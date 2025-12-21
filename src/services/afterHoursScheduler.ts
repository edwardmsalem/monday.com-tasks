/**
 * After-Hours Scheduler Service
 *
 * Handles two scheduled jobs:
 * 1. Release (8 AM ET on business days) - Ping assignees for after-hours tasks
 * 2. Follow-up (11 AM ET on business days) - Remind unacknowledged tasks
 *
 * Uses simple interval-based checking (no external cron library needed).
 * Checks every minute and triggers jobs at the right times.
 */

import { config } from '../config/environment.js';
import {
  isWorkingHours,
  releaseAllDeferredNotifications,
  sendAllAckReminders,
} from './slack.js';

// ============================================================================
// State
// ============================================================================

let isRunning = false;
let checkInterval: NodeJS.Timeout | null = null;

// Track last run dates to avoid duplicate runs
let lastReleaseDate: string | null = null;
let lastReminderDate: string | null = null;

// ============================================================================
// Time Utilities
// ============================================================================

/**
 * Get current date/time info in configured timezone
 */
function getCurrentTimeInfo(): {
  dateKey: string;  // YYYY-MM-DD for deduplication
  hour: number;
  minute: number;
  weekday: string;
  isBusinessDay: boolean;
} {
  const { quietHours } = config.slack;
  const now = new Date();

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: quietHours.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  const year = parts.find(p => p.type === 'year')?.value ?? '0000';
  const month = parts.find(p => p.type === 'month')?.value ?? '00';
  const day = parts.find(p => p.type === 'day')?.value ?? '00';
  const weekday = parts.find(p => p.type === 'weekday')?.value ?? '';
  const hour = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10);
  const minute = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10);

  const dateKey = `${year}-${month}-${day}`;
  const isBusinessDay = weekday !== 'Sat' && weekday !== 'Sun';

  return { dateKey, hour, minute, weekday, isBusinessDay };
}

// ============================================================================
// Job Runners
// ============================================================================

/**
 * Run the release job (8 AM ET on business days)
 */
async function runReleaseJob(): Promise<void> {
  console.log('[AfterHoursScheduler] Running release job...');
  try {
    const released = await releaseAllDeferredNotifications();
    console.log(`[AfterHoursScheduler] Release job complete: ${released} notifications released`);
  } catch (error) {
    console.error('[AfterHoursScheduler] Release job failed:', error);
  }
}

/**
 * Run the reminder job (11 AM ET on business days)
 */
async function runReminderJob(): Promise<void> {
  console.log('[AfterHoursScheduler] Running reminder job...');
  try {
    const reminded = await sendAllAckReminders();
    console.log(`[AfterHoursScheduler] Reminder job complete: ${reminded} reminders sent`);
  } catch (error) {
    console.error('[AfterHoursScheduler] Reminder job failed:', error);
  }
}

/**
 * Check if it's time to run scheduled jobs
 */
async function checkAndRunJobs(): Promise<void> {
  const { quietHours } = config.slack;
  const timeInfo = getCurrentTimeInfo();

  // Skip if not a business day
  if (!timeInfo.isBusinessDay) {
    return;
  }

  const releaseHour = quietHours.releaseHour;
  const ackDeadlineHour = quietHours.ackDeadlineHour;

  // Check for release job (run at release hour, minute 0-5)
  // Use a 5-minute window to account for any timing issues
  if (
    timeInfo.hour === releaseHour &&
    timeInfo.minute < 5 &&
    lastReleaseDate !== timeInfo.dateKey
  ) {
    lastReleaseDate = timeInfo.dateKey;
    await runReleaseJob();
  }

  // Check for reminder job (run at ack deadline hour, minute 0-5)
  if (
    timeInfo.hour === ackDeadlineHour &&
    timeInfo.minute < 5 &&
    lastReminderDate !== timeInfo.dateKey
  ) {
    lastReminderDate = timeInfo.dateKey;
    await runReminderJob();
  }
}

// ============================================================================
// Scheduler Control
// ============================================================================

/**
 * Start the after-hours scheduler
 */
export function startScheduler(): void {
  if (isRunning) {
    console.log('[AfterHoursScheduler] Already running');
    return;
  }

  if (!config.slack.quietHours.enabled) {
    console.log('[AfterHoursScheduler] Quiet hours disabled, scheduler not started');
    return;
  }

  console.log('[AfterHoursScheduler] Starting scheduler...');
  console.log(`[AfterHoursScheduler] Release hour: ${config.slack.quietHours.releaseHour}:00 ET`);
  console.log(`[AfterHoursScheduler] Ack deadline hour: ${config.slack.quietHours.ackDeadlineHour}:00 ET`);
  console.log(`[AfterHoursScheduler] Working hours: ${config.slack.quietHours.workingHoursStart}:00 - ${config.slack.quietHours.workingHoursEnd}:00 ET`);

  // Check every minute
  checkInterval = setInterval(() => {
    checkAndRunJobs().catch(err => {
      console.error('[AfterHoursScheduler] Error in check loop:', err);
    });
  }, 60 * 1000); // 1 minute

  // Also run an initial check
  checkAndRunJobs().catch(err => {
    console.error('[AfterHoursScheduler] Error in initial check:', err);
  });

  isRunning = true;
  console.log('[AfterHoursScheduler] Scheduler started');
}

/**
 * Stop the scheduler
 */
export function stopScheduler(): void {
  if (!isRunning) {
    return;
  }

  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }

  isRunning = false;
  console.log('[AfterHoursScheduler] Scheduler stopped');
}

/**
 * Get scheduler status for debugging
 */
export function getSchedulerStatus(): {
  isRunning: boolean;
  lastReleaseDate: string | null;
  lastReminderDate: string | null;
  currentTime: ReturnType<typeof getCurrentTimeInfo>;
} {
  return {
    isRunning,
    lastReleaseDate,
    lastReminderDate,
    currentTime: getCurrentTimeInfo(),
  };
}

/**
 * Manually trigger the release job (for testing)
 */
export async function triggerReleaseNow(): Promise<number> {
  console.log('[AfterHoursScheduler] Manual release trigger');
  return releaseAllDeferredNotifications();
}

/**
 * Manually trigger the reminder job (for testing)
 */
export async function triggerReminderNow(): Promise<number> {
  console.log('[AfterHoursScheduler] Manual reminder trigger');
  return sendAllAckReminders();
}
