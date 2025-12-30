/* eslint-disable @typescript-eslint/no-explicit-any */
import { WebClient, type ChatPostMessageResponse } from '@slack/web-api';
import { config } from '../config/environment.js';
import { SLACK_RELEASE_DELAY_MS } from '../config/constants.js';
import type { SlackMessage } from '../types/index.js';
import * as monday from './monday.js';
import { slackCircuit } from './circuitBreaker.js';

let slackClient: WebClient | null = null;

export function getClient(): WebClient {
  if (!slackClient) {
    slackClient = new WebClient(config.slack.botToken);
  }
  return slackClient;
}

type Priority = 'high' | 'medium' | 'low';

interface MeetingInfo {
  hasMeetingRequest: boolean;
  meetingDateTime: string | null;
  meetingDateTimeAlt: string | null;
}

interface SlackNotificationInput {
  taskType: string;
  subject: string;
  assigneeSlackId: string;      // Owner (will be pinged)
  assigneeName: string;         // Owner's display name (for after-hours display)
  supportSlackIds?: string[];   // Support users (optional, will also be pinged)
  dueDate: string;
  priority: Priority;
  notes: string;
  fromEmail: string | null;
  toEmail: string | null;
  mondayItemId: string;
  meeting?: MeetingInfo;
  team?: string;                // Team name (shown in header if present)
}

// Priority display config
const PRIORITY_CONFIG: Record<Priority, { emoji: string; label: string }> = {
  high: { emoji: '🔴', label: 'High' },
  medium: { emoji: '🟡', label: 'Medium' },
  low: { emoji: '🟢', label: 'Low' },
};

/**
 * Check if current time is within working hours
 * Working hours: Mon-Fri, 8am-8pm ET (configurable)
 */
export function isWorkingHours(date: Date = new Date()): boolean {
  const { quietHours } = config.slack;

  // Get current time in configured timezone
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: quietHours.timezone,
    weekday: 'short',
    hour: 'numeric',
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const weekday = parts.find(p => p.type === 'weekday')?.value ?? '';
  const hour = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10);

  // Check if weekend
  if (weekday === 'Sat' || weekday === 'Sun') {
    return false;
  }

  // Check if within working hours
  return hour >= quietHours.workingHoursStart && hour < quietHours.workingHoursEnd;
}

/**
 * Check if after-hours mode is active (quiet creation, deferred pings)
 */
export function isAfterHours(date: Date = new Date()): boolean {
  const { quietHours } = config.slack;

  // Disabled if quiet hours feature is not enabled
  if (!quietHours.enabled) {
    return false;
  }

  return !isWorkingHours(date);
}

/**
 * Check if quiet hours routing is active (legacy - prefer isAfterHours)
 */
export function isQuietHoursActive(): boolean {
  return isAfterHours();
}

/**
 * Format a date for display in configured timezone
 */
export function formatDateInTimezone(date: Date): string {
  const { quietHours } = config.slack;
  return date.toLocaleString('en-US', {
    timeZone: quietHours.timezone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * Get the next business day at release hour (8 AM ET by default)
 */
export function getNextReleaseTime(from: Date = new Date()): Date {
  const { quietHours } = config.slack;
  const releaseHour = quietHours.releaseHour;

  // Create a copy to avoid mutating input
  const next = new Date(from);

  // Get current day/hour in timezone
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: quietHours.timezone,
    weekday: 'short',
    hour: 'numeric',
    hour12: false,
  });

  const parts = formatter.formatToParts(next);
  const weekday = parts.find(p => p.type === 'weekday')?.value ?? '';
  const currentHour = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10);

  // Calculate days to add
  let daysToAdd = 0;

  if (weekday === 'Fri' && currentHour >= releaseHour) {
    daysToAdd = 3; // Next Monday
  } else if (weekday === 'Sat') {
    daysToAdd = 2; // Monday
  } else if (weekday === 'Sun') {
    daysToAdd = 1; // Monday
  } else if (currentHour >= releaseHour) {
    daysToAdd = 1; // Tomorrow
  }

  next.setDate(next.getDate() + daysToAdd);

  // Set to release hour (approximate - relies on timezone handling)
  // Get timezone offset for more accurate calculation
  const tzFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: quietHours.timezone,
    hour: 'numeric',
    hour12: false,
  });
  const tzParts = tzFormatter.formatToParts(next);
  const tzHour = parseInt(tzParts.find(p => p.type === 'hour')?.value ?? '0', 10);
  const hourDiff = next.getHours() - tzHour;

  next.setHours(releaseHour + hourDiff, 0, 0, 0);

  return next;
}

/**
 * Format ISO datetime string for display
 */
function formatMeetingTime(isoString: string): string {
  try {
    const date = new Date(isoString);
    return date.toLocaleString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    });
  } catch {
    return isoString;
  }
}

/**
 * Extended Slack message with after-hours metadata
 */
