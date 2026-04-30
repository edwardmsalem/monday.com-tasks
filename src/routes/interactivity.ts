/**
 * Slack Interactivity Webhook
 *
 * Receives POST requests when users:
 * - Click buttons
 * - Submit modals
 * - Use select menus
 *
 * Slack sends payload as application/x-www-form-urlencoded with a "payload" field
 * containing JSON.
 */

import { Router, Request, Response } from 'express';
import { WebClient } from '@slack/web-api';
import { config, configCompat } from '../config/environment.js';
import * as monday from '../services/monday.js';
import * as slack from '../services/slack.js';
import {
  recordTaskAcknowledgment,
  setTaskStatus,
} from '../services/digestState.js';
import { sendCrossNotificationDM } from '../services/slack.js';

const router = Router();
const slackClient = new WebClient(config.slack.botToken);

// ============================================================================
// Types
// ============================================================================

export interface InteractivityPayload {
  type: 'block_actions' | 'view_submission' | 'shortcut';
  user: {
    id: string;
    username: string;
    name: string;
  };
  trigger_id: string;
  response_url?: string;
  actions?: Array<{
    action_id: string;
    block_id: string;
    value: string;
    type: string;
  }>;
  view?: {
    id: string;
    callback_id: string;
    state: {
      values: Record<string, Record<string, any>>;
    };
    private_metadata?: string;
  };
  container?: {
    type: string;
    message_ts: string;
    channel_id: string;
    thread_ts?: string;
  };
  channel?: {
    id: string;
  };
  message?: {
    ts: string;
    thread_ts?: string;
  };
}

// ============================================================================
// Main Handler
// ============================================================================

router.post('/webhook/slack/interactivity', async (req: Request, res: Response): Promise<void> => {
  try {
    // Slack sends payload as form-encoded
    const payloadString = req.body.payload;
    if (!payloadString) {
      res.status(400).send('Missing payload');
      return;
    }

    const payload: InteractivityPayload = JSON.parse(payloadString);

    console.log('[Interactivity] Received:', {
      type: payload.type,
      user: payload.user.id,
      actions: payload.actions?.map((a) => a.action_id),
    });

    // Acknowledge immediately (Slack requires response within 3 seconds)
    res.status(200).send();

    // Route to appropriate handler
    if (payload.type === 'block_actions' && payload.actions) {
      for (const action of payload.actions) {
        await handleBlockAction(payload, action);
      }
    } else if (payload.type === 'view_submission' && payload.view) {
      await handleViewSubmission(payload);
    }
  } catch (error) {
    console.error('[Interactivity] Error:', error);
    // Don't send error response - already sent 200
  }
});

// ============================================================================
// Block Action Handlers
// ============================================================================

async function handleBlockAction(
  payload: InteractivityPayload,
  action: { action_id: string; block_id: string; value: string }
): Promise<void> {
  const { action_id, value } = action;
  const userId = payload.user.id;

  // Get thread info for posting confirmations
  const channelId = payload.channel?.id || payload.container?.channel_id;
  const threadTs =
    payload.message?.thread_ts || payload.message?.ts || payload.container?.message_ts;

  console.log(`[Interactivity] Action: ${action_id}, Value: ${value}, User: ${userId}`);

  switch (action_id) {
    case 'task_acknowledge':
      await handleTaskAcknowledge(value, userId, channelId, threadTs);
      break;

    case 'task_working':
      await handleTaskWorking(value, userId, channelId, threadTs);
      break;

    case 'task_complete':
      await handleTaskComplete(value, userId, channelId, threadTs);
      break;

    case 'task_stuck':
      await handleTaskStuck(value, userId, channelId, threadTs);
      break;

    case 'task_confirm_today':
      await handleTaskConfirmToday(value, userId, channelId, threadTs);
      break;

    case 'task_reschedule':
      await handleTaskReschedule(value, userId, payload.trigger_id);
      break;

    case 'issue_call_claim':
      await handleIssueCallClaim(value, userId, channelId, threadTs);
      break;

    case 'issue_call_working':
      await handleIssueCallWorking(value, userId, channelId, threadTs);
      break;

    case 'issue_call_complete':
      await handleIssueCallComplete(value, userId, channelId, threadTs);
      break;

    case 'issue_call_stuck':
      await handleIssueCallStuck(value, userId, channelId, threadTs);
      break;

    case 'claim_email_task':
      await handleClaimEmailTask(payload, action);
      break;

    default:
      console.log(`[Interactivity] Unknown action: ${action_id}`);
  }
}

