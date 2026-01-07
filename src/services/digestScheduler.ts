/**
 * Digest Scheduler
 *
 * Schedules and executes all digest-related jobs.
 * Runs checks every minute to determine what needs to be sent.
 */

import * as digest from './digest.js';
import * as workingHours from './workingHours.js';
import * as digestState from './digestState.js';

// ============================================================================
// Configuration
// ============================================================================

const SCHEDULER_INTERVAL_MS = 60 * 1000; // Check every minute

// Schedule times (EST, 24-hour format)
const SCHEDULE = {
  morningDigest: { hour: 10, minute: 0 }, // 10:00 AM (Dayna gets hers at 12:00)
  daynaDigest: { hour: 12, minute: 0 }, // 12:00 PM (Dayna's custom time)
  issueCallDigest: { hour: 10, minute: 0 }, // 10:00 AM
  teamOverview: { hour: 10, minute: 0 }, // 10:00 AM
  firstEscalation: { hour: 12, minute: 0 }, // 12:00 PM
  finalEscalation: { hour: 13, minute: 30 }, // 1:30 PM
  tomorrowPrep: { hour: 17, minute: 30 }, // 5:30 PM
  issueCallEOD: { hour: 17, minute: 30 }, // 5:30 PM
};

// Track what's been sent today to avoid duplicates
const sentToday = new Map<string, boolean>();

// Scheduler state
let schedulerInterval: NodeJS.Timeout | null = null;
let isRunning = false;
let lastCheckTime: Date | null = null;
let lastCheckStatus: string = 'Not started';

// ============================================================================
// Scheduler Status
// ============================================================================

export interface SchedulerStatus {
  isRunning: boolean;
  lastCheckTime: Date | null;
  lastCheckStatus: string;
  currentTimeEST: string;
  isBusinessDay: boolean;
  isWorkingHours: boolean;
  sentToday: string[];
}

export function getSchedulerStatus(): SchedulerStatus {
  const now = new Date();
  return {
    isRunning,
    lastCheckTime,
    lastCheckStatus,
    currentTimeEST: workingHours.formatDateEST(now, true),
    isBusinessDay: workingHours.isBusinessDay(now),
    isWorkingHours: workingHours.isWorkingHours(now),
    sentToday: Array.from(sentToday.keys()).filter((k) => sentToday.get(k)),
  };
}

// ============================================================================
// Schedule Checking
// ============================================================================

/**
 * Get a unique key for today's date
 */
function getTodayKey(): string {
  return workingHours.getESTDateString();
}

/**
 * Reset sent tracking at midnight
 */
function checkDayReset(): void {
  const todayKey = getTodayKey();
  const firstKey = sentToday.keys().next().value;

  if (firstKey && !firstKey.startsWith(todayKey)) {
    console.log('[Scheduler] New day detected, resetting tracking');
    sentToday.clear();
    digestState.checkAndResetForNewDay();
  }
}

/**
 * Check if a specific time slot matches current time
 */
function isTimeToRun(schedule: { hour: number; minute: number }): boolean {
  const now = new Date();
  const estHour = workingHours.getESTHour(now);
  const estMinute = now.getMinutes(); // Assuming we're roughly in sync

  // Allow a 2-minute window to account for timing variations
  return (
    estHour === schedule.hour &&
    estMinute >= schedule.minute &&
    estMinute < schedule.minute + 2
  );
}

/**
 * Mark a job as sent for today
 */
function markSent(jobName: string): void {
  const key = `${getTodayKey()}-${jobName}`;
  sentToday.set(key, true);
}

/**
 * Check if a job has been sent today
 */
function hasSentToday(jobName: string): boolean {
  const key = `${getTodayKey()}-${jobName}`;
  return sentToday.get(key) === true;
}

// ============================================================================
// Scheduler Loop
// ============================================================================

/**
 * Main scheduler check - runs every minute
 */
async function runSchedulerCheck(): Promise<void> {
  const now = new Date();
  lastCheckTime = now;

  try {
    // Reset tracking if it's a new day
    checkDayReset();

    // Skip if not a business day
    if (!workingHours.isBusinessDay(now)) {
      lastCheckStatus = 'Skipped (not a business day)';
      return;
    }

    const tasks: string[] = [];

    // Morning Digests (10:00 AM)
    if (isTimeToRun(SCHEDULE.morningDigest) && !hasSentToday('morning-digest')) {
      tasks.push('morning-digest');
    }

    // Issue Call Digest (10:00 AM)
    if (isTimeToRun(SCHEDULE.issueCallDigest) && !hasSentToday('issue-call-digest')) {
      tasks.push('issue-call-digest');
    }

    // Team Overview (10:00 AM)
    if (isTimeToRun(SCHEDULE.teamOverview) && !hasSentToday('team-overview')) {
      tasks.push('team-overview');
    }

    // Dayna's Digest (12:00 PM)
    if (isTimeToRun(SCHEDULE.daynaDigest) && !hasSentToday('dayna-digest')) {
      tasks.push('dayna-digest');
    }

    // First Escalation Check (12:00 PM)
    if (isTimeToRun(SCHEDULE.firstEscalation) && !hasSentToday('first-escalation')) {
      tasks.push('first-escalation');
    }

    // Final Escalation Check (1:30 PM)
    if (isTimeToRun(SCHEDULE.finalEscalation) && !hasSentToday('final-escalation')) {
      tasks.push('final-escalation');
    }

    // Tomorrow Prep (5:30 PM)
    if (isTimeToRun(SCHEDULE.tomorrowPrep) && !hasSentToday('tomorrow-prep')) {
      tasks.push('tomorrow-prep');
    }

    // Issue Call EOD (5:30 PM)
    if (isTimeToRun(SCHEDULE.issueCallEOD) && !hasSentToday('issue-call-eod')) {
      tasks.push('issue-call-eod');
    }

    if (tasks.length === 0) {
      lastCheckStatus = 'No tasks to run';
      return;
    }

    console.log(`[Scheduler] Running tasks: ${tasks.join(', ')}`);

    // Execute tasks
    for (const task of tasks) {
      try {
        switch (task) {
          case 'morning-digest':
            await digest.sendAllMorningDigests();
            markSent('morning-digest');
            break;

          case 'issue-call-digest':
            await digest.sendIssueCallDigest();
            markSent('issue-call-digest');
            break;

          case 'team-overview':
            await digest.sendTeamOverview();
            markSent('team-overview');
            break;

          case 'dayna-digest':
            // Dayna's custom digest time
            await digest.sendPersonalDigest('U05BRER83HT');
            markSent('dayna-digest');
            break;

          case 'first-escalation':
          case 'final-escalation':
            await digest.checkRegularTaskEscalations();
            markSent(task);
            break;

          case 'tomorrow-prep':
            await digest.sendAllTomorrowPrep();
            markSent('tomorrow-prep');
            break;

          case 'issue-call-eod':
            await digest.sendIssueCallEOD();
            markSent('issue-call-eod');
            break;
        }

        console.log(`[Scheduler] Completed: ${task}`);
      } catch (error) {
        console.error(`[Scheduler] Error running ${task}:`, error);
      }
    }

    lastCheckStatus = `Completed: ${tasks.join(', ')}`;
  } catch (error) {
    console.error('[Scheduler] Error in scheduler check:', error);
    lastCheckStatus = `Error: ${error instanceof Error ? error.message : 'Unknown'}`;
  }
}

