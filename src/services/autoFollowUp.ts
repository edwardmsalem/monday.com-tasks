/**
 * Auto Follow-Up Service
 *
 * Sends natural, conversational check-ins for tasks based on:
 * - Due date approaching (1 day before, day of)
 * - No activity/updates on a task for X days
 * - Overdue tasks
 *
 * Run this on a schedule (e.g., cron job, setInterval)
 */

import { config } from '../config/environment.js';
import * as monday from './monday.js';
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
  dueDate: string;
  owners: Owner[];
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
        await sendOverdueFollowUp(task, Math.abs(daysUntilDue));
      } else if (daysUntilDue === 0) {
        // Due today
        await sendDueTodayFollowUp(task);
      } else if (daysUntilDue === 1) {
        // Due tomorrow
        await sendDueTomorrowFollowUp(task);
      } else if (daysSinceActivity !== null && daysSinceActivity >= 3 && daysUntilDue <= 5) {
        // No activity for 3+ days and due within 5 days
        await sendCheckInFollowUp(task, daysSinceActivity);
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

    // Parse ALL owners (not just the first one)
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
      dueDate: getValue(config.monday.columns.date),
      owners,
      slackThreadTs: getValue(config.monday.columns.slackThreadId) || null,
      lastActivityDate: item.updates[0]?.created_at ?? null,
      status: getValue(config.monday.columns.status),
    };
  }).filter(task => task.dueDate); // Only tasks with due dates
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

/**
 * Get first names for more casual messages
 */
function getFirstNames(owners: Owner[]): string {
  const names = owners.map(o => o.name.split(' ')[0]);
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

// Natural conversation starters for variety
const OVERDUE_MESSAGES = [
  (task: TaskForFollowUp, days: number, mentions: string) =>
    `Hey ${mentions}, just checking in - "${task.name}" was due ${days} day${days > 1 ? 's' : ''} ago. Everything okay? Let us know if you need help or if the timeline changed.`,
  (task: TaskForFollowUp, days: number, mentions: string) =>
    `${mentions} - wanted to follow up on "${task.name}". It's ${days} day${days > 1 ? 's' : ''} past due. Any blockers we should know about?`,
  (task: TaskForFollowUp, days: number, mentions: string) =>
    `Quick check-in ${mentions}: "${task.name}" is overdue by ${days} day${days > 1 ? 's' : ''}. What's the status? Need any support?`,
];

const DUE_TODAY_MESSAGES = [
  (task: TaskForFollowUp, mentions: string) =>
    `Hey ${mentions}, "${task.name}" is due today. How's it looking?`,
  (task: TaskForFollowUp, mentions: string) =>
    `${mentions} - just a heads up that "${task.name}" is due today. Let us know if you need anything!`,
  (task: TaskForFollowUp, mentions: string) =>
    `Today's the day for "${task.name}", ${mentions}. You've got this!`,
];

const DUE_TOMORROW_MESSAGES = [
  (task: TaskForFollowUp, mentions: string) =>
    `Hey ${mentions}, "${task.name}" is coming up tomorrow. How's progress?`,
  (task: TaskForFollowUp, mentions: string) =>
    `${mentions} - quick reminder that "${task.name}" is due tomorrow. Anything you need?`,
  (task: TaskForFollowUp, mentions: string) =>
    `Just a heads up ${mentions}: "${task.name}" is due tomorrow. Let us know how it's going!`,
];

const CHECK_IN_MESSAGES = [
  (task: TaskForFollowUp, days: number, mentions: string) =>
    `Hey ${mentions}, haven't heard anything on "${task.name}" in a few days. Everything on track?`,
  (task: TaskForFollowUp, days: number, mentions: string) =>
    `${mentions} - checking in on "${task.name}". Any updates to share?`,
  (task: TaskForFollowUp, days: number, mentions: string) =>
    `Quick check-in ${mentions}: how's "${task.name}" going? Just want to make sure nothing's stuck.`,
];

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Send follow-up for overdue task
 */
async function sendOverdueFollowUp(task: TaskForFollowUp, daysOverdue: number): Promise<void> {
  const followUpKey = `overdue-${task.id}-${daysOverdue}`;
  if (hasRecentFollowUp(followUpKey)) return;

  const ownersWithSlack = task.owners.filter(o => o.slackId);
  if (ownersWithSlack.length === 0 || !task.slackThreadTs) return;

  const mentions = formatOwnerMentions(task.owners);
  const message = pickRandom(OVERDUE_MESSAGES)(task, daysOverdue, mentions);

  await slack.postToThread(task.slackThreadTs, message);

  markFollowUpSent(followUpKey);
  console.log(`Sent overdue follow-up for task ${task.id}`);
}

/**
 * Send follow-up for task due today
 */
async function sendDueTodayFollowUp(task: TaskForFollowUp): Promise<void> {
  const followUpKey = `due-today-${task.id}`;
  if (hasRecentFollowUp(followUpKey)) return;

  const ownersWithSlack = task.owners.filter(o => o.slackId);
  if (ownersWithSlack.length === 0 || !task.slackThreadTs) return;

  const mentions = formatOwnerMentions(task.owners);
  const message = pickRandom(DUE_TODAY_MESSAGES)(task, mentions);

  await slack.postToThread(task.slackThreadTs, message);

  markFollowUpSent(followUpKey);
  console.log(`Sent due-today follow-up for task ${task.id}`);
}

/**
 * Send follow-up for task due tomorrow
 */
async function sendDueTomorrowFollowUp(task: TaskForFollowUp): Promise<void> {
  const followUpKey = `due-tomorrow-${task.id}`;
  if (hasRecentFollowUp(followUpKey)) return;

  const ownersWithSlack = task.owners.filter(o => o.slackId);
  if (ownersWithSlack.length === 0 || !task.slackThreadTs) return;

  const mentions = formatOwnerMentions(task.owners);
  const message = pickRandom(DUE_TOMORROW_MESSAGES)(task, mentions);

  await slack.postToThread(task.slackThreadTs, message);

  markFollowUpSent(followUpKey);
  console.log(`Sent due-tomorrow follow-up for task ${task.id}`);
}

/**
 * Send check-in for task with no recent activity
 */
async function sendCheckInFollowUp(task: TaskForFollowUp, daysSinceActivity: number): Promise<void> {
  const followUpKey = `check-in-${task.id}-${Math.floor(daysSinceActivity / 3)}`;
  if (hasRecentFollowUp(followUpKey)) return;

  const ownersWithSlack = task.owners.filter(o => o.slackId);
  if (ownersWithSlack.length === 0 || !task.slackThreadTs) return;

  const mentions = formatOwnerMentions(task.owners);
  const message = pickRandom(CHECK_IN_MESSAGES)(task, daysSinceActivity, mentions);

  await slack.postToThread(task.slackThreadTs, message);

  markFollowUpSent(followUpKey);
  console.log(`Sent check-in follow-up for task ${task.id}`);
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
