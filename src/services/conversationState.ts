/**
 * Conversation state manager for multi-turn Slack interactions
 *
 * Tracks incomplete task creation flows where we need to ask
 * follow-up questions to gather required information.
 *
 * State is persisted to disk via pendingState.ts to survive restarts.
 */

import type { ParsedTask, MissingFields } from './taskParser.js';
import {
  getPendingTask as getPendingTaskFromState,
  setPendingTask,
  deletePendingTask,
  PENDING_TASK_TTL,
  type PendingTask,
} from './pendingState.js';

// Re-export the PendingTask type
export type { PendingTask };

// TTL for expiry checks
const CONVERSATION_TIMEOUT_MS = PENDING_TASK_TTL;

function getKey(channelId: string, userId: string): string {
  return `${channelId}-${userId}`;
}

/**
 * Store a pending task that needs more information
 */
export function storePendingTask(
  channelId: string,
  userId: string,
  task: PendingTask
): void {
  const key = getKey(channelId, userId);
  setPendingTask(key, {
    ...task,
    createdAt: Date.now(),
  });
  // Note: cleanup now handled by pendingState.ts cleanup interval
}

/**
 * Get a pending task for a user in a channel
 */
export function getPendingTask(channelId: string, userId: string): PendingTask | null {
  const key = getKey(channelId, userId);
  const task = getPendingTaskFromState(key);

  if (!task) return null;

  // Check if expired
  if (Date.now() - task.createdAt > CONVERSATION_TIMEOUT_MS) {
    deletePendingTask(key);
    return null;
  }

  return task;
}

/**
 * Update a pending task
 */
export function updatePendingTask(
  channelId: string,
  userId: string,
  updates: Partial<PendingTask>
): void {
  const key = getKey(channelId, userId);
  const existing = getPendingTaskFromState(key);

  if (existing) {
    setPendingTask(key, { ...existing, ...updates });
  }
}

/**
 * Clear a pending task (when completed or cancelled)
 */
export function clearPendingTask(channelId: string, userId: string): void {
  const key = getKey(channelId, userId);
  deletePendingTask(key);
}

/**
 * Get all missing fields as an array
 */
export function getMissingFields(missing: MissingFields): Array<'name' | 'assignee' | 'dueDate'> {
  const fields: Array<'name' | 'assignee' | 'dueDate'> = [];
  if (missing.needsName) fields.push('name');
  if (missing.needsAssignee) fields.push('assignee');
  if (missing.needsDueDate) fields.push('dueDate');
  return fields;
}

/**
 * Generate a combined question asking for all missing fields at once
 */
export function generateCombinedQuestion(missingFields: Array<'name' | 'assignee' | 'dueDate'>): string {
  const questions: string[] = [];

  for (const field of missingFields) {
    switch (field) {
      case 'name':
        questions.push("*What's the task?*");
        break;
      case 'assignee':
        questions.push("*Who should this be assigned to?* (say 'me' or a name)");
        break;
      case 'dueDate':
        questions.push("*When is it due?* (e.g., 'tomorrow', 'friday')");
        break;
    }
  }

  return questions.join('\n');
}

/**
 * Generate blocks for asking all missing questions at once
 */
export function generateQuestionBlocks(
  missingFields: Array<'name' | 'assignee' | 'dueDate'>,
  taskSoFar: ParsedTask,
  showCancel: boolean = true
): unknown[] {
  const blocks: unknown[] = [];

  // Show what we have so far
  const summaryParts: string[] = [];
  if (taskSoFar.name) summaryParts.push(`*Task:* ${taskSoFar.name}`);
  if (taskSoFar.assignee) summaryParts.push(`*Assignee:* ${taskSoFar.assignee}`);
  if (taskSoFar.dueDate) summaryParts.push(`*Due:* ${taskSoFar.rawDueDate || taskSoFar.dueDate}`);
  if (taskSoFar.team) summaryParts.push(`*Team:* ${taskSoFar.team}`);

  if (summaryParts.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:memo: *Got it!*\n${summaryParts.join('\n')}`,
      },
    });
    blocks.push({ type: 'divider' });
  }

  // Ask all questions at once
  const combinedQuestion = generateCombinedQuestion(missingFields);

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `:question: *I need a bit more info:*\n\n${combinedQuestion}\n\n_Reply with all answers (e.g., "john, friday" or "assign to john due friday")_`,
    },
  });

  // Add cancel button
  if (showCancel) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'Cancel',
            emoji: true,
          },
          style: 'danger',
          action_id: 'cancel_task',
        },
      ],
    });
  }

  return blocks;
}

/**
 * Generate confirmation blocks before creating the task
 */
export function generateConfirmationBlocks(
  taskName: string,
  assigneeName: string,
  dueDate: string,
  taskType?: string | null,
  priority?: string | null,
  team?: string | null
): unknown[] {
  const priorityText = priority === 'high' ? ':red_circle: High' :
                       priority === 'medium' ? ':large_yellow_circle: Medium' :
                       priority === 'low' ? ':large_green_circle: Low' : null;

  let details = `*Task:* ${taskName}\n*Assigned to:* ${assigneeName}\n*Due:* ${dueDate}`;
  if (taskType) details += `\n*Type:* ${taskType}`;
  if (team) details += `\n*Team:* ${team}`;
  if (priorityText) details += `\n*Priority:* ${priorityText}`;

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:white_check_mark: *Ready to create task*\n\n${details}`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'Create Task',
            emoji: true,
          },
          style: 'primary',
          action_id: 'confirm_task',
        },
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'Cancel',
            emoji: true,
          },
          style: 'danger',
          action_id: 'cancel_task',
        },
      ],
    },
  ];
}
