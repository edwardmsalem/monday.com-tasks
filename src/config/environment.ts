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
    columns: {
      date: 'date4',
      from: 'email_mkxvy5nq',
      owner: 'person',
      support: 'multiple_person_mky0vdq1',
      slackThreadId: 'text_mkxxn3hz',
      slackLink: 'link_mky1j0j6',
      to: 'email_mkxv1hyd',
      type: 'status',                    // Task type (General, Opportunity, etc.)
      workflowStatus: 'color_mkxvxxxn',  // Workflow status (Acknowledged, Working on it, etc.)
      source: 'color_mky0b1yr',          // Source (Forwarding Tasks, Slack Tasks, etc.)
      team: 'dropdown_mkyqe4we',         // Sports team
      file: 'file_mkxv6aa0',
      urgency: 'color_mkytzsrj',         // Urgency (High, Medium, Low)
      pdfUrl: 'text_mkythpzx',           // Durable PDF URL for retries
      // Attachment tracking columns (create in Monday if needed)
      attachmentState: 'status_mkyZZZZZ',     // Queued/Uploaded/Retrying/Failed - UPDATE WITH REAL ID
      attachmentError: 'text_mkyWWWWW',       // Last error message - UPDATE WITH REAL ID
      correlationId: 'text_mkyVVVVV',         // Workflow run ID - UPDATE WITH REAL ID
    },
  },

  // Slack
  slack: {
    botToken: getEnvVar('SLACK_BOT_TOKEN', ''),
    channelId: getEnvVar('SLACK_CHANNEL_ID', 'C08QCFC4Y0H'),
    signingSecret: getEnvVarOptional('SLACK_SIGNING_SECRET'),
  },

  // ConvertAPI
  convertApi: {
    secret: getEnvVar('CONVERTAPI_SECRET', ''),
  },

  // Anthropic (Claude AI)
  anthropic: {
    apiKey: getEnvVar('ANTHROPIC_API_KEY', ''),
  },

  // Google (Gmail API + Calendar)
  google: {
    enabled: getEnvVar('GOOGLE_CALENDAR_ENABLED', 'false') === 'true',
    calendarId: getEnvVar('GOOGLE_CALENDAR_ID', 'primary'),
    timeZone: getEnvVar('GOOGLE_CALENDAR_TIMEZONE', 'America/New_York'),
    // Forwarding inbox email for /scan feature
    forwardingEmail: getEnvVar('GOOGLE_FORWARDING_EMAIL', 'forwarding@salemseats.com'),
    // Service Account (recommended for server-side automation)
    serviceAccountKey: getEnvVarOptional('GOOGLE_SERVICE_ACCOUNT_KEY'),
    // OR OAuth (for personal use)
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
 */
export function validateConfig(): void {
  const missing: string[] = [];

  if (!config.monday.apiToken) missing.push('MONDAY_API_TOKEN');
  if (!config.slack.botToken) missing.push('SLACK_BOT_TOKEN');
  if (!config.convertApi.secret) missing.push('CONVERTAPI_SECRET');
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
