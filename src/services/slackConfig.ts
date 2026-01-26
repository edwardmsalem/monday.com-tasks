/**
 * Slack-Driven Configuration
 *
 * Fetches configuration from pinned messages in a control channel.
 * No redeploy required - edit the pinned message to update config.
 *
 * =============================================================================
 * SETUP REQUIREMENTS
 * =============================================================================
 *
 * 1. Set SLACK_CONTROL_CHANNEL_ID environment variable to the channel ID
 *    (e.g., C08QCFC4Y0H - find in channel details)
 *
 * 2. Pin a message with the Owners map in this YAML format:
 *    ```yaml
 *    owners:
 *      relocation:
 *        accounts_checked: "@Assignee1"
 *        board_setup: "@Assignee2"
 *        logins_confirmed: "@Assignee3"
 *        card_active: "@Assignee4"
 *      refund: "@Assignee4"
 *      decline: "@Assignee1"
 *    ```
 *
 * 3. Pin a message with the Sheets registry in this YAML format:
 *    ```yaml
 *    sheets:
 *      nba:
 *        knicks:
 *          sheetId: "1abc..."
 *          tab: "Sheet1"
 *        nets:
 *          sheetId: "2def..."
 *          tab: "Accounts"
 *      nfl:
 *        giants:
 *          sheetId: "3ghi..."
 *          tab: "Main"
 *    ```
 *
 * VALIDATION RULES:
 * - owners: must have root key "owners:" with nested task types
 * - sheets: must have root key "sheets:" with sport → team → {sheetId, tab}
 * - All values should be strings (quoted in YAML if needed)
 * - Slack user mentions use "@Name" format
 *
 * Cache: 5 minutes TTL
 */

import { config, configCompat } from '../config/environment.js';
import { SLACK_CONFIG_CACHE_TTL_MS } from '../config/constants.js';
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
  return Date.now() - lastFetched < SLACK_CONFIG_CACHE_TTL_MS;
}

// ============================================================================
// Pinned Message Fetcher
// ============================================================================

/**
 * Fetch all pinned messages from the control channel
 */
