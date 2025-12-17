/**
 * Conversation state manager for multi-turn Slack interactions
 *
 * Tracks incomplete task creation flows where we need to ask
 * follow-up questions to gather required information.
 */

import type { ParsedTask, MissingFields } from './taskParser.js';

export interface PendingTask {
  parsed: ParsedTask;
  missing: MissingFields;
  slackUserId: string;
  slackChannelId: string;
  awaitingField: 'name' | 'assignee' | 'dueDate' | null;
  createdAt: number;
  lastMessageTs?: string;
}

// In-memory store for pending tasks (keyed by `${channelId}-${userId}`)
const pendingTasks = new Map<string, PendingTask>();

// Cleanup old conversations after 10 minutes
const CONVERSATION_TIMEOUT_MS = 10 * 60 * 1000;

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
  pendingTasks.set(key, {
    ...task,
    createdAt: Date.now(),
  });

  // Schedule cleanup
  setTimeout(() => {
    const stored = pendingTasks.get(key);
    if (stored && stored.createdAt === task.createdAt) {
      pendingTasks.delete(key);
    }
  }, CONVERSATION_TIMEOUT_MS);
}

/**
 * Get a pending task for a user in a channel
 */
export function getPendingTask(channelId: string, userId: string): PendingTask | null {
  const key = getKey(channelId, userId);
  const task = pendingTasks.get(key);

  if (!task) return null;

  // Check if expired
  if (Date.now() - task.createdAt > CONVERSATION_TIMEOUT_MS) {
    pendingTasks.delete(key);
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
  const existing = pendingTasks.get(key);

  if (existing) {
    pendingTasks.set(key, { ...existing, ...updates });
  }
}

/**
 * Clear a pending task (when completed or cancelled)
 */
export function clearPendingTask(channelId: string, userId: string): void {
  const key = getKey(channelId, userId);
  pendingTasks.delete(key);
}

/**
 * Determine which field to ask for next
 */
export function getNextMissingField(missing: MissingFields): 'name' | 'assignee' | 'dueDate' | null {
  // Priority order: name first, then assignee, then due date
  if (missing.needsName) return 'name';
  if (missing.needsAssignee) return 'assignee';
  if (missing.needsDueDate) return 'dueDate';
  return null;
}

/**
 * Generate the question to ask for a missing field
 */
export function getQuestionForField(field: 'name' | 'assignee' | 'dueDate'): string {
  switch (field) {
    case 'name':
      return "What's the task? Please describe what needs to be done.";
    case 'assignee':
      return "Who should this be assigned to? (you can say 'me' or type a name)";
    case 'dueDate':
      return "When is this due? (e.g., 'tomorrow', 'friday', 'next week', '12/25')";
  }
}

/**
 * Generate blocks for asking a follow-up question
 */
export function generateQuestionBlocks(
  question: string,
  taskSoFar: ParsedTask,
  showCancel: boolean = true
): unknown[] {
  const blocks: unknown[] = [];

  // Show what we have so far
  const summaryParts: string[] = [];
  if (taskSoFar.name) summaryParts.push(`*Task:* ${taskSoFar.name}`);
  if (taskSoFar.assignee) summaryParts.push(`*Assignee:* ${taskSoFar.assignee}`);
  if (taskSoFar.dueDate) summaryParts.push(`*Due:* ${taskSoFar.rawDueDate || taskSoFar.dueDate}`);

  if (summaryParts.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:memo: *Creating task...*\n${summaryParts.join('\n')}`,
      },
    });
    blocks.push({ type: 'divider' });
  }

  // Ask the question
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `:question: ${question}`,
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
  priority?: string | null
): unknown[] {
  const priorityText = priority === 'high' ? ':red_circle: High' :
                       priority === 'medium' ? ':large_yellow_circle: Medium' :
                       priority === 'low' ? ':large_green_circle: Low' : null;

  let details = `*Task:* ${taskName}\n*Assigned to:* ${assigneeName}\n*Due:* ${dueDate}`;
  if (taskType) details += `\n*Type:* ${taskType}`;
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