// ============================================================================
// Task Action Handlers
// ============================================================================

/**
 * Parse acknowledge button value to extract task ID and assignee Slack IDs
 * Format: taskId|slackId1,slackId2,slackId3 or just taskId (legacy)
 */
function parseAcknowledgeValue(value: string): { taskId: string; assigneeSlackIds: string[] } {
  const parts = value.split('|');
  const taskId = parts[0];
  const assigneeSlackIds = parts[1] ? parts[1].split(',').filter((id) => id) : [];
  return { taskId, assigneeSlackIds };
}

/**
 * Get task info from Monday for cross-notifications
 * Returns task name and all assignee Slack IDs
 */
async function getTaskInfoForCrossNotify(
  mondayItemId: string
): Promise<{ taskName: string; assigneeSlackIds: string[] } | null> {
  try {
    const taskInfo = await monday.getTaskAssignees(mondayItemId);
    if (!taskInfo) return null;

    return {
      taskName: taskInfo.name,
      assigneeSlackIds: taskInfo.assigneeSlackIds,
    };
  } catch (error) {
    console.error(`[Interactivity] Failed to get task info for ${mondayItemId}:`, error);
    return null;
  }
}

/**
 * Get the owner's thread info for a task
 * Always posts confirmations to the owner's thread, regardless of where button was clicked
 */
async function getOwnerThreadInfo(
  mondayItemId: string
): Promise<{ channelId: string; threadTs: string } | null> {
  try {
    const threadInfo = await monday.getSlackThreadInfo(mondayItemId);
    if (!threadInfo) {
      console.log(`[Interactivity] No owner thread found for task ${mondayItemId}`);
      return null;
    }
    return {
      channelId: threadInfo.channelId,
      threadTs: threadInfo.threadTs,
    };
  } catch (error) {
    console.error(`[Interactivity] Failed to get owner thread for ${mondayItemId}:`, error);
    return null;
  }
}

async function handleTaskAcknowledge(
  value: string,
  userId: string,
  _channelId?: string,
  _threadTs?: string
): Promise<void> {
  try {
    const { taskId, assigneeSlackIds } = parseAcknowledgeValue(value);

    // Get owner's thread for posting confirmations
    const ownerThread = await getOwnerThreadInfo(taskId);

    // If we have assignee info, use per-user acknowledgment tracking
    if (assigneeSlackIds.length > 0) {
      // Record this user's acknowledgment
      const result = recordTaskAcknowledgment(taskId, userId, assigneeSlackIds);

      if (result.fullyAcknowledged) {
        // All assignees have acknowledged - update Monday status
        await monday.updateWorkflowStatus(taskId, 'Acknowledged');

        // Always post to owner's thread
        if (ownerThread) {
          await slack.postToThread(
            ownerThread.threadTs,
            `👀 Fully acknowledged - all assignees confirmed`,
            ownerThread.channelId
          );
        }
        console.log(`[Interactivity] Task ${taskId} fully acknowledged by all assignees`);
      } else {
        // Partial acknowledgment - show who's still waiting
        const waitingMentions = result.waitingOn.map((id) => `<@${id}>`).join(', ');

        // Post to owner's thread
        if (ownerThread) {
          await slack.postToThread(
            ownerThread.threadTs,
            `👀 <@${userId}> acknowledged, waiting on ${waitingMentions}`,
            ownerThread.channelId
          );
        }
        console.log(
          `[Interactivity] Task ${taskId} acknowledged by ${userId}, waiting on ${result.waitingOn.length} more`
        );
      }
    } else {
      // Legacy behavior - no assignee info, just acknowledge
      await monday.updateWorkflowStatus(taskId, 'Acknowledged');

      // Post to owner's thread
      if (ownerThread) {
        await slack.postToThread(ownerThread.threadTs, `👀 Acknowledged by <@${userId}>`, ownerThread.channelId);
      }

      console.log(`[Interactivity] Task ${taskId} acknowledged by ${userId} (legacy)`);
    }
  } catch (error) {
    console.error(`[Interactivity] Failed to acknowledge task:`, error);
  }
}

