/**
 * Relay Events Route
 *
 * Receives Slack events forwarded from our slack-relay hub.
 * Uses X-Relay-Secret header for authentication instead of Slack signature.
 */

import { Router, type Request, type Response } from 'express';
import express from 'express';
import * as sync from '../services/sync.js';
import * as slack from '../services/slack.js';
import { config } from '../config/environment.js';
import { isPendingIssueCall, claimIssueCall, isIssueCall, completeIssueCall } from '../services/issueCallTracker.js';

const router = Router();

// ============================================================================
// Types
// ============================================================================

interface SlackEvent {
  type: string;
  challenge?: string;
  event?: {
    type: string;
    user?: string;
    text?: string;
    thread_ts?: string;
    ts?: string;
    channel?: string;
    reaction?: string;
    item?: {
      type: string;
      ts: string;
      channel: string;
      thread_ts?: string;
    };
  };
}

// Track which threads we've already reminded (to avoid spamming)
const remindedThreads = new Set<string>();

/**
 * Handle replies in supporter channels
 * If the parent message is a supporter notification, remind user to post on Monday
 */
async function handleSupporterChannelReply(
  channelId: string,
  threadTs: string,
  userId: string
): Promise<void> {
  // Only remind once per thread
  const threadKey = `${channelId}:${threadTs}`;
  if (remindedThreads.has(threadKey)) {
    console.log('Already reminded this thread, skipping');
    return;
  }

  const client = slack.getClient();

  // Fetch the parent message to check if it's a supporter notification
  const result = await client.conversations.replies({
    channel: channelId,
    ts: threadTs,
    limit: 1,
  });

  if (!result.messages || result.messages.length === 0) {
    console.log('Could not fetch parent message');
    return;
  }

  const parentMessage = result.messages[0];
  const parentText = parentMessage.text || '';

  // Check for supporter notification marker
  const markerMatch = parentText.match(/\[supporter-notification:(\d+)\]/);
  if (!markerMatch) {
    console.log('Parent message is not a supporter notification');
    return;
  }

  const mondayItemId = markerMatch[1];
  const mondayLink = `${config.monday.boardUrl}/pulses/${mondayItemId}`;

  // Send reminder
  await client.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text: `👋 <@${userId}> Thanks for your input! Please add your update directly on <${mondayLink}|the Monday task> so it's visible to the whole team. This Slack channel isn't synced.`,
  });

  // Mark as reminded
  remindedThreads.add(threadKey);
  console.log(`Sent Monday reminder for thread ${threadTs}`);

  // Clean up old entries after 24 hours to prevent memory leak
  setTimeout(() => {
    remindedThreads.delete(threadKey);
  }, 24 * 60 * 60 * 1000);
}

// ============================================================================
// Route Handler
// ============================================================================

/**
 * POST /relay/events
 *
 * Receives Slack events forwarded from slack-relay hub
 * Authenticates via X-Relay-Secret header
 */
