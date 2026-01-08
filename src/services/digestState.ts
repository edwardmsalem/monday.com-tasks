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

// Per-user acknowledgment tracking (requires ALL assignees to ack)
export interface TaskAcknowledgment {
  acknowledgedBy: string[]; // List of user IDs who have acknowledged
  acknowledgedAt: { [userId: string]: number }; // Timestamp per user
}

// Task status tracking (first one wins for complete/working/stuck)
export interface TaskStatus {
  status: 'complete' | 'working' | 'stuck';
  setBy: string;
  setAt: number;
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

  // Track per-user task acknowledgments (requires ALL assignees to ack)
  taskAcknowledgments: {
    [taskId: string]: TaskAcknowledgment;
  };

  // Track task statuses (complete/working/stuck - first one wins)
  taskStatuses: {
    [taskId: string]: TaskStatus;
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

  // Track which scheduled tasks have been sent today (survives reboot)
  scheduledTasksSent: {
    [key: string]: boolean; // "2026-01-08-morning-digest" -> true
  };
}

// ============================================================================
// Default State
// ============================================================================

function createDefaultState(): DigestState {
  return {
    lastDigestDate: '',
    confirmedTasks: {},
    taskAcknowledgments: {},
    taskStatuses: {},
    escalationsSent: {},
    digestAcks: {},
    issueCallEscalations: {},
    digestMessages: {},
    scheduledTasksSent: {},
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
    state.taskAcknowledgments = {};
    state.taskStatuses = {};
    state.escalationsSent = {};
    state.digestAcks = {};
    state.digestMessages = {};
    state.scheduledTasksSent = {};
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
// Task Acknowledgment (per-user tracking - requires ALL assignees to ack)
// ============================================================================

/**
 * Record a user's acknowledgment of a task
 * Returns true if ALL assignees have now acknowledged
 */
export function recordTaskAcknowledgment(
  taskId: string,
  userId: string,
  allAssigneeIds: string[]
): { acknowledged: boolean; fullyAcknowledged: boolean; acknowledgedBy: string[]; waitingOn: string[] } {
  const state = getState();

  // Initialize if not exists
  if (!state.taskAcknowledgments[taskId]) {
    state.taskAcknowledgments[taskId] = {
      acknowledgedBy: [],
      acknowledgedAt: {},
    };
  }

  const ack = state.taskAcknowledgments[taskId];

  // Check if user already acknowledged
  if (ack.acknowledgedBy.includes(userId)) {
    // Already acknowledged, return current state
    const waitingOn = allAssigneeIds.filter((id) => !ack.acknowledgedBy.includes(id));
    return {
      acknowledged: true,
      fullyAcknowledged: waitingOn.length === 0,
      acknowledgedBy: [...ack.acknowledgedBy],
      waitingOn,
    };
  }

  // Add acknowledgment
  ack.acknowledgedBy.push(userId);
  ack.acknowledgedAt[userId] = Date.now();

  saveDigestState(state);

  // Calculate who is still waiting
  const waitingOn = allAssigneeIds.filter((id) => !ack.acknowledgedBy.includes(id));
  const fullyAcknowledged = waitingOn.length === 0;

  console.log(
    `[DigestState] Task ${taskId} acknowledged by ${userId}. ` +
      `Fully acknowledged: ${fullyAcknowledged}, Waiting on: ${waitingOn.length} users`
  );

  return {
    acknowledged: true,
    fullyAcknowledged,
    acknowledgedBy: [...ack.acknowledgedBy],
    waitingOn,
  };
}

/**
 * Get acknowledgment status for a task
 */
export function getTaskAcknowledgment(taskId: string): TaskAcknowledgment | null {
  const state = getState();
  return state.taskAcknowledgments[taskId] ?? null;
}

/**
 * Check if a specific user has acknowledged a task
 */
export function hasUserAcknowledged(taskId: string, userId: string): boolean {
  const state = getState();
  const ack = state.taskAcknowledgments[taskId];
  return ack?.acknowledgedBy.includes(userId) ?? false;
}

/**
 * Check if a task is fully acknowledged by all assignees
 */
export function isTaskFullyAcknowledged(taskId: string, allAssigneeIds: string[]): boolean {
  const state = getState();
  const ack = state.taskAcknowledgments[taskId];
  if (!ack) return false;

  return allAssigneeIds.every((id) => ack.acknowledgedBy.includes(id));
}

/**
 * Get acknowledgment status text for a task
 * Returns something like "👀 Jerry, waiting on Dayna" or "👀 All acknowledged"
 */
export function getAcknowledgmentStatusText(
  taskId: string,
  assigneeNames: { id: string; name: string }[]
): string | null {
  const state = getState();
  const ack = state.taskAcknowledgments[taskId];
  if (!ack || ack.acknowledgedBy.length === 0) return null;

  const acknowledgedNames = assigneeNames
    .filter((a) => ack.acknowledgedBy.includes(a.id))
    .map((a) => a.name);

  const waitingNames = assigneeNames
    .filter((a) => !ack.acknowledgedBy.includes(a.id))
    .map((a) => a.name);

  if (waitingNames.length === 0) {
    return '👀 All acknowledged';
  }

  return `👀 ${acknowledgedNames.join(', ')}, waiting on ${waitingNames.join(', ')}`;
}

// ============================================================================
// Task Status (first one wins for complete/working/stuck)
// ============================================================================

/**
 * Set a task's status (complete/working/stuck) - first one wins
 * Returns true if this was the first status set, false if already set
 */
export function setTaskStatus(
  taskId: string,
  status: 'complete' | 'working' | 'stuck',
  userId: string
): { success: boolean; existingStatus?: TaskStatus } {
  const state = getState();

  // Check if already set
  if (state.taskStatuses[taskId]) {
    console.log(
      `[DigestState] Task ${taskId} already has status ${state.taskStatuses[taskId].status} ` +
        `set by ${state.taskStatuses[taskId].setBy}`
    );
    return { success: false, existingStatus: state.taskStatuses[taskId] };
  }

  // Set the status
  state.taskStatuses[taskId] = {
    status,
    setBy: userId,
    setAt: Date.now(),
  };

  saveDigestState(state);
  console.log(`[DigestState] Task ${taskId} status set to ${status} by ${userId}`);

  return { success: true };
}

/**
 * Get task status
 */
export function getTaskStatus(taskId: string): TaskStatus | null {
  const state = getState();
  return state.taskStatuses[taskId] ?? null;
}

/**
 * Check if a task has any status set (complete/working/stuck)
 */
export function hasTaskStatus(taskId: string): boolean {
  const state = getState();
  return taskId in state.taskStatuses;
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

// ============================================================================
// Scheduled Task Tracking (survives reboot)
// ============================================================================

/**
 * Mark a scheduled task as sent for today
 */
export function markScheduledTaskSent(taskName: string): void {
  const state = getState();
  const key = `${getESTDateString()}-${taskName}`;

  if (!state.scheduledTasksSent) {
    state.scheduledTasksSent = {};
  }

  state.scheduledTasksSent[key] = true;
  saveDigestState(state);
  console.log(`[DigestState] Scheduled task marked as sent: ${key}`);
}

/**
 * Check if a scheduled task has been sent today
 */
export function hasScheduledTaskBeenSent(taskName: string): boolean {
  const state = getState();
  const key = `${getESTDateString()}-${taskName}`;
  return state.scheduledTasksSent?.[key] === true;
}

/**
 * Clear scheduled task tracking (called on new day)
 */
export function clearScheduledTasksSent(): void {
  const state = getState();
  state.scheduledTasksSent = {};
  saveDigestState(state);
}

// ============================================================================
// Weekly Escalation Tracking (for supervisor reports)
// ============================================================================

/**
 * Get weekly escalation counts by user name (regular tasks)
 * Looks at escalations sent in the past 7 days
 */
export function getWeeklyEscalationCounts(): Map<string, number> {
  const state = getState();
  const counts = new Map<string, number>();

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  for (const [key, timestamp] of Object.entries(state.escalationsSent)) {
    // Only count regular task escalations (not issue calls)
    if (!key.startsWith('regular-')) continue;

    // Only count if within last 7 days
    if (timestamp < sevenDaysAgo.getTime()) continue;

    // Extract user ID from key format: "regular-{level}-{userId}-{date}"
    const parts = key.split('-');
    if (parts.length >= 4) {
      const userId = parts[2];
      counts.set(userId, (counts.get(userId) || 0) + 1);
    }
  }

  return counts;
}

/**
 * Get weekly issue call escalation counts by user name
 * Looks at issue call escalations in the past 7 days
 */
export function getWeeklyIssueCallEscalationCounts(): Map<string, number> {
  const state = getState();
  const counts = new Map<string, number>();

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  for (const [key, timestamp] of Object.entries(state.escalationsSent)) {
    // Only count issue call escalations
    if (!key.startsWith('issue-claim-') && !key.startsWith('issue-completion-')) continue;

    // Only count if within last 7 days
    if (timestamp < sevenDaysAgo.getTime()) continue;

    // Extract issue call ID from key format: "issue-{type}-{level}-{issueCallId}-{date}"
    const parts = key.split('-');
    if (parts.length >= 5) {
      const issueCallId = parts[3];
      counts.set(issueCallId, (counts.get(issueCallId) || 0) + 1);
    }
  }

  return counts;
}