async function handleTaskWorking(
  mondayItemId: string,
  userId: string,
  _channelId?: string,
  _threadTs?: string
): Promise<void> {
  try {
    // Get owner's thread for posting confirmations
    const ownerThread = await getOwnerThreadInfo(mondayItemId);

    // First-one-wins: check if status already set
    const statusResult = setTaskStatus(mondayItemId, 'working', userId);

    if (statusResult.success) {
      // This user is the first to set status
      await monday.updateWorkflowStatus(mondayItemId, 'Working on it');

      // Always post to owner's thread
      if (ownerThread) {
        await slack.postToThread(ownerThread.threadTs, `🟡 Working on it - <@${userId}>`, ownerThread.channelId);
      }

      console.log(`[Interactivity] Task ${mondayItemId} marked working by ${userId}`);
    } else {
      // Status was already set by someone else
      const existing = statusResult.existingStatus!;
      console.log(
        `[Interactivity] Task ${mondayItemId} already has status ${existing.status} set by ${existing.setBy}`
      );

      // Post to owner's thread
      if (ownerThread) {
        await slack.postToThread(
          ownerThread.threadTs,
          `ℹ️ Status already set to ${existing.status} by <@${existing.setBy}>`,
          ownerThread.channelId
        );
      }
    }
  } catch (error) {
    console.error(`[Interactivity] Failed to mark task ${mondayItemId} working:`, error);
  }
}

async function handleTaskComplete(
  mondayItemId: string,
  userId: string,
  _channelId?: string,
  _threadTs?: string
): Promise<void> {
  try {
    // Get owner's thread for posting confirmations
    const ownerThread = await getOwnerThreadInfo(mondayItemId);

    // First-one-wins: check if status already set
    const statusResult = setTaskStatus(mondayItemId, 'complete', userId);

    if (statusResult.success) {
      // This user is the first to set status
      await monday.updateWorkflowStatus(mondayItemId, 'Done');

      // Always post to owner's thread
      if (ownerThread) {
        await slack.postToThread(ownerThread.threadTs, `✅ Completed by <@${userId}>`, ownerThread.channelId);
      }

      console.log(`[Interactivity] Task ${mondayItemId} completed by ${userId}`);

      // Send cross-notification DMs to other assignees
      const taskInfo = await getTaskInfoForCrossNotify(mondayItemId);
      if (taskInfo && taskInfo.assigneeSlackIds.length > 1) {
        await sendCrossNotificationDM(
          mondayItemId,
          'complete',
          userId,
          taskInfo.assigneeSlackIds,
          taskInfo.taskName
        );
      }
    } else {
      // Status was already set by someone else
      const existing = statusResult.existingStatus!;
      console.log(
        `[Interactivity] Task ${mondayItemId} already has status ${existing.status} set by ${existing.setBy}`
      );

      // Post to owner's thread
      if (ownerThread) {
        await slack.postToThread(
          ownerThread.threadTs,
          `ℹ️ Status already set to ${existing.status} by <@${existing.setBy}>`,
          ownerThread.channelId
        );
      }
    }
  } catch (error) {
    console.error(`[Interactivity] Failed to complete task ${mondayItemId}:`, error);
  }
}

async function handleTaskStuck(
  mondayItemId: string,
  userId: string,
  _channelId?: string,
  _threadTs?: string
): Promise<void> {
  try {
    // Get owner's thread for posting confirmations
    const ownerThread = await getOwnerThreadInfo(mondayItemId);

    // First-one-wins: check if status already set
    const statusResult = setTaskStatus(mondayItemId, 'stuck', userId);

    if (statusResult.success) {
      // This user is the first to set status
      await monday.updateWorkflowStatus(mondayItemId, 'Stuck');

      // Always post to owner's thread
      if (ownerThread) {
        await slack.postToThread(ownerThread.threadTs, `🔴 Stuck - <@${userId}> needs help`, ownerThread.channelId);
      }

      console.log(`[Interactivity] Task ${mondayItemId} marked stuck by ${userId}`);

      // Send cross-notification DMs to other assignees
      const taskInfo = await getTaskInfoForCrossNotify(mondayItemId);
      if (taskInfo && taskInfo.assigneeSlackIds.length > 1) {
        await sendCrossNotificationDM(
          mondayItemId,
          'stuck',
          userId,
          taskInfo.assigneeSlackIds,
          taskInfo.taskName
        );
      }
    } else {
      // Status was already set by someone else
      const existing = statusResult.existingStatus!;
      console.log(
        `[Interactivity] Task ${mondayItemId} already has status ${existing.status} set by ${existing.setBy}`
      );

      // Post to owner's thread
      if (ownerThread) {
        await slack.postToThread(
          ownerThread.threadTs,
          `ℹ️ Status already set to ${existing.status} by <@${existing.setBy}>`,
          ownerThread.channelId
        );
      }
    }
  } catch (error) {
    console.error(`[Interactivity] Failed to mark task ${mondayItemId} stuck:`, error);
  }
}

