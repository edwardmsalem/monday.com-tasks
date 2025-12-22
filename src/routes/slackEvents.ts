/**
 * Slack Events API Route
 *
 * Handles incoming Slack events:
 * - Thread replies (sync to Monday)
 * - Reaction added (acknowledge/complete)
 * - Reaction removed (undo completion)
 * - URL verification challenge
 */

import { Router, type Request, type Response } from 'express';
import express from 'express';
import * as sync from '../services/sync.js';
import * as slack from '../services/slack.js';
import { verifySlackSignature, type SlackRequest } from './middleware.js';

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

// ============================================================================
// Middleware
// ============================================================================

// Raw body parser for Slack signature verification
router.use('/webhook/slack/events', express.raw({ type: 'application/json' }));

// ============================================================================
// Route Handler
// ============================================================================

/**
 * POST /webhook/slack/events
 *
 * Slack Events API webhook
 * Handles: message events (thread replies), reaction events (checkmarks)
 */
router.post('/webhook/slack/events', async (req: Request, res: Response): Promise<void> => {
  console.log('=== Slack event received ===');

  // Verify Slack signature first (QW-07)
  if (!verifySlackSignature(req as SlackRequest)) {
    res.status(401).send('Invalid signature');
    return;
  }

  // Parse JSON with explicit error handling (QW-01)
  let body: SlackEvent;
  try {
    body = JSON.parse(req.body.toString()) as SlackEvent;
  } catch (parseError) {
    console.error('Invalid Slack event JSON:', parseError);
    res.status(400).send('Invalid JSON');
    return;
  }

  try {
    console.log('Slack event type:', body.type, body.event?.type);

    // Handle URL verification challenge
    if (body.type === 'url_verification' && body.challenge) {
      res.json({ challenge: body.challenge });
      return;
    }

    // Acknowledge receipt immediately (Slack requires response within 3s)
    res.status(200).send();

    // Process event asynchronously
    if (body.type === 'event_callback' && body.event) {
      const event = body.event;

      // Handle thread replies - sync to Monday
      if (event.type === 'message' && event.thread_ts && event.text && event.user) {
        // Ignore bot messages to prevent loops
        if (!event.text.startsWith('[From Monday')) {
          console.log('Slack thread reply detected:', {
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

      // Handle reaction added - 👀 = acknowledged, ✅ = complete
      if (event.type === 'reaction_added' && event.reaction && event.item) {
        if (event.reaction === 'eyes') {
          console.log('Eyes reaction added, marking Monday item acknowledged...');
          await sync.markAcknowledgedFromSlack(event.item.ts);

          // Also handle after-hours acknowledgement tracking
          const threadTs = event.item.thread_ts || event.item.ts;
          try {
            await slack.markThreadAcknowledged(threadTs);
            console.log(`After-hours ack tracked for thread ${threadTs}`);
          } catch (ackError) {
            console.log('After-hours ack tracking skipped (not a deferred task or already acked)');
          }
        } else if (
          ['white_check_mark', 'heavy_check_mark', 'ballot_box_with_check'].includes(event.reaction)
        ) {
          console.log('Checkmark reaction added, marking Monday item complete...');
          await sync.markCompleteFromSlack(event.item.ts);

          // Also handle after-hours done tracking
          const threadTs = event.item.thread_ts || event.item.ts;
          try {
            await slack.markThreadDone(threadTs);
            console.log(`After-hours done tracked for thread ${threadTs}`);
          } catch (doneError) {
            console.log('After-hours done tracking skipped (not a deferred task or already done)');
          }
        }
      }

      // Handle reaction removed - undo completion
      if (event.type === 'reaction_removed' && event.reaction && event.item) {
        if (
          ['white_check_mark', 'heavy_check_mark', 'ballot_box_with_check'].includes(event.reaction)
        ) {
          console.log('Checkmark reaction removed, unmarking Monday item...');
          await sync.unmarkCompleteFromSlack(event.item.ts);
        }
      }
    }
  } catch (error) {
    console.error('Slack event error:', error);
    // Don't send error response - already sent 200
  }
});

export default router;