/**
 * Issue call escalation check - runs every 15 minutes during business hours
 */
let issueCallCheckCounter = 0;

async function runIssueCallEscalationCheck(): Promise<void> {
  issueCallCheckCounter++;

  // Only run every 15 checks (15 minutes)
  if (issueCallCheckCounter % 15 !== 0) {
    return;
  }

  const now = new Date();

  // Only run during working hours
  if (!workingHours.isWorkingHours(now)) {
    return;
  }

  try {
    console.log('[Scheduler] Running issue call escalation check');
    await digest.checkIssueCallEscalations();
  } catch (error) {
    console.error('[Scheduler] Error in issue call escalation check:', error);
  }
}

// ============================================================================
// Scheduler Control
// ============================================================================

/**
 * Start the digest scheduler
 */
export function startDigestScheduler(): void {
  if (isRunning) {
    console.log('[Scheduler] Already running');
    return;
  }

  console.log('[Scheduler] Starting digest scheduler');
  isRunning = true;
  lastCheckStatus = 'Started';

  // Run initial check after 5 seconds
  setTimeout(() => {
    runSchedulerCheck().catch(console.error);
  }, 5000);

  // Set up regular interval
  schedulerInterval = setInterval(async () => {
    await runSchedulerCheck();
    await runIssueCallEscalationCheck();
  }, SCHEDULER_INTERVAL_MS);

  console.log('[Scheduler] Digest scheduler started');
}

/**
 * Stop the digest scheduler
 */
export function stopDigestScheduler(): void {
  if (!isRunning) {
    console.log('[Scheduler] Not running');
    return;
  }

  console.log('[Scheduler] Stopping digest scheduler');

  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }

  isRunning = false;
  lastCheckStatus = 'Stopped';

  console.log('[Scheduler] Digest scheduler stopped');
}

// ============================================================================
// Manual Triggers (for testing)
// ============================================================================

/**
 * Manually trigger morning digests
 */
export async function triggerMorningDigests(): Promise<{ sent: number }> {
  console.log('[Scheduler] Manual trigger: morning digests');
  const sent = await digest.sendAllMorningDigests();
  return { sent };
}

/**
 * Manually trigger personal digest for a specific user
 */
export async function triggerPersonalDigest(
  slackUserId: string
): Promise<{ success: boolean }> {
  console.log(`[Scheduler] Manual trigger: personal digest for ${slackUserId}`);
  const success = await digest.sendPersonalDigest(slackUserId);
  return { success };
}

/**
 * Manually trigger issue call digest
 */
export async function triggerIssueCallDigest(): Promise<{ success: boolean }> {
  console.log('[Scheduler] Manual trigger: issue call digest');
  const success = await digest.sendIssueCallDigest();
  return { success };
}

/**
 * Manually trigger team overview
 */
export async function triggerTeamOverview(): Promise<{ success: boolean }> {
  console.log('[Scheduler] Manual trigger: team overview');
  const success = await digest.sendTeamOverview();
  return { success };
}

/**
 * Manually trigger tomorrow prep
 */
export async function triggerTomorrowPrep(): Promise<{ sent: number }> {
  console.log('[Scheduler] Manual trigger: tomorrow prep');
  const sent = await digest.sendAllTomorrowPrep();
  return { sent };
}

/**
 * Manually trigger issue call EOD
 */
export async function triggerIssueCallEOD(): Promise<{ success: boolean }> {
  console.log('[Scheduler] Manual trigger: issue call EOD');
  const success = await digest.sendIssueCallEOD();
  return { success };
}

/**
 * Manually trigger escalation checks
 */
export async function triggerEscalationCheck(): Promise<{ checked: boolean }> {
  console.log('[Scheduler] Manual trigger: escalation check');
  await digest.checkRegularTaskEscalations();
  await digest.checkIssueCallEscalations();
  return { checked: true };
}

/**
 * Reset all tracking for today (for testing)
 */
export function resetTodayTracking(): void {
  console.log('[Scheduler] Resetting today tracking');
  sentToday.clear();
  digestState.clearAllState();
}