async function handleTaskConfirmToday(
  mondayItemId: string,
  userId: string,
  channelId?: string,
  threadTs?: string
): Promise<void> {
  try {
    // This is for digest confirmations - user confirms they'll complete today
    // Could store in digest state, or just mark as acknowledged
    await monday.updateWorkflowStatus(mondayItemId, 'Working on it');

    if (channelId && threadTs) {
      await slack.postToThread(
        threadTs,
        `✅ <@${userId}> confirmed - will complete today`,
        channelId
      );
    }

    console.log(`[Interactivity] Task ${mondayItemId} confirmed for today by ${userId}`);
  } catch (error) {
    console.error(`[Interactivity] Failed to confirm task ${mondayItemId}:`, error);
  }
}

async function handleTaskReschedule(
  mondayItemId: string,
  userId: string,
  triggerId: string
): Promise<void> {
  try {
    // Open a modal for date selection
    await slackClient.views.open({
      trigger_id: triggerId,
      view: {
        type: 'modal',
        callback_id: 'reschedule_task',
        private_metadata: JSON.stringify({ mondayItemId, userId }),
        title: {
          type: 'plain_text',
          text: 'Reschedule Task',
        },
        submit: {
          type: 'plain_text',
          text: 'Reschedule',
        },
        close: {
          type: 'plain_text',
          text: 'Cancel',
        },
        blocks: [
          {
            type: 'input',
            block_id: 'new_date_block',
            element: {
              type: 'datepicker',
              action_id: 'new_date',
              placeholder: {
                type: 'plain_text',
                text: 'Select new due date',
              },
            },
            label: {
              type: 'plain_text',
              text: 'New Due Date',
            },
          },
          {
            type: 'input',
            block_id: 'reason_block',
            optional: true,
            element: {
              type: 'plain_text_input',
              action_id: 'reason',
              multiline: true,
              placeholder: {
                type: 'plain_text',
                text: 'Why are you rescheduling? (optional)',
              },
            },
            label: {
              type: 'plain_text',
              text: 'Reason',
            },
          },
        ],
      },
    });

    console.log(`[Interactivity] Opened reschedule modal for task ${mondayItemId}`);
  } catch (error) {
    console.error(`[Interactivity] Failed to open reschedule modal:`, error);
  }
}

// ============================================================================
// Issue Call Handlers
// ============================================================================

async function handleIssueCallClaim(
  issueCallId: string,
  userId: string,
  channelId?: string,
  threadTs?: string
): Promise<void> {
  try {
    // Import issue call tracker
    const { claimIssueCall } = await import('../services/issueCallTracker.js');

    // threadTs is the issue call thread - use it to claim
    if (threadTs) {
      const result = await claimIssueCall(threadTs, userId);
      if (!result.success) {
        console.error(`[Interactivity] Failed to claim issue call: ${result.error}`);
      }
    }

    console.log(`[Interactivity] Issue call claimed by ${userId}`);
  } catch (error) {
    console.error(`[Interactivity] Failed to claim issue call:`, error);
  }
}

async function handleIssueCallWorking(
  mondayItemId: string,
  userId: string,
  channelId?: string,
  threadTs?: string
): Promise<void> {
  try {
    // Update Monday status to "Working on it"
    await monday.updateWorkflowStatus(mondayItemId, 'Working on it');

    // Post confirmation to thread
    if (channelId && threadTs) {
      await slack.postToThread(
        threadTs,
        `🟡 <@${userId}> marked this issue call as *Working on it*`,
        channelId
      );
    }

    console.log(`[Interactivity] Issue call ${mondayItemId} marked working by ${userId}`);
  } catch (error) {
    console.error(`[Interactivity] Failed to mark issue call working:`, error);
  }
}