export interface SlackMessageWithDeferred extends SlackMessage {
  /** True if created during after-hours (deferred ping) */
  isDeferred: boolean;
  /** When the assignee ping is scheduled (if deferred) */
  scheduledReleaseTime?: Date;
}

/**
 * Send a notification message using Block Kit for rich formatting
 *
 * After-hours behavior (nights + weekends):
 * - Creates Monday item + Slack thread immediately (always)
 * - Does NOT ping assignee during after-hours
 * - Does NOT ping on-call during after-hours
 * - Posts a thread note with:
 *   - Creation time
 *   - Scheduled release time (next business day 8 AM)
 *   - Ack deadline (11 AM)
 * - Assignee will be pinged at next business start (8 AM ET)
 */
export async function sendNotification(input: SlackNotificationInput): Promise<SlackMessageWithDeferred> {
  const client = getClient();
  const mondayUrl = monday.getItemUrl(input.mondayItemId);
  const afterHours = isAfterHours();

  // Always show owner as @mention (clickable link to profile)
  // The after-hours system handles notification timing separately
  const ownerDisplay = `<@${input.assigneeSlackId}>`;

  // Support users display (if any) - show as @mentions
  const supportSlackIds = input.supportSlackIds ?? [];
  const supportDisplay = supportSlackIds.length > 0
    ? supportSlackIds.map(id => `<@${id}>`).join(', ')
    : null;

  // Build header text - include team name if available
  const headerText = input.team
    ? `New ${input.taskType} Email: ${input.team}`
    : `New ${input.taskType} Email`;

  // Build Block Kit message - use any[] to avoid type issues with mixed block types
  const blocks: any[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: headerText,
        emoji: true,
      },
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*Subject:*\n${input.subject}`,
        },
        {
          type: 'mrkdwn',
          text: `*Owner:*\n${ownerDisplay}`,
        },
      ],
    },
  ];

  // Add support field if there are support users
  if (supportDisplay) {
    blocks.push({
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*Support:*\n${supportDisplay}`,
        },
      ],
    });
  }

  // Continue with due date and priority
  blocks.push(
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*Due:*\n${input.dueDate}`,
        },
        {
          type: 'mrkdwn',
          text: `*Priority:*\n${PRIORITY_CONFIG[input.priority].emoji} ${PRIORITY_CONFIG[input.priority].label}`,
        },
      ],
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*Type:*\n${input.taskType}`,
        },
      ],
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*From:*\n${input.fromEmail ?? 'N/A'}`,
        },
        {
          type: 'mrkdwn',
          text: `*To:*\n${input.toEmail ?? 'N/A'}`,
        },
      ],
    },
    {
      type: 'divider',
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Notes:*\n${input.notes || '_No notes provided_'}`,
      },
    }
  );

  // Add meeting section if there's a meeting request
  if (input.meeting?.hasMeetingRequest) {
    let meetingText = '📅 *Meeting Requested*';
    if (input.meeting.meetingDateTime) {
      meetingText += `\n• ${formatMeetingTime(input.meeting.meetingDateTime)}`;
    }
    if (input.meeting.meetingDateTimeAlt) {
      meetingText += `\n• ${formatMeetingTime(input.meeting.meetingDateTimeAlt)} _(alt)_`;
    }
    if (!input.meeting.meetingDateTime && !input.meeting.meetingDateTimeAlt) {
      meetingText += '\n_No specific time mentioned_';
    }

    blocks.push(
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: meetingText,
        },
      }
    );
  }

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: {
          type: 'plain_text',
          text: 'View in Monday',
          emoji: true,
        },
        url: mondayUrl,
        action_id: 'view_monday',
      },
    ],
  });

  // Fallback text for notifications (always with @mention)
  const fallbackText = `New ${input.taskType} Email: ${input.subject} - Assigned to <@${input.assigneeSlackId}> - Due: ${input.dueDate}`;

  // Wrapped in circuit breaker to prevent cascading failures (TD-05)
  const response: ChatPostMessageResponse = await slackCircuit.execute(() =>
    client.chat.postMessage({
      channel: config.slack.channelId,
      text: fallbackText,
      blocks,
      unfurl_links: false,
      unfurl_media: false,
    })
  );

  if (!response.ok || !response.ts) {
    throw new Error(`Failed to send Slack message: ${response.error}`);
  }

  const slackMessage: SlackMessageWithDeferred = {
    ts: response.ts,
    channel: response.channel ?? config.slack.channelId,
    isDeferred: afterHours,
  };

  // During after-hours: post deferred note (NO pings to anyone)
  if (afterHours) {
    const now = new Date();
    const releaseTime = getNextReleaseTime(now);
    const ackDeadlineHour = config.slack.quietHours.ackDeadlineHour;

    // Store scheduled release time
    slackMessage.scheduledReleaseTime = releaseTime;

    // Format times for display
    const createdTimeStr = formatDateInTimezone(now);
    const releaseTimeStr = formatDateInTimezone(releaseTime);

    // Create ack deadline time (same day as release, at ackDeadlineHour)
    const ackDeadline = new Date(releaseTime);
    // Get timezone offset for ack deadline calculation
    const tzFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: config.slack.quietHours.timezone,
      hour: 'numeric',
      hour12: false,
    });
    const tzParts = tzFormatter.formatToParts(ackDeadline);
    const tzHour = parseInt(tzParts.find(p => p.type === 'hour')?.value ?? '0', 10);
    const hourDiff = ackDeadline.getHours() - tzHour;
    ackDeadline.setHours(ackDeadlineHour + hourDiff, 0, 0, 0);
    const ackDeadlineStr = formatDateInTimezone(ackDeadline);

    // Post deferred note with all timing info (no pings)
    // Format: [after-hours:deferred:SLACK_USER_ID] - used by release scheduler
    await postToThread(
      slackMessage.ts,
      `⏰ *Created ${createdTimeStr} (after hours)*\n` +
      `👀 Assignee ping scheduled for ${releaseTimeStr}\n` +
      `👀 Ack needed by ${ackDeadlineStr}\n\n` +
      `[after-hours:deferred:${input.assigneeSlackId}]`
    );

    // NO on-call ping during after-hours (per new spec)
    // Task will be released at next business start
  }

  return slackMessage;
}

