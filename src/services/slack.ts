/* eslint-disable @typescript-eslint/no-explicit-any */
import { WebClient, type ChatPostMessageResponse } from '@slack/web-api';
import { config } from '../config/environment.js';
import type { SlackMessage } from '../types/index.js';
import * as monday from './monday.js';

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
  assigneeSlackId: string;
  dueDate: string;
  priority: Priority;
  notes: string;
  fromEmail: string | null;
  toEmail: string | null;
  mondayItemId: string;
  meeting?: MeetingInfo;
}

// Priority display config
const PRIORITY_CONFIG: Record<Priority, { emoji: string; label: string }> = {
  high: { emoji: '🔴', label: 'High' },
  medium: { emoji: '🟡', label: 'Medium' },
  low: { emoji: '🟢', label: 'Low' },
};

/**
 * Check if current time is within working hours
 * Working hours: Mon-Fri, 10am-6pm (no holiday logic)
 */
export function isWorkingHours(): boolean {
  const { quietHours } = config.slack;

  // Get current time in configured timezone
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: quietHours.timezone,
    weekday: 'short',
    hour: 'numeric',
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  const weekday = parts.find(p => p.type === 'weekday')?.value ?? '';
  const hour = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10);

  // Check if weekend
  if (weekday === 'Sat' || weekday === 'Sun') {
    return false;
  }

  // Check if within working hours (10am-6pm)
  return hour >= quietHours.workingHoursStart && hour < quietHours.workingHoursEnd;
}

/**
 * Check if quiet hours routing is active
 */
export function isQuietHoursActive(): boolean {
  const { quietHours } = config.slack;

  // Disabled if not enabled or no on-call user configured
  if (!quietHours.enabled || !quietHours.onCallUserId) {
    return false;
  }

  return !isWorkingHours();
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
 * Send a notification message using Block Kit for rich formatting
 *
 * Quiet hours routing (nights + weekends):
 * - Still creates the Slack thread (always)
 * - Does NOT mention assignee during quiet hours
 * - Notifies only on-call user during quiet hours
 * - Posts thread note about being queued
 */
export async function sendNotification(input: SlackNotificationInput): Promise<SlackMessage> {
  const client = getClient();
  const mondayUrl = monday.getItemUrl(input.mondayItemId);
  const quietHoursActive = isQuietHoursActive();

  // During quiet hours: show assignee name without @ mention
  // During working hours: full @ mention
  const assigneeDisplay = quietHoursActive
    ? input.assigneeSlackId  // Just the ID/name, no notification
    : `<@${input.assigneeSlackId}>`;  // Full mention, notifies user

  // Build Block Kit message - use any[] to avoid type issues with mixed block types
  const blocks: any[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `New ${input.taskType} Email`,
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
          text: `*Assigned to:*\n${assigneeDisplay}`,
        },
      ],
    },
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
    },
  ];

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

  // Fallback text for notifications
  // During quiet hours, don't include @ mention in fallback either
  const fallbackText = quietHoursActive
    ? `New ${input.taskType} Email: ${input.subject} - Assigned to ${input.assigneeSlackId} - Due: ${input.dueDate}`
    : `New ${input.taskType} Email: ${input.subject} - Assigned to <@${input.assigneeSlackId}> - Due: ${input.dueDate}`;

  const response: ChatPostMessageResponse = await client.chat.postMessage({
    channel: config.slack.channelId,
    text: fallbackText,
    blocks,
    unfurl_links: false,
    unfurl_media: false,
  });

  if (!response.ok || !response.ts) {
    throw new Error(`Failed to send Slack message: ${response.error}`);
  }

  const slackMessage: SlackMessage = {
    ts: response.ts,
    channel: response.channel ?? config.slack.channelId,
  };

  // During quiet hours: notify on-call user and post deferred marker
  if (quietHoursActive && config.slack.quietHours.onCallUserId) {
    // Post deferred marker (searchable, no @mention to avoid pings)
    // Format: [quiet-hours:deferred:SLACK_USER_ID] - used by release scheduler
    await postToThread(
      slackMessage.ts,
      `[quiet-hours:deferred:${input.assigneeSlackId}] _Queued outside working hours – assignee will be notified at next business hour._`
    );

    // Notify on-call user in thread
    await postToThread(
      slackMessage.ts,
      `<@${config.slack.quietHours.onCallUserId}> 📞 _On-call notification_`
    );
  }

  return slackMessage;
}

/**
 * Upload a file to a Slack thread
 */
export async function uploadFileToThread(
  threadTs: string,
  filename: string,
  fileData: Buffer,
  title?: string
): Promise<void> {
  const client = getClient();

  await client.filesUploadV2({
    channel_id: config.slack.channelId,
    thread_ts: threadTs,
    filename,
    file: fileData,
    title: title ?? filename,
  });
}

/**
 * Find a Slack user by email
 */