async function handleIssueCallComplete(
  mondayItemId: string,
  userId: string,
  channelId?: string,
  threadTs?: string
): Promise<void> {
  try {
    // Update Monday status to "Done"
    await monday.updateWorkflowStatus(mondayItemId, 'Done');

    // Post confirmation to thread
    if (channelId && threadTs) {
      await slack.postToThread(
        threadTs,
        `✅ <@${userId}> marked this issue call as *Done*`,
        channelId
      );
    }

    console.log(`[Interactivity] Issue call ${mondayItemId} marked done by ${userId}`);
  } catch (error) {
    console.error(`[Interactivity] Failed to mark issue call done:`, error);
  }
}

async function handleIssueCallStuck(
  mondayItemId: string,
  userId: string,
  channelId?: string,
  threadTs?: string
): Promise<void> {
  try {
    // Update Monday status to "Stuck"
    await monday.updateWorkflowStatus(mondayItemId, 'Stuck');

    // Post confirmation to thread
    if (channelId && threadTs) {
      await slack.postToThread(
        threadTs,
        `🔴 <@${userId}> marked this issue call as *Stuck*`,
        channelId
      );
    }

    console.log(`[Interactivity] Issue call ${mondayItemId} marked stuck by ${userId}`);
  } catch (error) {
    console.error(`[Interactivity] Failed to mark issue call stuck:`, error);
  }
}

// ============================================================================
// View Submission Handlers
// ============================================================================

async function handleViewSubmission(payload: InteractivityPayload): Promise<void> {
  const view = payload.view;
  if (!view) return;

  const callbackId = view.callback_id;

  switch (callbackId) {
    case 'reschedule_task':
      await handleRescheduleSubmission(payload);
      break;

    case 'claim_email_task_view':
      await handleClaimEmailTaskSubmission(payload);
      break;

    default:
      console.log(`[Interactivity] Unknown view submission: ${callbackId}`);
  }
}

async function handleRescheduleSubmission(payload: InteractivityPayload): Promise<void> {
  try {
    const view = payload.view!;
    const metadata = JSON.parse(view.private_metadata || '{}');
    const { mondayItemId, userId } = metadata;

    const newDate = view.state.values.new_date_block?.new_date?.selected_date;
    const reason = view.state.values.reason_block?.reason?.value || '';

    if (!newDate || !mondayItemId) {
      console.error('[Interactivity] Missing data for reschedule');
      return;
    }

    // Update Monday.com due date
    await monday.updateDueDate(mondayItemId, newDate);

    // Get the task's Slack thread to post update
    const slackInfo = await monday.getSlackThreadInfo(mondayItemId);

    if (slackInfo?.threadTs) {
      const reasonText = reason ? `\nReason: ${reason}` : '';
      await slack.postToThread(
        slackInfo.threadTs,
        `📅 Rescheduled to ${newDate} by <@${userId}>${reasonText}`,
        slackInfo.channelId
      );
    }

    console.log(`[Interactivity] Task ${mondayItemId} rescheduled to ${newDate}`);
  } catch (error) {
    console.error('[Interactivity] Failed to process reschedule:', error);
  }
}

// ============================================================================
// Exported Handler for Relay Events
// ============================================================================

/**
 * Handle interactivity payload from relay (already parsed JSON)
 * Used by relayEvents.ts when receiving forwarded interactivity events
 */
export async function handleInteractivityPayload(payload: InteractivityPayload): Promise<void> {
  console.log('[Interactivity] Received (via relay):', {
    type: payload.type,
    user: payload.user.id,
    actions: payload.actions?.map((a) => a.action_id),
  });

  if (payload.type === 'block_actions' && payload.actions) {
    for (const action of payload.actions) {
      await handleBlockAction(payload, action);
    }
  } else if (payload.type === 'view_submission' && payload.view) {
    await handleViewSubmission(payload);
  }
}