router.post('/relay/events', express.json(), async (req: Request, res: Response): Promise<void> => {
  console.log('=== Relay event received ===');

  // Verify relay secret
  const relaySecret = req.headers['x-relay-secret'] as string | undefined;
  const configuredSecret = config.relay.apiKey;

  if (!configuredSecret) {
    console.error('RELAY_API_KEY not configured');
    res.status(500).send('Relay not configured');
    return;
  }

  if (!relaySecret || relaySecret !== configuredSecret) {
    console.error('Invalid or missing X-Relay-Secret');
    res.status(401).send('Unauthorized');
    return;
  }

  const body = req.body as SlackEvent;

  try {
    console.log('Relay event type:', body.type, body.event?.type);

    // Handle URL verification challenge
    if (body.type === 'url_verification' && body.challenge) {
      res.json({ challenge: body.challenge });
      return;
    }

    // Acknowledge receipt immediately (return 200, process async)
    res.status(200).send();

    // Process event asynchronously
    if (body.type === 'event_callback' && body.event) {
      const event = body.event;

      // Handle thread replies - sync to Monday (main channel) or remind about Monday (supporter channels)
      if (event.type === 'message' && event.thread_ts && event.text && event.user && event.channel) {
        // Ignore bot messages to prevent loops - check both old and new format
        const isFromMonday = event.text.includes('(via Monday)') || event.text.startsWith('[From Monday');
        if (!isFromMonday && !event.text.includes('[supporter-notification:')) {
          // Check if this is an issue call thread being claimed
          if (isPendingIssueCall(event.thread_ts)) {
            console.log('Reply in issue call thread detected, claiming for user:', event.user);
            try {
              await claimIssueCall(event.thread_ts, event.user);
            } catch (err) {
              console.error('Failed to claim issue call:', err);
            }
          }
          // Check if this is in a supporter channel
          else {
            const supporterChannels = [
              config.slack.supporterPrimaryChannel,
              ...config.slack.supporterSecondaryChannels,
            ].filter(Boolean) as string[];

            if (supporterChannels.includes(event.channel)) {
              // This is a reply in a supporter channel - check if parent is a supporter notification
              console.log('Reply in supporter channel detected, checking parent message...');
              try {
                await handleSupporterChannelReply(event.channel, event.thread_ts, event.user);
              } catch (err) {
                console.error('Failed to handle supporter channel reply:', err);
              }
            } else {
              // Main channel - sync to Monday
              console.log('Slack thread reply detected (via relay):', {
                thread_ts: event.thread_ts,
                user: event.user,
                text: event.text.substring(0, 50),
              });
              try {
                await sync.syncSlackToMonday(event.thread_ts, event.text, event.user);
              } catch (syncError) {
                console.error('Failed to sync Slack to Monday:', syncError);
              }
            }
          }
        }
      }

      // Handle reaction added - 👀 = acknowledged, ✅ = complete
      if (event.type === 'reaction_added' && event.reaction && event.item && event.user) {
        if (event.reaction === 'eyes') {
          console.log('Eyes reaction added (via relay), marking Monday item acknowledged...');
          await sync.markAcknowledgedFromSlack(event.item.ts);

          // Check if this is an issue call being claimed via 👀 reaction
          const threadTs = event.item.thread_ts || event.item.ts;
          if (isPendingIssueCall(threadTs)) {
            console.log('Eyes reaction on issue call thread, claiming for user:', event.user);
            try {
              await claimIssueCall(threadTs, event.user);
            } catch (err) {
              console.error('Failed to claim issue call via reaction:', err);
            }
          }

          // Also handle after-hours acknowledgement tracking
          try {
            await slack.markThreadAcknowledged(threadTs);
            console.log(`After-hours ack tracked for thread ${threadTs}`);
          } catch (ackError) {
            console.log('After-hours ack tracking skipped (not a deferred task or already acked)');
          }
        } else if (
          ['white_check_mark', 'heavy_check_mark', 'ballot_box_with_check'].includes(event.reaction)
        ) {
          console.log('Checkmark reaction added (via relay), marking Monday item complete...');
          await sync.markCompleteFromSlack(event.item.ts);

          // Also handle after-hours done tracking
          const threadTs = event.item.thread_ts || event.item.ts;
          try {
            await slack.markThreadDone(threadTs);
            console.log(`After-hours done tracked for thread ${threadTs}`);
          } catch (doneError) {
            console.log('After-hours done tracking skipped (not a deferred task or already done)');
          }

          // Handle issue call completion
          if (isIssueCall(threadTs)) {
            console.log('Checkmark on issue call thread, marking complete:', event.user);
            try {
              await completeIssueCall(threadTs, event.user);
            } catch (err) {
              console.error('Failed to complete issue call:', err);
            }
          }
        }
      }

      // Handle reaction removed - undo completion
      if (event.type === 'reaction_removed' && event.reaction && event.item) {
        if (
          ['white_check_mark', 'heavy_check_mark', 'ballot_box_with_check'].includes(event.reaction)
        ) {
          console.log('Checkmark reaction removed (via relay), unmarking Monday item...');
          await sync.unmarkCompleteFromSlack(event.item.ts);
        }
      }
    }
  } catch (error) {
    console.error('Relay event error:', error);
    // Don't send error response - already sent 200
  }
});

export default router;
