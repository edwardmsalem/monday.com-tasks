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

  // Monday.com (all board/column IDs are REQUIRED - no defaults)
  monday: {
    apiToken: getEnvVar('MONDAY_API_TOKEN'),
    boardId: getEnvVar('MONDAY_BOARD_ID'),
    fileColumnId: getEnvVar('MONDAY_FILE_COLUMN_ID'),
    slackThreadColumnId: getEnvVar('MONDAY_SLACK_THREAD_COLUMN_ID'),
    // Board URL derived from board ID (no hardcoded URLs)
    get boardUrl(): string {
      return `https://salemseats.monday.com/boards/${this.boardId}`;
    },

    // Column IDs from the board - ALL REQUIRED
    // LOCKED ARCHITECTURE: Columns = STATE + ROUTING only
    // Narrative/context goes to Updates, not columns
    columns: {
      // Core state/routing columns (required env vars)
      owner: getEnvVar('MONDAY_COL_OWNER'),
      support: getEnvVar('MONDAY_COL_SUPPORT'),
      type: getEnvVar('MONDAY_COL_TYPE'),
      workflowStatus: getEnvVar('MONDAY_COL_WORKFLOW_STATUS'),
      urgency: getEnvVar('MONDAY_COL_URGENCY'),
      date: getEnvVar('MONDAY_COL_DATE'),
      source: getEnvVar('MONDAY_COL_SOURCE'),
      attachmentState: getEnvVar('MONDAY_COL_ATTACHMENT_STATE'),
      runId: getEnvVar('MONDAY_COL_RUN_ID'),
      // Internal linking (required env vars)
      slackThreadId: getEnvVar('MONDAY_COL_SLACK_THREAD_ID'),
      team: getEnvVar('MONDAY_COL_TEAM'),
      file: getEnvVar('MONDAY_COL_FILE'),
      pdfUrl: getEnvVar('MONDAY_COL_PDF_URL'),
      // REMOVED: from, to, notes, slackLink - narrative belongs in Updates
    },
  },

  // Slack
  slack: {
    botToken: getEnvVar('SLACK_BOT_TOKEN'),
    channelId: getEnvVar('SLACK_CHANNEL_ID'),  // REQUIRED: notification channel for task threads
    signingSecret: getEnvVarOptional('SLACK_SIGNING_SECRET'),
    // Escalation user for overdue tasks (day 2+) - REQUIRED
    escalationUserId: getEnvVar('SLACK_ESCALATION_USER_ID'),
    // After-hours behavior (nights + weekends)
    // Tasks created after-hours are created quietly (no pings), then released at business start
    quietHours: {
      enabled: getEnvVarBool('SLACK_QUIET_HOURS_ENABLED', true),
      onCallUserId: getEnvVar('SLACK_ON_CALL_USER_ID'),  // On-call user for after-hours/weekend routing - REQUIRED
      timezone: 'America/New_York',  // Locked to Eastern Time for all time logic
      workingHoursStart: getEnvVarNumber('SLACK_WORKING_HOURS_START', 10),  // 10:00 AM ET
      workingHoursEnd: getEnvVarNumber('SLACK_WORKING_HOURS_END', 18),      // 6:00 PM ET (18:00)
      releaseHour: getEnvVarNumber('SLACK_RELEASE_HOUR', 10),               // 10:00 AM - ping deferred tasks
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
  },

  // ConvertAPI
  convertApi: {
    secret: getEnvVar('CONVERTAPI_SECRET'),
  },

  // Anthropic (Claude AI)
  anthropic: {
    apiKey: getEnvVar('ANTHROPIC_API_KEY'),
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
} as const;

/**
 * Validate that all required config is present
 * Call this at startup
 *
 * NOTE: All critical env vars are now required at config load time.
 * If any are missing, the app will fail fast with a clear error.
 * This function logs config status for visibility.
 */
export function validateConfig(): void {
  // Log config summary (all required vars already validated at load time)
  console.log('✓ Config loaded successfully');
  console.log(`  Monday Board: ${config.monday.boardId}`);
  console.log(`  Slack Channel: ${config.slack.channelId}`);
  console.log(`  Working Hours: ${config.slack.quietHours.workingHoursStart}:00 - ${config.slack.quietHours.workingHoursEnd}:00 ET`);
  console.log(`  Quiet Hours: ${config.slack.quietHours.enabled ? 'ENABLED' : 'DISABLED'}`);

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
