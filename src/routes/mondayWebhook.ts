/**
 * Monday.com Webhook Route
 *
 * Handles incoming Monday.com webhooks:
 * - Status changes (mark complete)
 * - Item updates (comments sync to Slack)
 * - Direct item creation detection (send guidance)
 * - Support column changes (notify new supporters)
 */

import { Router, type Request, type Response } from 'express';
import express from 'express';
import { config } from '../config/environment.js';
import * as monday from '../services/monday.js';
import * as slack from '../services/slack.js';
import * as sync from '../services/sync.js';
import { handleAssociateLink, ASSOCIATE_LINK_TRIGGER } from '../services/associateLink.js';
import { handleSsNumberRequest, SS_NUMBER_TRIGGER } from '../services/ssNumberRequest.js';
import { getDmCooldown, setDmCooldown, DM_COOLDOWN_TTL } from '../services/pendingState.js';

const router = Router();

// ============================================================================
// Types
// ============================================================================

interface PersonColumnValue {
  personsAndTeams?: Array<{ id: number; kind: string }>;
}

interface StatusColumnValue {
  label?: { text: string };
}

interface MondayWebhook {
  challenge?: string;
  event?: {
    type: string;
    pulseId?: number;
    pulseName?: string;
    columnId?: string;
    value?: StatusColumnValue | PersonColumnValue;
    previousValue?: StatusColumnValue | PersonColumnValue;
    userId?: number;
    textBody?: string;
    boardId?: number;
    id?: number;  // Update ID for create_update events
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

/**
 * Parse Monday person IDs from a person column value
 */
function parsePersonIds(value: PersonColumnValue | StatusColumnValue | undefined): number[] {
  if (!value) return [];
  const personValue = value as PersonColumnValue;
  if (!personValue.personsAndTeams) return [];
  return personValue.personsAndTeams
    .filter(p => p.kind === 'person')
    .map(p => p.id);
}

/**
 * Notify newly added supporters via DM
 * Called when the support column changes on a task
 */
async function notifyNewSupporters(
  pulseId: number,
  newPersonIds: number[],
  oldPersonIds: number[]
): Promise<void> {
  // Find newly added supporters (in new but not in old)
  const addedIds = newPersonIds.filter(id => !oldPersonIds.includes(id));

  if (addedIds.length === 0) {
    console.log(`[SupporterWebhook] No new supporters added to item ${pulseId}`);
    return;
  }

  console.log(`[SupporterWebhook] ${addedIds.length} new supporter(s) added to item ${pulseId}: ${addedIds.join(', ')}`);

  // Get task details for the notification
  const taskDetails = await monday.getTaskDetailsForSupporterNotification(String(pulseId));
  if (!taskDetails) {
    console.error(`[SupporterWebhook] Could not get task details for item ${pulseId}`);
    return;
  }

  // Map urgency to priority
  const priorityMap: Record<string, 'high' | 'medium' | 'low'> = {
    'High': 'high',
    'Medium': 'medium',
    'Low': 'low',
  };
  const priority = priorityMap[taskDetails.urgency] || 'medium';

  // Get Monday users and Slack users for mapping
  const { findUserByEmail } = await import('../services/userResolver.js');
  const mondayUsers = await monday.getAllUsers();

  for (const mondayUserId of addedIds) {
    try {
      // Find the Monday user - try cached list first, then direct lookup
      let mondayUser = mondayUsers.find(u => u.id === mondayUserId);
      if (!mondayUser?.email) {
        // Fallback: fetch user directly from Monday API
        console.log(`[SupporterWebhook] User ${mondayUserId} not in cache, fetching directly...`);
        mondayUser = await monday.getUser(mondayUserId) ?? undefined;
      }
      if (!mondayUser?.email) {
        console.log(`[SupporterWebhook] No email for Monday user ${mondayUserId}`);
        continue;
      }

      // Find the Slack user
      const user = await findUserByEmail(mondayUser.email);
      if (!user?.slackId) {
        console.log(`[SupporterWebhook] No Slack ID for ${mondayUser.email}`);
        continue;
      }

      // Send the notification DM
      const success = await slack.sendSupporterNotificationDM(
        user.slackId,
        user.name,
        {
          taskSubject: taskDetails.taskSubject,
          taskType: taskDetails.taskType,
          ownerName: taskDetails.ownerName,
          dueDate: taskDetails.dueDate,
          priority,
        },
        String(pulseId),
        taskDetails.assigneeSlackIds
      );

      if (success) {
        console.log(`[SupporterWebhook] Notified ${user.name} about being added to item ${pulseId}`);
      }
    } catch (error) {
      console.error(`[SupporterWebhook] Error notifying user ${mondayUserId}:`, error);
    }
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
    console.log('[Monday Webhook] Received:', JSON.stringify(req.body, null, 2));

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
        const statusValue = event.value as StatusColumnValue | undefined;
        const prevStatusValue = event.previousValue as StatusColumnValue | undefined;
        const newStatus = statusValue?.label?.text;
        const oldStatus = prevStatusValue?.label?.text;

        if (newStatus === 'Complete' && oldStatus !== 'Complete' && event.pulseId) {
          console.log('Monday item marked as Complete, notifying Slack...');
          const mondayUser = event.userId ? await monday.getUser(event.userId) : null;
          await sync.notifySlackOfCompletion(String(event.pulseId), mondayUser?.name ?? 'Someone');
        }
      }

      // Handle support column change - notify newly added supporters
      if (
        event.type === 'update_column_value' &&
        event.columnId === config.monday.columns.support &&
        event.pulseId
      ) {
        console.log(`[SupporterWebhook] Support column changed on item ${event.pulseId}`);
        const newPersonIds = parsePersonIds(event.value);
        const oldPersonIds = parsePersonIds(event.previousValue);
        await notifyNewSupporters(event.pulseId, newPersonIds, oldPersonIds);
      }

      // Handle "Associate" link change on the Master Numbers board.
      // Stamps the number onto the associate and reflects the link state.
      // Replaces Bod's Sim-Directory associate automation. (Different board
      // than this service's own, matched on boardId + columnId.)
      // Match on board + column only. Any column-change event carries columnId,
      // and Monday's delivered type string varies by subscription, so keying on
      // the column avoids a silent miss. handleAssociateLink no-ops if unchanged.
      if (
        event.boardId === ASSOCIATE_LINK_TRIGGER.boardId &&
        event.columnId === ASSOCIATE_LINK_TRIGGER.columnId
      ) {
        console.log(`[AssociateLink] Trigger on item ${event.pulseId}`);
        await handleAssociateLink(event);
      }

      // Handle "Status" change to "Request Setup" on the Leads board -> create
      // an SS number (allocate a SIM + run the Unavo swap on farm-b). Gated by
      // SS_NUMBER_FLOW_ENABLED; dry-run otherwise. Matched on board + column.
      if (
        event.boardId === SS_NUMBER_TRIGGER.boardId &&
        event.columnId === SS_NUMBER_TRIGGER.columnId
      ) {
        console.log(`[SsNumber] Trigger on lead ${event.pulseId}`);
        await handleSsNumberRequest(event);
      }

      // Handle item updates (comments)
      if (event.type === 'create_update' && event.pulseId && event.textBody && event.userId) {
        // Only sync if not from Slack (avoid loops) - check both old and new format
        const isFromSlack = event.textBody.includes('(via Slack)') || event.textBody.startsWith('[From Slack');
        if (!isFromSlack) {
          console.log('Monday update created, syncing to Slack...', { updateId: event.id });
          const updateId = event.id ? String(event.id) : undefined;
          await sync.syncMondayToSlack(String(event.pulseId), event.textBody, event.userId, updateId);
        }
      }
    }
  } catch (error) {
    console.error('Monday webhook error:', error);
  }
});

export default router;
