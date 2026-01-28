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
import { declineOpportunity } from '../services/presaleState.js';
import { extractCodesFromMessageIds } from '../services/presaleScanner.js';

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

    case 'presale_interested':
      await handlePresaleInterested(action, payload);
      break;

    case 'presale_decline':
      await handlePresaleDecline(action, payload);
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
// Presale Action Handlers
// ============================================================================

async function handlePresaleInterested(
  action: { action_id: string; block_id: string; value: string },
  payload: InteractivityPayload
): Promise<void> {
  try {
    const userId = payload.user.id;
    const channelId = payload.channel?.id || payload.container?.channel_id;
    const messageTs = payload.message?.ts || payload.container?.message_ts;

    // Parse the interested payload
    const data = JSON.parse(action.value) as {
      dedupKey: string;
      team: string;
      eventName: string;
      subject: string;
      presaleType: string;
      presaleDate: string | null;
      presaleChannel: string;
      messageIds?: string[];
    };

    console.log(`[Interactivity] User ${userId} interested in presale: ${data.eventName}`);

    // Extract codes/links from all emails now that they're interested
    let statusInfo = '';
    let csvContent: string | null = null;
    let csvFilename = '';

    if (data.messageIds && data.messageIds.length > 0) {
      try {
        const extraction = await extractCodesFromMessageIds(data.messageIds);

        // Build status info for the message
        const statusParts: string[] = [];
        statusParts.push(`📊 ${extraction.accounts.length} accounts`);
        if (extraction.sharedCode) {
          statusParts.push(`🔑 Shared code`);
        } else if (extraction.hasUniqueCodes) {
          statusParts.push(`🔐 Unique codes per account`);
        }
        if (extraction.hasUniqueLinks) {
          statusParts.push(`🔗 Unique links per account`);
        }
        statusInfo = statusParts.join(' • ');

        // Generate CSV if we have account data
        if (extraction.accounts.length > 0) {
          const csvRows = ['Email,Code,Link'];
          for (const account of extraction.accounts) {
            const email = account.email.replace(/"/g, '""');
            const code = (account.code ?? '').replace(/"/g, '""');
            const link = (account.link ?? '').replace(/"/g, '""');
            csvRows.push(`"${email}","${code}","${link}"`);
          }
          csvContent = csvRows.join('\n');
          csvFilename = `${data.team.toLowerCase().replace(/\s+/g, '-')}-${data.eventName.toLowerCase().replace(/\s+/g, '-')}.csv`;
        }
      } catch (error) {
        console.error('[Interactivity] Failed to extract codes:', error);
        statusInfo = '⚠️ _Could not extract codes - check emails manually_';
      }
    }

    // Post to operations channel
    const operationsChannel = configCompat.presale?.operationsChannel;
    if (operationsChannel) {
      // Build the message link back to the original presale notification
      const messageLink = messageTs && channelId
        ? `https://slack.com/archives/${channelId}/p${messageTs.replace('.', '')}`
        : '';

      // Build presale info line
      let presaleInfo = '';
      if (data.presaleType === 'registration') {
        presaleInfo = data.presaleDate ? `📝 Registration • Presale starts ${data.presaleDate}` : '📝 Registration';
      } else if (data.presaleType === 'upcoming') {
        presaleInfo = data.presaleDate ? `📅 Upcoming • 🗓️ ${data.presaleDate}` : '📅 Upcoming';
      } else {
        presaleInfo = '🎟️ Live Now';
      }
      if (statusInfo) {
        presaleInfo += `\n${statusInfo}`;
      }

      const blocks: any[] = [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `📋 *Prepare a sheet for ${data.team}*\n\n*Event:* ${data.eventName}\n${presaleInfo}`,
          },
        },
      ];

      // Add link back to original message
      if (messageLink) {
        blocks.push({
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `<${messageLink}|View original presale notification>`,
            },
          ],
        });
      }

      // Post the message
      const opsMessage = await slackClient.chat.postMessage({
        channel: operationsChannel,
        blocks,
        text: `📋 Prepare a sheet for ${data.team} - ${data.eventName}`,
      });

      // Upload CSV as a file in thread
      if (csvContent && opsMessage.ts) {
        try {
          await slackClient.filesUploadV2({
            channel_id: operationsChannel,
            thread_ts: opsMessage.ts,
            filename: csvFilename,
            file: Buffer.from(csvContent, 'utf-8'),
            title: `Account Data - ${data.eventName}`,
            initial_comment: 'Email, Code, Link for each account:',
          });
          console.log(`[Interactivity] Uploaded CSV: ${csvFilename}`);
        } catch (uploadError) {
          console.error('[Interactivity] Failed to upload CSV:', uploadError);
        }
      }
    }

    // Update the original message to show status
    if (channelId && messageTs) {
      const originalBlocks = (payload.message as any)?.blocks ?? [];
      const updatedBlocks = originalBlocks.filter((b: any) => b.type !== 'actions');
      updatedBlocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `✅ *Interested* • Posted to operations channel`,
          },
        ],
      });

      await slackClient.chat.update({
        channel: channelId,
        ts: messageTs,
        blocks: updatedBlocks,
        text: (payload.message as any)?.text ?? '',
      });
    }

  } catch (error) {
    console.error('[Interactivity] Failed to handle presale interested:', error);
  }
}

async function handlePresaleDecline(
  action: { action_id: string; block_id: string; value: string },
  payload: InteractivityPayload
): Promise<void> {
  try {
    const userId = payload.user.id;
    const channelId = payload.channel?.id || payload.container?.channel_id;
    const messageTs = payload.message?.ts || payload.container?.message_ts;

    // Parse the decline payload
    const data = JSON.parse(action.value) as {
      domain: string;
      eventName: string;
      team: string;
    };

    console.log(`[Interactivity] User ${userId} declined presale: ${data.eventName} from ${data.domain}`);

    // Mark as declined in state
    declineOpportunity(data.domain, data.eventName, data.team);

    // Update the original message to show status
    if (channelId && messageTs) {
      const originalBlocks = (payload.message as any)?.blocks ?? [];
      const updatedBlocks = originalBlocks.filter((b: any) => b.type !== 'actions');
      updatedBlocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `❌ *Not Interested* • Future emails for "${data.eventName}" will be skipped`,
          },
        ],
      });

      await slackClient.chat.update({
        channel: channelId,
        ts: messageTs,
        blocks: updatedBlocks,
        text: (payload.message as any)?.text ?? '',
      });
    }

  } catch (error) {
    console.error('[Interactivity] Failed to handle presale decline:', error);
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