/**
 * Upload a file to a Slack thread
 * Wrapped in circuit breaker (TD-05)
 */
export async function uploadFileToThread(
  channelId: string,
  threadTs: string,
  fileBuffer: Buffer,
  filename: string,
  initialComment?: string
): Promise<void> {
  const client = getClient();

  await slackCircuit.execute(() =>
    client.filesUploadV2({
      channel_id: channelId,
      thread_ts: threadTs,
      filename,
      file: fileBuffer,
      title: filename,
      initial_comment: initialComment,
    })
  );
}

/**
 * Find a Slack user by email
 * Wrapped in circuit breaker (TD-05)
 */
export async function findUserByEmail(email: string): Promise<string | null> {
  const client = getClient();

  try {
    const response = await slackCircuit.execute(() =>
      client.users.lookupByEmail({ email })
    );
    return response.user?.id ?? null;
  } catch (error) {
    // User not found (or circuit open)
    console.warn(`Slack user not found for email: ${email}`);
    return null;
  }
}

/**
 * Add a bookmark to a channel (for Monday link)
 * This creates a persistent link at the top of the channel
 */
export async function addBookmark(
  title: string,
  link: string
): Promise<void> {
  const client = getClient();

  try {
    await client.bookmarks.add({
      channel_id: config.slack.channelId,
      title,
      type: 'link',
      link,
    });
  } catch (error) {
    // Bookmarks might require additional permissions
    console.warn('Failed to add Slack bookmark:', error);
  }
}

export interface SlackUser {
  id: string;
  name: string;
  realName: string;
  email: string | null;
}

/**
 * Fetch all users from Slack workspace
 */
export async function getAllUsers(): Promise<SlackUser[]> {
  const client = getClient();
  const users: SlackUser[] = [];

  let cursor: string | undefined;

  do {
    const response = await client.users.list({
      limit: 200,
      cursor,
    });

    if (response.members) {
      for (const member of response.members) {
        // Skip bots and deleted users
        if (member.is_bot || member.deleted || !member.id) continue;

        users.push({
          id: member.id,
          name: member.name ?? '',
          realName: member.real_name ?? member.name ?? '',
          email: member.profile?.email ?? null,
        });
      }
    }

    cursor = response.response_metadata?.next_cursor;
  } while (cursor);

  return users;
}

export interface ReminderInput {
  userId: string;
  text: string;
  dueDate: string; // YYYY-MM-DD format
}

/**
 * Set a Slack reminder for a user on the due date
 *
 * The reminder will trigger at 9am on the due date
 */
export async function setReminder(input: ReminderInput): Promise<boolean> {
  const client = getClient();

  try {
    // Parse the due date and set reminder for 9am
    const [year, month, day] = input.dueDate.split('-').map(Number);
    const reminderDate = new Date(year, month - 1, day, 9, 0, 0);

    // Convert to Unix timestamp
    const timestamp = Math.floor(reminderDate.getTime() / 1000);

    // Don't set reminders in the past
    if (timestamp < Math.floor(Date.now() / 1000)) {
      console.log('Skipping reminder - due date is in the past');
      return false;
    }

    await client.reminders.add({
      user: input.userId,
      text: input.text,
      time: timestamp,
    });

    console.log(`Slack reminder set for ${input.userId} at ${reminderDate.toISOString()}`);
    return true;
  } catch (error) {
    // Reminders API might not be available for all workspaces
    console.warn('Failed to set Slack reminder:', error);
    return false;
  }
}

/**
 * Post a message to an existing thread
 * Wrapped in circuit breaker (TD-05)
 * @param threadTs - Thread timestamp to reply to
 * @param text - Message text
 * @param channelId - Optional channel ID (defaults to main channel)
 * @param blocks - Optional Slack blocks
 */