// ============================================================================
// Claim Email Task — multi-owner claim button on Slack-shared emails
// ============================================================================

/**
 * Button value formats:
 *   pending|<gmailMessageId>|<truncatedSubject>   (first click — no Monday item yet)
 *   claimed|<mondayItemId>|<ownerCount>            (subsequent clicks — item exists)
 */
async function handleClaimEmailTask(
  payload: InteractivityPayload,
  action: { action_id: string; block_id: string; value: string }
): Promise<void> {
  const userId = payload.user.id;
  const channelId = payload.channel?.id || payload.container?.channel_id;
  const messageTs = payload.message?.ts || payload.container?.message_ts;
  const value = action.value;

  if (!channelId || !messageTs) {
    console.error('[claim_email_task] Missing channel or messageTs');
    return;
  }

  const { findUserBySlackId } = await import('../services/userResolver.js');
  const clicker = await findUserBySlackId(userId);
  if (!clicker) {
    await slack.postToThread(messageTs, `<@${userId}> — couldn't find you in Monday. Add yourself as a board member to claim tasks.`, channelId);
    return;
  }

  const parts = value.split('|');
  const state = parts[0];

  if (state === 'pending') {
    // First claim — open a modal so the clicker can pick a due date before
    // we create the Monday item. Modal submission completes the creation
    // (see handleClaimEmailTaskSubmission).
    const gmailMessageId = parts[1] || '';
    const subject = parts.slice(2).join('|') || 'Email';

    await openClaimDateModal({
      triggerId: payload.trigger_id,
      gmailMessageId,
      subject,
      channelId,
      messageTs,
    });
    return;
  }

  if (state === 'claimed') {
    const mondayItemId = parts[1];
    if (!mondayItemId) {
      console.error('[claim_email_task] claimed state missing itemId');
      return;
    }
    const dueDate = parts[3] || null; // optional — present only after first-click date pick

    const result = await monday.addOwner(mondayItemId, clicker.mondayId);

    if (!result.added) {
      // Already an owner — ephemeral note via thread
      await slack.postToThread(messageTs, `<@${userId}> you're already an owner.`, channelId);
      return;
    }

    await replaceClaimButton({
      channelId,
      messageTs,
      payload,
      mondayItemId,
      ownerCount: result.ownerCount,
      dueDate,
    });

    // Schedule a 9am-day-of reminder DM for this new owner so each claimer
    // gets their own ping (date locked from the first claim).
    if (dueDate) {
      await scheduleClaimReminderDM(userId, mondayItemId, dueDate);
    }

    const dueLine = dueDate ? ` (due ${dueDate})` : '';
    await slack.postToThread(messageTs, `➕ <@${userId}> joined as owner${dueLine} — ${result.ownerCount} total.`, channelId);
    return;
  }

  console.error(`[claim_email_task] Unknown state: ${state}`);
}

/**
 * Open a Slack modal that lets the clicker pick a due date before the
 * Monday item is created. Submission goes to handleClaimEmailTaskSubmission.
 */
async function openClaimDateModal(args: {
  triggerId: string;
  gmailMessageId: string;
  subject: string;
  channelId: string;
  messageTs: string;
}): Promise<void> {
  // Default the date picker to tomorrow (most common case for triage tasks)
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const initialDate = tomorrow.toISOString().split('T')[0];

  try {
    await slackClient.views.open({
      trigger_id: args.triggerId,
      view: {
        type: 'modal',
        callback_id: 'claim_email_task_view',
        private_metadata: JSON.stringify({
          gmailMessageId: args.gmailMessageId,
          subject: args.subject,
          channelId: args.channelId,
          messageTs: args.messageTs,
        }),
        title: { type: 'plain_text', text: 'Claim Task' },
        submit: { type: 'plain_text', text: 'Create Task' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `*${args.subject.slice(0, 150)}*` },
          },
          {
            type: 'input',
            block_id: 'due_date_block',
            element: {
              type: 'datepicker',
              action_id: 'due_date',
              initial_date: initialDate,
              placeholder: { type: 'plain_text', text: 'Select due date' },
            },
            label: { type: 'plain_text', text: 'Due Date' },
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: '🔔 You\'ll get a DM reminder at 9am the day it\'s due.',
              },
            ],
          },
        ],
      },
    });
  } catch (err) {
    console.error('[claim_email_task] views.open failed:', err);
  }
}

