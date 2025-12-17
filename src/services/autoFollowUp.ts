/**
 * Auto Follow-Up Service
 *
 * Automatically sends reminders for tasks based on:
 * - Due date approaching (1 day before, day of)
 * - No activity/updates on a task for X days
 * - Overdue tasks
 *
 * Run this on a schedule (e.g., cron job, setInterval)
 */

import { config } from '../config/environment.js';
import * as monday from './monday.js';
import * as slack from './slack.js';
import { getAllUsers } from './userResolver.js';

// Track which reminders we've already sent (to avoid duplicates)
const sentReminders = new Map<string, number>(); // key -> timestamp

// Cleanup old entries every hour
setInterval(() => {
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  for (const [key, timestamp] of sentReminders.entries()) {
    if (timestamp < oneDayAgo) {
      sentReminders.delete(key);
    }
  }
}, 60 * 60 * 1000);

interface TaskForFollowUp {
  id: string;
  name: string;
  dueDate: string;
  ownerId: number;
  ownerName: string;
  slackThreadTs: string | null;
  lastActivityDate: string | null;
  status: string;
}

/**
 * Check all open tasks and send appropriate follow-ups
 */
export async function checkAndSendFollowUps(): Promise<void> {
  console.log('Checking tasks for follow-ups...');

  try {
    const tasks = await getOpenTasksWithDueDates();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (const task of tasks) {
      // Skip completed tasks
      if (task.status === 'Done') continue;

      const dueDate = new Date(task.dueDate);
      dueDate.setHours(0, 0, 0, 0);

      const daysUntilDue = Math.ceil((dueDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
      const daysSinceActivity = task.lastActivityDate
        ? Math.floor((today.getTime() - new Date(task.lastActivityDate).getTime()) / (1000 * 60 * 60 * 24))
        : null;

      // Check different follow-up scenarios
      if (daysUntilDue < 0) {
        // Overdue
        await sendOverdueReminder(task, Math.abs(daysUntilDue));
      } else if (daysUntilDue === 0) {
        // Due today
        await sendDueTodayReminder(task);
      } else if (daysUntilDue === 1) {
        // Due tomorrow
        await sendDueTomorrowReminder(task);
      } else if (daysSinceActivity !== null && daysSinceActivity >= 3 && daysUntilDue <= 5) {
        // No activity for 3+ days and due within 5 days
        await sendNoActivityReminder(task, daysSinceActivity);
      }
    }

    console.log('Follow-up check complete');
  } catch (error) {
    console.error('Error checking follow-ups:', error);
  }
}

/**
 * Get all open tasks with their due dates
 */
async function getOpenTasksWithDueDates(): Promise<TaskForFollowUp[]> {
  const query = `
    query GetOpenTasks($boardId: ID!) {
      boards(ids: [$boardId]) {
        items_page(limit: 100) {
          items {
            id
            name
            column_values {
              id
              text
              value
            }
            updates(limit: 1) {
              created_at
            }
          }
        }
      }
    }
  `;

  interface MondayResponse {
    boards: Array<{
      items_page: {
        items: Array<{
          id: string;
          name: string;
          column_values: Array<{
            id: string;
            text: string;
            value: string;
          }>;
          updates: Array<{
            created_at: string;
          }>;
        }>;
      };
    }>;
  }

  // Use the Monday API directly
  const response = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': config.monday.apiToken,
      'API-Version': '2024-01',
    },
    body: JSON.stringify({
      query,
      variables: { boardId: config.monday.boardId },
    }),
  });

  const result = await response.json() as { data: MondayResponse };
  const items = result.data?.boards?.[0]?.items_page?.items ?? [];
  const users = await getAllUsers();

  return items.map(item => {
    const getValue = (columnId: string) =>
      item.column_values.find(cv => cv.id === columnId)?.text ?? '';

    const ownerValue = item.column_values.find(cv => cv.id === config.monday.columns.owner)?.value;
    let ownerId = 0;
    let ownerName = 'Unknown';

    if (ownerValue) {
      try {
        const parsed = JSON.parse(ownerValue);
        ownerId = parsed?.personsAndTeams?.[0]?.id ?? 0;
        const user = users.find(u => u.mondayId === ownerId);
        ownerName = user?.name ?? 'Unknown';
      } catch {
        // Ignore parse errors
      }
    }

    return {
      id: item.id,
      name: item.name,
      dueDate: getValue(config.monday.columns.date),
      ownerId,
      ownerName,
      slackThreadTs: getValue(config.monday.columns.slackThreadId) || null,
      lastActivityDate: item.updates[0]?.created_at ?? null,
      status: getValue(config.monday.columns.status),
    };
  }).filter(task => task.dueDate); // Only tasks with due dates
}