export async function postToThread(
  threadTs: string,
  text: string,
  channelId?: string,
  blocks?: any[]
): Promise<SlackMessage> {
  const client = getClient();
  const channel = channelId || config.slack.channelId;

  const response = await slackCircuit.execute(() =>
    client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text,
      blocks,
      unfurl_links: false,
      unfurl_media: false,
    })
  );

  if (!response.ok || !response.ts) {
    throw new Error(`Failed to post to Slack thread: ${response.error}`);
  }

  return {
    ts: response.ts,
    channel: response.channel ?? channel,
  };
}

/**
 * Add a reaction to a message
 * Wrapped in circuit breaker (TD-05)
 */
export async function addReaction(
  messageTs: string,
  emoji: string,
  channelId?: string
): Promise<void> {
  const client = getClient();
  const channel = channelId || config.slack.channelId;

  try {
    await slackCircuit.execute(() =>
      client.reactions.add({
        channel,
        timestamp: messageTs,
        name: emoji,
      })
    );
  } catch (error) {
    // Might fail if reaction already exists (or circuit open)
    console.warn('Failed to add reaction:', error);
  }
}

/**
 * Remove a reaction from a message
 * Wrapped in circuit breaker (TD-05)
 */
export async function removeReaction(
  messageTs: string,
  emoji: string
): Promise<void> {
  const client = getClient();

  try {
    await slackCircuit.execute(() =>
      client.reactions.remove({
        channel: config.slack.channelId,
        timestamp: messageTs,
        name: emoji,
      })
    );
  } catch (error) {
    // Might fail if reaction doesn't exist (or circuit open)
    console.warn('Failed to remove reaction:', error);
  }
}

/**
 * Post an ephemeral message (only visible to one user)
 * Wrapped in circuit breaker (TD-05)
 */
export async function postEphemeral(
  channelId: string,
  userId: string,
  text: string,
  blocks?: any[]
): Promise<void> {
  const client = getClient();

  await slackCircuit.execute(() =>
    client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text,
      blocks,
    })
  );
}

/**
 * Delete recent bot messages from a channel (including threads)
 * @param minutesAgo - Delete messages from the last N minutes
 */
export async function deleteRecentBotMessages(minutesAgo: number = 60): Promise<number> {
  const client = getClient();
  let deletedCount = 0;

  try {
    // Get bot's own user ID
    const authResponse = await client.auth.test();
    const botUserId = authResponse.user_id;

    console.log(`Bot user ID: ${botUserId}`);
    console.log(`Deleting bot messages from the last ${minutesAgo} minutes...`);

    // Calculate cutoff timestamp
    const cutoffTimestamp = (Date.now() - minutesAgo * 60 * 1000) / 1000;

    // Get more channel history (last 500 messages or 7 days) to find threads with recent replies
    const historyResponse = await client.conversations.history({
      channel: config.slack.channelId,
      limit: 500,
    });

    if (!historyResponse.messages) {
      console.log('No messages found in channel');
      return 0;
    }

    console.log(`Found ${historyResponse.messages.length} messages in channel`);

    // Check each message and its thread for recent bot messages
    for (const message of historyResponse.messages) {
      // Check threads for bot replies
      if (message.thread_ts && message.reply_count && message.reply_count > 0) {
        try {
          const threadResponse = await client.conversations.replies({
            channel: config.slack.channelId,
            ts: message.thread_ts,
          });

          if (threadResponse.messages) {
            for (const reply of threadResponse.messages) {
              // Only delete bot's replies that are within the time window
              const replyTimestamp = parseFloat(reply.ts || '0');
              if (reply.user === botUserId && reply.ts && replyTimestamp >= cutoffTimestamp) {
                try {
                  await client.chat.delete({
                    channel: config.slack.channelId,
                    ts: reply.ts,
                  });
                  deletedCount++;
                  console.log(`Deleted thread reply: ${reply.ts}`);
                } catch (e: any) {
                  console.warn(`Failed to delete thread reply ${reply.ts}:`, e.message);
                }
              }
            }
          }
        } catch (e: any) {
          console.warn(`Failed to fetch thread ${message.thread_ts}:`, e.message);
        }
      }

      // Delete main channel messages from bot within time window
      const msgTimestamp = parseFloat(message.ts || '0');
      if (message.user === botUserId && message.ts && msgTimestamp >= cutoffTimestamp) {
        try {
          await client.chat.delete({
            channel: config.slack.channelId,
            ts: message.ts,
          });
          deletedCount++;
          console.log(`Deleted message: ${message.ts}`);
        } catch (e: any) {
          console.warn(`Failed to delete message ${message.ts}:`, e.message);
        }
      }
    }

    console.log(`Cleanup complete: deleted ${deletedCount} bot messages`);
    return deletedCount;
  } catch (error) {
    console.error('Error deleting bot messages:', error);
    return deletedCount;
  }
}

