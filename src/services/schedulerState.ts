/**
 * Scheduler State Persistence
 *
 * Persists scheduler state to disk to survive restarts.
 * Prevents duplicate 8AM release and 11AM reminder jobs after deploy/restart.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';

// ============================================================================
// Types
// ============================================================================

export interface SchedulerState {
  lastReleaseDate: string | null;
  lastReminderDate: string | null;
  lastRunTimestamp: number;
}

// ============================================================================
// Constants
// ============================================================================

const STATE_FILE_PATH = './data/scheduler-state.json';

const DEFAULT_STATE: SchedulerState = {
  lastReleaseDate: null,
  lastReminderDate: null,
  lastRunTimestamp: 0,
};

// ============================================================================
// In-memory cache (to avoid reading file on every check)
// ============================================================================

let cachedState: SchedulerState | null = null;

// ============================================================================
// File Operations
// ============================================================================

/**
 * Ensure the data directory exists
 */
function ensureDataDirectory(): void {
  const dir = dirname(STATE_FILE_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    console.log(`[SchedulerState] Created data directory: ${dir}`);
  }
}

/**
 * Load state from disk
 * Returns default state if file doesn't exist or is corrupted
 */
export function loadState(): SchedulerState {
  try {
    ensureDataDirectory();

    if (!existsSync(STATE_FILE_PATH)) {
      console.log('[SchedulerState] No state file found, using defaults');
      cachedState = { ...DEFAULT_STATE };
      return cachedState;
    }

    const content = readFileSync(STATE_FILE_PATH, 'utf-8');
    const parsed = JSON.parse(content) as Partial<SchedulerState>;

    // Validate and merge with defaults
    cachedState = {
      lastReleaseDate: typeof parsed.lastReleaseDate === 'string' ? parsed.lastReleaseDate : null,
      lastReminderDate: typeof parsed.lastReminderDate === 'string' ? parsed.lastReminderDate : null,
      lastRunTimestamp: typeof parsed.lastRunTimestamp === 'number' ? parsed.lastRunTimestamp : 0,
    };

    console.log(`[SchedulerState] Loaded state: lastRelease=${cachedState.lastReleaseDate}, lastReminder=${cachedState.lastReminderDate}`);
    return cachedState;
  } catch (error) {
    console.error('[SchedulerState] Failed to load state, using defaults:', error);
    cachedState = { ...DEFAULT_STATE };
    return cachedState;
  }
}

/**
 * Save state to disk
 */
export function saveState(state: SchedulerState): void {
  try {
    ensureDataDirectory();

    const content = JSON.stringify(state, null, 2);
    writeFileSync(STATE_FILE_PATH, content, 'utf-8');
    cachedState = state;

    console.log(`[SchedulerState] Saved state: lastRelease=${state.lastReleaseDate}, lastReminder=${state.lastReminderDate}`);
  } catch (error) {
    console.error('[SchedulerState] Failed to save state:', error);
  }
}

// ============================================================================
// Convenience Accessors
// ============================================================================

/**
 * Get current state (from cache or load from disk)
 */
function getState(): SchedulerState {
  if (!cachedState) {
    return loadState();
  }
  return cachedState;
}

/**
 * Get the last release date
 */
export function getLastReleaseDate(): string | null {
  return getState().lastReleaseDate;
}

/**
 * Set the last release date and persist
 */
export function setLastReleaseDate(dateKey: string): void {
  const state = getState();
  state.lastReleaseDate = dateKey;
  state.lastRunTimestamp = Date.now();
  saveState(state);
}

/**
 * Get the last reminder date
 */
export function getLastReminderDate(): string | null {
  return getState().lastReminderDate;
}

/**
 * Set the last reminder date and persist
 */
export function setLastReminderDate(dateKey: string): void {
  const state = getState();
  state.lastReminderDate = dateKey;
  state.lastRunTimestamp = Date.now();
  saveState(state);
}

/**
 * Get full state (for debugging/status)
 */
export function getFullState(): SchedulerState {
  return { ...getState() };
}