/**
 * Modal submission: actually create the Monday item with the picked date,
 * post the confirmation thread reply, swap the channel button to claimed
 * state, and schedule the 9am reminder DM for the clicker.
 */
async function handleClaimEmailTaskSubmission(payload: InteractivityPayload): Promise<void> {
  const view = payload.view!;
  const userId = payload.user.id;

  let metadata: { gmailMessageId: string; subject: string; channelId: string; messageTs: string };
  try {
    metadata = JSON.parse(view.private_metadata || '{}');
  } catch {
    console.error('[claim_email_task_view] bad private_metadata');
    return;
  }

  const dueDate = view.state.values.due_date_block?.due_date?.selected_date as string | undefined;
  if (!dueDate) {
    console.error('[claim_email_task_view] no date selected');
    return;
  }

  const { findUserBySlackId } = await import('../services/userResolver.js');
  const clicker = await findUserBySlackId(userId);
  if (!clicker) {
    await slack.postToThread(metadata.messageTs, `<@${userId}> — couldn't find you in Monday.`, metadata.channelId);
    return;
  }

  const item = await monday.createItem({
    name: metadata.subject,
    dueDate,
    ownerIds: [clicker.mondayId],
    taskType: 'Triage',
    source: 'Slack',
    urgency: 'Medium',
  });

  const slackPermalink = await getMessagePermalink(metadata.channelId, metadata.messageTs);
  const updateLines = [
    `✍️ Claimed via Slack by <@${userId}>`,
    `📅 Due ${dueDate}`,
    metadata.gmailMessageId ? `📧 Gmail message: ${metadata.gmailMessageId}` : null,
    slackPermalink ? `💬 Slack thread: ${slackPermalink}` : null,
  ].filter(Boolean) as string[];
  await monday.createUpdate(item.id, updateLines.join('\n\n'));

  // Swap the channel button to claimed state. We don't have payload.message
  // here (modal payloads don't carry it) so use a minimal block-rebuild path.
  await rebuildClaimedButton({
    channelId: metadata.channelId,
    messageTs: metadata.messageTs,
    mondayItemId: item.id,
    ownerCount: 1,
    dueDate,
  });

  await slack.postToThread(
    metadata.messageTs,
    `✅ Task created by <@${userId}> — due ${dueDate} — <https://salemseats.monday.com/boards/${configCompat.monday.boardId}/pulses/${item.id}|view in Monday>`,
    metadata.channelId
  );

  await scheduleClaimReminderDM(userId, item.id, dueDate);
}

/**
 * Schedule a 9am-ET DM to a Slack user reminding them about their claimed task.
 * Uses Slack's chat.scheduleMessage. No-op if scheduled time is already past.
 */
async function scheduleClaimReminderDM(userSlackId: string, mondayItemId: string, dueDate: string): Promise<void> {
  // Build 9am ET timestamp for dueDate. ET is UTC-5 (EST) or UTC-4 (EDT) —
  // close enough to use 13:00 UTC year-round (off by one hour during DST,
  // acceptable for a "morning of" reminder).
  const dt = new Date(`${dueDate}T13:00:00Z`);
  const postAt = Math.floor(dt.getTime() / 1000);
  const now = Math.floor(Date.now() / 1000);
  if (postAt <= now) {
    console.log(`[claim_email_task] reminder time ${dueDate} 9am ET already past, skipping schedule`);
    return;
  }

  try {
    const dm = await slackClient.conversations.open({ users: userSlackId });
    if (!dm.ok || !dm.channel?.id) {
      console.error('[claim_email_task] DM open failed:', dm);
      return;
    }
    const monLink = `https://salemseats.monday.com/boards/${configCompat.monday.boardId}/pulses/${mondayItemId}`;
    await slackClient.chat.scheduleMessage({
      channel: dm.channel.id,
      post_at: postAt,
      text: `🔔 Reminder: your claimed task is due today — <${monLink}|open in Monday>`,
    });
    console.log(`[claim_email_task] scheduled reminder for ${userSlackId} at ${dueDate} 9am ET`);
  } catch (err) {
    console.error('[claim_email_task] scheduleMessage failed:', err);
  }
}

