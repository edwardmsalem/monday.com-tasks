/**
 * Presale State Persistence
 *
 * Manages persistent state for the presale scanner.
 * Tracks seen presales to prevent duplicate notifications.
 * State is persisted to disk (Railway volume) to survive restarts.
 */

import * as fs from 'fs';
import * as path from 'path';

// Use /data directory on Railway, fallback to cwd for local dev
// Railway volumes are mounted at /data by default
const DATA_DIR = process.env['RAILWAY_VOLUME_MOUNT_PATH'] || (process.env['RAILWAY_ENVIRONMENT'] ? '/data' : process.cwd());
const STATE_FILE = path.join(DATA_DIR, 'presale-state.json');

// ============================================================================
// Types
// ============================================================================

export interface SeenPresale {
  firstSeen: string;      // ISO timestamp
  slackTs: string;        // Slack message timestamp
  accountCount: number;   // How many accounts received it
  team: string;           // Team name
  subject: string;        // Email subject
}

export interface LabelCache {
  labels: string[];       // Cached sports team labels
  cachedAt: string;       // When cache was built (ISO timestamp)
}

export interface DeclinedOpportunity {
  declinedAt: string;     // ISO timestamp
  team: string;           // Team name
  eventName: string;      // Event name (e.g., "Bruno Mars")
}

export interface PresaleState {
  seenPresales: { [dedupKey: string]: SeenPresale };
  declinedOpportunities: { [key: string]: DeclinedOpportunity };  // key: domain:eventName
  lastScan: string;       // ISO timestamp
  labelCache: LabelCache | null;
}

// ============================================================================
// Default State
// ============================================================================

function createDefaultState(): PresaleState {
  return {
    seenPresales: {},
    declinedOpportunities: {},
    lastScan: '',
    labelCache: null,
  };
}

// ============================================================================
// State Management
// ============================================================================

let cachedState: PresaleState | null = null;

/**
 * Load presale state from disk
 * Creates default state if file doesn't exist
 */
export function loadPresaleState(): PresaleState {
  if (cachedState) {
    return cachedState;
  }

  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = fs.readFileSync(STATE_FILE, 'utf-8');
      cachedState = JSON.parse(data) as PresaleState;
      console.log('[PresaleState] Loaded state from disk');
    } else {
      cachedState = createDefaultState();
      console.log('[PresaleState] Created new state');
    }
  } catch (error) {
    console.error('[PresaleState] Failed to load state, creating new:', error);
    cachedState = createDefaultState();
  }

  return cachedState;
}

/**
 * Save presale state to disk
 */
export function savePresaleState(state: PresaleState): void {
  try {
    // Ensure directory exists
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    cachedState = state;
  } catch (error) {
    console.error('[PresaleState] Failed to save state:', error);
  }
}

/**
 * Get the current state (loads if not cached)
 */
function getState(): PresaleState {
  return loadPresaleState();
}

// ============================================================================
// Seen Presales
// ============================================================================

/**
 * Check if a presale has already been seen
 */
export function isPresaleSeen(dedupKey: string): boolean {
  const state = getState();
  return dedupKey in state.seenPresales;
}

/**
 * Get details of a seen presale
 */
export function getSeenPresale(dedupKey: string): SeenPresale | null {
  const state = getState();
  return state.seenPresales[dedupKey] ?? null;
}

/**
 * Mark a presale as seen and store details
 */
export function markPresaleSeen(
  dedupKey: string,
  slackTs: string,
  accountCount: number,
  team: string,
  subject: string
): void {
  const state = getState();

  state.seenPresales[dedupKey] = {
    firstSeen: new Date().toISOString(),
    slackTs,
    accountCount,
    team,
    subject,
  };

  savePresaleState(state);
  console.log(`[PresaleState] Marked presale as seen: ${dedupKey}`);
}

/**
 * Get all seen presales
 */
export function getAllSeenPresales(): { [dedupKey: string]: SeenPresale } {
  const state = getState();
  return { ...state.seenPresales };
}

// ============================================================================
// Declined Opportunities
// ============================================================================

/**
 * Build the key for declined opportunities
 * Normalizes domain and event name for consistent matching
 */
function buildDeclinedKey(domain: string, eventName: string): string {
  const normalizedDomain = domain.toLowerCase().trim();
  const normalizedEvent = eventName.toLowerCase().trim().replace(/\s+/g, ' ');
  return `${normalizedDomain}:${normalizedEvent}`;
}

/**
 * Check if an opportunity has been declined
 */
export function isOpportunityDeclined(domain: string, eventName: string): boolean {
  if (!eventName) return false;
  const state = getState();
  // Ensure declinedOpportunities exists (for old state files)
  if (!state.declinedOpportunities) {
    state.declinedOpportunities = {};
  }
  const key = buildDeclinedKey(domain, eventName);
  return key in state.declinedOpportunities;
}

