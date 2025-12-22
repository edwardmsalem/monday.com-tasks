/**
 * Idempotency Service
 *
 * Prevents duplicate processing of requests by tracking processed keys.
 * Used to prevent duplicate Monday items or Slack threads from duplicate webhook calls.
 *
 * Keys are persisted to disk and expire after a configurable TTL.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';

// ============================================================================
// Types
// ============================================================================

interface IdempotencyEntry {
  key: string;
  result: unknown; // cached result to return on duplicate
  createdAt: number; // timestamp
  expiresAt: number; // timestamp
}

interface IdempotencyState {
  entries: Record<string, IdempotencyEntry>;
  savedAt: number;
}

export interface IdempotencyCheckResult {
  isDuplicate: boolean;
  cachedResult?: unknown;
}

// ============================================================================
// Constants
// ============================================================================

const DATA_DIR = './data';
const IDEMPOTENCY_FILE = `${DATA_DIR}/idempotency-keys.json`;
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

// ============================================================================
// State
// ============================================================================

let entries: Record<string, IdempotencyEntry> = {};
let initialized = false;
let cleanupInterval: NodeJS.Timeout | null = null;

// ============================================================================
// File Operations
// ============================================================================

function ensureDataDirectory(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
    console.log(`[Idempotency] Created data directory: ${DATA_DIR}`);
  }
}

function loadEntries(): void {
  if (initialized) return;

  try {
    if (existsSync(IDEMPOTENCY_FILE)) {
      const content = readFileSync(IDEMPOTENCY_FILE, 'utf-8');
      const state = JSON.parse(content) as IdempotencyState;
      entries = state.entries || {};

      // Clean up expired entries on load
      const now = Date.now();
      let expiredCount = 0;
      for (const key of Object.keys(entries)) {
        if (entries[key].expiresAt <= now) {
          delete entries[key];
          expiredCount++;
        }
      }

      const remainingCount = Object.keys(entries).length;
      console.log(
        `[Idempotency] Loaded ${remainingCount} keys from disk` +
          (expiredCount > 0 ? ` (${expiredCount} expired keys removed)` : '')
      );
    }
  } catch (error) {
    console.error('[Idempotency] Failed to load keys (starting fresh):', error);
    entries = {};
  }

  initialized = true;
}

function saveEntries(): void {
  try {
    ensureDataDirectory();
    const state: IdempotencyState = {
      entries,
      savedAt: Date.now(),
    };
    writeFileSync(IDEMPOTENCY_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (error) {
    console.error('[Idempotency] Failed to save keys:', error);
  }
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Check if a key exists and is not expired
 */
export function isDuplicate(key: string): boolean {
  loadEntries();

  const entry = entries[key];
  if (!entry) return false;

  // Check if expired
  if (entry.expiresAt <= Date.now()) {
    delete entries[key];
    saveEntries();
    return false;
  }

  return true;
}

/**
 * Get cached result for a duplicate key
 */
export function getCachedResult(key: string): unknown | null {
  loadEntries();

  const entry = entries[key];
  if (!entry) return null;

  // Check if expired
  if (entry.expiresAt <= Date.now()) {
    delete entries[key];
    saveEntries();
    return null;
  }

  return entry.result;
}

/**
 * Set key with result (call after successful processing)
 */
export function setIdempotencyKey(key: string, result: unknown, ttlMs: number = DEFAULT_TTL_MS): void {
  loadEntries();

  const now = Date.now();
  entries[key] = {
    key,
    result,
    createdAt: now,
    expiresAt: now + ttlMs,
  };

  saveEntries();
  console.log(`[Idempotency] Set key: ${key} (expires in ${Math.round(ttlMs / 1000)}s)`);
}

/**
 * Check and set in one atomic operation
 * Returns { isDuplicate, cachedResult }
 *
 * Note: This only checks - you must call setIdempotencyKey after successful processing
 */