/**
 * Send a follow-up message to a Slack response_url
 */
export async function sendResponseUrl(responseUrl: string, text: string): Promise<void> {
  try {
    await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        response_type: 'ephemeral',
        text,
        replace_original: false,
      }),
    });
  } catch (error) {
    console.error('Failed to send response_url message:', error);
  }
}

/**
 * Verify a Slack request signature
 */
export function verifySlackSignature(
  signature: string,
  timestamp: string,
  body: string,
  signingSecret: string
): boolean {
  const crypto = require('crypto');
  const baseString = `v0:${timestamp}:${body}`;
  const hmac = crypto.createHmac('sha256', signingSecret);
  hmac.update(baseString);
  const expectedSignature = `v0=${hmac.digest('hex')}`;
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

// ============================================================================
// After-Hours - Deferred Task Release & Acknowledgement
// ============================================================================

// Hardening constants
const DEFERRED_LOOKBACK_HOURS = 48;  // Max 48 hours lookback for deferred notifications
const RELEASE_BATCH_SIZE = 5;        // Release in batches of 5
// RELEASE_DELAY_MS imported from constants.ts

// Marker patterns for thread tracking
const DEFERRED_MARKER_PATTERN = /\[after-hours:deferred:([^\]]+)\]/;
const RELEASED_MARKER = '[after-hours:released]';
const ACKNOWLEDGED_MARKER = '[after-hours:acknowledged]';
const DONE_MARKER = '[after-hours:done]';
const REMINDER_MARKER = '[after-hours:reminder-sent]';
// Legacy pattern for backwards compatibility
const LEGACY_DEFERRED_PATTERN = /\[quiet-hours:deferred:([^\]]+)\]/;
const LEGACY_NOTIFIED_MARKER = '[quiet-hours:notified]';

interface DeferredNotification {
  threadTs: string;
  assigneeSlackId: string;
  mondayUrl: string | null;  // Extracted from parent message for direct link
}

/**
 * Sleep helper for rate limiting
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Extract Monday URL from a Slack message's blocks
 */
function extractMondayUrlFromBlocks(blocks: any[] | undefined): string | null {
  if (!blocks) return null;

  for (const block of blocks) {
    if (block.type === 'actions' && block.elements) {
      for (const element of block.elements) {
        if (element.action_id === 'view_monday' && element.url) {
          return element.url;
        }
      }
    }
  }
  return null;
}

/**
 * Extended deferred notification with tracking state
 */
interface DeferredNotificationState extends DeferredNotification {
  isReleased: boolean;
  isAcknowledged: boolean;  // 👀 reaction received
  isDone: boolean;          // ✅ reaction received
  hasReminder: boolean;
  releaseMessageTs?: string;  // Timestamp of release message (for tracking 👀)
}

/**
 * Find threads with deferred assignee notifications from after-hours
 *
 * Hardening:
 * - Limited to 48-hour lookback window (no historical scan)
 * - Extracts Monday URL for direct linking
 * - Supports both new [after-hours:*] and legacy [quiet-hours:*] markers
 * - Returns full state for each deferred thread
 */
export async function findDeferredNotifications(): Promise<DeferredNotification[]> {
  const allDeferred = await findDeferredNotificationsWithState();
  // Return only unreleased ones for release
  return allDeferred.filter(d => !d.isReleased);
}

/**
 * Find all deferred notification threads with full state
 */
