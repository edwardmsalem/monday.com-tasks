/**
 * Slack-Driven Configuration
 *
 * Fetches configuration from pinned messages in a control channel.
 * No redeploy required - edit the pinned message to update config.
 *
 * Configs:
 * - Owners Map: Assignment rules for subitems/automation
 * - Sheets Registry: Team → Google Sheet mapping
 *
 * Cache: 5 minutes TTL
 */

import { config } from '../config/environment.js';
import { getClient } from './slack.js';
import YAML from 'yaml';

// ============================================================================
// Types
// ============================================================================

export interface OwnersMap {
  relocation?: {
    accounts_checked?: string;
    board_setup?: string;
    logins_confirmed?: string;
    card_active?: string;
  };
  refund?: string;
  decline?: string;
  [key: string]: string | Record<string, string> | undefined;
}

export interface SheetEntry {
  sheetId: string;
  tab: string;
}

export interface SheetsRegistry {
  [sport: string]: {
    [team: string]: SheetEntry;
  };
}

interface ParsedConfig<T> {
  data: T | null;
  error: string | null;
  lastFetched: number;
}

// ============================================================================
// Cache
// ============================================================================

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let ownersCache: ParsedConfig<OwnersMap> = {
  data: null,
  error: null,
  lastFetched: 0,
};

let sheetsCache: ParsedConfig<SheetsRegistry> = {
  data: null,
  error: null,
  lastFetched: 0,
};

function isCacheValid(lastFetched: number): boolean {
  return Date.now() - lastFetched < CACHE_TTL_MS;
}

// ============================================================================
// Pinned Message Fetcher
// ============================================================================

/**
 * Fetch all pinned messages from the control channel
 */
async function fetchPinnedMessages(): Promise<Array<{ text: string; ts: string }>> {
  const client = getClient();
  const channelId = config.slack.controlChannelId;

  if (!channelId) {
    console.warn('SLACK_CONTROL_CHANNEL_ID not configured');
    return [];
  }

  try {
    const response = await client.pins.list({ channel: channelId });

    if (!response.ok || !response.items) {
      console.error('Failed to fetch pinned messages:', response.error);
      return [];
    }

    // Extract messages from pinned items
    const messages: Array<{ text: string; ts: string }> = [];
    for (const item of response.items) {
      // Type assertion for Slack API response
      const pinnedItem = item as { type?: string; message?: { text?: string; ts?: string } };
      if (pinnedItem.type === 'message' && pinnedItem.message?.text) {
        messages.push({
          text: pinnedItem.message.text,
          ts: pinnedItem.message.ts || '',
        });
      }
    }

    return messages;
  } catch (error) {
    console.error('Error fetching pinned messages:', error);
    return [];
  }
}

/**
 * Find a pinned message by prefix (e.g., "owners:" or "sheets:")
 */
async function findPinnedConfig(prefix: string): Promise<string | null> {
  const messages = await fetchPinnedMessages();

  for (const msg of messages) {
    // Handle code blocks
    let text = msg.text;

    // Remove Slack code block formatting
    text = text.replace(/```(?:yaml|yml)?\n?/gi, '').replace(/```/g, '');

    // Check if message starts with the prefix
    const trimmed = text.trim();
    if (trimmed.toLowerCase().startsWith(prefix.toLowerCase())) {
      return trimmed;
    }
  }

  return null;
}

/**
 * Parse YAML from a config message
 */
function parseYamlConfig<T>(text: string, rootKey: string): T | null {
  try {
    const parsed = YAML.parse(text);
    if (parsed && typeof parsed === 'object' && rootKey in parsed) {
      return parsed[rootKey] as T;
    }
    return parsed as T;
  } catch (error) {
    console.error(`Failed to parse YAML config for ${rootKey}:`, error);
    return null;
  }
}

// ============================================================================
// Owners Map
// ============================================================================

/**
 * Get the Owners map from pinned Slack message
 * Returns cached value if fresh, otherwise fetches from Slack
 *
 * Expected format (pinned message):
 * ```yaml
 * owners:
 *   relocation:
 *     accounts_checked: "@Johanna"
 *     board_setup: "@Dayna"
 *     logins_confirmed: "@Sean"
 *     card_active: "@Chantay"
 *   refund: "@Chantay"
 *   decline: "@Johanna"
 * ```
 */
