/**
 * Environment configuration
 *
 * LOCAL CONFIG: Service-specific settings (ports, feature flags, column IDs)
 * REMOTE CONFIG: Shared IDs (channels, boards, sheets) fetched from core-api at startup
 */

import { initConfig, getCachedConfig, type CoreConfig } from '../services/coreApi.js';

function getEnvVar(name: string, defaultValue?: string): string {
  const value = process.env[name] ?? defaultValue;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getEnvVarOptional(name: string): string | undefined {
  return process.env[name];
}

function getEnvVarNumber(name: string, defaultValue?: number): number {
  const stringValue = process.env[name];
  if (stringValue === undefined) {
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(`Missing required environment variable: ${name}`);
  }
  const value = parseInt(stringValue, 10);
  if (isNaN(value)) {
    throw new Error(`Environment variable ${name} must be a number`);
  }
  return value;
}

function getEnvVarBool(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return defaultValue;
  return value.toLowerCase() === 'true' || value === '1';
}

export type AttachmentsMode = 'off' | 'slack_only' | 'monday_only' | 'both';

function getAttachmentsMode(): AttachmentsMode {
  const value = process.env['ATTACHMENTS_MODE']?.toLowerCase();
  if (value === 'off' || value === 'slack_only' || value === 'monday_only' || value === 'both') {
    return value;
  }
  return 'both'; // default
}

// ============================================================================
// Local Config (service-specific, loaded from env vars)
// ============================================================================

export const config = {
  // Server
  port: getEnvVarNumber('PORT', 8080),

  // Safety valves
  safetyValves: {
    /** If true, skip all email processing (log receipt only) */
    disableEmailAutomation: getEnvVarBool('DISABLE_EMAIL_AUTOMATION', false),
    /** Control attachment upload behavior: off | slack_only | monday_only | both */
    attachmentsMode: getAttachmentsMode(),
  },

  // Monday.com - column IDs are service-specific (board schema)
  // apiToken kept for legacy direct API calls (autoFollowUp, digest) until migrated
  monday: {
    apiToken: getEnvVar('MONDAY_API_TOKEN', ''),
    fileColumnId: getEnvVar('MONDAY_FILE_COLUMN_ID', 'file_mkxv6aa0'),
    slackThreadColumnId: getEnvVar('MONDAY_SLACK_THREAD_COLUMN_ID', 'text_mkxxn3hz'),

    // Column IDs from the board
    // LOCKED ARCHITECTURE: Columns = STATE + ROUTING only
    // Narrative/context goes to Updates, not columns
    columns: {
      // Core state/routing columns
      owner: 'person',
      support: 'multiple_person_mky0vdq1',
      type: 'status',                         // Task type (General, Opportunity, etc.)
      workflowStatus: 'color_mkxvxxxn',       // Workflow status (Acknowledged, Working on it, etc.)
      urgency: 'color_mkytzsrj',              // Urgency (High, Medium, Low)
      date: 'date4',                          // Due Date
      source: 'color_mky0b1yr',               // Source (Forwarding Tasks, Slack Tasks, etc.)
      attachmentState: 'color_mkytqrh8',      // Status: Queued/Uploaded/Retrying/Failed/Skipped
      runId: 'text_mkyt4seq',                 // Text: Workflow run ID
      // Internal linking (not user-facing state)
      slackThreadId: 'text_mkxxn3hz',
      team: 'dropdown_mkyqe4we',              // Sports team
      file: 'file_mkxv6aa0',
      pdfUrl: 'text_mkythpzx',                // Durable PDF URL for retries
    },
  },

  // Slack - business logic config (quiet hours, permissions)
  slack: {
    // Credentials (still needed for WebClient until fully migrated to core-api)
    botToken: getEnvVarOptional('SLACK_BOT_TOKEN'),
    signingSecret: getEnvVarOptional('SLACK_SIGNING_SECRET'),
    // After-hours behavior (nights + weekends)
    quietHours: {
      enabled: getEnvVarBool('SLACK_QUIET_HOURS_ENABLED', true),
      timezone: getEnvVar('SLACK_TIMEZONE', 'America/New_York'),
      workingHoursStart: getEnvVarNumber('SLACK_WORKING_HOURS_START', 8),
      workingHoursEnd: getEnvVarNumber('SLACK_WORKING_HOURS_END', 20),
      releaseHour: getEnvVarNumber('SLACK_RELEASE_HOUR', 8),
      ackDeadlineHour: getEnvVarNumber('SLACK_ACK_DEADLINE_HOUR', 11),
    },
    // /task command permissions
    taskCommandWhitelist: getEnvVar('SLACK_TASK_COMMAND_WHITELIST', '')
      .split(',')
      .map(id => id.trim())
      .filter(id => id.length > 0),
    // Users who can set Owner to someone other than themselves
    ownerOverrideUserIds: getEnvVar('SLACK_OWNER_OVERRIDE_USER_IDS', '')
      .split(',')
      .map(id => id.trim())
      .filter(id => id.length > 0),
    // Allowed channels for /seasontask command
    seasontaskAllowedChannels: getEnvVar('SLACK_SEASONTASK_ALLOWED_CHANNELS', '')
      .split(',')
      .map(id => id.trim())
      .filter(id => id.length > 0),
  },

  // Slack Relay (for receiving events via relay proxy)
  relay: {
    apiKey: getEnvVarOptional('RELAY_API_KEY'),
  },

  // Core API (centralized gateway)
  coreApi: {
    url: getEnvVar('CORE_API_URL', 'http://core-api.railway.internal:8080'),
    apiKey: getEnvVarOptional('CORE_API_KEY'),
  },

  // Google - credentials still needed for direct API calls until fully migrated
  google: {
    enabled: getEnvVarBool('GOOGLE_CALENDAR_ENABLED', false),
    calendarId: getEnvVar('GOOGLE_CALENDAR_ID', 'primary'),
    timeZone: getEnvVar('GOOGLE_CALENDAR_TIMEZONE', 'America/New_York'),
    forwardingEmail: getEnvVar('GOOGLE_FORWARDING_EMAIL', 'forwarding@salemseats.com'),
    serviceAccountKey: getEnvVarOptional('GOOGLE_SERVICE_ACCOUNT_KEY'),
    clientId: getEnvVarOptional('GOOGLE_CLIENT_ID'),
    clientSecret: getEnvVarOptional('GOOGLE_CLIENT_SECRET'),
    refreshToken: getEnvVarOptional('GOOGLE_REFRESH_TOKEN'),
  },

  // ConvertAPI - kept for validation checks (actual calls go through core-api)
  convertApi: {
    secret: getEnvVarOptional('CONVERTAPI_SECRET'),
  },

  // Anthropic - kept for validation checks (actual calls go through core-api)
  anthropic: {
    apiKey: getEnvVarOptional('ANTHROPIC_API_KEY'),
  },

  // Todoist integration (feature-flagged)
  todoist: {
    enabled: getEnvVarBool('ENABLE_TODOIST_SYNC', false),
    apiToken: getEnvVarOptional('TODOIST_API_TOKEN'),
  },

  // Presale Scanner Configuration
  presale: {
    scanIntervalMs: 60 * 60 * 1000, // 1 hour
    lookbackMinutes: 60,
    sportsLabelPrefixes: ['NBA/', 'MLB/', 'NFL/', 'NHL/', 'MLS/', 'NCAA/'],
  },
} as const;

// ============================================================================
// Remote Config (shared IDs from core-api)
// ============================================================================

let remoteConfig: CoreConfig | null = null;

/**
 * Get remote config (channels, boards, sheets from core-api)
 * Must call initRemoteConfig() at startup first
 */
export function getRemoteConfig(): CoreConfig {
  if (!remoteConfig) {
    throw new Error('Remote config not initialized. Call initRemoteConfig() at startup.');
  }
  return remoteConfig;
}

/**
 * Initialize remote config from core-api
 * Call this at server startup before handling requests
 */
export async function initRemoteConfig(): Promise<void> {
  remoteConfig = await initConfig();
}

// Convenience accessors for common remote config values
export const remote = {
  get slack() {
    return getRemoteConfig().slack;
  },
  get monday() {
    return getRemoteConfig().monday;
  },
  get google() {
    return getRemoteConfig().google;
  },
};

// ============================================================================
// Backward-compatible accessors (reads from remote config)
// These allow existing code to work without changes
// ============================================================================

export const configCompat = {
  slack: {
    get channelId() {
      return getRemoteConfig().slack.channels.seasonTicketAdmin;
    },
    get issueCallChannelId() {
      return getRemoteConfig().slack.channels.issueCall;
    },
    get controlChannelId() {
      return getRemoteConfig().slack.channels.control;
    },
    get presaleChannel() {
      return getRemoteConfig().slack.channels.presales;
    },
    get operationsChannel() {
      return getRemoteConfig().slack.channels.operations;
    },
    get supporterPrimaryChannel() {
      return getRemoteConfig().slack.channels.supporterPrimary;
    },
    get supporterSecondaryChannels() {
      const val = getRemoteConfig().slack.channels.supporterSecondary;
      return val ? val.split(',').map(s => s.trim()).filter(Boolean) : [];
    },
  },
  monday: {
    get boardId() {
      return getRemoteConfig().monday.boards.seasonTicketTasks;
    },
    get boardUrl() {
      const boardId = getRemoteConfig().monday.boards.seasonTicketTasks;
      return `https://salemseats.monday.com/boards/${boardId}`;
    },
  },
  accountSheets: {
    get mlb() { return getRemoteConfig().google.sheets.mlb; },
    get nfl() { return getRemoteConfig().google.sheets.nfl; },
    get nba() { return getRemoteConfig().google.sheets.nba; },
    get wnba() { return getRemoteConfig().google.sheets.wnba; },
    get nhl() { return getRemoteConfig().google.sheets.nhl; },
    get mls() { return getRemoteConfig().google.sheets.mls; },
    get ncaa() { return getRemoteConfig().google.sheets.ncaa; },
    get other() { return getRemoteConfig().google.sheets.other; },
  },
  presale: {
    get slackChannel() {
      return getRemoteConfig().slack.channels.presales;
    },
    get operationsChannel() {
      return getRemoteConfig().slack.channels.operations;
    },
  },
};

/**
 * Validate that all required config is present
 * Call this at startup AFTER initRemoteConfig()
 */
export function validateConfig(): void {
  const missing: string[] = [];

  // Core API is required
  if (!config.coreApi.url) missing.push('CORE_API_URL');
  if (!config.coreApi.apiKey) missing.push('CORE_API_KEY');

  if (missing.length > 0) {
    console.warn(`Warning: Missing environment variables: ${missing.join(', ')}`);
    console.warn('Some features may not work correctly.');
  }

  // Validate remote config is loaded
  try {
    const rc = getRemoteConfig();
    if (!rc.slack.channels.seasonTicketAdmin) {
      console.warn('Warning: SLACK_CHANNEL_SEASON_TICKET_ADMIN not set in core-api');
    }
    if (!rc.monday.boards.seasonTicketTasks) {
      console.warn('Warning: MONDAY_BOARD_SEASON_TICKET_TASKS not set in core-api');
    }
  } catch {
    console.error('ERROR: Remote config not loaded. Call initRemoteConfig() first.');
  }

  // Log safety valve status
  if (config.safetyValves.disableEmailAutomation) {
    console.warn('⚠️ DISABLE_EMAIL_AUTOMATION=true - Email processing is DISABLED');
  }
  if (config.safetyValves.attachmentsMode !== 'both') {
    console.warn(`⚠️ ATTACHMENTS_MODE=${config.safetyValves.attachmentsMode}`);
  }
  if (config.todoist.enabled) {
    console.log('📋 Todoist sync ENABLED (projection only)');
  }
}
