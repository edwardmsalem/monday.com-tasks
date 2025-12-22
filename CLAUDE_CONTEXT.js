/**
 * CLAUDE CONTEXT FILE
 * ====================
 * This file provides context for Claude Code sessions about the forwarding-monday project.
 * Read this file at the start of a new session to understand the codebase.
 *
 * Last updated: December 2024
 */

// =============================================================================
// PROJECT OVERVIEW
// =============================================================================

/**
 * forwarding-monday is a task management integration that bridges:
 * - Email (Gmail) → Monday.com + Slack
 * - Slack slash commands → Monday.com
 * - Two-way sync between Slack threads and Monday.com updates
 *
 * Deployed on Railway with two services:
 * 1. forwarding-monday (this app) - main application
 * 2. slack-relay - proxy for Slack events (separate repo)
 */

// =============================================================================
// KEY INTEGRATIONS
// =============================================================================

const INTEGRATIONS = {
  monday: {
    description: 'Task management board',
    apiVersion: '2024-10', // Updated from 2024-01
    features: [
      'Create items with owner, support, due date, urgency',
      'File uploads (PDF attachments)',
      'Updates (comments) with HTML formatting',
      'Webhooks for status changes and new updates',
    ],
  },

  slack: {
    description: 'Team communication',
    features: [
      'Slash commands (/task, /emailtask, /seasontask, /issuecall, /monday, /taskdebug)',
      'Thread sync with Monday updates',
      'Reaction handling (👀 = acknowledged, ✅ = complete)',
      'Quiet hours (after-hours task deferral)',
    ],
  },

  gmail: {
    description: 'Email intake',
    features: [
      'Search emails by subject',
      'OAuth2 authentication with refresh tokens',
      'HTML/text body extraction',
    ],
  },

  convertApi: {
    description: 'PDF generation',
    features: ['Convert HTML emails to PDF for Monday attachments'],
  },

  claude: {
    description: 'AI parsing',
    features: [
      'Natural language task parsing',
      'Email subject search parsing',
      'Smart task creation with follow-up questions',
    ],
  },
};

// =============================================================================
// SLACK SLASH COMMANDS
// =============================================================================

const SLASH_COMMANDS = {
  '/task': {
    endpoint: '/webhook/slack/task',
    description: 'Create task with @assignee, due date, urgency',
    usage: '/task @assignee description due friday urgency high',
    whitelist: 'SLACK_TASK_COMMAND_WHITELIST',
  },

  '/emailtask': {
    endpoint: '/webhook/slack/emailtask',
    description: 'Search Gmail and create task from email',
    usage: '/emailtask Knicks Presale 2025',
    whitelist: 'SLACK_TASK_COMMAND_WHITELIST',
  },

  '/seasontask': {
    endpoint: '/webhook/slack/seasontask',
    description: 'Season tickets task (channel-restricted)',
    usage: '/seasontask Follow up on Yankees renewal',
    channelRestriction: 'SLACK_SEASONTASK_ALLOWED_CHANNELS',
  },

  '/issuecall': {
    endpoint: '/webhook/slack/issuecall',
    description: 'Issue call task - owner is ALWAYS Dayna',
    usage: '/issuecall @supporter description',
    postsTo: 'SLACK_ISSUE_CALL_CHANNEL_ID',
  },

  '/monday': {
    endpoint: '/webhook/slack/command',
    description: 'Smart AI task creation with follow-up questions',
    usage: '/monday Fix the login bug by friday',
  },

  '/taskdebug': {
    endpoint: '/webhook/slack/taskdebug',
    description: 'Debug info for a Monday item',
    usage: '/taskdebug 1234567890',
  },
};

// =============================================================================
// TWO-WAY SYNC (Slack ↔ Monday)
// =============================================================================

/**
 * SYNC MESSAGE FORMAT:
 *
 * Slack → Monday:
 *   <p>💬 <strong>AuthorName</strong> <em>(via Slack)</em></p>
 *   <p>Message content with @mentions translated</p>
 *
 * Monday → Slack:
 *   📋 *AuthorName* _(via Monday)_
 *   Message content with @mentions translated
 *
 * IMPORTANT:
 * - Author name is NOT an @mention (just bold text)
 * - @mentions WITHIN the message content ARE translated
 * - Loop prevention filters detect "(via Slack)" and "(via Monday)"
 */

const SYNC_DETAILS = {
  slackToMonday: {
    trigger: 'Thread reply in synced Slack thread',
    handler: 'src/routes/slackEvents.ts or src/routes/relayEvents.ts',
    loopPrevention: 'Skip if message contains "(via Monday)"',
  },

  mondayToSlack: {
    trigger: 'Monday webhook for new update',
    handler: 'src/routes/mondayWebhook.ts',
    loopPrevention: 'Skip if update contains "(via Slack)"',
    webhookUrl: '/webhook/monday (NOT through relay)',
  },
};

// =============================================================================
// RELAY SETUP
// =============================================================================

/**
 * The slack-relay service forwards Slack events to this app.
 * This is needed because Slack Events API requires a single endpoint.
 *
 * Relay → forwarding-monday flow:
 * 1. Slack sends event to slack-relay
 * 2. slack-relay forwards to /relay/events with X-Relay-Secret header
 * 3. forwarding-monday validates X-Relay-Secret matches RELAY_API_KEY
 *
 * IMPORTANT: Monday webhooks go DIRECTLY to forwarding-monday, NOT through relay
 */