export async function getOwnersMap(): Promise<OwnersMap | null> {
  // Return cached if valid
  if (isCacheValid(ownersCache.lastFetched) && ownersCache.data) {
    return ownersCache.data;
  }

  // Fetch fresh config
  const text = await findPinnedConfig('owners:');
  if (!text) {
    ownersCache = {
      data: null,
      error: 'Owners map not found in pinned messages',
      lastFetched: Date.now(),
    };
    return null;
  }

  const parsed = parseYamlConfig<OwnersMap>(text, 'owners');
  ownersCache = {
    data: parsed,
    error: parsed ? null : 'Failed to parse owners YAML',
    lastFetched: Date.now(),
  };

  return parsed;
}

/**
 * Get owner for a specific task type and role
 * Returns the Slack user mention (e.g., "@Sean") or null if not found
 */
export async function getOwnerForRole(
  taskType: string,
  role?: string
): Promise<string | null> {
  const owners = await getOwnersMap();
  if (!owners) return null;

  const typeConfig = owners[taskType.toLowerCase()];
  if (!typeConfig) return null;

  // If it's a simple string assignment
  if (typeof typeConfig === 'string') {
    return typeConfig;
  }

  // If it's an object with roles
  if (role && typeof typeConfig === 'object') {
    return typeConfig[role] || null;
  }

  return null;
}

/**
 * Get all relocation subitem owners
 * Returns object with all 4 checklist item owners
 */
export async function getRelocationOwners(): Promise<{
  accounts_checked: string | null;
  board_setup: string | null;
  logins_confirmed: string | null;
  card_active: string | null;
}> {
  const owners = await getOwnersMap();
  const relocation = owners?.relocation;

  return {
    accounts_checked: relocation?.accounts_checked || null,
    board_setup: relocation?.board_setup || null,
    logins_confirmed: relocation?.logins_confirmed || null,
    card_active: relocation?.card_active || null,
  };
}

// ============================================================================
// Sheets Registry
// ============================================================================

/**
 * Get the Sheets registry from pinned Slack message
 *
 * Expected format (pinned message):
 * ```yaml
 * sheets:
 *   nba:
 *     knicks:
 *       sheetId: "1abc..."
 *       tab: "Sheet1"
 *   nfl:
 *     giants:
 *       sheetId: "2def..."
 *       tab: "Accounts"
 * ```
 */
export async function getSheetsRegistry(): Promise<SheetsRegistry | null> {
  // Return cached if valid
  if (isCacheValid(sheetsCache.lastFetched) && sheetsCache.data) {
    return sheetsCache.data;
  }

  // Fetch fresh config
  const text = await findPinnedConfig('sheets:');
  if (!text) {
    sheetsCache = {
      data: null,
      error: 'Sheets registry not found in pinned messages',
      lastFetched: Date.now(),
    };
    return null;
  }

  const parsed = parseYamlConfig<SheetsRegistry>(text, 'sheets');
  sheetsCache = {
    data: parsed,
    error: parsed ? null : 'Failed to parse sheets YAML',
    lastFetched: Date.now(),
  };

  return parsed;
}

/**
 * Get sheet info for a specific sport and team
 * Returns { sheetId, tab } or null if not found
 */
export async function getSheetForTeam(
  sport: string,
  team: string
): Promise<SheetEntry | null> {
  const registry = await getSheetsRegistry();
  if (!registry) return null;

  const sportConfig = registry[sport.toLowerCase()];
  if (!sportConfig) return null;

  const teamConfig = sportConfig[team.toLowerCase()];
  if (!teamConfig) return null;

  // Validate required fields
  if (!teamConfig.sheetId || !teamConfig.tab) {
    console.warn(`Incomplete sheet config for ${sport}/${team}`);
    return null;
  }

  return teamConfig;
}

// ============================================================================
// Cache Management
// ============================================================================

/**
 * Force refresh all cached configs
 * Call this after updating pinned messages
 */
export function invalidateCache(): void {
  ownersCache = { data: null, error: null, lastFetched: 0 };
  sheetsCache = { data: null, error: null, lastFetched: 0 };
  console.log('Slack config cache invalidated');
}

/**
 * Get cache status for debugging
 */
export function getCacheStatus(): {
  owners: { cached: boolean; age: number; error: string | null };
  sheets: { cached: boolean; age: number; error: string | null };
} {
  const now = Date.now();
  return {
    owners: {
      cached: ownersCache.data !== null,
      age: ownersCache.lastFetched ? Math.round((now - ownersCache.lastFetched) / 1000) : -1,
      error: ownersCache.error,
    },
    sheets: {
      cached: sheetsCache.data !== null,
      age: sheetsCache.lastFetched ? Math.round((now - sheetsCache.lastFetched) / 1000) : -1,
      error: sheetsCache.error,
    },
  };
}