export async function findDeferredNotificationsWithState(): Promise<DeferredNotificationState[]> {
  const client = getClient();
  const deferred: DeferredNotificationState[] = [];

  try {
    // Get bot's user ID to identify our messages
    const authResponse = await client.auth.test();
    const botUserId = authResponse.user_id;

    // Calculate lookback cutoff (48 hours max)
    const cutoffTimestamp = (Date.now() - DEFERRED_LOOKBACK_HOURS * 60 * 60 * 1000) / 1000;

    // Look at recent channel history
    const historyResponse = await client.conversations.history({
      channel: config.slack.channelId,
      oldest: cutoffTimestamp.toString(),  // Only messages within lookback window
      limit: 100,
    });

    if (!historyResponse.messages) {
      return [];
    }

    console.log(`Scanning ${historyResponse.messages.length} messages within ${DEFERRED_LOOKBACK_HOURS}h lookback`);

    // Check each thread for deferred markers
    for (const message of historyResponse.messages) {
      // Only check threads started by the bot
      if (message.user !== botUserId || !message.ts) continue;

      // Skip if no thread replies
      if (!message.reply_count || message.reply_count === 0) continue;

      // Skip if message is older than lookback window (double-check)
      const msgTimestamp = parseFloat(message.ts);
      if (msgTimestamp < cutoffTimestamp) continue;

      try {
        const threadResponse = await client.conversations.replies({
          channel: config.slack.channelId,
          ts: message.ts,
        });

        if (!threadResponse.messages) continue;

        let deferredUserId: string | null = null;
        let isReleased = false;
        let isAcknowledged = false;
        let isDone = false;
        let hasReminder = false;
        let releaseMessageTs: string | undefined;

        for (const reply of threadResponse.messages) {
          // Skip non-bot messages
          if (reply.user !== botUserId || !reply.text) continue;

          // Check for new deferred marker: [after-hours:deferred:USER_ID]
          const newMatch = reply.text.match(DEFERRED_MARKER_PATTERN);
          if (newMatch) {
            deferredUserId = newMatch[1];
          }

          // Check for legacy deferred marker: [quiet-hours:deferred:USER_ID]
          const legacyMatch = reply.text.match(LEGACY_DEFERRED_PATTERN);
          if (legacyMatch) {
            deferredUserId = legacyMatch[1];
          }

          // Check for released marker (new or legacy)
          if (reply.text.includes(RELEASED_MARKER) || reply.text.includes(LEGACY_NOTIFIED_MARKER)) {
            isReleased = true;
            // The release message is the one with the ping
            if (reply.text.includes('👀') && reply.text.includes('<@')) {
              releaseMessageTs = reply.ts;
            }
          }

          // Check for acknowledgement marker (👀 reaction)
          if (reply.text.includes(ACKNOWLEDGED_MARKER)) {
            isAcknowledged = true;
          }

          // Check for done marker (✅ reaction)
          if (reply.text.includes(DONE_MARKER)) {
            isDone = true;
          }

          // Check for reminder marker
          if (reply.text.includes(REMINDER_MARKER)) {
            hasReminder = true;
          }
        }

        // Add to list if this is a deferred thread
        if (deferredUserId) {
          // Extract Monday URL from parent message blocks
          const parentMessage = threadResponse.messages[0];
          const mondayUrl = extractMondayUrlFromBlocks(parentMessage?.blocks as any[]);

          deferred.push({
            threadTs: message.ts,
            assigneeSlackId: deferredUserId,
            mondayUrl,
            isReleased,
            isAcknowledged,
            isDone,
            hasReminder,
            releaseMessageTs,
          });
        }
      } catch (e: any) {
        console.warn(`Failed to check thread ${message.ts}:`, e.message);
      }
    }

    return deferred;
  } catch (error) {
    console.error('Error finding deferred notifications:', error);
    return [];
  }
}

/**
 * Release a deferred notification by notifying the assignee
 *
 * Posts: "<@assignee> 👀 new task created after hours (please ack)"
 *
 * Idempotency: Only posts released marker AFTER @mention succeeds.
 * If @mention fails, notification will be retried on next scheduler run.
 *
 * Returns the timestamp of the release message (for tracking 👀 reactions)
 */
export async function releaseDeferredNotification(
  threadTs: string,
  assigneeSlackId: string,
  mondayUrl: string | null
): Promise<{ success: boolean; releaseMessageTs?: string }> {
  try {
    // Build release message with optional Monday link
    const mondayLink = mondayUrl ? `\n<${mondayUrl}|View in Monday>` : '';

    // Post the release ping with ack request
    const releaseMessage = await postToThread(
      threadTs,
      `<@${assigneeSlackId}> 👀 new task created after hours (please ack)${mondayLink}`
    );

    // Only mark as released AFTER @mention succeeds (idempotency guard)
    await postToThread(
      threadTs,
      `${RELEASED_MARKER} _Assignee notified at business hour._`
    );

    return { success: true, releaseMessageTs: releaseMessage.ts };
  } catch (error) {
    // Do NOT mark as released - will retry on next scheduler run
    console.error(`Failed to release deferred notification for thread ${threadTs}:`, error);
    return { success: false };
  }
}

/**
 * Find released but unacknowledged tasks (for 11 AM follow-up)
 * Excludes: acknowledged (👀), done (✅), and already reminded tasks
 */
export async function findReleasedUnacknowledgedTasks(): Promise<DeferredNotificationState[]> {
  const allDeferred = await findDeferredNotificationsWithState();
  // Return released but not acknowledged, not done, and no reminder sent yet
  return allDeferred.filter(d => d.isReleased && !d.isAcknowledged && !d.isDone && !d.hasReminder);
}

/**
 * Send a follow-up reminder for unacknowledged tasks
 *
 * Posts: "<@assignee> ⚠️ still need 👀 acknowledgement on this task"
 *
 * Only sends ONE reminder per task (tracked by reminder marker)
 */
export async function sendAckReminder(
  threadTs: string,
  assigneeSlackId: string
): Promise<boolean> {
  try {
    // Post the reminder
    await postToThread(
      threadTs,
      `<@${assigneeSlackId}> ⚠️ still need 👀 acknowledgement on this task`
    );

    // Mark as reminder sent
    await postToThread(
      threadTs,
      `${REMINDER_MARKER}`
    );

    return true;
  } catch (error) {
    console.error(`Failed to send ack reminder for thread ${threadTs}:`, error);
    return false;
  }
}

/**
 * Mark a thread as acknowledged (when 👀 reaction is received)
 */