export function checkIdempotency(key: string): IdempotencyCheckResult {
  loadEntries();

  const entry = entries[key];

  if (!entry) {
    return { isDuplicate: false };
  }

  // Check if expired
  if (entry.expiresAt <= Date.now()) {
    delete entries[key];
    saveEntries();
    return { isDuplicate: false };
  }

  return {
    isDuplicate: true,
    cachedResult: entry.result,
  };
}

/**
 * Manual cleanup of expired keys
 * Also runs automatically every 15 minutes
 */
export function cleanupExpiredKeys(): number {
  loadEntries();

  const now = Date.now();
  let removedCount = 0;

  for (const key of Object.keys(entries)) {
    if (entries[key].expiresAt <= now) {
      delete entries[key];
      removedCount++;
    }
  }

  if (removedCount > 0) {
    saveEntries();
    console.log(`[Idempotency] Cleaned up ${removedCount} expired keys`);
  }

  return removedCount;
}

/**
 * Get stats for debugging
 */
export function getStats(): { totalKeys: number; oldestKey?: Date } {
  loadEntries();

  const keys = Object.values(entries);
  if (keys.length === 0) {
    return { totalKeys: 0 };
  }

  const oldest = Math.min(...keys.map((e) => e.createdAt));
  return {
    totalKeys: keys.length,
    oldestKey: new Date(oldest),
  };
}

/**
 * Clear all keys (for testing)
 */
export function clearAll(): void {
  entries = {};
  saveEntries();
  console.log('[Idempotency] Cleared all keys');
}

// ============================================================================
// Key Generation Helpers
// ============================================================================

/**
 * Generate idempotency key for email webhook
 * Based on subject, sender, and timestamp
 */
export function generateEmailIdempotencyKey(subject: string, from: string, timestamp: string): string {
  const normalized = `${subject.trim().toLowerCase()}|${from.trim().toLowerCase()}|${timestamp}`;
  const hash = createHash('md5').update(normalized).digest('hex').slice(0, 16);
  return `email:${hash}`;
}

/**
 * Generate idempotency key for /task slash command
 * Rounds timestamp to nearest minute to catch rapid duplicates
 */
export function generateTaskIdempotencyKey(userId: string, description: string): string {
  // Round timestamp to nearest minute to catch rapid duplicates
  const minuteTimestamp = Math.floor(Date.now() / 60000);
  const normalized = `${userId}|${description.trim().toLowerCase()}|${minuteTimestamp}`;
  const hash = createHash('md5').update(normalized).digest('hex').slice(0, 16);
  return `task:${hash}`;
}

/**
 * Generate idempotency key for /emailtask
 * Based on user and selected email ID
 */
export function generateEmailTaskIdempotencyKey(userId: string, emailId: string): string {
  return `emailtask:${userId}:${emailId}`;
}

/**
 * Generate idempotency key for JSON webhook
 * Based on message-id or subject+from+date combo
 */
export function generateJsonEmailIdempotencyKey(
  messageId: string | undefined,
  subject: string,
  from: string,
  date: string
): string {
  if (messageId) {
    const hash = createHash('md5').update(messageId).digest('hex').slice(0, 16);
    return `json:${hash}`;
  }
  // Fallback to subject+from+date
  return generateEmailIdempotencyKey(subject, from, date);
}

// ============================================================================
// Lifecycle
// ============================================================================

/**
 * Start the cleanup interval
 * Called during server startup
 */
export function startCleanupInterval(): void {
  if (cleanupInterval) return;

  cleanupInterval = setInterval(() => {
    cleanupExpiredKeys();
  }, CLEANUP_INTERVAL_MS);

  console.log(`[Idempotency] Started cleanup interval (every ${CLEANUP_INTERVAL_MS / 1000}s)`);
}

/**
 * Stop the cleanup interval
 */
export function stopCleanupInterval(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    console.log('[Idempotency] Stopped cleanup interval');
  }
}
