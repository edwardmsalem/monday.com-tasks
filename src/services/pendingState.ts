/**
 * Pending State Persistence
 *
 * Persists in-memory Maps to disk to survive restarts:
 * - pendingTasks: In-progress task creation flows
 * - pendingEmailSelections: Email selection flows mid-conversation
 * - directCreationDmCooldown: Prevents spam DMs after restart
 *
 * Each Map is stored in a separate JSON file in ./data/
 * TTL cleanup runs on load and periodically to remove expired entries.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import type { ParsedTask, MissingFields } from './taskParser.js';
import type { GmailEmailResult } from './gmail.js';

// ============================================================================
// Types
// ============================================================================

export interface PendingTask {
  parsed: ParsedTask;
  missing: MissingFields;
  slackUserId: string;
  slackChannelId: string;
  awaitingFields: Array<'name' | 'assignee' | 'dueDate'>;
  createdAt: number;
  lastMessageTs?: string;
}

export interface PendingEmailSelection {
  emails: GmailEmailResult[];
  subject: string;
  responseUrl: string;
  expiresAt: number;
}

// Serializable format for storage
interface PendingTasksState {
  entries: Array<{ key: string; value: PendingTask }>;
  savedAt: number;
}

interface PendingEmailSelectionsState {
  entries: Array<{ key: string; value: PendingEmailSelection }>;
  savedAt: number;
}

interface DmCooldownState {
  entries: Array<{ key: string; value: number }>;
  savedAt: number;
}

// ============================================================================
// Constants
// ============================================================================

const DATA_DIR = './data';
const PENDING_TASKS_FILE = `${DATA_DIR}/pending-tasks.json`;
const PENDING_EMAIL_FILE = `${DATA_DIR}/pending-email-selections.json`;
const DM_COOLDOWN_FILE = `${DATA_DIR}/dm-cooldown.json`;

// TTLs (matching original values)
const PENDING_TASK_TTL_MS = 10 * 60 * 1000;        // 10 minutes
const PENDING_EMAIL_TTL_MS = 5 * 60 * 1000;        // 5 minutes
const DM_COOLDOWN_TTL_MS = 24 * 60 * 60 * 1000;    // 24 hours

// Cleanup interval
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;  // 5 minutes

// ============================================================================
// In-memory Maps (with lazy loading)
// ============================================================================

let pendingTasksMap: Map<string, PendingTask> | null = null;
let pendingEmailSelectionsMap: Map<string, PendingEmailSelection> | null = null;
let dmCooldownMap: Map<string, number> | null = null;
let cleanupIntervalId: NodeJS.Timeout | null = null;

// ============================================================================
// File Utilities
// ============================================================================

function ensureDataDirectory(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
    console.log(`[PendingState] Created data directory: ${DATA_DIR}`);
  }
}

function safeReadJson<T>(filepath: string, defaultValue: T): T {
  try {
    if (!existsSync(filepath)) {
      return defaultValue;
    }
    const content = readFileSync(filepath, 'utf-8');
    return JSON.parse(content) as T;
  } catch (error) {
    console.error(`[PendingState] Failed to read ${filepath}:`, error);
    return defaultValue;
  }
}

function safeWriteJson<T>(filepath: string, data: T): void {
  try {
    ensureDataDirectory();
    writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (error) {
    console.error(`[PendingState] Failed to write ${filepath}:`, error);
  }
}

// ============================================================================
// Pending Tasks
// ============================================================================

function loadPendingTasks(): Map<string, PendingTask> {
  const state = safeReadJson<PendingTasksState>(PENDING_TASKS_FILE, {
    entries: [],
    savedAt: 0,
  });

  const map = new Map<string, PendingTask>();
  const now = Date.now();
  let expired = 0;

  for (const { key, value } of state.entries) {
    // Filter out expired entries
    if (now - value.createdAt < PENDING_TASK_TTL_MS) {
      map.set(key, value);
    } else {
      expired++;
    }
  }

  if (expired > 0) {
    console.log(`[PendingState] Cleaned up ${expired} expired pending tasks`);
  }
  console.log(`[PendingState] Loaded ${map.size} pending tasks`);

  return map;
}

function savePendingTasks(map: Map<string, PendingTask>): void {
  const state: PendingTasksState = {
    entries: Array.from(map.entries()).map(([key, value]) => ({ key, value })),
    savedAt: Date.now(),
  };
  safeWriteJson(PENDING_TASKS_FILE, state);
}

export function getPendingTasksMap(): Map<string, PendingTask> {
  if (!pendingTasksMap) {
    pendingTasksMap = loadPendingTasks();
  }
  return pendingTasksMap;
}

export function setPendingTask(key: string, value: PendingTask): void {
  const map = getPendingTasksMap();
  map.set(key, value);
  savePendingTasks(map);
}

export function deletePendingTask(key: string): void {
  const map = getPendingTasksMap();
  map.delete(key);
  savePendingTasks(map);
}

export function getPendingTask(key: string): PendingTask | undefined {
  return getPendingTasksMap().get(key);
}

export function hasPendingTask(key: string): boolean {
  return getPendingTasksMap().has(key);
}

// ============================================================================
// Pending Email Selections
// ============================================================================

function loadPendingEmailSelections(): Map<string, PendingEmailSelection> {
  const state = safeReadJson<PendingEmailSelectionsState>(PENDING_EMAIL_FILE, {
    entries: [],
    savedAt: 0,
  });

  const map = new Map<string, PendingEmailSelection>();
  const now = Date.now();
  let expired = 0;

  for (const { key, value } of state.entries) {
    // Filter out expired entries (using expiresAt field)
    if (value.expiresAt > now) {
      map.set(key, value);
    } else {
      expired++;
    }
  }

  if (expired > 0) {
    console.log(`[PendingState] Cleaned up ${expired} expired email selections`);
  }
  console.log(`[PendingState] Loaded ${map.size} pending email selections`);

  return map;
}

function savePendingEmailSelections(map: Map<string, PendingEmailSelection>): void {
  const state: PendingEmailSelectionsState = {
    entries: Array.from(map.entries()).map(([key, value]) => ({ key, value })),
    savedAt: Date.now(),
  };
  safeWriteJson(PENDING_EMAIL_FILE, state);
}

export function getPendingEmailSelectionsMap(): Map<string, PendingEmailSelection> {
  if (!pendingEmailSelectionsMap) {
    pendingEmailSelectionsMap = loadPendingEmailSelections();
  }
  return pendingEmailSelectionsMap;
}

export function setPendingEmailSelection(key: string, value: PendingEmailSelection): void {
  const map = getPendingEmailSelectionsMap();
  map.set(key, value);
  savePendingEmailSelections(map);
}

export function deletePendingEmailSelection(key: string): void {
  const map = getPendingEmailSelectionsMap();
  map.delete(key);
  savePendingEmailSelections(map);
}

export function getPendingEmailSelection(key: string): PendingEmailSelection | undefined {
  return getPendingEmailSelectionsMap().get(key);
}

export function hasPendingEmailSelection(key: string): boolean {
  return getPendingEmailSelectionsMap().has(key);
}

// ============================================================================
// DM Cooldown
// ============================================================================

function loadDmCooldown(): Map<string, number> {
  const state = safeReadJson<DmCooldownState>(DM_COOLDOWN_FILE, {
    entries: [],
    savedAt: 0,
  });

  const map = new Map<string, number>();
  const now = Date.now();
  let expired = 0;

  for (const { key, value } of state.entries) {
    // Filter out expired entries
    if (now - value < DM_COOLDOWN_TTL_MS) {
      map.set(key, value);
    } else {
      expired++;
    }
  }

  if (expired > 0) {
    console.log(`[PendingState] Cleaned up ${expired} expired DM cooldowns`);
  }
  console.log(`[PendingState] Loaded ${map.size} DM cooldowns`);

  return map;
}

function saveDmCooldown(map: Map<string, number>): void {
  const state: DmCooldownState = {
    entries: Array.from(map.entries()).map(([key, value]) => ({ key, value })),
    savedAt: Date.now(),
  };
  safeWriteJson(DM_COOLDOWN_FILE, state);
}

export function getDmCooldownMap(): Map<string, number> {
  if (!dmCooldownMap) {
    dmCooldownMap = loadDmCooldown();
  }
  return dmCooldownMap;
}

export function setDmCooldown(key: string, value: number): void {
  const map = getDmCooldownMap();
  map.set(key, value);
  saveDmCooldown(map);
}

export function getDmCooldown(key: string): number | undefined {
  return getDmCooldownMap().get(key);
}

// ============================================================================
// Cleanup
// ============================================================================

/**
 * Clean up all expired entries from all Maps
 */
