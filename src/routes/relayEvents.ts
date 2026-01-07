/**
 * Relay Events Route
 *
 * Receives Slack events forwarded from our slack-relay hub.
 * Uses X-Relay-Secret header for authentication instead of Slack signature.
 */

import { Router, type Request, type Response } from 'express';
import express from 'express';
import * as sync from '../services/sync.js';
import { config } from '../config/environment.js';
import { isPendingIssueCall, claimIssueCall, isIssueCall, completeIssueCall } from '../services/issueCallTracker.js';
import { handleInteractivityPayload, type InteractivityPayload } from './interactivity.js';

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
    bot_id?: string; // Present if message is from a bot
    subtype?: string; // 'bot_message' for bot messages
    files?: Array<{
      id: string;
      name: string;
      mimetype: string;
      url_private: string;
      size?: number;
    }>;
    item?: {
      type: string;
      ts: string;
      channel: string;
      thread_ts?: string;
    };
  };
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

  const body = req.body;

  try {
    console.log('Relay event type:', body.type, body.event?.type);

    // Handle URL verification challenge
    if (body.type === 'url_verification' && body.challenge) {
      res.json({ challenge: body.challenge });
      return;
    }

    // Handle interactivity payloads (block_actions, view_submission)
    if (body.type === 'block_actions' || body.type === 'view_submission') {
      // Acknowledge immediately
      res.status(200).send();

      // Process interactivity asynchronously
      try {
        await handleInteractivityPayload(body as InteractivityPayload);
      } catch (error) {
        console.error('[Relay] Error handling interactivity:', error);
      }
      return;
    }

    // Acknowledge receipt immediately (return 200, process async)
    res.status(200).send();

    // Process Slack events asynchronously
    if (body.type === 'event_callback' && body.event) {
      const event = body.event;

      // Handle thread replies - sync to Monday
      if (event.type === 'message' && event.thread_ts && event.text && event.user && event.channel) {
        // Ignore bot messages to prevent loops
        if (event.bot_id || event.subtype === 'bot_message') {
          console.log('Ignoring bot message (via relay), not syncing to Monday');
          return;
        }
        // Also check text content for Monday sync markers
        const isFromMonday = event.text.includes('(via Monday)') || event.text.startsWith('[From Monday');
        if (!isFromMonday) {
          // Check if this is an issue call thread being claimed
          if (isPendingIssueCall(event.thread_ts)) {
            console.log('Reply in issue call thread detected, claiming for user:', event.user);
            try {
              await claimIssueCall(event.thread_ts, event.user);
            } catch (err) {
              console.error('Failed to claim issue call:', err);
            }
          } else {
            // Sync to Monday
            console.log('Slack thread reply detected (via relay):', {
              channel: event.channel,
              thread_ts: event.thread_ts,
              user: event.user,
              text: event.text.substring(0, 50),
              fileCount: event.files?.length ?? 0,
            });
            try {
              await sync.syncSlackToMonday(event.thread_ts, event.text, event.user, event.channel, event.files);
            } catch (syncError) {
              console.error('Failed to sync Slack to Monday:', syncError);
            }
          }
        }
      }

      // Handle reaction added - 👀 = acknowledged, ✅ = complete
      if (event.type === 'reaction_added' && event.reaction && event.item && event.user) {
        // Use thread_ts if available (reaction on a reply), otherwise item.ts (reaction on parent)
        // Monday items are linked to the parent thread timestamp
        const threadTs = event.item.thread_ts || event.item.ts;
        const channelId = event.item.channel;

        console.log(`Reaction event received (via relay):`, {
          reaction: event.reaction,
          channelId,
          threadTs,
          itemTs: event.item.ts,
          itemThreadTs: event.item.thread_ts,
          user: event.user,
        });

        if (event.reaction === 'eyes') {
          console.log(`Eyes reaction added (via relay) in channel ${channelId}, looking up Monday item for thread ${threadTs}...`);
          try {
            await sync.markAcknowledgedFromSlack(threadTs, channelId);
          } catch (ackError) {
            console.error('Failed to mark acknowledged from eyes reaction (relay):', ackError);
          }

          // Check if this is an issue call being claimed via 👀 reaction
          if (isPendingIssueCall(threadTs)) {
            console.log('Eyes reaction on issue call thread, claiming for user:', event.user);
            try {
              await claimIssueCall(threadTs, event.user);
            } catch (err) {
              console.error('Failed to claim issue call via reaction:', err);
            }
          }

        } else if (
          ['white_check_mark', 'heavy_check_mark', 'ballot_box_with_check', 'large_green_circle'].includes(event.reaction)
        ) {
          console.log(`Complete reaction added (via relay) in channel ${channelId}, marking Monday item complete...`);
          await sync.markCompleteFromSlack(threadTs, channelId, event.user);

          // Handle issue call completion
          if (isIssueCall(threadTs)) {
            console.log('Complete reaction on issue call thread, marking complete:', event.user);
            try {
              await completeIssueCall(threadTs, event.user);
            } catch (err) {
              console.error('Failed to complete issue call:', err);
            }
          }
        } else if (event.reaction === 'large_yellow_circle') {
          // 🟡 = Working on it
          console.log(`Yellow circle reaction added (via relay) in channel ${channelId}, marking Monday item as Working on it...`);
          try {
            await sync.markWorkingFromSlack(threadTs, channelId, event.user);
          } catch (err) {
            console.error('Failed to mark working from yellow circle reaction:', err);
          }
        } else if (event.reaction === 'red_circle') {
          // 🔴 = Stuck
          console.log(`Red circle reaction added (via relay) in channel ${channelId}, marking Monday item as Stuck...`);
          try {
            await sync.markStuckFromSlack(threadTs, channelId, event.user);
          } catch (err) {
            console.error('Failed to mark stuck from red circle reaction:', err);
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