/**
 * Send reminder for overdue task
 */
async function sendOverdueReminder(task: TaskForFollowUp, daysOverdue: number): Promise<void> {
  const reminderKey = `overdue-${task.id}-${daysOverdue}`;
  if (hasRecentReminder(reminderKey)) return;

  const users = await getAllUsers();
  const owner = users.find(u => u.mondayId === task.ownerId);

  if (!owner?.slackId) return;

  const message = `:rotating_light: *Overdue Task*\n\n` +
    `*${task.name}*\n` +
    `Was due ${daysOverdue} day${daysOverdue > 1 ? 's' : ''} ago\n\n` +
    `<${monday.getItemUrl(task.id)}|View in Monday.com>`;

  // Send DM to owner
  await slack.postEphemeral(owner.slackId, owner.slackId, message);

  // Also post to thread if exists
  if (task.slackThreadTs) {
    await slack.postToThread(
      task.slackThreadTs,
      `:rotating_light: *Reminder:* This task is ${daysOverdue} day${daysOverdue > 1 ? 's' : ''} overdue. <@${owner.slackId}> - any update?`
    );
  }

  markReminderSent(reminderKey);
  console.log(`Sent overdue reminder for task ${task.id}`);
}

/**
 * Send reminder for task due today
 */
async function sendDueTodayReminder(task: TaskForFollowUp): Promise<void> {
  const reminderKey = `due-today-${task.id}`;
  if (hasRecentReminder(reminderKey)) return;

  const users = await getAllUsers();
  const owner = users.find(u => u.mondayId === task.ownerId);

  if (!owner?.slackId) return;

  if (task.slackThreadTs) {
    await slack.postToThread(
      task.slackThreadTs,
      `:calendar: *Reminder:* This task is due today! <@${owner.slackId}>`
    );
  }

  markReminderSent(reminderKey);
  console.log(`Sent due-today reminder for task ${task.id}`);
}

/**
 * Send reminder for task due tomorrow
 */
async function sendDueTomorrowReminder(task: TaskForFollowUp): Promise<void> {
  const reminderKey = `due-tomorrow-${task.id}`;
  if (hasRecentReminder(reminderKey)) return;

  const users = await getAllUsers();
  const owner = users.find(u => u.mondayId === task.ownerId);

  if (!owner?.slackId) return;

  if (task.slackThreadTs) {
    await slack.postToThread(
      task.slackThreadTs,
      `:clock1: *Heads up:* This task is due tomorrow. <@${owner.slackId}> - how's it going?`
    );
  }

  markReminderSent(reminderKey);
  console.log(`Sent due-tomorrow reminder for task ${task.id}`);
}

/**
 * Send reminder for task with no recent activity
 */
async function sendNoActivityReminder(task: TaskForFollowUp, daysSinceActivity: number): Promise<void> {
  const reminderKey = `no-activity-${task.id}-${Math.floor(daysSinceActivity / 3)}`;
  if (hasRecentReminder(reminderKey)) return;

  const users = await getAllUsers();
  const owner = users.find(u => u.mondayId === task.ownerId);

  if (!owner?.slackId || !task.slackThreadTs) return;

  await slack.postToThread(
    task.slackThreadTs,
    `:wave: *Check-in:* No updates on this task for ${daysSinceActivity} days. <@${owner.slackId}> - any progress to share?`
  );

  markReminderSent(reminderKey);
  console.log(`Sent no-activity reminder for task ${task.id}`);
}

function hasRecentReminder(key: string): boolean {
  const lastSent = sentReminders.get(key);
  if (!lastSent) return false;
  // Don't send same reminder within 12 hours
  return Date.now() - lastSent < 12 * 60 * 60 * 1000;
}

function markReminderSent(key: string): void {
  sentReminders.set(key, Date.now());
}

/**
 * Start the follow-up scheduler
 * Runs every hour by default
 */
export function startFollowUpScheduler(intervalMs: number = 60 * 60 * 1000): void {
  console.log(`Starting follow-up scheduler (interval: ${intervalMs / 1000 / 60} minutes)`);

  // Run immediately on start
  checkAndSendFollowUps();

  // Then run on interval
  setInterval(checkAndSendFollowUps, intervalMs);
}
