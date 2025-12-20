/**
 * Auto Follow-Up Service
 *
 * Sends action-oriented reminders:
 * - No 👀 acknowledgment → remind to acknowledge
 * - Past due → remind to complete with ✅
 *
 * Run this on a schedule (e.g., cron job, setInterval)
 * Only sends during business hours (M-F 9am-5pm EST, excluding US holidays)
 */

import { config } from '../config/environment.js';
import * as slack from './slack.js';
import * as monday from './monday.js';
import { getAllUsers, type UnifiedUser } from './userResolver.js';

// US Federal Holidays (fixed dates and observed dates for 2024-2025)
const US_HOLIDAYS: string[] = [
  // 2024
  '2024-01-01', // New Year's Day
  '2024-01-15', // MLK Day
  '2024-02-19', // Presidents Day
  '2024-05-27', // Memorial Day
  '2024-06-19', // Juneteenth
  '2024-07-04', // Independence Day
  '2024-09-02', // Labor Day
  '2024-10-14', // Columbus Day
  '2024-11-11', // Veterans Day
  '2024-11-28', // Thanksgiving
  '2024-11-29', // Day after Thanksgiving
  '2024-12-24', // Christmas Eve
  '2024-12-25', // Christmas
  '2024-12-31', // New Year's Eve
  // 2025
  '2025-01-01', // New Year's Day
  '2025-01-20', // MLK Day
  '2025-02-17', // Presidents Day
  '2025-05-26', // Memorial Day
  '2025-06-19', // Juneteenth
  '2025-07-04', // Independence Day
  '2025-09-01', // Labor Day
  '2025-10-13', // Columbus Day
  '2025-11-11', // Veterans Day
  '2025-11-27', // Thanksgiving
  '2025-11-28', // Day after Thanksgiving
  '2025-12-24', // Christmas Eve
  '2025-12-25', // Christmas
  '2025-12-31', // New Year's Eve
];

/**
 * Check if current time is within business hours
 * Business hours: Monday-Friday, 10am-6pm Eastern Time
 */
function isBusinessHours(): boolean {
  // Get current time in Eastern timezone
  const now = new Date();
  const eastern = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));

  const dayOfWeek = eastern.getDay(); // 0 = Sunday, 6 = Saturday
  const hour = eastern.getHours();

  // Check if weekend
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return false;
  }

  // Check if outside 10am-6pm
  if (hour < 10 || hour >= 18) {
    return false;
  }

  // Check if holiday
  const dateStr = eastern.toISOString().split('T')[0];
  if (US_HOLIDAYS.includes(dateStr)) {
    return false;
  }

  return true;
}

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
 * @param force - If true, bypasses business hours check (for manual triggers)
 */
export async function checkAndSendFollowUps(force: boolean = false): Promise<{ sent: number; skipped: string }> {
  console.log('Checking tasks for follow-ups...');

  // Skip if outside business hours (unless forced)
  if (!force && !isBusinessHours()) {
    console.log('Outside business hours - skipping follow-ups');
    return { sent: 0, skipped: 'outside_business_hours' };
  }

  let sentCount = 0;

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
        const sent = await sendAcknowledgeReminder(task);
        if (sent) sentCount++;
      }

      // 2. Past due and not complete → remind to add ✅
      if (task.dueDate) {
        const dueDate = new Date(task.dueDate);
        dueDate.setHours(0, 0, 0, 0);
        const daysOverdue = Math.floor((today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));

        if (daysOverdue > 0) {
          const sent = await sendOverdueReminder(task, daysOverdue);
          if (sent) sentCount++;
        }
      }
    }

    console.log(`Follow-up check complete. Sent ${sentCount} reminders.`);
    return { sent: sentCount, skipped: '' };
  } catch (error) {
    console.error('Error checking follow-ups:', error);
    return { sent: sentCount, skipped: 'error' };
  }
}

interface TaskDebugInfo {
  id: string;
  name: string;
  status: string;
  dueDate: string | null;
  daysOverdue: number;
  hasThread: boolean;
  hasOwners: boolean;
  ownersWithSlack: number;
  skipReason: string | null;
}

/**
 * Debug function to see what tasks exist and why they would/wouldn't get reminders
 */