export async function findUserByEmail(email: string): Promise<string | null> {
  const client = getClient();

  try {
    const response = await client.users.lookupByEmail({ email });
    return response.user?.id ?? null;
  } catch (error) {
    // User not found
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
 */
export async function postToThread(
  threadTs: string,
  text: string,
  blocks?: any[]
): Promise<SlackMessage> {
  const client = getClient();

  const response = await client.chat.postMessage({
    channel: config.slack.channelId,
    thread_ts: threadTs,
    text,
    blocks,
    unfurl_links: false,
    unfurl_media: false,
  });

  if (!response.ok || !response.ts) {
    throw new Error(`Failed to post to Slack thread: ${response.error}`);
  }

  return {
    ts: response.ts,
    channel: response.channel ?? config.slack.channelId,
  };
}

/**
 * Add a reaction to a message
 */
export async function addReaction(
  messageTs: string,
  emoji: string
): Promise<void> {
  const client = getClient();

  try {
    await client.reactions.add({
      channel: config.slack.channelId,
      timestamp: messageTs,
      name: emoji,
    });
  } catch (error) {
    // Might fail if reaction already exists
    console.warn('Failed to add reaction:', error);
  }
}

/**
 * Remove a reaction from a message
 */
export async function removeReaction(
  messageTs: string,
  emoji: string
): Promise<void> {
  const client = getClient();

  try {
    await client.reactions.remove({
      channel: config.slack.channelId,
      timestamp: messageTs,
      name: emoji,
    });
  } catch (error) {
    // Might fail if reaction doesn't exist
    console.warn('Failed to remove reaction:', error);
  }
}

/**
 * Post an ephemeral message (only visible to one user)
 */
export async function postEphemeral(
  channelId: string,
  userId: string,
  text: string,
  blocks?: any[]
): Promise<void> {
  const client = getClient();

  await client.chat.postEphemeral({
    channel: channelId,
    user: userId,
    text,
    blocks,
  });
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
// Quiet Hours - Deferred Notification Release
// ============================================================================

// Hardening constants
const DEFERRED_LOOKBACK_HOURS = 48;  // Max 48 hours lookback for deferred notifications
const RELEASE_BATCH_SIZE = 5;        // Release in batches of 5
const RELEASE_DELAY_MS = 1000;       // 1 second delay between releases (avoid rate limits)

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
 * Find threads with deferred assignee notifications from quiet hours
 *
 * Hardening:
 * - Limited to 48-hour lookback window (no historical scan)
 * - Extracts Monday URL for direct linking
 * - Only returns threads with deferred marker but no notified marker
 */
export async function findDeferredNotifications(): Promise<DeferredNotification[]> {
  const client = getClient();
  const deferred: DeferredNotification[] = [];

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
        let alreadyNotified = false;

        for (const reply of threadResponse.messages) {
          // Skip non-bot messages
          if (reply.user !== botUserId || !reply.text) continue;

          // Check for deferred marker: [quiet-hours:deferred:USER_ID]
          const deferredMatch = reply.text.match(/\[quiet-hours:deferred:([^\]]+)\]/);
          if (deferredMatch) {
            deferredUserId = deferredMatch[1];
          }

          // Check for already notified marker
          if (reply.text.includes('[quiet-hours:notified]')) {
            alreadyNotified = true;
          }
        }

        // Add to list if deferred but not yet notified
        if (deferredUserId && !alreadyNotified) {
          // Extract Monday URL from parent message blocks
          const parentMessage = threadResponse.messages[0];
          const mondayUrl = extractMondayUrlFromBlocks(parentMessage?.blocks as any[]);

          deferred.push({
            threadTs: message.ts,
            assigneeSlackId: deferredUserId,
            mondayUrl,
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
 * Idempotency: Only posts [quiet-hours:notified] marker AFTER @mention succeeds.
 * If @mention fails, notification will be retried on next scheduler run.
 */
export async function releaseDeferredNotification(
  threadTs: string,
  assigneeSlackId: string,
  mondayUrl: string | null
): Promise<boolean> {
  try {
    // Build release message with optional Monday link
    const mondayLink = mondayUrl ? ` → <${mondayUrl}|View in Monday>` : '';

    // Notify assignee with @mention (this is the critical step)
    await postToThread(
      threadTs,
      `<@${assigneeSlackId}> 📬 _You have a new task from quiet hours._${mondayLink}`
    );

    // Only mark as notified AFTER @mention succeeds (idempotency guard)
    await postToThread(
      threadTs,
      `[quiet-hours:notified] _Assignee notified at business hour._`
    );

    return true;
  } catch (error) {
    // Do NOT mark as notified - will retry on next scheduler run
    console.error(`Failed to release deferred notification for thread ${threadTs}:`, error);
    return false;
  }
}

/**
 * Release all deferred notifications from quiet hours
 * Called at 10am Mon-Fri by scheduler
 *
 * Hardening:
 * - Processes in batches of 5 to avoid rate limits
 * - 1 second delay between releases
 * - Does NOT re-notify on-call user (they were already notified during quiet hours)
 *
 * Returns count of notifications released
 */
export async function releaseAllDeferredNotifications(): Promise<number> {
  console.log('Releasing deferred quiet-hours notifications...');

  const deferred = await findDeferredNotifications();

  if (deferred.length === 0) {
    console.log('No deferred notifications to release');
    return 0;
  }

  console.log(`Found ${deferred.length} deferred notification(s) to release`);

  let released = 0;
  let batchCount = 0;

  for (const notification of deferred) {
    const success = await releaseDeferredNotification(
      notification.threadTs,
      notification.assigneeSlackId,
      notification.mondayUrl
    );

    if (success) {
      released++;
    }

    batchCount++;

    // Rate limiting: delay between releases
    if (batchCount < deferred.length) {
      await sleep(RELEASE_DELAY_MS);
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
