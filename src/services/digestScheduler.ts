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
  dailyReports: { hour: 18, minute: 0 }, // 6:00 PM - supervisor & executive reports
  scanRescan: { hour: 9, minute: 0 }, // 9:00 AM - daily appointment re-scan
};

// Note: Sent tracking is now persisted in digestState.scheduledTasksSent
// to survive server reboots

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
  const state = digestState.getFullState();
  const todayPrefix = workingHours.getESTDateString();

  // Get sent tasks for today from persisted state
  const sentTodayList = Object.keys(state.scheduledTasksSent || {})
    .filter(k => k.startsWith(todayPrefix) && state.scheduledTasksSent[k]);

  return {
    isRunning,
    lastCheckTime,
    lastCheckStatus,
    currentTimeEST: workingHours.formatDateEST(now, true),
    isBusinessDay: workingHours.isBusinessDay(now),
    isWorkingHours: workingHours.isWorkingHours(now),
    sentToday: sentTodayList,
  };
}

// ============================================================================
// Schedule Checking
// ============================================================================

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
    // Reset state if it's a new day (persisted to disk)
    digestState.checkAndResetForNewDay();

    // Skip if not a business day
    if (!workingHours.isBusinessDay(now)) {
      lastCheckStatus = 'Skipped (not a business day)';
      return;
    }

    const tasks: string[] = [];

    // Morning Digests (10:00 AM)
    if (isTimeToRun(SCHEDULE.morningDigest) && !digestState.hasScheduledTaskBeenSent('morning-digest')) {
      tasks.push('morning-digest');
    }

    // Issue Call Digest (10:00 AM)
    if (isTimeToRun(SCHEDULE.issueCallDigest) && !digestState.hasScheduledTaskBeenSent('issue-call-digest')) {
      tasks.push('issue-call-digest');
    }

    // Team Overview (10:00 AM)
    if (isTimeToRun(SCHEDULE.teamOverview) && !digestState.hasScheduledTaskBeenSent('team-overview')) {
      tasks.push('team-overview');
    }

    // Dayna's Digest (12:00 PM)
    if (isTimeToRun(SCHEDULE.daynaDigest) && !digestState.hasScheduledTaskBeenSent('dayna-digest')) {
      tasks.push('dayna-digest');
    }

    // First Escalation Check (12:00 PM)
    if (isTimeToRun(SCHEDULE.firstEscalation) && !digestState.hasScheduledTaskBeenSent('first-escalation')) {
      tasks.push('first-escalation');
    }

    // Final Escalation Check (1:30 PM)
    if (isTimeToRun(SCHEDULE.finalEscalation) && !digestState.hasScheduledTaskBeenSent('final-escalation')) {
      tasks.push('final-escalation');
    }

    // Tomorrow Prep (5:30 PM)
    if (isTimeToRun(SCHEDULE.tomorrowPrep) && !digestState.hasScheduledTaskBeenSent('tomorrow-prep')) {
      tasks.push('tomorrow-prep');
    }

    // Issue Call EOD (5:30 PM)
    if (isTimeToRun(SCHEDULE.issueCallEOD) && !digestState.hasScheduledTaskBeenSent('issue-call-eod')) {
      tasks.push('issue-call-eod');
    }

    // Daily Reports (6:00 PM) - supervisor and executive reports
    if (isTimeToRun(SCHEDULE.dailyReports) && !digestState.hasScheduledTaskBeenSent('daily-reports')) {
      tasks.push('daily-reports');
    }

    // Scan Re-scan (9:00 AM) - check for new appointment times on existing scans
    if (isTimeToRun(SCHEDULE.scanRescan) && !digestState.hasScheduledTaskBeenSent('scan-rescan')) {
      tasks.push('scan-rescan');
    }

    if (tasks.length === 0) {
      lastCheckStatus = 'No tasks to run';
      return;
    }

    console.log(`[Scheduler] Running tasks: ${tasks.join(', ')}`);

    // Mark all tasks as sent BEFORE executing to prevent duplicate runs
    // if tasks take longer than the scheduler interval (persisted to disk)
    for (const task of tasks) {
      digestState.markScheduledTaskSent(task);
    }

    // Execute tasks
    for (const task of tasks) {
      try {
        switch (task) {
          case 'morning-digest':
            await digest.sendAllMorningDigests();
            break;

          case 'issue-call-digest':
            await digest.sendIssueCallDigest();
            break;

          case 'team-overview':
            await digest.sendTeamOverview();
            break;

          case 'dayna-digest':
            // Dayna's custom digest time
            await digest.sendPersonalDigest('U05BRER83HT');
            break;

          case 'first-escalation':
          case 'final-escalation':
            await digest.checkRegularTaskEscalations();
            break;

          case 'tomorrow-prep':
            await digest.sendAllTomorrowPrep();
            break;

          case 'issue-call-eod':
            await digest.sendIssueCallEOD();
            break;

          case 'daily-reports':
            await digest.sendAllDailyReports();
            break;

          case 'scan-rescan':
            await runScanRescan();
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
// Scan Re-scan (Daily Appointment Check)
// ============================================================================

/**
 * Daily re-scan: check for new appointment times on all active scans.
 * For each active scan:
 * 1. Re-scan Gmail for the same subject
 * 2. Extract appointment times
 * 3. Compare with existing sheet data
 * 4. Update sheet with new times
 * 5. Create calendar events for new unique time slots
 * 6. Post update to Slack/Monday
 */
async function runScanRescan(): Promise<void> {
  const { getActiveScans, updateScanAfterRescan, cleanupOldScans } = await import('./scanState.js');
  const { findRelatedRecipients, enrichRecipientsWithAppointments } = await import('./gmail.js');
  const { updateScanSheet } = await import('./sheets.js');
  const calendar = await import('./calendar.js');
  const monday = await import('./monday.js');
  const slack = await import('./slack.js');

  // Cleanup scans older than 30 days
  cleanupOldScans(30);

  const activeScans = getActiveScans();
  if (activeScans.length === 0) {
    console.log('[ScanRescan] No active scans to re-check');
    return;
  }

  console.log(`[ScanRescan] Re-scanning ${activeScans.length} active scans for new appointments...`);

  for (const scan of activeScans) {
    try {
      console.log(`[ScanRescan] Re-scanning "${scan.teamName}" (subject: "${scan.subject}")...`);

      // Step 1: Re-scan Gmail for the same subject (fast, skip appointment extraction)
      // Search from 24 hours before the scan was first created to catch emails
      // that arrive today but are dated yesterday
      const searchAfter = new Date(new Date(scan.createdAt).getTime() - 24 * 60 * 60 * 1000);
      console.log(`[ScanRescan] Search window: after ${searchAfter.toISOString()} (24h before scan creation)`);

      const recipients = await findRelatedRecipients(scan.subject, {
        skipAppointmentExtraction: true,
        afterDate: searchAfter,
      });

      if (recipients.length === 0) {
        console.log(`[ScanRescan] No recipients found for "${scan.teamName}", skipping`);
        continue;
      }

      // Step 2: Extract appointment times from emails
      const enriched = await enrichRecipientsWithAppointments(scan.subject, recipients);
      const withTimes = enriched.filter(r => r.rawDateTime);

      if (withTimes.length === 0) {
        console.log(`[ScanRescan] No appointment times found for "${scan.teamName}", skipping`);
        continue;
      }

      // Step 3: Compare with known times and find new ones
      const knownTimesSet = new Set(scan.knownAppointmentTimes);
      const newRecipients = withTimes.filter(r => !knownTimesSet.has(r.rawDateTime!));

      if (newRecipients.length === 0) {
        console.log(`[ScanRescan] No new appointment times for "${scan.teamName}"`);
        continue;
      }

      console.log(`[ScanRescan] Found ${newRecipients.length} new appointments for "${scan.teamName}"`);

      // Step 4: Update the existing Google Sheet with new times
      const updateResult = await updateScanSheet(scan.spreadsheetId, enriched);
      console.log(`[ScanRescan] Updated ${updateResult.updatedRows} rows in sheet`);

      // Step 5: Create calendar events for new unique time slots
      const newCalendarEventIds: string[] = [];
      if (calendar.isCalendarEnabled() && updateResult.newAppointmentTimes.length > 0) {
        try {
          const calendarEvents = await calendar.createScanAppointmentEvents(
            scan.teamName,
            newRecipients,
            scan.mondayItemId,
            scan.spreadsheetUrl
          );

          for (const event of calendarEvents) {
            newCalendarEventIds.push(event.eventId);
          }

          if (calendarEvents.length > 0) {
            console.log(`[ScanRescan] Created ${calendarEvents.length} new calendar events`);
          }
        } catch (calError) {
          console.error(`[ScanRescan] Failed to create calendar events:`, calError);
        }
      }

      // Step 6: Update scan state
      const newTimes = newRecipients.map(r => r.rawDateTime!);
      updateScanAfterRescan(scan.mondayItemId, newTimes, newCalendarEventIds);

      // Step 7: Post update to Slack thread
      try {
        const updateParts: string[] = [
          `*Daily Re-scan Update*`,
          `Found ${newRecipients.length} new appointment time(s)`,
        ];
        if (updateResult.updatedRows > 0) {
          updateParts.push(`Updated ${updateResult.updatedRows} rows in the tracking sheet`);
        }
        if (newCalendarEventIds.length > 0) {
          updateParts.push(`Created ${newCalendarEventIds.length} new calendar event(s)`);
        }

        await slack.postToThread(
          scan.slackThreadTs,
          `🔄 ${updateParts.join('\n')}`
        );
      } catch (slackErr) {
        console.error(`[ScanRescan] Failed to post Slack update:`, slackErr);
      }

      // Step 8: Post Monday update
      try {
        await monday.createUpdate(
          scan.mondayItemId,
          `🔄 Daily re-scan: ${newRecipients.length} new appointment(s) found, ${newCalendarEventIds.length} calendar event(s) created`
        );
      } catch (mondayErr) {
        console.error(`[ScanRescan] Failed to post Monday update:`, mondayErr);
      }

    } catch (error) {
      console.error(`[ScanRescan] Failed to re-scan "${scan.teamName}":`, error);
    }
  }

  console.log('[ScanRescan] Daily re-scan complete');
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
  digestState.clearScheduledTasksSent();
  digestState.clearAllState();
}

/**
 * Manually trigger all daily reports (supervisor + executive)
 */
export async function triggerDailyReports(): Promise<{ garet: boolean; ruzzell: boolean; executive: boolean }> {
  console.log('[Scheduler] Manual trigger: daily reports');
  return await digest.sendAllDailyReports();
}

/**
 * Manually trigger Garet's supervisor report
 */
export async function triggerGaretReport(): Promise<{ success: boolean }> {
  console.log('[Scheduler] Manual trigger: Garet report');
  const success = await digest.sendSupervisorReportGaret();
  return { success };
}

/**
 * Manually trigger Ruzzell's supervisor report
 */
export async function triggerRuzzellReport(): Promise<{ success: boolean }> {
  console.log('[Scheduler] Manual trigger: Ruzzell report');
  const success = await digest.sendSupervisorReportRuzzell();
  return { success };
}

/**
 * Manually trigger executive report
 */
export async function triggerExecutiveReport(): Promise<{ success: boolean }> {
  console.log('[Scheduler] Manual trigger: executive report');
  const success = await digest.sendExecutiveReport();
  return { success };
}