const RELAY_CONFIG = {
  endpoint: '/relay/events',
  authHeader: 'X-Relay-Secret',
  envVar: 'RELAY_API_KEY',
  note: 'Must match RELAY_API_KEY in slack-relay service',
};

// =============================================================================
// ENVIRONMENT VARIABLES
// =============================================================================

const ENV_VARS = {
  // Monday.com
  MONDAY_API_KEY: 'Monday.com API token',
  MONDAY_BOARD_ID: 'Target board ID',
  MONDAY_FILE_COLUMN_ID: 'Column ID for file attachments',
  MONDAY_WEBHOOK_SECRET: 'Secret for validating Monday webhooks',

  // Slack
  SLACK_BOT_TOKEN: 'xoxb-... bot token',
  SLACK_SIGNING_SECRET: 'For verifying Slack requests',
  SLACK_CHANNEL_ID: 'Main channel for task threads',
  SLACK_ISSUE_CALL_CHANNEL_ID: 'Dedicated channel for issue calls',
  SLACK_TASK_COMMAND_WHITELIST: 'Comma-separated user IDs (empty = all)',
  SLACK_OWNER_OVERRIDE_USER_IDS: 'Users allowed to use owner: prefix',
  SLACK_SEASONTASK_ALLOWED_CHANNELS: 'Channels where /seasontask works',

  // Gmail
  GMAIL_CLIENT_ID: 'OAuth client ID',
  GMAIL_CLIENT_SECRET: 'OAuth client secret',
  GMAIL_REFRESH_TOKEN: 'OAuth refresh token',

  // ConvertAPI
  CONVERTAPI_SECRET: 'API secret for PDF conversion',

  // Claude AI
  ANTHROPIC_API_KEY: 'Claude API key',

  // Relay
  RELAY_API_KEY: 'Shared secret with slack-relay service',
};

// =============================================================================
// KEY FILES
// =============================================================================

const KEY_FILES = {
  'src/server.ts': 'Express server, slash command handlers, app startup',
  'src/config/environment.ts': 'Environment variable loading and validation',
  'src/services/monday.ts': 'Monday.com API (create items, updates, file uploads)',
  'src/services/slack.ts': 'Slack API (post messages, reactions, threads)',
  'src/services/sync.ts': 'Two-way sync logic, mention translation, smart tasks',
  'src/services/gmail.ts': 'Gmail search and email fetching',
  'src/services/claude.ts': 'Claude AI parsing (tasks, email searches)',
  'src/services/userResolver.ts': 'Map between Slack IDs, Monday IDs, and names',
  'src/routes/slackEvents.ts': 'Direct Slack Events API handler',
  'src/routes/relayEvents.ts': 'Slack events via relay proxy',
  'src/routes/mondayWebhook.ts': 'Monday.com webhook handler',
  'src/workflow.ts': 'Task creation workflows (email and Slack)',
};

// =============================================================================
// RECENT FIXES AND GOTCHAS
// =============================================================================

const GOTCHAS = [
  {
    issue: 'Monday file upload "Unsupported query" error',
    fix: 'Use API version 2024-10, inline item_id/column_id in mutation, variables[file] format',
    file: 'src/services/monday.ts',
  },
  {
    issue: '/relay/events returning 404',
    fix: 'Use inline JSON middleware: router.post("/relay/events", express.json(), async ...)',
    file: 'src/routes/relayEvents.ts',
  },
  {
    issue: 'Sync messages pinging author',
    fix: 'Author should be bold name only, NOT @mention. Only translate @mentions in message content.',
    file: 'src/services/sync.ts',
  },
  {
    issue: 'Monday → Slack not syncing',
    fix: 'Monday webhook must point to forwarding-monday /webhook/monday, NOT through relay',
    file: 'src/routes/mondayWebhook.ts',
  },
  {
    issue: 'Sync loops',
    fix: 'Check for "(via Slack)" and "(via Monday)" in messages before syncing',
    files: ['src/routes/slackEvents.ts', 'src/routes/mondayWebhook.ts'],
  },
];

// =============================================================================
// USER DIRECTORY
// =============================================================================

/**
 * User mapping is stored in src/config/users.json
 * Each user has: name, slackId, mondayId
 *
 * userResolver.ts provides:
 * - findUserByName(name) → user object
 * - findUserBySlackId(slackId) → user object
 * - findUserByMondayId(mondayId) → user object
 * - translateMentionsSlackToMonday(text) → text with Monday @mentions
 * - translateMentionsMondayToSlack(text) → text with Slack @mentions
 */

// =============================================================================
// TASK CREATION FLOW
// =============================================================================

/**
 * 1. Input received (email, /task command, /emailtask)
 * 2. Claude parses natural language → structured fields
 * 3. Monday item created with:
 *    - Name, Owner, Support, Due Date, Urgency, Task Type, Source
 * 4. Run ID generated and stored on item
 * 5. Initial Update posted to Monday item
 * 6. Slack thread created with task summary
 * 7. Thread ID stored on Monday item for sync
 * 8. PDF attached (if email source)
 *
 * Quiet Hours:
 * - Tasks created after 6 PM or before 8 AM (Eastern) are "deferred"
 * - Assignee notified but not pinged until 8 AM release
 */

// =============================================================================
// TESTING
// =============================================================================

/**
 * Run tests: npm test
 * Run specific test: npm test -- --grep "pattern"
 *
 * Key test files:
 * - tests/unit/: Unit tests for services
 * - tests/integration/: Integration tests
 */

console.log('CLAUDE_CONTEXT.js loaded - this file is for context only');
