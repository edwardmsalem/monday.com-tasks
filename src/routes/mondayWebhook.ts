/**
 * Monday.com Webhook Route
 *
 * Handles incoming Monday.com webhooks:
 * - Status changes (mark complete)
 * - Item updates (comments sync to Slack)
 * - Direct item creation detection (send guidance)
 */

import { Router, type Request, type Response } from 'express';
import express from 'express';
import { config } from '../config/environment.js';
import * as monday from '../services/monday.js';
import * as slack from '../services/slack.js';
import * as sync from '../services/sync.js';
import { getDmCooldown, setDmCooldown, DM_COOLDOWN_TTL } from '../services/pendingState.js';

const router = Router();

// ============================================================================
// Types
// ============================================================================

interface MondayWebhook {
  challenge?: string;
  event?: {
    type: string;
    pulseId?: number;
    pulseName?: string;
    columnId?: string;
    value?: {
      label?: { text: string };
    };
    previousValue?: {
      label?: { text: string };
    };
    userId?: number;
    textBody?: string;
    boardId?: number;
  };
}

// ============================================================================
// DM Cooldown Helpers
// ============================================================================

const DM_COOLDOWN_MS = DM_COOLDOWN_TTL;

/**
 * Check if a user is on DM cooldown
 */
function isOnDmCooldown(slackUserId: string): boolean {
  const lastDm = getDmCooldown(slackUserId);
  if (!lastDm) return false;
  return Date.now() - lastDm < DM_COOLDOWN_MS;
}

/**
 * Record that we sent a DM to a user (persisted to disk)
 */
function recordDmSent(slackUserId: string): void {
  setDmCooldown(slackUserId, Date.now());
}

/**
 * Send guidance DM to a user who created an item directly in Monday
 * This is informational, not an error.
 * Includes 24-hour cooldown per user to prevent spam.
 */
async function sendDirectCreationGuidance(mondayUserId: number): Promise<void> {
  try {
    const mondayUser = await monday.getUser(mondayUserId);
    if (!mondayUser?.email) {
      console.log(`Cannot send guidance: no email for Monday user ${mondayUserId}`);
      return;
    }

    const { findUserByEmail } = await import('../services/userResolver.js');
    const user = await findUserByEmail(mondayUser.email);

    if (!user?.slackId) {
      console.log(`Cannot send guidance: no Slack ID for ${mondayUser.email}`);
      return;
    }

    if (isOnDmCooldown(user.slackId)) {
      console.log(`Skipping guidance DM to ${user.name} - on 24h cooldown`);
      return;
    }

    const client = slack.getClient();
    await client.chat.postMessage({
      channel: user.slackId,
      text:
        `📋 *Task Creation Guidance*\n\n` +
        `I noticed you created a task directly in Monday.com.\n\n` +
        `To keep everything in sync, please use one of these methods:\n` +
        `• *Email:* Forward emails to the forwarding inbox\n` +
        `• *Slack:* Use the \`/task\` command\n\n` +
        `This ensures tasks have proper tracking, Slack threads, and Run IDs.\n\n` +
        `_This is just a friendly reminder – your task was still created._`,
    });

    recordDmSent(user.slackId);
    console.log(`Sent direct creation guidance to ${user.name}`);
  } catch (error) {
    console.error('Failed to send direct creation guidance:', error);
  }
}

// ============================================================================
// Route Handler
// ============================================================================

/**
 * POST /webhook/monday
 *
 * Monday.com webhook handler
 * Handles: status changes, item updates, direct item creation detection
 */
router.post('/webhook/monday', express.json(), async (req: Request, res: Response): Promise<void> => {
  try {
    const body = req.body as MondayWebhook;

    // Handle challenge verification
    if (body.challenge) {
      res.json({ challenge: body.challenge });
      return;
    }

    // Acknowledge receipt
    res.status(200).send();

    if (body.event) {
      const event = body.event;

      // Handle direct item creation - send guidance to user
      if (event.type === 'create_item' && event.pulseId && event.userId) {
        console.log(
          `Item ${event.pulseId} created by user ${event.userId}, checking if direct creation...`
        );

        // Wait 5 seconds for automated workflow to populate Run ID and Source
        setTimeout(async () => {
          try {
            const automation = await monday.checkItemAutomation(String(event.pulseId));

            if (!automation.isAutomated && event.userId) {
              console.log(
                `Item ${event.pulseId} not automated (Run ID: ${automation.hasRunId}, Source: ${automation.source}) - sending guidance`
              );
              await sendDirectCreationGuidance(event.userId);
            } else if (automation.isAutomated) {
              console.log(
                `Item ${event.pulseId} is automated (Run ID: ${automation.hasRunId}, Source: ${automation.source}) - no guidance needed`
              );
            }
          } catch (error) {
            console.error('Error checking for direct creation:', error);
          }
        }, 5000);
      }

      // Handle workflow status change to "Complete"
      if (
        event.type === 'change_column_value' &&
        event.columnId === config.monday.columns.workflowStatus
      ) {
        const newStatus = event.value?.label?.text;
        const oldStatus = event.previousValue?.label?.text;

        if (newStatus === 'Complete' && oldStatus !== 'Complete' && event.pulseId) {
          console.log('Monday item marked as Complete, notifying Slack...');
          const mondayUser = event.userId ? await monday.getUser(event.userId) : null;
          await sync.notifySlackOfCompletion(String(event.pulseId), mondayUser?.name ?? 'Someone');
        }
      }

      // Handle item updates (comments)
      if (event.type === 'create_update' && event.pulseId && event.textBody && event.userId) {
        // Only sync if not from Slack (avoid loops)
        if (!event.textBody.startsWith('[From Slack')) {
          console.log('Monday update created, syncing to Slack...');
          await sync.syncMondayToSlack(String(event.pulseId), event.textBody, event.userId);
        }
      }
    }
  } catch (error) {
    console.error('Monday webhook error:', error);
  }
});

export default router;
