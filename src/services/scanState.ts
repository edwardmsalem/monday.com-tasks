/**
 * Scan State Persistence
 *
 * Tracks active /scan operations so the daily re-scan can:
 * - Find existing scan sheets
 * - Re-check Gmail for new appointment times
 * - Update sheets and create calendar events for new times
 *
 * State is persisted to disk to survive server restarts.
 */

import * as fs from 'fs';
import * as path from 'path';

const STATE_FILE = path.join(process.cwd(), '.scan-state.json');

// ============================================================================
// Types
// ============================================================================

export interface ActiveScan {
  /** Team name (e.g., "Vegas Golden Knights") */
  teamName: string;
  /** Email subject used for Gmail search */
  subject: string;
  /** Google Sheet ID */
  spreadsheetId: string;
  /** Google Sheet URL */
  spreadsheetUrl: string;
  /** Monday.com item ID */
  mondayItemId: string;
  /** Slack thread timestamp */
  slackThreadTs: string;
  /** ISO timestamp of initial scan */
  createdAt: string;
  /** ISO timestamp of last re-scan */
  lastRescanAt: string;
  /** Known appointment times (ISO strings) to detect new ones */
  knownAppointmentTimes: string[];
  /** Known calendar event IDs to avoid duplicates */
  calendarEventIds: string[];
}

interface ScanState {
  /** Active scans keyed by mondayItemId */
  activeScans: Record<string, ActiveScan>;
}

// ============================================================================
// Persistence
// ============================================================================

let state: ScanState = {
  activeScans: {},
};

function loadState(): void {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf-8');
      state = JSON.parse(raw);
    }
  } catch (error) {
    console.error('[ScanState] Failed to load state:', error);
    state = { activeScans: {} };
  }
}

function saveState(): void {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (error) {
    console.error('[ScanState] Failed to save state:', error);
  }
}

// Load on import
loadState();

// ============================================================================
// Public API
// ============================================================================

/**
 * Register a new scan for daily re-scanning
 */
export function registerScan(scan: ActiveScan): void {
  state.activeScans[scan.mondayItemId] = scan;
  saveState();
  console.log(`[ScanState] Registered scan for "${scan.teamName}" (Monday ID: ${scan.mondayItemId})`);
}

/**
 * Get all active scans
 */
export function getActiveScans(): ActiveScan[] {
  return Object.values(state.activeScans);
}

/**
 * Get a specific scan by Monday item ID
 */
export function getScan(mondayItemId: string): ActiveScan | undefined {
  return state.activeScans[mondayItemId];
}

/**
 * Update a scan's last rescan time and known appointments
 */
export function updateScanAfterRescan(
  mondayItemId: string,
  newAppointmentTimes: string[],
  newCalendarEventIds: string[]
): void {
  const scan = state.activeScans[mondayItemId];
  if (!scan) return;

  scan.lastRescanAt = new Date().toISOString();

  // Merge new appointment times (deduplicated)
  const allTimes = new Set([...scan.knownAppointmentTimes, ...newAppointmentTimes]);
  scan.knownAppointmentTimes = Array.from(allTimes);

  // Merge new calendar event IDs
  const allEventIds = new Set([...scan.calendarEventIds, ...newCalendarEventIds]);
  scan.calendarEventIds = Array.from(allEventIds);

  saveState();
  console.log(`[ScanState] Updated scan for "${scan.teamName}" - ${scan.knownAppointmentTimes.length} known times, ${scan.calendarEventIds.length} calendar events`);
}

/**
 * Remove a scan (e.g., when task is completed)
 */
export function removeScan(mondayItemId: string): void {
  const scan = state.activeScans[mondayItemId];
  if (scan) {
    delete state.activeScans[mondayItemId];
    saveState();
    console.log(`[ScanState] Removed scan for "${scan.teamName}"`);
  }
}

/**
 * Remove scans older than N days (auto-cleanup)
 */
export function cleanupOldScans(maxAgeDays: number = 30): number {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let removed = 0;

  for (const [id, scan] of Object.entries(state.activeScans)) {
    const createdAt = new Date(scan.createdAt).getTime();
    if (createdAt < cutoff) {
      delete state.activeScans[id];
      removed++;
    }
  }

  if (removed > 0) {
    saveState();
    console.log(`[ScanState] Cleaned up ${removed} old scans`);
  }

  return removed;
}
