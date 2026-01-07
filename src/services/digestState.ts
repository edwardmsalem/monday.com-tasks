/**
 * Digest State Persistence
 *
 * Manages persistent state for the digest notification system.
 * State is persisted to disk to survive server restarts.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getESTDateString } from './workingHours.js';

const STATE_FILE = path.join(process.cwd(), '.digest-state.json');

// ============================================================================
// Types
// ============================================================================

export interface ConfirmedTask {
  userId: string;
  confirmedAt: number;
  type: 'will_complete' | 'rescheduled';
  newDueDate?: string;
}

export interface DigestAck {
  date: string;
  ackedAt: number;
}

export interface DigestState {
  // Track which digests have been sent today
  lastDigestDate: string; // "2026-01-07"

  // Track user confirmations for due-today tasks
  confirmedTasks: {
    [taskId: string]: ConfirmedTask;
  };

  // Track escalations sent (prevent duplicates)
  escalationsSent: {
    [key: string]: number; // "regular-first-2026-01-07" -> timestamp
  };

  // Track digest acknowledgments
  digestAcks: {
    [userId: string]: DigestAck;
  };

  // Track issue call escalation levels (per issue call ID)
  issueCallEscalations: {
    [issueCallId: string]: {
      claimLevel: 0 | 1 | 2;
      completionLevel: 0 | 1 | 2;
      lastClaimEscalationAt?: number;
      lastCompletionEscalationAt?: number;
    };
  };

  // Track digest message timestamps for updates
  digestMessages: {
    [key: string]: {
      // key: "morning-{userId}-{date}" or "team-{date}" etc.
      channel: string;
      ts: string;
      sentAt: number;
    };
  };
}

// ============================================================================
// Default State
// ============================================================================

function createDefaultState(): DigestState {
  return {
    lastDigestDate: '',
    confirmedTasks: {},
    escalationsSent: {},
    digestAcks: {},
    issueCallEscalations: {},
    digestMessages: {},
  };
}

// ============================================================================
// State Management
// ============================================================================

let cachedState: DigestState | null = null;

/**
 * Load digest state from disk
 * Creates default state if file doesn't exist
 */
export function loadDigestState(): DigestState {
  if (cachedState) {
    return cachedState;
  }

  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = fs.readFileSync(STATE_FILE, 'utf-8');
      cachedState = JSON.parse(data) as DigestState;
      console.log('[DigestState] Loaded state from disk');
    } else {
      cachedState = createDefaultState();
      console.log('[DigestState] Created new state');
    }
  } catch (error) {
    console.error('[DigestState] Failed to load state, creating new:', error);
    cachedState = createDefaultState();
  }

  return cachedState;
}

/**
 * Save digest state to disk
 */
export function saveDigestState(state: DigestState): void {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    cachedState = state;
  } catch (error) {
    console.error('[DigestState] Failed to save state:', error);
  }
}

/**
 * Get the current state (loads if not cached)
 */
function getState(): DigestState {
  return loadDigestState();
}

/**
 * Update state with a partial update
 */
function updateState(updates: Partial<DigestState>): void {
  const state = getState();
  Object.assign(state, updates);
  saveDigestState(state);
}

// ============================================================================
// Daily Reset
// ============================================================================

/**
 * Check if state needs to be reset for a new day
 * Resets confirmations, escalations, and acks at midnight EST
 */
export function checkAndResetForNewDay(): void {
  const state = getState();
  const today = getESTDateString();

  if (state.lastDigestDate !== today) {
    console.log(`[DigestState] New day detected (${today}), resetting daily state`);

    // Reset daily tracking
    state.confirmedTasks = {};
    state.escalationsSent = {};
    state.digestAcks = {};
    state.digestMessages = {};
    state.lastDigestDate = today;

    // Keep issue call escalations (they span days until resolved)
    saveDigestState(state);
  }
}

// ============================================================================
// Task Confirmation
// ============================================================================

/**
 * Mark a task as confirmed by a user
 */
export function markTaskConfirmed(
  taskId: string,
  userId: string,
  type: 'will_complete' | 'rescheduled',
  newDueDate?: string
): void {
  const state = getState();

  state.confirmedTasks[taskId] = {
    userId,
    confirmedAt: Date.now(),
    type,
    newDueDate,
  };

  saveDigestState(state);
  console.log(`[DigestState] Task ${taskId} confirmed as ${type} by ${userId}`);
}

/**
 * Check if a task has been confirmed
 */
export function isTaskConfirmed(taskId: string): boolean {
  const state = getState();
  return taskId in state.confirmedTasks;
}

/**
 * Get confirmation info for a task
 */
export function getTaskConfirmation(taskId: string): ConfirmedTask | null {
  const state = getState();
  return state.confirmedTasks[taskId] ?? null;
}

/**
 * Get all unconfirmed task IDs from a list
 */
export function getUnconfirmedTaskIds(taskIds: string[]): string[] {
  const state = getState();
  return taskIds.filter((id) => !(id in state.confirmedTasks));
}

// ============================================================================
// Escalation Tracking
// ============================================================================

/**
 * Generate an escalation key
 * Format: "{type}-{level}-{date}" or "{type}-{level}-{taskId}-{date}"
 */