export async function debugFollowUps(): Promise<{ tasks: TaskDebugInfo[]; total: number }> {
  const tasks = await getOpenTasks();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const debugInfo: TaskDebugInfo[] = tasks.map(task => {
    const status = task.workflowStatus.toLowerCase();
    let daysOverdue = 0;

    if (task.dueDate) {
      const dueDate = new Date(task.dueDate);
      dueDate.setHours(0, 0, 0, 0);
      daysOverdue = Math.floor((today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));
    }

    const ownersWithSlack = task.owners.filter(o => o.slackId).length;

    // Determine skip reason
    let skipReason: string | null = null;
    if (status === 'complete' || status === 'done' || status === 'completed' || status === 'closed') {
      skipReason = `Status is "${task.workflowStatus}"`;
    } else if (!task.slackThreadTs) {
      skipReason = 'No Slack thread ID';
    } else if (task.owners.length === 0) {
      skipReason = 'No owners assigned';
    } else if (ownersWithSlack === 0) {
      skipReason = 'No owners have Slack IDs';
    } else if (daysOverdue <= 0 && task.workflowStatus) {
      skipReason = 'Not overdue and already acknowledged';
    } else if (daysOverdue <= 0 && !task.dueDate) {
      skipReason = 'No due date set';
    }

    return {
      id: task.id,
      name: task.name.substring(0, 50) + (task.name.length > 50 ? '...' : ''),
      status: task.workflowStatus || '(none)',
      dueDate: task.dueDate,
      daysOverdue,
      hasThread: !!task.slackThreadTs,
      hasOwners: task.owners.length > 0,
      ownersWithSlack,
      skipReason,
    };
  });

  return { tasks: debugInfo, total: tasks.length };
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
 * @returns true if message was sent, false if skipped
 */
async function sendAcknowledgeReminder(task: TaskForFollowUp): Promise<boolean> {
  const followUpKey = `ack-${task.id}`;
  if (hasRecentFollowUp(followUpKey)) return false;

  const ownersWithSlack = task.owners.filter(o => o.slackId);
  if (ownersWithSlack.length === 0 || !task.slackThreadTs) return false;

  const mentions = formatOwnerMentions(task.owners);
  const message = pickRandom(ACKNOWLEDGE_REMINDERS)(task, mentions);

  await slack.postToThread(task.slackThreadTs, message);

  markFollowUpSent(followUpKey);
  console.log(`Sent acknowledge reminder for task ${task.id}`);
  return true;
}

/**
 * Send reminder for overdue task to mark ✅
 * Day 1: Regular reminder to owner
 * Day 2+: Escalated reminder with manager visibility
 * @returns true if message was sent, false if skipped
 */
async function sendOverdueReminder(task: TaskForFollowUp, daysOverdue: number): Promise<boolean> {
  // Send daily reminders for overdue tasks
  const followUpKey = `overdue-${task.id}-${daysOverdue}`;
  if (hasRecentFollowUp(followUpKey)) return false;

  const ownersWithSlack = task.owners.filter(o => o.slackId);
  if (ownersWithSlack.length === 0 || !task.slackThreadTs) return false;

  const mentions = formatOwnerMentions(task.owners);

  // Use escalation reminders (with manager cc) on day 2+
  const message = daysOverdue >= 2
    ? pickRandom(ESCALATION_REMINDERS)(task, daysOverdue, mentions)
    : pickRandom(OVERDUE_REMINDERS)(task, daysOverdue, mentions);

  await slack.postToThread(task.slackThreadTs, message);

  markFollowUpSent(followUpKey);
  console.log(`Sent ${daysOverdue >= 2 ? 'escalated ' : ''}overdue reminder for task ${task.id} (${daysOverdue} days)`);
  return true;
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
 * Retry failed attachment uploads
 * Runs hourly as part of the scheduler - survives restarts
 */
async function runAttachmentRetry(): Promise<void> {
  try {
    // Create a Slack poster function for notifications
    const postToSlack = async (threadTs: string, message: string) => {
      await slack.postToThread(threadTs, message);
    };

    const result = await monday.retryFailedAttachments(postToSlack);

    if (result.attempted > 0) {
      console.log(`Attachment retry sweep: ${result.succeeded}/${result.attempted} succeeded`);
    }
  } catch (error) {
    console.error('Attachment retry sweep failed:', error);
  }
}

/**
 * Check if it's 10am (start of business hours) and release deferred notifications
 * Only runs Mon-Fri at 10am in configured timezone
 */
async function checkAndReleaseQuietHoursNotifications(): Promise<void> {
  const { quietHours } = config.slack;

  // Skip if quiet hours not enabled
  if (!quietHours.enabled) return;

  // Get current time in configured timezone
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: quietHours.timezone,
    weekday: 'short',
    hour: 'numeric',
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  const weekday = parts.find(p => p.type === 'weekday')?.value ?? '';
  const hour = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10);

  // Only run at 10am Mon-Fri
  if (weekday === 'Sat' || weekday === 'Sun') return;
  if (hour !== quietHours.workingHoursStart) return;

  console.log('10am business hour - checking for deferred quiet-hours notifications...');
  await slack.releaseAllDeferredNotifications();
}

/**
 * Start the follow-up scheduler
 * Runs every hour by default
 * Includes:
 * - Follow-up reminders (acknowledge, overdue)
 * - Failed attachment retry sweep (persistent across restarts)
 * - Quiet hours notification release (10am Mon-Fri)
 */
export function startFollowUpScheduler(intervalMs: number = 60 * 60 * 1000): void {
  console.log(`Starting follow-up scheduler (interval: ${intervalMs / 1000 / 60} minutes)`);

  // Run immediately on start
  checkAndSendFollowUps();
  runAttachmentRetry();
  checkAndReleaseQuietHoursNotifications();

  // Then run on interval
  setInterval(() => {
    checkAndSendFollowUps();
    runAttachmentRetry();
    checkAndReleaseQuietHoursNotifications();
  }, intervalMs);
}
