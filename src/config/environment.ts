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

export const config = {
  // Server
  port: getEnvVarNumber('PORT', 3000),

  // Monday.com
  monday: {
    apiToken: getEnvVar('MONDAY_API_TOKEN', ''),
    boardId: getEnvVar('MONDAY_BOARD_ID', '18383923820'),
    fileColumnId: getEnvVar('MONDAY_FILE_COLUMN_ID', 'file_mkxv6aa0'),
    slackThreadColumnId: getEnvVar('MONDAY_SLACK_THREAD_COLUMN_ID', 'text_mkxxn3hz'),
    boardUrl: getEnvVar('MONDAY_BOARD_URL', 'https://salemseats.monday.com/boards/18383923820'),

    // Column IDs from the blueprint
    columns: {
      date: 'date4',
      from: 'email_mkxvy5nq',
      notes: 'long_text_mkxv1vhb',
      owner: 'person',
      slackThreadId: 'text_mkxxn3hz',
      to: 'email_mkxv1hyd',
      status: 'status',
      file: 'file_mkxv6aa0',
    },
  },

  // Slack
  slack: {
    botToken: getEnvVar('SLACK_BOT_TOKEN', ''),
    channelId: getEnvVar('SLACK_CHANNEL_ID', 'C08QCFC4Y0H'),
  },

  // ConvertAPI
  convertApi: {
    secret: getEnvVar('CONVERTAPI_SECRET', ''),
  },

  // Anthropic (Claude AI)
  anthropic: {
    apiKey: getEnvVar('ANTHROPIC_API_KEY', ''),
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
}