async function fetchPinnedMessages(): Promise<Array<{ text: string; ts: string }>> {
  const client = getClient();
  const channelId = configCompat.slack.controlChannelId;

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
 *     accounts_checked: "@Assignee1"
 *     board_setup: "@Assignee2"
 *     logins_confirmed: "@Assignee3"
 *     card_active: "@Assignee4"
 *   refund: "@Assignee4"
 *   decline: "@Assignee1"
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
 * Returns the Slack user mention (e.g., "@Assignee") or null if not found
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

// ============================================================================
// Configuration Validation
// ============================================================================

/**
 * Configuration validation result
 */
export interface ConfigValidationResult {
  valid: boolean;
  errors: string[];
  fixSteps: string[];
}

/**
 * Check if Slack control channel is configured
 */
export function isControlChannelConfigured(): boolean {
  return !!(configCompat.slack.controlChannelId && configCompat.slack.controlChannelId.length > 0);
}

/**
 * Validate Slack-driven configuration
 * Returns detailed errors and fix steps for missing/malformed config
 *
 * Call this before any operation that requires Slack config.
 * If not valid, respond ephemerally with the fixSteps and stop the flow.
 */
export async function validateSlackConfig(): Promise<ConfigValidationResult> {
  const errors: string[] = [];
  const fixSteps: string[] = [];

  // Check 1: Control channel ID
  if (!isControlChannelConfigured()) {
    errors.push('SLACK_CONTROL_CHANNEL_ID environment variable is not set');
    fixSteps.push(
      '1. Find your control channel ID:',
      '   • Open the channel in Slack',
      '   • Click the channel name at the top',
      '   • Scroll to the bottom - Channel ID is there (e.g., C08QCFC4Y0H)',
      '2. Set the environment variable:',
      '   `SLACK_CONTROL_CHANNEL_ID=C08QCFC4Y0H`',
      '3. Redeploy the application'
    );
    return { valid: false, errors, fixSteps };
  }

  // Check 2: Try to fetch pinned messages
  let pinnedMessages: Array<{ text: string; ts: string }> = [];
  try {
    pinnedMessages = await fetchPinnedMessages();
  } catch (error) {
    errors.push(`Failed to fetch pinned messages: ${error instanceof Error ? error.message : 'Unknown error'}`);
    fixSteps.push(
      '1. Verify the bot has access to the control channel',
      '2. Check that the bot has the pins:read permission',
      '3. Ensure SLACK_CONTROL_CHANNEL_ID is correct'
    );
    return { valid: false, errors, fixSteps };
  }

  if (pinnedMessages.length === 0) {
    errors.push('No pinned messages found in control channel');
    fixSteps.push(
      '1. Go to the control channel',
      '2. Post a message with the owners config (see format below)',
      '3. Pin the message',
      '',
      '*Owners config format:*',
      '```yaml',
      'owners:',
      '  relocation:',
      '    accounts_checked: "@Assignee1"',
      '    board_setup: "@Assignee2"',
      '    logins_confirmed: "@Assignee3"',
      '    card_active: "@Assignee4"',
      '  refund: "@Assignee4"',
      '  decline: "@Assignee1"',
      '```'
    );
    return { valid: false, errors, fixSteps };
  }

  // Check 3: Owners map
  const ownersText = await findPinnedConfig('owners:');
  if (!ownersText) {
    errors.push('Owners map not found in pinned messages');
    fixSteps.push(
      '*Missing owners config. Pin a message with this format:*',
      '```yaml',
      'owners:',
      '  relocation:',
      '    accounts_checked: "@Assignee1"',
      '    board_setup: "@Assignee2"',
      '    logins_confirmed: "@Assignee3"',
      '    card_active: "@Assignee4"',
      '  refund: "@Assignee4"',
      '  decline: "@Assignee1"',
      '```'
    );
  } else {
    // Validate YAML
    try {
      const parsed = YAML.parse(ownersText);
      if (!parsed || typeof parsed !== 'object') {
        errors.push('Owners config is not valid YAML');
        fixSteps.push('*Owners YAML is malformed.* Check for:',
          '• Correct indentation (2 spaces per level)',
          '• Colons after keys (owners:, relocation:, etc.)',
          '• Quoted values if they contain special characters'
        );
      } else if (!parsed.owners) {
        errors.push('Owners config missing root "owners:" key');
        fixSteps.push('*Owners config must start with "owners:"*',
          'Example:',
          '```yaml',
          'owners:',
          '  refund: "@Assignee"',
          '```'
        );
      }
    } catch (yamlError) {
      errors.push(`Owners YAML parse error: ${yamlError instanceof Error ? yamlError.message : 'Unknown'}`);
      fixSteps.push(
        '*Owners YAML is malformed.* Check for:',
        '• Correct indentation (2 spaces per level)',
        '• Colons after keys',
        '• No tabs (use spaces only)',
        '• Quoted values if needed'
      );
    }
  }

  // Check 4: Sheets registry (optional - warn only)
  const sheetsText = await findPinnedConfig('sheets:');
  if (!sheetsText) {
    // Sheets is optional, just log warning
    console.warn('Sheets registry not found in pinned messages (optional)');
  } else {
    try {
      const parsed = YAML.parse(sheetsText);
      if (!parsed || typeof parsed !== 'object' || !parsed.sheets) {
        errors.push('Sheets config is malformed or missing root "sheets:" key');
        fixSteps.push(
          '*Sheets config format:*',
          '```yaml',
          'sheets:',
          '  nba:',
          '    knicks:',
          '      sheetId: "1abc..."',
          '      tab: "Sheet1"',
          '```'
        );
      }
    } catch (yamlError) {
      errors.push(`Sheets YAML parse error: ${yamlError instanceof Error ? yamlError.message : 'Unknown'}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    fixSteps,
  };
}

/**
 * Format validation errors as Slack ephemeral message
 */
export function formatValidationError(result: ConfigValidationResult): string {
  const parts: string[] = [
    ':warning: *Slack Configuration Error*',
    '',
    '*Errors:*',
    ...result.errors.map(e => `• ${e}`),
  ];

  if (result.fixSteps.length > 0) {
    parts.push('', '*How to fix:*', ...result.fixSteps);
  }

  return parts.join('\n');
}
