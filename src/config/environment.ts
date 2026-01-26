/**
 * Environment configuration
 * Validates and exports all required environment variables
 */

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

export const config = {
  // Server
  port: getEnvVarNumber('PORT', 3000),

  // Safety valves
  safetyValves: {
    /** If true, skip all email processing (log receipt only) */
    disableEmailAutomation: getEnvVarBool('DISABLE_EMAIL_AUTOMATION', false),
    /** Control attachment upload behavior: off | slack_only | monday_only | both */
    attachmentsMode: getAttachmentsMode(),
  },

  // Monday.com
  monday: {
    apiToken: getEnvVar('MONDAY_API_TOKEN', ''),
    boardId: getEnvVar('MONDAY_BOARD_ID', '18383923820'),
    fileColumnId: getEnvVar('MONDAY_FILE_COLUMN_ID', 'file_mkxv6aa0'),
    slackThreadColumnId: getEnvVar('MONDAY_SLACK_THREAD_COLUMN_ID', 'text_mkxxn3hz'),
    boardUrl: getEnvVar('MONDAY_BOARD_URL', 'https://salemseats.monday.com/boards/18383923820'),

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
      // REMOVED: from, to, notes, slackLink - narrative belongs in Updates
    },
  },

  // Slack
  slack: {
    botToken: getEnvVar('SLACK_BOT_TOKEN', ''),
    channelId: getEnvVar('SLACK_CHANNEL_ID', ''),  // Main task notification channel (required for main server)
    signingSecret: getEnvVarOptional('SLACK_SIGNING_SECRET'),
    // After-hours behavior (nights + weekends)
    // Tasks created after-hours are created quietly (no pings), then released at business start
    quietHours: {
      enabled: getEnvVarBool('SLACK_QUIET_HOURS_ENABLED', true),
      onCallUserId: getEnvVar('SLACK_ON_CALL_USER_ID', ''),  // On-call user for after-hours/weekend routing
      timezone: getEnvVar('SLACK_TIMEZONE', 'America/New_York'),
      workingHoursStart: getEnvVarNumber('SLACK_WORKING_HOURS_START', 8),   // 8:00 AM ET
      workingHoursEnd: getEnvVarNumber('SLACK_WORKING_HOURS_END', 20),      // 8:00 PM ET (20:00)
      releaseHour: getEnvVarNumber('SLACK_RELEASE_HOUR', 8),                // 8:00 AM - ping deferred tasks
      ackDeadlineHour: getEnvVarNumber('SLACK_ACK_DEADLINE_HOUR', 11),      // 11:00 AM - follow up if no 👀
    },
    // /task command permissions
    taskCommandWhitelist: getEnvVar('SLACK_TASK_COMMAND_WHITELIST', '')
      .split(',')
      .map(id => id.trim())
      .filter(id => id.length > 0),  // Comma-separated Slack user IDs
    // Users who can set Owner to someone other than themselves
    // Everyone else: Owner = task creator (Support can be set by anyone)
    ownerOverrideUserIds: getEnvVar('SLACK_OWNER_OVERRIDE_USER_IDS', '')
      .split(',')
      .map(id => id.trim())
      .filter(id => id.length > 0),  // Comma-separated Slack user IDs
    // Control channel for pinned config (Owners map, Sheets registry)
    controlChannelId: getEnvVar('SLACK_CONTROL_CHANNEL_ID', 'C0A4TMWDZJA'),
    // Allowed channels for /seasontask command (QW-06: moved from hardcoded)
    seasontaskAllowedChannels: getEnvVar('SLACK_SEASONTASK_ALLOWED_CHANNELS', 'C06BSL06WJK,C08QCFC4Y0H')
      .split(',')
      .map(id => id.trim())
      .filter(id => id.length > 0),
    // Issue Call channel - separate channel for issue call tasks (syncs to Monday)
    issueCallChannelId: getEnvVarOptional('SLACK_ISSUE_CALL_CHANNEL_ID'),
  },

  // Slack Relay (for receiving events via relay proxy)
  relay: {
    apiKey: getEnvVarOptional('RELAY_API_KEY'),  // Must match core-api's CORE_API_KEY
  },

  // Core API (centralized gateway for Monday, ConvertAPI, some Slack/Google operations)
  coreApi: {
    url: getEnvVar('CORE_API_URL', 'http://core-api.railway.internal'),
    apiKey: getEnvVarOptional('CORE_API_KEY'),
  },

  // ConvertAPI (legacy - now proxied through core-api)
  convertApi: {
    secret: getEnvVar('CONVERTAPI_SECRET', ''),
  },

  // Anthropic (Claude AI)
  anthropic: {
    apiKey: getEnvVar('ANTHROPIC_API_KEY', ''),
  },

  // Google (Gmail API, Calendar, and future Sheets read)
  // Supports TWO auth modes (use whichever is configured, prefers Service Account):
  //   A) Service Account: GOOGLE_SERVICE_ACCOUNT_KEY (base64 JSON)
  //   B) OAuth User: GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_REFRESH_TOKEN
  google: {
    enabled: getEnvVar('GOOGLE_CALENDAR_ENABLED', 'false') === 'true',
    calendarId: getEnvVar('GOOGLE_CALENDAR_ID', 'primary'),
    timeZone: getEnvVar('GOOGLE_CALENDAR_TIMEZONE', 'America/New_York'),
    // Forwarding inbox email for /scan feature
    forwardingEmail: getEnvVar('GOOGLE_FORWARDING_EMAIL', 'forwarding@salemseats.com'),
    // Auth Mode A: Service Account (recommended - base64 encoded JSON key)
    serviceAccountKey: getEnvVarOptional('GOOGLE_SERVICE_ACCOUNT_KEY'),
    // Auth Mode B: OAuth User (reads as a workspace user with existing access)
    clientId: getEnvVarOptional('GOOGLE_CLIENT_ID'),
    clientSecret: getEnvVarOptional('GOOGLE_CLIENT_SECRET'),
    refreshToken: getEnvVarOptional('GOOGLE_REFRESH_TOKEN'),
  },

  // Todoist integration (feature-flagged, projection only in v1)
  todoist: {
    enabled: getEnvVarBool('ENABLE_TODOIST_SYNC', false),
    apiToken: getEnvVarOptional('TODOIST_API_TOKEN'),
  },

  // Google Sheets - Account lookup by sport/team
  // Each sport has its own workbook with a sheet per team
  accountSheets: {
    mlb: getEnvVarOptional('SHEETS_MLB_ID'),       // MLB workbook spreadsheet ID
    nfl: getEnvVarOptional('SHEETS_NFL_ID'),       // NFL workbook spreadsheet ID
    nba: getEnvVarOptional('SHEETS_NBA_ID'),       // NBA workbook spreadsheet ID
    wnba: getEnvVarOptional('SHEETS_WNBA_ID'),     // WNBA workbook spreadsheet ID
    nhl: getEnvVarOptional('SHEETS_NHL_ID'),       // NHL workbook spreadsheet ID
    mls: getEnvVarOptional('SHEETS_MLS_ID'),       // MLS workbook spreadsheet ID
    ncaa: getEnvVarOptional('SHEETS_NCAA_ID'),     // NCAA workbook spreadsheet ID (college)
    other: getEnvVarOptional('SHEETS_OTHER_ID'),   // Other events workbook
  },

  // Presale Scanner Configuration
  presale: {
    slackChannel: getEnvVar('SLACK_PRESALE_CHANNEL', ''),
    operationsChannel: getEnvVar('SLACK_OPERATIONS_CHANNEL', ''),  // Channel for "Interested" notifications
    scanIntervalMs: 60 * 60 * 1000, // 1 hour
    lookbackMinutes: 60,
    sportsLabelPrefixes: ['NBA/', 'MLB/', 'NFL/', 'NHL/', 'MLS/', 'NCAA/'],
  },
} as const;

/**
 * Validate that all required config is present
 * Call this at startup
 */
export function validateConfig(): void {
  const missing: string[] = [];

  // Core API is required for Monday, ConvertAPI, and some Slack operations
  if (!config.coreApi.url) missing.push('CORE_API_URL');
  if (!config.coreApi.apiKey) missing.push('CORE_API_KEY');

  // Still needed directly (partial migration)
  if (!config.slack.botToken) missing.push('SLACK_BOT_TOKEN');
  if (!config.slack.channelId) missing.push('SLACK_CHANNEL_ID');
  if (!config.anthropic.apiKey) missing.push('ANTHROPIC_API_KEY');

  if (missing.length > 0) {
    console.warn(`Warning: Missing environment variables: ${missing.join(', ')}`);
    console.warn('Some features may not work correctly.');
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