/**
 * Rebuild the claim button on the original channel message. Used after modal
 * submission where we don't have access to payload.message.blocks. We refetch
 * the message via conversations.history and replace its actions block.
 */
async function rebuildClaimedButton(args: {
  channelId: string;
  messageTs: string;
  mondayItemId: string;
  ownerCount: number;
  dueDate: string;
}): Promise<void> {
  const newValue = `claimed|${args.mondayItemId}|${args.ownerCount}|${args.dueDate}`;
  const label = args.ownerCount === 1 ? `Claim (1 owner)` : `Claim (${args.ownerCount} owners)`;

  // Fetch the current message blocks so we preserve everything except the
  // actions block.
  let originalBlocks: any[] = [];
  let originalText = '';
  try {
    const history = await slackClient.conversations.history({
      channel: args.channelId,
      latest: args.messageTs,
      inclusive: true,
      limit: 1,
    });
    const msg = history.messages?.[0];
    originalBlocks = (msg as any)?.blocks ?? [];
    originalText = (msg as any)?.text ?? 'Claim email task';
  } catch (err) {
    console.error('[claim_email_task] conversations.history failed:', err);
  }

  const newBlocks = originalBlocks.map((b: any) => {
    if (b.type !== 'actions') return b;
    return {
      ...b,
      elements: (b.elements ?? []).map((el: any) =>
        el.action_id === 'claim_email_task'
          ? { ...el, text: { type: 'plain_text', text: label, emoji: true }, value: newValue }
          : el
      ),
    };
  });

  // If no blocks (e.g., history fetch failed), fall back to a minimal block set
  if (newBlocks.length === 0) {
    newBlocks.push({
      type: 'actions',
      block_id: 'claim_email_task_block',
      elements: [
        {
          type: 'button',
          action_id: 'claim_email_task',
          text: { type: 'plain_text', text: label, emoji: true },
          style: 'primary',
          value: newValue,
        },
      ],
    });
  }

  try {
    const { slack: coreApiSlack } = await import('../services/coreApi.js');
    await coreApiSlack.updateMessage({
      channel: args.channelId,
      ts: args.messageTs,
      text: originalText,
      blocks: newBlocks,
      asUser: true,
    });
  } catch (err) {
    console.error('[claim_email_task] update via core-api failed:', err);
  }
}

/**
 * Replace the "Claim Task" actions block on the original message with an
 * updated one carrying the new state in its value.
 */
async function replaceClaimButton(args: {
  channelId: string;
  messageTs: string;
  payload: InteractivityPayload;
  mondayItemId: string;
  ownerCount: number;
  dueDate?: string | null;
}): Promise<void> {
  const originalBlocks = (args.payload as any).message?.blocks ?? [];
  const dueSuffix = args.dueDate ? `|${args.dueDate}` : '';
  const newValue = `claimed|${args.mondayItemId}|${args.ownerCount}${dueSuffix}`;
  const buttonLabel = args.ownerCount === 1 ? 'Claim (1 owner)' : `Claim (${args.ownerCount} owners)`;

  const newBlocks = originalBlocks.map((block: any) => {
    if (block.type !== 'actions') return block;
    return {
      ...block,
      elements: (block.elements ?? []).map((el: any) => {
        if (el.action_id !== 'claim_email_task') return el;
        return {
          ...el,
          text: { type: 'plain_text', text: buttonLabel, emoji: true },
          value: newValue,
        };
      }),
    };
  });

  try {
    // The button message was posted via user token (so it appears authored
    // by the human, not the bot). chat.update only allows the original
    // author to edit, so route through core-api which has the user token.
    const { slack: coreApiSlack } = await import('../services/coreApi.js');
    await coreApiSlack.updateMessage({
      channel: args.channelId,
      ts: args.messageTs,
      text: (args.payload as any).message?.text ?? 'Claim email task',
      blocks: newBlocks,
      asUser: true,
    });
  } catch (err) {
    console.error('[claim_email_task] chat.update failed:', err);
  }
}

async function getMessagePermalink(channelId: string, messageTs: string): Promise<string | null> {
  try {
    const result = await slackClient.chat.getPermalink({ channel: channelId, message_ts: messageTs });
    return result.permalink ?? null;
  } catch {
    return null;
  }
}

export default router;
