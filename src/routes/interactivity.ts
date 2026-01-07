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
import { config } from '../config/environment.js';
import * as monday from '../services/monday.js';
import * as slack from '../services/slack.js';

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

    default:
      console.log(`[Interactivity] Unknown action: ${action_id}`);
  }
}

// ============================================================================
// Task Action Handlers
// ============================================================================

async function handleTaskAcknowledge(
  mondayItemId: string,
  userId: string,
  channelId?: string,
  threadTs?: string
): Promise<void> {
  try {
    // Update Monday.com status
    await monday.updateWorkflowStatus(mondayItemId, 'Acknowledged');

    // Post confirmation to thread
    if (channelId && threadTs) {
      await slack.postToThread(threadTs, `👀 Acknowledged by <@${userId}>`, channelId);
    }

    console.log(`[Interactivity] Task ${mondayItemId} acknowledged by ${userId}`);
  } catch (error) {
    console.error(`[Interactivity] Failed to acknowledge task ${mondayItemId}:`, error);
  }
}

async function handleTaskWorking(
  mondayItemId: string,
  userId: string,
  channelId?: string,
  threadTs?: string
): Promise<void> {
  try {
    await monday.updateWorkflowStatus(mondayItemId, 'Working on it');

    if (channelId && threadTs) {
      await slack.postToThread(threadTs, `🟡 Working on it - <@${userId}>`, channelId);
    }

    console.log(`[Interactivity] Task ${mondayItemId} marked working by ${userId}`);
  } catch (error) {
    console.error(`[Interactivity] Failed to mark task ${mondayItemId} working:`, error);
  }
}

async function handleTaskComplete(
  mondayItemId: string,
  userId: string,
  channelId?: string,
  threadTs?: string
): Promise<void> {
  try {
    await monday.updateWorkflowStatus(mondayItemId, 'Complete');

    if (channelId && threadTs) {
      await slack.postToThread(threadTs, `✅ Completed by <@${userId}>`, channelId);
    }

    console.log(`[Interactivity] Task ${mondayItemId} completed by ${userId}`);
  } catch (error) {
    console.error(`[Interactivity] Failed to complete task ${mondayItemId}:`, error);
  }
}

async function handleTaskStuck(
  mondayItemId: string,
  userId: string,
  channelId?: string,
  threadTs?: string
): Promise<void> {
  try {
    await monday.updateWorkflowStatus(mondayItemId, 'Stuck');

    if (channelId && threadTs) {
      await slack.postToThread(threadTs, `🔴 Stuck - <@${userId}> needs help`, channelId);
    }

    console.log(`[Interactivity] Task ${mondayItemId} marked stuck by ${userId}`);
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

export default router;