export function cleanupExpiredEntries(): void {
  const now = Date.now();
  let totalCleaned = 0;

  // Clean pending tasks
  if (pendingTasksMap) {
    const before = pendingTasksMap.size;
    for (const [key, value] of pendingTasksMap.entries()) {
      if (now - value.createdAt >= PENDING_TASK_TTL_MS) {
        pendingTasksMap.delete(key);
      }
    }
    const cleaned = before - pendingTasksMap.size;
    if (cleaned > 0) {
      savePendingTasks(pendingTasksMap);
      totalCleaned += cleaned;
    }
  }

  // Clean pending email selections
  if (pendingEmailSelectionsMap) {
    const before = pendingEmailSelectionsMap.size;
    for (const [key, value] of pendingEmailSelectionsMap.entries()) {
      if (value.expiresAt <= now) {
        pendingEmailSelectionsMap.delete(key);
      }
    }
    const cleaned = before - pendingEmailSelectionsMap.size;
    if (cleaned > 0) {
      savePendingEmailSelections(pendingEmailSelectionsMap);
      totalCleaned += cleaned;
    }
  }

  // Clean DM cooldowns
  if (dmCooldownMap) {
    const before = dmCooldownMap.size;
    for (const [key, value] of dmCooldownMap.entries()) {
      if (now - value >= DM_COOLDOWN_TTL_MS) {
        dmCooldownMap.delete(key);
      }
    }
    const cleaned = before - dmCooldownMap.size;
    if (cleaned > 0) {
      saveDmCooldown(dmCooldownMap);
      totalCleaned += cleaned;
    }
  }

  if (totalCleaned > 0) {
    console.log(`[PendingState] Cleanup: removed ${totalCleaned} expired entries`);
  }
}

/**
 * Start the periodic cleanup interval
 */
export function startCleanupInterval(): void {
  if (cleanupIntervalId) {
    return; // Already running
  }

  cleanupIntervalId = setInterval(() => {
    cleanupExpiredEntries();
  }, CLEANUP_INTERVAL_MS);

  console.log(`[PendingState] Started cleanup interval (every ${CLEANUP_INTERVAL_MS / 1000}s)`);
}

/**
 * Stop the periodic cleanup interval
 */
export function stopCleanupInterval(): void {
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
    console.log('[PendingState] Stopped cleanup interval');
  }
}

/**
 * Initialize all state (call on startup)
 */
export function initializePendingState(): void {
  ensureDataDirectory();

  // Eagerly load all maps to ensure cleanup on startup
  getPendingTasksMap();
  getPendingEmailSelectionsMap();
  getDmCooldownMap();

  // Start cleanup interval
  startCleanupInterval();

  console.log('[PendingState] Initialized');
}

// Export TTL constants for use by other modules
export const PENDING_TASK_TTL = PENDING_TASK_TTL_MS;
export const PENDING_EMAIL_TTL = PENDING_EMAIL_TTL_MS;
export const DM_COOLDOWN_TTL = DM_COOLDOWN_TTL_MS;