export function getEscalationKey(
  type: 'regular' | 'issue-claim' | 'issue-completion',
  level: 'first' | 'final',
  identifier?: string // userId for regular, issueCallId for issue calls
): string {
  const today = getESTDateString();
  if (identifier) {
    return `${type}-${level}-${identifier}-${today}`;
  }
  return `${type}-${level}-${today}`;
}

/**
 * Mark an escalation as sent
 */
export function markEscalationSent(key: string): void {
  const state = getState();
  state.escalationsSent[key] = Date.now();
  saveDigestState(state);
  console.log(`[DigestState] Escalation marked as sent: ${key}`);
}

/**
 * Check if an escalation has already been sent
 */
export function hasEscalationBeenSent(key: string): boolean {
  const state = getState();
  return key in state.escalationsSent;
}

// ============================================================================
// Digest Acknowledgment
// ============================================================================

/**
 * Mark a user's digest as acknowledged
 */
export function markDigestAcked(userId: string): void {
  const state = getState();
  const today = getESTDateString();

  state.digestAcks[userId] = {
    date: today,
    ackedAt: Date.now(),
  };

  saveDigestState(state);
  console.log(`[DigestState] Digest acknowledged by ${userId}`);
}

/**
 * Check if a user has acknowledged today's digest
 */
export function hasDigestBeenAcked(userId: string): boolean {
  const state = getState();
  const today = getESTDateString();
  const ack = state.digestAcks[userId];
  return ack?.date === today;
}

// ============================================================================
// Issue Call Escalation Tracking
// ============================================================================

/**
 * Get escalation state for an issue call
 */
export function getIssueCallEscalation(issueCallId: string): {
  claimLevel: 0 | 1 | 2;
  completionLevel: 0 | 1 | 2;
  lastClaimEscalationAt?: number;
  lastCompletionEscalationAt?: number;
} {
  const state = getState();
  return (
    state.issueCallEscalations[issueCallId] ?? {
      claimLevel: 0,
      completionLevel: 0,
    }
  );
}

/**
 * Update claim escalation level for an issue call
 */
export function setIssueCallClaimEscalation(
  issueCallId: string,
  level: 0 | 1 | 2
): void {
  const state = getState();

  if (!state.issueCallEscalations[issueCallId]) {
    state.issueCallEscalations[issueCallId] = {
      claimLevel: 0,
      completionLevel: 0,
    };
  }

  state.issueCallEscalations[issueCallId].claimLevel = level;
  if (level > 0) {
    state.issueCallEscalations[issueCallId].lastClaimEscalationAt = Date.now();
  }

  saveDigestState(state);
  console.log(`[DigestState] Issue call ${issueCallId} claim escalation set to level ${level}`);
}

/**
 * Update completion escalation level for an issue call
 */
export function setIssueCallCompletionEscalation(
  issueCallId: string,
  level: 0 | 1 | 2
): void {
  const state = getState();

  if (!state.issueCallEscalations[issueCallId]) {
    state.issueCallEscalations[issueCallId] = {
      claimLevel: 0,
      completionLevel: 0,
    };
  }

  state.issueCallEscalations[issueCallId].completionLevel = level;
  if (level > 0) {
    state.issueCallEscalations[issueCallId].lastCompletionEscalationAt = Date.now();
  }

  saveDigestState(state);
  console.log(`[DigestState] Issue call ${issueCallId} completion escalation set to level ${level}`);
}

/**
 * Clear escalation state for an issue call (when resolved)
 */
export function clearIssueCallEscalation(issueCallId: string): void {
  const state = getState();
  delete state.issueCallEscalations[issueCallId];
  saveDigestState(state);
  console.log(`[DigestState] Issue call ${issueCallId} escalation state cleared`);
}

// ============================================================================
// Digest Message Tracking
// ============================================================================

/**
 * Save a digest message reference (for updating later)
 */
export function saveDigestMessage(
  key: string,
  channel: string,
  ts: string
): void {
  const state = getState();

  state.digestMessages[key] = {
    channel,
    ts,
    sentAt: Date.now(),
  };

  saveDigestState(state);
}

/**
 * Get a saved digest message reference
 */
export function getDigestMessage(
  key: string
): { channel: string; ts: string; sentAt: number } | null {
  const state = getState();
  return state.digestMessages[key] ?? null;
}

/**
 * Generate a digest message key
 */
export function getDigestMessageKey(
  type: 'morning' | 'team' | 'issue-call' | 'issue-call-eod' | 'tomorrow',
  identifier?: string // userId for personal digests
): string {
  const today = getESTDateString();
  if (identifier) {
    return `${type}-${identifier}-${today}`;
  }
  return `${type}-${today}`;
}

// ============================================================================
// Debug / Admin
// ============================================================================

/**
 * Get the full state for debugging
 */
export function getFullState(): DigestState {
  return getState();
}

/**
 * Clear all state (for testing)
 */
export function clearAllState(): void {
  cachedState = createDefaultState();
  saveDigestState(cachedState);
  console.log('[DigestState] All state cleared');
}

/**
 * Force reload state from disk
 */
export function reloadState(): DigestState {
  cachedState = null;
  return loadDigestState();
}