/**
 * Mark an opportunity as declined (user clicked "Not Interested")
 */
export function declineOpportunity(domain: string, eventName: string, team: string): void {
  const state = getState();
  // Ensure declinedOpportunities exists (for old state files)
  if (!state.declinedOpportunities) {
    state.declinedOpportunities = {};
  }
  const key = buildDeclinedKey(domain, eventName);

  state.declinedOpportunities[key] = {
    declinedAt: new Date().toISOString(),
    team,
    eventName,
  };

  savePresaleState(state);
  console.log(`[PresaleState] Declined opportunity: ${key}`);
}

/**
 * Get all declined opportunities
 */
export function getAllDeclinedOpportunities(): { [key: string]: DeclinedOpportunity } {
  const state = getState();
  return { ...state.declinedOpportunities };
}

/**
 * Clear a declined opportunity (allow future notifications again)
 */
export function clearDeclinedOpportunity(domain: string, eventName: string): boolean {
  const state = getState();
  if (!state.declinedOpportunities) return false;

  const key = buildDeclinedKey(domain, eventName);
  if (key in state.declinedOpportunities) {
    delete state.declinedOpportunities[key];
    savePresaleState(state);
    console.log(`[PresaleState] Cleared declined opportunity: ${key}`);
    return true;
  }
  return false;
}

// ============================================================================
// Label Cache
// ============================================================================

/**
 * Get cached labels if still valid (within 24 hours)
 */
export function getCachedLabels(): string[] | null {
  const state = getState();

  if (!state.labelCache) {
    return null;
  }

  // Check if cache is still valid (24 hours)
  const cachedAt = new Date(state.labelCache.cachedAt);
  const now = new Date();
  const hoursSinceCached = (now.getTime() - cachedAt.getTime()) / (1000 * 60 * 60);

  if (hoursSinceCached > 24) {
    console.log('[PresaleState] Label cache expired (>24 hours old)');
    return null;
  }

  console.log(`[PresaleState] Using cached labels (${state.labelCache.labels.length} labels, cached ${hoursSinceCached.toFixed(1)}h ago)`);
  return state.labelCache.labels;
}

/**
 * Update the label cache
 */
export function updateLabelCache(labels: string[]): void {
  const state = getState();

  state.labelCache = {
    labels,
    cachedAt: new Date().toISOString(),
  };

  savePresaleState(state);
  console.log(`[PresaleState] Updated label cache with ${labels.length} labels`);
}

// ============================================================================
// Last Scan
// ============================================================================

/**
 * Update the last scan timestamp
 */
export function updateLastScan(): void {
  const state = getState();
  state.lastScan = new Date().toISOString();
  savePresaleState(state);
}

/**
 * Get the last scan timestamp
 */
export function getLastScan(): string | null {
  const state = getState();
  return state.lastScan || null;
}

// ============================================================================
// Cleanup
// ============================================================================

/**
 * Remove entries older than N days from state
 */
export function cleanupOldEntries(daysToKeep: number = 7): number {
  const state = getState();
  const now = new Date();
  const cutoff = new Date(now.getTime() - daysToKeep * 24 * 60 * 60 * 1000);
  // Declined opportunities kept longer (30 days)
  const declinedCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  let removedCount = 0;

  // Clean up seen presales
  for (const [key, presale] of Object.entries(state.seenPresales)) {
    const firstSeen = new Date(presale.firstSeen);
    if (firstSeen < cutoff) {
      delete state.seenPresales[key];
      removedCount++;
    }
  }

  // Clean up old declined opportunities
  if (state.declinedOpportunities) {
    for (const [key, declined] of Object.entries(state.declinedOpportunities)) {
      const declinedAt = new Date(declined.declinedAt);
      if (declinedAt < declinedCutoff) {
        delete state.declinedOpportunities[key];
        removedCount++;
      }
    }
  }

  if (removedCount > 0) {
    savePresaleState(state);
    console.log(`[PresaleState] Cleaned up ${removedCount} entries older than ${daysToKeep} days`);
  }

  return removedCount;
}

/**
 * Clear all seen presales (for testing)
 */
export function clearSeenPresales(): number {
  const state = getState();
  const count = Object.keys(state.seenPresales).length;
  state.seenPresales = {};
  savePresaleState(state);
  console.log(`[PresaleState] Cleared ${count} seen presales`);
  return count;
}

// ============================================================================
// Debug / Admin
// ============================================================================

/**
 * Get the full state for debugging
 */
export function getFullState(): PresaleState {
  return getState();
}

/**
 * Clear all state (for testing)
 */
export function clearAllState(): void {
  cachedState = createDefaultState();
  savePresaleState(cachedState);
  console.log('[PresaleState] All state cleared');
}

/**
 * Force reload state from disk
 */
export function reloadState(): PresaleState {
  cachedState = null;
  return loadPresaleState();
}
