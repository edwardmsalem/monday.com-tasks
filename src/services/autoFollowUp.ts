/**
 * Auto Follow-Up Service
 *
 * Sends action-oriented reminders:
 * - No 👀 acknowledgment → remind to acknowledge
 * - Past due → remind to complete with ✅
 *
 * Run this on a schedule (e.g., cron job, setInterval)
 */

import { config } from '../config/environment.js';
import * as slack from './slack.js';
import { getAllUsers, type UnifiedUser } from './userResolver.js';

// Track which follow-ups we've already sent (to avoid duplicates)
const sentFollowUps = new Map<string, number>(); // key -> timestamp

// Cleanup old entries every hour
setInterval(() => {
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  for (const [key, timestamp] of sentFollowUps.entries()) {
    if (timestamp < oneDayAgo) {
      sentFollowUps.delete(key);
    }
  }
}, 60 * 60 * 1000);

interface Owner {
  id: number;
  name: string;
  slackId: string | null;
}

interface TaskForFollowUp {
  id: string;
  name: string;
  dueDate: string | null;
  owners: Owner[];
  slackThreadTs: string | null;
  workflowStatus: string; // "Acknowledged", "Working on it", "Complete", or ""
  createdAt: string;
}

/**
 * Check all open tasks and send appropriate follow-ups
 */
export async function checkAndSendFollowUps(): Promise<void> {
  console.log('Checking tasks for follow-ups...');

  try {
    const tasks = await getOpenTasks();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (const task of tasks) {
      // Skip completed tasks (check multiple possible values)
      const status = task.workflowStatus.toLowerCase();
      if (status === 'complete' || status === 'done' || status === 'completed' || status === 'closed') {
        continue;
      }

      // Skip tasks without a Slack thread (can't send reminders)
      if (!task.slackThreadTs) continue;

      // Skip tasks with no owners
      if (task.owners.length === 0) continue;

      const taskCreatedAt = new Date(task.createdAt);
      const hoursSinceCreation = (Date.now() - taskCreatedAt.getTime()) / (1000 * 60 * 60);

      // 1. Not acknowledged after 4 hours → remind to add 👀
      if (!task.workflowStatus && hoursSinceCreation >= 4) {
        await sendAcknowledgeReminder(task);
      }

      // 2. Past due and not complete → remind to add ✅
      if (task.dueDate) {
        const dueDate = new Date(task.dueDate);
        dueDate.setHours(0, 0, 0, 0);
        const daysOverdue = Math.floor((today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));

        if (daysOverdue > 0) {
          await sendOverdueReminder(task, daysOverdue);
        }
      }
    }

    console.log('Follow-up check complete');
  } catch (error) {
    console.error('Error checking follow-ups:', error);
  }
}

/**
 * Get all open tasks
 */
async function getOpenTasks(): Promise<TaskForFollowUp[]> {
  const query = `
    query GetOpenTasks($boardId: ID!) {
      boards(ids: [$boardId]) {
        items_page(limit: 100) {
          items {
            id
            name
            created_at
            column_values {
              id
              text
              value
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
          created_at: string;
          column_values: Array<{
            id: string;
            text: string;
            value: string;
          }>;
        }>;
      };
    }>;
  }

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

    // Parse ALL owners
    const ownerValue = item.column_values.find(cv => cv.id === config.monday.columns.owner)?.value;
    const owners: Owner[] = [];

    if (ownerValue) {
      try {
        const parsed = JSON.parse(ownerValue);
        const personsAndTeams = parsed?.personsAndTeams ?? [];

        for (const person of personsAndTeams) {
          if (person.kind === 'person') {
            const user = users.find(u => u.mondayId === person.id);
            owners.push({
              id: person.id,
              name: user?.name ?? 'Unknown',
              slackId: user?.slackId ?? null,
            });
          }
        }
      } catch {
        // Ignore parse errors
      }
    }

    return {
      id: item.id,
      name: item.name,
      dueDate: getValue(config.monday.columns.date) || null,
      owners,
      slackThreadTs: getValue(config.monday.columns.slackThreadId) || null,
      workflowStatus: getValue(config.monday.columns.workflowStatus),
      createdAt: item.created_at,
    };
  });
}

/**
 * Format owner mentions for Slack
 */
function formatOwnerMentions(owners: Owner[]): string {
  const mentions = owners
    .filter(o => o.slackId)
    .map(o => `<@${o.slackId}>`);

  if (mentions.length === 0) {
    return owners.map(o => o.name).join(', ') || 'team';
  }

  if (mentions.length === 1) return mentions[0];
  if (mentions.length === 2) return `${mentions[0]} and ${mentions[1]}`;
  return `${mentions.slice(0, -1).join(', ')}, and ${mentions[mentions.length - 1]}`;
}

// Reminder messages for acknowledgment
const ACKNOWLEDGE_REMINDERS = [
  (task: TaskForFollowUp, mentions: string) =>
    `${mentions} - please react with 👀 to acknowledge "${task.name}"`,
  (task: TaskForFollowUp, mentions: string) =>
    `Hey ${mentions}, don't forget to 👀 this task to let us know you've seen it.`,
  (task: TaskForFollowUp, mentions: string) =>
    `${mentions} - add a 👀 reaction to acknowledge you're on this.`,
];