export async function markThreadAcknowledged(threadTs: string): Promise<boolean> {
  try {
    await postToThread(
      threadTs,
      `${ACKNOWLEDGED_MARKER} ✓ _Task acknowledged_`
    );
    return true;
  } catch (error) {
    console.error(`Failed to mark thread ${threadTs} as acknowledged:`, error);
    return false;
  }
}

/**
 * Mark a thread as done (when ✅ reaction is received)
 */
export async function markThreadDone(threadTs: string): Promise<boolean> {
  try {
    await postToThread(
      threadTs,
      `${DONE_MARKER} ✓ _Task marked done_`
    );
    return true;
  } catch (error) {
    console.error(`Failed to mark thread ${threadTs} as done:`, error);
    return false;
  }
}

/**
 * Check if a message is a release ping message (for 👀 tracking)
 */
export function isReleasePingMessage(messageText: string): boolean {
  return messageText.includes('👀 new task created after hours');
}

/**
 * Release all deferred notifications from after-hours
 * Called at 8am Mon-Fri by scheduler
 *
 * Hardening:
 * - Processes in batches of 5 to avoid rate limits
 * - 1 second delay between releases
 * - Does NOT ping anyone else (only the assignee)
 *
 * Returns count of notifications released
 */
export async function releaseAllDeferredNotifications(): Promise<number> {
  console.log('Releasing deferred after-hours notifications...');

  const deferred = await findDeferredNotifications();

  if (deferred.length === 0) {
    console.log('No deferred notifications to release');
    return 0;
  }

  console.log(`Found ${deferred.length} deferred notification(s) to release`);

  let released = 0;
  let batchCount = 0;

  for (const notification of deferred) {
    const result = await releaseDeferredNotification(
      notification.threadTs,
      notification.assigneeSlackId,
      notification.mondayUrl
    );

    if (result.success) {
      released++;
    }

    batchCount++;

    // Rate limiting: delay between releases
    if (batchCount < deferred.length) {
      await sleep(SLACK_RELEASE_DELAY_MS);
    }

    // Log progress for batches
    if (batchCount % RELEASE_BATCH_SIZE === 0) {
      console.log(`Released ${released}/${batchCount} so far...`);
    }
  }

  console.log(`Released ${released}/${deferred.length} deferred notifications`);
  return released;
}

/**
 * Send reminders for all unacknowledged tasks
 * Called at 11am Mon-Fri by scheduler
 *
 * Returns count of reminders sent
 */
export async function sendAllAckReminders(): Promise<number> {
  console.log('Sending acknowledgement reminders...');

  const unacked = await findReleasedUnacknowledgedTasks();

  if (unacked.length === 0) {
    console.log('No unacknowledged tasks to remind');
    return 0;
  }

  console.log(`Found ${unacked.length} unacknowledged task(s) to remind`);

  let reminded = 0;
  let batchCount = 0;

  for (const task of unacked) {
    const success = await sendAckReminder(
      task.threadTs,
      task.assigneeSlackId
    );

    if (success) {
      reminded++;
    }

    batchCount++;

    // Rate limiting: delay between reminders
    if (batchCount < unacked.length) {
      await sleep(SLACK_RELEASE_DELAY_MS);
    }
  }

  console.log(`Sent ${reminded}/${unacked.length} acknowledgement reminders`);
  return reminded;
}

/**
 * Check quiet-hours status for a specific thread
 * Used by /taskdebug to show deferred/notified status
 */
export interface QuietHoursStatus {
  wasDeferred: boolean;
  deferredUserId: string | null;
  wasReleased: boolean;
}

export async function getQuietHoursStatus(threadTs: string): Promise<QuietHoursStatus> {
  const client = getClient();

  try {
    // Get bot's user ID
    const authResponse = await client.auth.test();
    const botUserId = authResponse.user_id;

    // Fetch thread replies
    const threadResponse = await client.conversations.replies({
      channel: config.slack.channelId,
      ts: threadTs,
    });

    if (!threadResponse.messages) {
      return { wasDeferred: false, deferredUserId: null, wasReleased: false };
    }

    let deferredUserId: string | null = null;
    let wasReleased = false;

    for (const reply of threadResponse.messages) {
      // Only check bot messages
      if (reply.user !== botUserId || !reply.text) continue;

      // Check for deferred marker: [quiet-hours:deferred:USER_ID]
      const deferredMatch = reply.text.match(/\[quiet-hours:deferred:([^\]]+)\]/);
      if (deferredMatch) {
        deferredUserId = deferredMatch[1];
      }

      // Check for notified marker
      if (reply.text.includes('[quiet-hours:notified]')) {
        wasReleased = true;
      }
    }

    return {
      wasDeferred: deferredUserId !== null,
      deferredUserId,
      wasReleased,
    };
  } catch (error) {
    console.error('Error checking quiet-hours status:', error);
    return { wasDeferred: false, deferredUserId: null, wasReleased: false };
  }
}

