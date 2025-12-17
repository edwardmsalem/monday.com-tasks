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

interface SlackNotificationInput {
  taskType: string;
  subject: string;
  assigneeSlackId: string;
  dueDate: string;
  notes: string;
  fromEmail: string | null;
  toEmail: string | null;
  mondayItemId: string;
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
    {
      type: 'divider',
    },
    {
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
    },
  ];

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