// Reminder messages for overdue tasks (day 1)
const OVERDUE_REMINDERS = [
  (task: TaskForFollowUp, days: number, mentions: string) =>
    `${mentions} - "${task.name}" is ${days} day${days > 1 ? 's' : ''} overdue. React with ✅ when complete.`,
  (task: TaskForFollowUp, days: number, mentions: string) =>
    `Hey ${mentions}, this task is past due. Add ✅ once it's done.`,
  (task: TaskForFollowUp, days: number, mentions: string) =>
    `${mentions} - overdue by ${days} day${days > 1 ? 's' : ''}. Mark complete with ✅ when finished.`,
];

// Escalation reminder messages (day 2+) - includes manager visibility
const ESCALATION_SLACK_ID = 'U0144K906KA'; // Edward Salem - for visibility on repeat overdue

const ESCALATION_REMINDERS = [
  (task: TaskForFollowUp, days: number, mentions: string) =>
    `${mentions} - "${task.name}" is now ${days} days overdue. <@${ESCALATION_SLACK_ID}> for visibility. Please update or mark ✅ when complete.`,
  (task: TaskForFollowUp, days: number, mentions: string) =>
    `Hey ${mentions}, this task has been overdue for ${days} days. Looping in <@${ESCALATION_SLACK_ID}>. Add ✅ once it's done.`,
  (task: TaskForFollowUp, days: number, mentions: string) =>
    `${mentions} - ${days} days overdue now. cc <@${ESCALATION_SLACK_ID}>. Mark complete with ✅ when finished.`,
];

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Send reminder to acknowledge with 👀
 */
async function sendAcknowledgeReminder(task: TaskForFollowUp): Promise<void> {
  const followUpKey = `ack-${task.id}`;
  if (hasRecentFollowUp(followUpKey)) return;

  const ownersWithSlack = task.owners.filter(o => o.slackId);
  if (ownersWithSlack.length === 0 || !task.slackThreadTs) return;

  const mentions = formatOwnerMentions(task.owners);
  const message = pickRandom(ACKNOWLEDGE_REMINDERS)(task, mentions);

  await slack.postToThread(task.slackThreadTs, message);

  markFollowUpSent(followUpKey);
  console.log(`Sent acknowledge reminder for task ${task.id}`);
}

/**
 * Send reminder for overdue task to mark ✅
 * Day 1: Regular reminder to owner
 * Day 2+: Escalated reminder with manager visibility
 */
async function sendOverdueReminder(task: TaskForFollowUp, daysOverdue: number): Promise<void> {
  // Send daily reminders for overdue tasks
  const followUpKey = `overdue-${task.id}-${daysOverdue}`;
  if (hasRecentFollowUp(followUpKey)) return;

  const ownersWithSlack = task.owners.filter(o => o.slackId);
  if (ownersWithSlack.length === 0 || !task.slackThreadTs) return;

  const mentions = formatOwnerMentions(task.owners);

  // Use escalation reminders (with manager cc) on day 2+
  const message = daysOverdue >= 2
    ? pickRandom(ESCALATION_REMINDERS)(task, daysOverdue, mentions)
    : pickRandom(OVERDUE_REMINDERS)(task, daysOverdue, mentions);

  await slack.postToThread(task.slackThreadTs, message);

  markFollowUpSent(followUpKey);
  console.log(`Sent ${daysOverdue >= 2 ? 'escalated ' : ''}overdue reminder for task ${task.id} (${daysOverdue} days)`);
}

function hasRecentFollowUp(key: string): boolean {
  const lastSent = sentFollowUps.get(key);
  if (!lastSent) return false;
  // Don't send same follow-up within 12 hours
  return Date.now() - lastSent < 12 * 60 * 60 * 1000;
}

function markFollowUpSent(key: string): void {
  sentFollowUps.set(key, Date.now());
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