// ============================================================================
// Supporter Channel Notifications
// ============================================================================

/**
 * Check if a user is a member of a specific Slack channel
 * Wrapped in circuit breaker (TD-05)
 */
export async function isUserInChannel(userId: string, channelId: string): Promise<boolean> {
  const client = getClient();

  try {
    // Use conversations.members to get channel members
    // This may need pagination for large channels, but for most teams it's fine
    const response = await slackCircuit.execute(() =>
      client.conversations.members({
        channel: channelId,
        limit: 1000,  // Should cover most team channels
      })
    );

    if (!response.ok || !response.members) {
      console.warn(`Failed to get members for channel ${channelId}`);
      return false;
    }

    return response.members.includes(userId);
  } catch (error) {
    console.error(`Error checking channel membership for ${userId} in ${channelId}:`, error);
    return false;
  }
}

/**
 * Find which notification channel a supporter should receive notifications in
 * Checks primary channel first, then secondaries in order
 * Returns null if supporter is not in any configured channel
 */
export async function findSupporterNotificationChannel(supporterSlackId: string): Promise<string | null> {
  const { supporterPrimaryChannel, supporterSecondaryChannels } = config.slack;

  // Build ordered list of channels to check
  const channelsToCheck: string[] = [];

  if (supporterPrimaryChannel) {
    channelsToCheck.push(supporterPrimaryChannel);
  }

  channelsToCheck.push(...supporterSecondaryChannels);

  if (channelsToCheck.length === 0) {
    console.log('No supporter notification channels configured');
    return null;
  }

  console.log(`Checking ${channelsToCheck.length} channels for supporter ${supporterSlackId}...`);

  // Check channels in order until we find one the supporter is in
  for (const channelId of channelsToCheck) {
    const isMember = await isUserInChannel(supporterSlackId, channelId);
    if (isMember) {
      console.log(`Supporter ${supporterSlackId} found in channel ${channelId}`);
      return channelId;
    }
  }

  console.log(`Supporter ${supporterSlackId} not found in any configured channel`);
  return null;
}

/**
 * Task details for supporter notification
 */
export interface SupporterNotificationDetails {
  taskSubject: string;
  taskType: string;
  ownerName: string;
  dueDate: string;           // Formatted for display (e.g., "Mon Dec 23")
  priority: 'high' | 'medium' | 'low';
  notes?: string;
}

/**
 * Send a notification to a supporter's channel
 * Includes full task details so supporter has context without leaving Slack
 * Links to Monday for updates (thread replies sync to Monday automatically)
 */
export async function notifySupporterInChannel(
  supporterSlackId: string,
  supporterName: string,
  details: SupporterNotificationDetails,
  mainThreadTs: string,
  mondayItemId: string
): Promise<boolean> {
  const channelId = await findSupporterNotificationChannel(supporterSlackId);

  if (!channelId) {
    console.log(`No notification channel found for supporter ${supporterName}`);
    return false;
  }

  const client = getClient();
  const mondayLink = `${config.monday.boardUrl}/pulses/${mondayItemId}`;

  // Priority emoji
  const priorityEmoji = details.priority === 'high' ? '🔴' : details.priority === 'low' ? '🟢' : '🟡';

  // Build the message with all relevant details
  let message = `🤝 <@${supporterSlackId}> you've been added as a supporter on:\n\n`;
  message += `*${details.taskSubject}*\n\n`;
  message += `📋 *Type:* ${details.taskType}\n`;
  message += `👤 *Owner:* ${details.ownerName}\n`;
  message += `📅 *Due:* ${details.dueDate}\n`;
  message += `${priorityEmoji} *Priority:* ${details.priority.charAt(0).toUpperCase() + details.priority.slice(1)}\n`;

  if (details.notes) {
    message += `📝 *Notes:* ${details.notes}\n`;
  }

  message += `\n<${mondayLink}|View Monday task>\n\n💬 _Add any updates or comments on Monday - this channel is not synced._\n\n[supporter-notification:${mondayItemId}]`;

  try {
    const response = await slackCircuit.execute(() =>
      client.chat.postMessage({
        channel: channelId,
        text: message,
        unfurl_links: false,
        unfurl_media: false,
      })
    );

    if (response.ok) {
      console.log(`Sent supporter notification to channel ${channelId} for ${supporterName}`);
      return true;
    } else {
      console.error(`Failed to send supporter notification: ${response.error}`);
      return false;
    }
  } catch (error) {
    console.error(`Error sending supporter notification:`, error);
    return false;
  }
}

// ============================================================================
// File Sync Functions
// ============================================================================

/**
 * Slack file information from message events
 */
export interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  url_private: string;
  size?: number;
}

/**
 * Download a file from Slack using the bot token
 * Slack file URLs require authentication
 */
export async function downloadFile(file: SlackFile): Promise<Buffer> {
  const response = await fetch(file.url_private, {
    headers: {
      Authorization: `Bearer ${config.slack.botToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to download Slack file: ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

