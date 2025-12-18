import { WebClient, type ChatPostMessageResponse } from '@slack/web-api';
import { config } from '../config/environment.js';
import type { SlackMessage } from '../types/index.js';
import * as monday from './monday.js';

let slackClient: WebClient | null = null;

function getClient(): WebClient {
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
 */
export async function sendNotification(input: SlackNotificationInput): Promise<SlackMessage> {
  const client = getClient();
  const mondayUrl = monday.getItemUrl(input.mondayItemId);

  // Build Block Kit message
  const blocks = [
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
          text: `*Assigned to:*\n<@${input.assigneeSlackId}>`,
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
  const fallbackText = `New ${input.taskType} Email: ${input.subject} - Assigned to <@${input.assigneeSlackId}> - Due: ${input.dueDate}`;

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

  return {
    ts: response.ts,
    channel: response.channel ?? config.slack.channelId,
  };
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
  blocks?: unknown[]
): Promise<SlackMessage> {
  const client = getClient();

  const response = await client.chat.postMessage({
    channel: config.slack.channelId,
    thread_ts: threadTs,
    text,
    blocks: blocks as ChatPostMessageResponse['blocks'],
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
  blocks?: unknown[]
): Promise<void> {
  const client = getClient();

  await client.chat.postEphemeral({
    channel: channelId,
    user: userId,
    text,
    blocks: blocks as ChatPostMessageResponse['blocks'],
  });
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
