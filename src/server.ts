/**
 * Express server for receiving email webhooks
 *
 * This server accepts incoming emails via HTTP POST and triggers the workflow.
 * It can be used with various email-to-webhook services like:
 * - Mailgun
 * - SendGrid Inbound Parse
 * - Postmark
 * - AWS SES + Lambda
 *
 * Also handles:
 * - Slack Events API (thread sync, reactions)
 * - Monday.com webhooks (status changes, updates)
 * - Slack slash commands (/monday)
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { config, configCompat, validateConfig, initRemoteConfig } from './config/environment.js';
import {
  executeAISlackTaskWorkflowSafe,
} from './workflow.js';
import * as monday from './services/monday.js';
import * as slack from './services/slack.js';
import * as sync from './services/sync.js';
import { findUserByName, findUserBySlackId } from './services/userResolver.js';
import { initializeJobQueue } from './services/jobQueue.js';
import {
  checkIdempotency,
  setIdempotencyKey,
  generateTaskIdempotencyKey,
  startCleanupInterval as startIdempotencyCleanup,
} from './services/idempotency.js';

// Import route modules
import {
  healthRouter,
  emailWebhookRouter,
  slackEventsRouter,
  mondayWebhookRouter,
  relayEventsRouter,
  slackUrlEncodedWithRawBody,
  verifySlackSignature,
  type SlackRequest,
} from './routes/index.js';
import interactivityRouter from './routes/interactivity.js';

// Import middleware
import { requestLogger } from './middleware/index.js';
import { formatTaskName } from './utils/taskName.js';

const app = express();

// ============================================================================
// Global Middleware
// ============================================================================

// Request logging - must be first to capture all requests
app.use(requestLogger);

// ============================================================================
// Mount Route Modules
// ============================================================================

// Health check endpoint
app.use(healthRouter);

// Email webhook endpoints (/webhook/email, /webhook/json, /webhook/make, /webhook/make/parsed)
app.use(emailWebhookRouter);

// Slack Events API (/webhook/slack/events)
app.use(slackEventsRouter);

// Monday.com webhooks (/webhook/monday)
app.use(mondayWebhookRouter);

// Relay events (Slack events via relay proxy, /relay/events)
app.use(relayEventsRouter);

// Slack interactivity endpoint (/webhook/slack/interactivity) - for button clicks
// Must use urlencoded parser since Slack sends payload as form-encoded
app.use('/webhook/slack/interactivity', express.urlencoded({ extended: true }));
app.use(interactivityRouter);

// ============================================================================
// Slack Debug Commands
// ============================================================================

/**
 * /taskdebug slash command handler
 * Shows all tracking info for a Monday item (for debugging)
 *
 * Usage: /taskdebug <monday_item_id>
 * Example: /taskdebug 1234567890
 */
app.post('/webhook/slack/taskdebug', slackUrlEncodedWithRawBody, async (req: Request & { rawBody?: string }, res: Response): Promise<void> => {
  // Verify Slack signature (QW-07)
  if (!verifySlackSignature(req)) {
    res.status(401).send('Invalid signature');
    return;
  }

  try {
    const { text, user_id } = req.body as {
      text: string;
      user_id: string;
    };

    const itemId = text.trim();

    // Handle help or empty input
    if (!itemId || itemId === 'help') {
      res.json({
        response_type: 'ephemeral',
        text: `*Task Debug*\n\n` +
          `Shows all tracking info for a Monday.com task.\n\n` +
          `*Usage:* \`/taskdebug <monday_item_id>\`\n\n` +
          `*Example:* \`/taskdebug 1234567890\`\n\n` +
          `_Find the item ID in the Monday URL or from the Slack thread._`,
      });
      return;
    }

    // Validate item ID format (should be numeric)
    if (!/^\d+$/.test(itemId)) {
      res.json({
        response_type: 'ephemeral',
        text: `:x: Invalid item ID. Please provide a numeric Monday item ID.\n\nExample: \`/taskdebug 1234567890\``,
      });
      return;
    }

    // Fetch task debug info
    const debugInfo = await monday.getTaskDebugInfo(itemId);

    if (!debugInfo) {
      res.json({
        response_type: 'ephemeral',
        text: `:x: Task not found: \`${itemId}\`\n\nMake sure the item ID is correct and the task exists.`,
      });
      return;
    }

    // Format debug info as Slack blocks
    const blocks = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: '🔍 Task Debug Info',
          emoji: true,
        },
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Monday ID:*\n<${debugInfo.mondayUrl}|${debugInfo.mondayItemId}>`,
          },
          {
            type: 'mrkdwn',
            text: `*Run ID:*\n\`${debugInfo.runId || 'N/A'}\``,
          },
        ],
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Task Type:*\n${debugInfo.taskType || 'N/A'}`,
          },
          {
            type: 'mrkdwn',
            text: `*Workflow Status:*\n${debugInfo.workflowStatus || 'N/A'}`,
          },
        ],
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Owner:*\n${debugInfo.owner || 'N/A'}`,
          },
          {
            type: 'mrkdwn',
            text: `*Due Date:*\n${debugInfo.dueDate || 'N/A'}`,
          },
        ],
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Urgency:*\n${debugInfo.urgency || 'N/A'}`,
          },
          {
            type: 'mrkdwn',
            text: `*Attachment State:*\n${debugInfo.attachmentState || 'N/A'}`,
          },
        ],
      },
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Slack Thread:*\n${debugInfo.slackThreadUrl ? `<${debugInfo.slackThreadUrl}|View Thread>` : 'N/A'}`,
        },
      },
    ];

    // Add PDF URL if present
    if (debugInfo.pdfUrl) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*PDF URL:*\n<${debugInfo.pdfUrl}|Download PDF>`,
        },
      });
    }

    // Check quiet-hours status if we have a Slack thread
    if (debugInfo.slackThreadTs) {
      const quietHoursStatus = await slack.getQuietHoursStatus(debugInfo.slackThreadTs);

      let quietHoursText = '*Quiet Hours:*\n';
      if (!quietHoursStatus.wasDeferred) {
        quietHoursText += 'Not deferred (created during working hours)';
      } else if (quietHoursStatus.wasReleased) {
        quietHoursText += `✅ Deferred → Released\n_Assignee: <@${quietHoursStatus.deferredUserId}>_`;
      } else {
        quietHoursText += `⏳ Deferred (pending release)\n_Assignee: <@${quietHoursStatus.deferredUserId}>_`;
      }

      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: quietHoursText,
        },
      });
    }

    // Note: Errors are in Updates/Slack thread, not columns (keeping board lean)

    res.json({
      response_type: 'ephemeral',
      blocks,
      text: `Task Debug Info for ${itemId}`,
    });
  } catch (error) {
    console.error('Task debug command error:', error);
    res.json({
      response_type: 'ephemeral',
      text: `:x: Error fetching task info: ${error instanceof Error ? error.message : 'Unknown error'}`,
    });
  }
});

// ============================================================================
// Slack /task Command - Unified Task Intake
// ============================================================================

/**
 * /task slash command handler
 * Primary intake path for internal task creation via Slack
 *
 * NOW AI-POWERED - Works exactly like the email workflow!
 *
 * Usage (natural language):
 * - /task Dayna refund for angry customer next friday
 * - /task call back about Yankees tickets asap
 * - /task @jamie follow up on renewal with Sarah's help
 * - /task urgent payment declined for season tickets
 *
 * Behavior:
 * - Uses Claude AI to parse natural language (same as email workflow)
 * - Auto-detects owner, due date, priority, task type, team
 * - Creates Monday item immediately
 * - Generates Run ID and stores it
 * - Posts initial Monday Update (narrative only)
 * - Creates Slack thread
 * - Respects quiet-hours routing
 */
app.post('/webhook/slack/task', slackUrlEncodedWithRawBody, async (req: Request & { rawBody?: string }, res: Response): Promise<void> => {
  // Verify Slack signature (QW-07)
  if (!verifySlackSignature(req)) {
    res.status(401).send('Invalid signature');
    return;
  }

  try {
    const { text, user_id, response_url } = req.body as {
      text: string;
      user_id: string;
      response_url: string;
    };

    console.log(`/task command received from ${user_id}: ${text}`);

    // Check whitelist permissions
    const whitelist = config.slack.taskCommandWhitelist;
    if (whitelist.length > 0 && !whitelist.includes(user_id)) {
      res.json({
        response_type: 'ephemeral',
        text: `🔒 *Access Restricted*\n\n` +
          `The \`/task\` command is currently limited to authorized users.\n\n` +
          `*How to create tasks:*\n` +
          `• Forward emails to the forwarding inbox\n` +
          `• Ask an authorized user to run \`/task\` for you\n\n` +
          `_Contact your admin if you need access._`,
      });
      return;
    }

    // Handle help or empty input
    const trimmedText = text.trim();
    if (!trimmedText || trimmedText.toLowerCase() === 'help') {
      res.json({
        response_type: 'ephemeral',
        text: `*Task Creation (AI-Powered)*\n\n` +
          `Just describe your task naturally! I'll figure out the rest.\n\n` +
          `*Examples:*\n` +
          `• \`/task Dayna refund for angry customer next friday\`\n` +
          `• \`/task call back about Yankees tickets asap\`\n` +
          `• \`/task @jamie follow up on renewal\`\n` +
          `• \`/task urgent payment declined for season tickets\`\n` +
          `• \`/task Jamie relocation with Sarah's help by monday\`\n\n` +
          `*What I detect automatically:*\n` +
          `• Owner (name or @mention)\n` +
          `• Due date (friday, next week, 12/25, asap)\n` +
          `• Priority (urgent, asap = high)\n` +
          `• Task type (refund, renewal, relocation, etc.)\n` +
          `• Team (Yankees, Knicks, etc.)\n` +
          `• Supporters ("with Sarah's help")\n\n` +
          `_If no owner specified, task is assigned to you._`,
      });
      return;
    }

    // Check idempotency to prevent duplicate tasks
    const idempotencyKey = generateTaskIdempotencyKey(user_id, trimmedText);
    const { isDuplicate, cachedResult } = checkIdempotency(idempotencyKey);
    if (isDuplicate) {
      console.log(`[Idempotency] Duplicate /task request detected: ${idempotencyKey}`);
      res.json({
        response_type: 'ephemeral',
        text: cachedResult
          ? `✅ Task already created (duplicate request ignored)`
          : `⚠️ Duplicate request detected. Please wait for the previous task to be created.`,
      });
      return;
    }

    // Acknowledge immediately (Slack requires response within 3 seconds)
    res.json({
      response_type: 'ephemeral',
      text: `⏳ Analyzing task with AI...`,
    });

    // Execute the AI-powered workflow asynchronously
    const result = await executeAISlackTaskWorkflowSafe({
      text: trimmedText,
      creatorSlackId: user_id,
    });

    // Send confirmation or error via response_url
    if (result.success) {
      // Store result for idempotency
      setIdempotencyKey(idempotencyKey, {
        success: true,
        mondayItemId: result.mondayItemId,
        slackThreadTs: result.slackThreadTs,
      });

      const mondayUrl = monday.getItemUrl(result.mondayItemId);
      const slackThreadUrl = `https://slack.com/archives/${configCompat.slack.channelId}/p${result.slackThreadTs.replace('.', '')}`;

      // Post creator attribution to thread
      await slack.postToThread(
        result.slackThreadTs,
        `✅ Task created by <@${user_id}>`
      );

      // Send ephemeral confirmation to creator via response_url
      await slack.sendResponseUrl(response_url,
        `✅ *Task Created*\n\n` +
        `• *Monday:* <${mondayUrl}|View Item>\n` +
        `• *Slack Thread:* <${slackThreadUrl}|View Thread>\n` +
        `• *Run ID:* \`${result.runId?.substring(0, 8)}\``
      );
    } else {
      // Send error via response_url
      console.error('Task creation failed:', result.error);
      await slack.sendResponseUrl(response_url,
        `:x: *Task Creation Failed*\n\n${result.error}`
      );
    }
  } catch (error) {
    console.error('/task command error:', error);
    res.json({
      response_type: 'ephemeral',
      text: `:x: Error creating task: ${error instanceof Error ? error.message : 'Unknown error'}`,
    });
  }
});

// ============================================================================
// Slack /issuecall Command - Issue Call Task with Account Lookup
// ============================================================================

import { lookupAccountForIssueCall, formatIssueCallAccount, logSheetsConfiguration } from './services/sheets.js';
import { parseIssueCallInputSafe } from './services/claude.js';

/**
 * Expand short team names to full official names for Monday.com
 */
const TEAM_NAME_EXPANSIONS: Record<string, string> = {
  // NBA
  'knicks': 'New York Knicks',
  'nets': 'Brooklyn Nets',
  'lakers': 'Los Angeles Lakers',
  'celtics': 'Boston Celtics',
  'bulls': 'Chicago Bulls',
  'heat': 'Miami Heat',
  'warriors': 'Golden State Warriors',
  'rockets': 'Houston Rockets',
  'mavericks': 'Dallas Mavericks',
  'mavs': 'Dallas Mavericks',
  'spurs': 'San Antonio Spurs',
  'thunder': 'Oklahoma City Thunder',
  'suns': 'Phoenix Suns',
  'bucks': 'Milwaukee Bucks',
  'sixers': 'Philadelphia 76ers',
  '76ers': 'Philadelphia 76ers',
  'raptors': 'Toronto Raptors',
  'hawks': 'Atlanta Hawks',
  'hornets': 'Charlotte Hornets',
  'cavaliers': 'Cleveland Cavaliers',
  'cavs': 'Cleveland Cavaliers',
  'pistons': 'Detroit Pistons',
  'pacers': 'Indiana Pacers',
  'magic': 'Orlando Magic',
  'wizards': 'Washington Wizards',
  'nuggets': 'Denver Nuggets',
  'timberwolves': 'Minnesota Timberwolves',
  'wolves': 'Minnesota Timberwolves',
  'pelicans': 'New Orleans Pelicans',
  'blazers': 'Portland Trail Blazers',
  'trail blazers': 'Portland Trail Blazers',
  'sacramento kings': 'Sacramento Kings',
  'nba kings': 'Sacramento Kings',
  'jazz': 'Utah Jazz',
  'clippers': 'Los Angeles Clippers',
  'grizzlies': 'Memphis Grizzlies',
  // NFL
  'ny giants': 'New York Giants',
  'nfl giants': 'New York Giants',
  // 'jets' is AMBIGUOUS - must specify: 'ny jets'/'nfl jets' for NFL, 'winnipeg jets'/'nhl jets' for NHL
  'ny jets': 'New York Jets',
  'nfl jets': 'New York Jets',
  'cowboys': 'Dallas Cowboys',
  'eagles': 'Philadelphia Eagles',
  'patriots': 'New England Patriots',
  'texans': 'Houston Texans',
  'titans': 'Tennessee Titans',
  'colts': 'Indianapolis Colts',
  'jaguars': 'Jacksonville Jaguars',
  'chiefs': 'Kansas City Chiefs',
  'broncos': 'Denver Broncos',
  'raiders': 'Las Vegas Raiders',
  'chargers': 'Los Angeles Chargers',
  'ravens': 'Baltimore Ravens',
  'bengals': 'Cincinnati Bengals',
  'browns': 'Cleveland Browns',
  'steelers': 'Pittsburgh Steelers',
  'bills': 'Buffalo Bills',
  'dolphins': 'Miami Dolphins',
  'bears': 'Chicago Bears',
  'lions': 'Detroit Lions',
  'packers': 'Green Bay Packers',
  'vikings': 'Minnesota Vikings',
  'falcons': 'Atlanta Falcons',
  // 'panthers' is AMBIGUOUS - must specify: 'carolina panthers'/'nfl panthers' for NFL, 'florida panthers'/'nhl panthers' for NHL
  'carolina panthers': 'Carolina Panthers',
  'nfl panthers': 'Carolina Panthers',
  'saints': 'New Orleans Saints',
  'buccaneers': 'Tampa Bay Buccaneers',
  'bucs': 'Tampa Bay Buccaneers',
  'arizona cardinals': 'Arizona Cardinals',
  'nfl cardinals': 'Arizona Cardinals',
  'rams': 'Los Angeles Rams',
  '49ers': 'San Francisco 49ers',
  'niners': 'San Francisco 49ers',
  'seahawks': 'Seattle Seahawks',
  'commanders': 'Washington Commanders',
  'redskins': 'Washington Commanders',
  // MLB
  'yankees': 'New York Yankees',
  'mets': 'New York Mets',
  'astros': 'Houston Astros',
  // 'rangers' is AMBIGUOUS - must specify: 'texas rangers' for MLB, 'ny rangers'/'nyr' for NHL
  'texas rangers': 'Texas Rangers',
  'dodgers': 'Los Angeles Dodgers',
  'red sox': 'Boston Red Sox',
  'cubs': 'Chicago Cubs',
  'white sox': 'Chicago White Sox',
  'braves': 'Atlanta Braves',
  'phillies': 'Philadelphia Phillies',
  'marlins': 'Miami Marlins',
  'nationals': 'Washington Nationals',
  'reds': 'Cincinnati Reds',
  'pirates': 'Pittsburgh Pirates',
  'brewers': 'Milwaukee Brewers',
  'padres': 'San Diego Padres',
  'rockies': 'Colorado Rockies',
  'd-backs': 'Arizona Diamondbacks',
  'diamondbacks': 'Arizona Diamondbacks',
  'mariners': 'Seattle Mariners',
  'athletics': 'Oakland Athletics',
  'angels': 'Los Angeles Angels',
  'twins': 'Minnesota Twins',
  'royals': 'Kansas City Royals',
  'tigers': 'Detroit Tigers',
  'guardians': 'Cleveland Guardians',
  'orioles': 'Baltimore Orioles',
  'blue jays': 'Toronto Blue Jays',
  'rays': 'Tampa Bay Rays',
  // 'cardinals' is AMBIGUOUS - must specify: 'arizona cardinals'/'nfl cardinals' for NFL, 'st louis cardinals'/'stl cardinals'/'mlb cardinals' for MLB
  'stl cardinals': 'St. Louis Cardinals',
  'st louis cardinals': 'St. Louis Cardinals',
  'mlb cardinals': 'St. Louis Cardinals',
  // 'giants' is AMBIGUOUS - must specify: 'ny giants'/'nfl giants' for NFL, 'sf giants'/'san francisco giants'/'mlb giants' for MLB
  'sf giants': 'San Francisco Giants',
  'san francisco giants': 'San Francisco Giants',
  'mlb giants': 'San Francisco Giants',
  // NHL
  'ny rangers': 'New York Rangers',
  'nyr': 'New York Rangers',
  'islanders': 'New York Islanders',
  'devils': 'New Jersey Devils',
  'bruins': 'Boston Bruins',
  'stars': 'Dallas Stars',
  'blackhawks': 'Chicago Blackhawks',
  'red wings': 'Detroit Red Wings',
  'penguins': 'Pittsburgh Penguins',
  'flyers': 'Philadelphia Flyers',
  'capitals': 'Washington Capitals',
  'caps': 'Washington Capitals',
  'lightning': 'Tampa Bay Lightning',
  'avalanche': 'Colorado Avalanche',
  'avs': 'Colorado Avalanche',
  'blues': 'St. Louis Blues',
  'wild': 'Minnesota Wild',
  'predators': 'Nashville Predators',
  'preds': 'Nashville Predators',
  'winnipeg jets': 'Winnipeg Jets',
  'nhl jets': 'Winnipeg Jets',
  'flames': 'Calgary Flames',
  'oilers': 'Edmonton Oilers',
  'canucks': 'Vancouver Canucks',
  'kraken': 'Seattle Kraken',
  'golden knights': 'Vegas Golden Knights',
  'ducks': 'Anaheim Ducks',
  'sharks': 'San Jose Sharks',
  // 'kings' is AMBIGUOUS - must specify: 'sacramento kings'/'nba kings' for NBA, 'la kings'/'nhl kings' for NHL
  'la kings': 'Los Angeles Kings',
  'nhl kings': 'Los Angeles Kings',
  'coyotes': 'Arizona Coyotes',
  'hurricanes': 'Carolina Hurricanes',
  'canes': 'Carolina Hurricanes',
  'blue jackets': 'Columbus Blue Jackets',
  'sabres': 'Buffalo Sabres',
  'senators': 'Ottawa Senators',
  'sens': 'Ottawa Senators',
  'canadiens': 'Montreal Canadiens',
  'habs': 'Montreal Canadiens',
  'maple leafs': 'Toronto Maple Leafs',
  'leafs': 'Toronto Maple Leafs',
  'florida panthers': 'Florida Panthers',
  'nhl panthers': 'Florida Panthers',
};

// Teams with ambiguous names that could refer to multiple sports leagues
const AMBIGUOUS_TEAMS: Record<string, { options: string[]; hint: string }> = {
  'jets': {
    options: ['New York Jets (NFL)', 'Winnipeg Jets (NHL)'],
    hint: 'Try: `ny jets` or `nfl jets` for NFL, `winnipeg jets` or `nhl jets` for NHL',
  },
  'panthers': {
    options: ['Carolina Panthers (NFL)', 'Florida Panthers (NHL)'],
    hint: 'Try: `carolina panthers` or `nfl panthers` for NFL, `florida panthers` or `nhl panthers` for NHL',
  },
  'rangers': {
    options: ['Texas Rangers (MLB)', 'New York Rangers (NHL)'],
    hint: 'Try: `texas rangers` for MLB, `ny rangers` or `nyr` for NHL',
  },
  'giants': {
    options: ['New York Giants (NFL)', 'San Francisco Giants (MLB)'],
    hint: 'Try: `ny giants` for NFL, `sf giants` or `san francisco giants` for MLB',
  },
  'cardinals': {
    options: ['Arizona Cardinals (NFL)', 'St. Louis Cardinals (MLB)'],
    hint: 'Try: `arizona cardinals` for NFL, `st louis cardinals` or `stl cardinals` for MLB',
  },
  'kings': {
    options: ['Sacramento Kings (NBA)', 'Los Angeles Kings (NHL)'],
    hint: 'Try: `sacramento kings` for NBA, `la kings` for NHL',
  },
};

/**
 * Check if a team name is ambiguous and needs clarification
 */
function isAmbiguousTeam(teamName: string): { options: string[]; hint: string } | null {
  const lower = teamName.toLowerCase().trim();
  return AMBIGUOUS_TEAMS[lower] || null;
}

function expandTeamName(shortName: string): string {
  const lower = shortName.toLowerCase().trim();
  return TEAM_NAME_EXPANSIONS[lower] || shortName;
}

/**
 * Calculate due date for issue call:
 * - If before 4 PM EST → today
 * - If 4 PM EST or later → tomorrow
 */
function getIssueCallDueDate(): string {
  const now = new Date();
  const estFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    hour12: false,
  });
  const estHour = parseInt(estFormatter.format(now), 10);

  const dueDate = new Date(now);
  if (estHour >= 16) {
    // 4 PM or later → tomorrow
    dueDate.setDate(dueDate.getDate() + 1);
  }

  // Format as YYYY-MM-DD
  return dueDate.toISOString().split('T')[0];
}

/**
 * /issuecall slash command handler
 * Creates an Issue Call task with account lookup from Google Sheets
 *
 * Usage: /issuecall [team] [email]
 * Example: /issuecall astros john@example.com
 *
 * - Owners: Dayna + Ruzzell Garcia
 * - Due: Today (or tomorrow if after 4 PM EST)
 * - Posts to issue call channel with account info
 * - Monitors thread for first 👀 or reply → assigns as supporter
 * - Pings @closers hourly until claimed
 */
app.post('/webhook/slack/issuecall', slackUrlEncodedWithRawBody, async (req: Request & { rawBody?: string }, res: Response): Promise<void> => {
  // Verify Slack signature (QW-07)
  if (!verifySlackSignature(req)) {
    res.status(401).send('Invalid signature');
    return;
  }

  try {
    const { text, user_id, response_url } = req.body as {
      text: string;
      user_id: string;
      response_url: string;
    };

    console.log(`/issuecall command received from ${user_id}: ${text}`);

    // Check if issue call channel is configured
    const issueCallChannelId = configCompat.slack.issueCallChannelId;
    if (!issueCallChannelId) {
      res.json({
        response_type: 'ephemeral',
        text: `:x: Issue Call channel not configured. Please set SLACK_ISSUE_CALL_CHANNEL_ID.`,
      });
      return;
    }

    // Handle help or empty input
    const trimmedText = text.trim();
    if (!trimmedText || trimmedText.toLowerCase() === 'help') {
      res.json({
        response_type: 'ephemeral',
        text: `*Issue Call - AI-Powered Task with Account Lookup*\n\n` +
          `Describe the issue call naturally. I'll extract the team and email.\n\n` +
          `*Examples:*\n` +
          `• \`/issuecall astros john@example.com\`\n` +
          `• \`/issuecall issue call for houston astros customer jane@gmail.com\`\n` +
          `• \`/issuecall rockets account holder bob@email.com @jamie\`\n` +
          `• \`/issuecall texans fan@gmail.com with Sarah's help\`\n\n` +
          `_Mention someone to suggest them as supporter. They'll be pinged first._`,
      });
      return;
    }

    // Acknowledge immediately
    res.json({
      response_type: 'ephemeral',
      text: `⏳ Analyzing issue call request...`,
    });

    // Use AI to parse the input
    const parseResult = await parseIssueCallInputSafe(trimmedText);

    if (!parseResult || !parseResult.emails || parseResult.emails.length === 0) {
      await slack.sendResponseUrl(response_url,
        `:x: Could not find an email address in your request.\n\n` +
        `Please include the account holder's email.\n\n` +
        `Example: \`/issuecall astros john@example.com\``
      );
      return;
    }

    if (!parseResult.team) {
      await slack.sendResponseUrl(response_url,
        `:x: Could not identify the team.\n\n` +
        `Please include the team name (e.g., Astros, Rockets, Texans).\n\n` +
        `Example: \`/issuecall astros john@example.com\``
      );
      return;
    }

    const emails = parseResult.emails;
    const teamName = parseResult.team;

    // Check if team name is ambiguous (could refer to multiple leagues)
    const ambiguity = isAmbiguousTeam(teamName);
    if (ambiguity) {
      await slack.sendResponseUrl(response_url,
        `:question: *Which team did you mean?*\n\n` +
        `"${teamName}" could refer to:\n` +
        ambiguity.options.map(opt => `• ${opt}`).join('\n') + '\n\n' +
        `${ambiguity.hint}`
      );
      return;
    }

    // Expand team name to full official name
    const fullTeamName = expandTeamName(teamName);

    // Check for @mention in the original text (Slack IDs) and resolve to user
    let supporterUser: Awaited<ReturnType<typeof findUserBySlackId>> | null = null;
    const mentionPattern = /<@([A-Z0-9]+)>/;
    const mentionMatch = trimmedText.match(mentionPattern);
    if (mentionMatch) {
      supporterUser = await findUserBySlackId(mentionMatch[1]);
    } else if (parseResult.suggestedSupporter) {
      // AI found a supporter name, try to resolve
      supporterUser = await findUserByName(parseResult.suggestedSupporter);
    }

    console.log(`Issue call parsed: team=${fullTeamName}, emails=${emails.join(', ')}, supporter=${supporterUser?.name || 'none'}`);

    // Look up all accounts
    const accountResults = await Promise.all(
      emails.map(email => lookupAccountForIssueCall(teamName, email))
    );

    // Check if team name is ambiguous (matches multiple sports)
    const ambiguousResult = accountResults.find(r => r.isAmbiguous);
    if (ambiguousResult && ambiguousResult.ambiguousMatches) {
      const options = ambiguousResult.ambiguousMatches
        .map(m => `• *${m.sport.toUpperCase()}*: ${m.teamKey}`)
        .join('\n');

      await slack.sendResponseUrl(response_url,
        `:question: *Which team did you mean?*\n\n` +
        `"${teamName}" matches teams in multiple leagues:\n${options}\n\n` +
        `Please be more specific, e.g.:\n` +
        ambiguousResult.ambiguousMatches
          .map(m => `• \`/issuecall ${m.teamKey} ${emails[0]}\``)
          .join('\n')
      );
      return;
    }

    // Use the first successful account for naming, or first email if none found
    const primaryAccount = accountResults.find(r => r.success) || accountResults[0];

    // Look up owners: Dayna + Ruzzell Garcia
    const dayna = await findUserByName('Dayna');
    const ruzzell = await findUserByName('Ruzzell Garcia');

    if (!dayna) {
      await slack.sendResponseUrl(response_url,
        `:x: Could not find Dayna in the user directory. Please contact an admin.`
      );
      return;
    }

    if (!ruzzell) {
      await slack.sendResponseUrl(response_url,
        `:x: Could not find Ruzzell Garcia in the user directory. Please contact an admin.`
      );
      return;
    }

    // Calculate due date
    const dueDate = getIssueCallDueDate();

    // Generate run ID for tracking
    const runId = randomUUID();

    // Get issue description from parsed input
    const issueDescription = parseResult.issueDescription;

    // Create Monday item
    const displayTeam = primaryAccount.team ? expandTeamName(primaryAccount.team) : fullTeamName;
    const accountName = primaryAccount.success ? primaryAccount.name || emails[0] : emails[0];

    // Clean item name - just account and issue description
    // Team and Type columns already store this info, no need to duplicate in name
    const taskName = issueDescription
      ? `${accountName} - ${issueDescription}`
      : accountName;

    // If supporter was mentioned, assign them directly
    const supportIds = supporterUser ? [String(supporterUser.mondayId)] : [];

    const mondayItem = await monday.createItem({
      name: taskName,
      dueDate,
      ownerIds: [dayna.mondayId, ruzzell.mondayId],
      supportIds,
      taskType: 'Issue Call',
      source: 'Slack Tasks',
      urgency: 'High',
      team: displayTeam,
    });

    console.log(`Created Monday item ${mondayItem.id} for issue call`);

    // Store run ID
    await monday.storeRunId(mondayItem.id, runId);

    // Create initial update with account info
    // Include (via Slack) marker to prevent sync loop back to Slack
    const creator = await findUserBySlackId(user_id);
    const creatorName = creator?.name ?? 'Unknown';

    let updateHtml = `<p><strong>Issue Call Task</strong> <em>(via Slack)</em></p>` +
      `<p>Created by: ${creatorName}</p>`;

    // Add ACTION REQUIRED prominently at the top
    if (parseResult.actionRequired) {
      updateHtml += `<p><strong>🎯 ACTION REQUIRED:</strong> ${parseResult.actionRequired}</p>`;
    }

    // Add issue description if provided
    if (issueDescription) {
      updateHtml += `<p><strong>Issue:</strong> ${issueDescription}</p>`;
    }

    // Add notes if provided (full context from user input)
    if (parseResult.notes) {
      updateHtml += `<p><strong>Context:</strong> ${parseResult.notes}</p>`;
    }

    // Add Slack thread link if provided
    if (parseResult.slackThreadLink) {
      updateHtml += `<p><strong>Related Thread:</strong> <a href="${parseResult.slackThreadLink}">${parseResult.slackThreadLink}</a></p>`;
    }

    // Add account info for all emails
    for (let i = 0; i < accountResults.length; i++) {
      const result = accountResults[i];
      const email = emails[i];
      const accountLabel = accountResults.length > 1 ? ` #${i + 1}` : '';

      if (result.success) {
        updateHtml += `<p><strong>Account Info${accountLabel}:</strong></p>` +
          `<p>Name: ${result.name || 'N/A'}</p>` +
          `<p>Email: ${result.email}</p>` +
          `<p>Phone: ${result.phone || 'N/A'}</p>` +
          `<p>Seats: ${result.seats || 'N/A'}</p>` +
          `<p>Address: ${result.address || 'N/A'}</p>` +
          `<p>Card: ${result.cardInfo || 'N/A'}</p>`;
      } else {
        updateHtml += `<p><em>Account${accountLabel} lookup failed (${email}): ${result.error}</em></p>`;
      }
    }

    await monday.createUpdate(mondayItem.id, updateHtml);

    // Build Slack message
    const mondayUrl = monday.getItemUrl(mondayItem.id);

    // Format all account infos for Slack
    const accountInfoParts: string[] = [];
    for (let i = 0; i < accountResults.length; i++) {
      const result = accountResults[i];
      const email = emails[i];
      const accountLabel = accountResults.length > 1 ? `*Account #${i + 1}:*\n` : '';

      if (result.success) {
        accountInfoParts.push(accountLabel + formatIssueCallAccount(result));
      } else {
        accountInfoParts.push(accountLabel + `⚠️ Account lookup failed (${email}): ${result.error}`);
      }
    }
    const accountInfo = accountInfoParts.join('\n\n');

    // Build Block Kit message for issue call
    const issueCallBlocks: any[] = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `📞 Issue Call${issueDescription ? `: ${issueDescription}` : ''}`,
          emoji: true,
        },
      },
    ];

    // Build compact context lines (action required, notes, thread link)
    const contextLines: string[] = [];
    if (parseResult.actionRequired) {
      contextLines.push(`🎯 *ACTION REQUIRED:* ${parseResult.actionRequired}`);
    }
    if (parseResult.notes) {
      contextLines.push(`\n*Context:* ${parseResult.notes}\n`);
    }
    if (parseResult.slackThreadLink) {
      contextLines.push(`*Related Thread:* ${parseResult.slackThreadLink}`);
    }

    // Compact assignment line: Due · Owners · Supporter
    const supporterPart = supporterUser?.slackId
      ? `*Supporter:* <@${supporterUser.slackId}>`
      : `⏳ _Waiting for supporter_ — React 👀 or reply to claim`;
    contextLines.push(`*Due:* ${dueDate}  ·  *Owners:* <@${dayna.slackId}> & <@${ruzzell.slackId}>  ·  ${supporterPart}`);

    // Single section for all context + assignment info
    if (contextLines.length > 0) {
      issueCallBlocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: contextLines.join('\n'),
        },
      });
    }

    // Account info stays its own section (can be long)
    issueCallBlocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: accountInfo,
      },
    });

    // Status buttons + View in Monday in one actions row
    issueCallBlocks.push({
      type: 'actions',
      block_id: `issue_call_${mondayItem.id}_status`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '🟡 Working on it', emoji: true },
          action_id: 'issue_call_working',
          value: mondayItem.id,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '✅ Done', emoji: true },
          style: 'primary',
          action_id: 'issue_call_complete',
          value: mondayItem.id,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '🔴 Stuck', emoji: true },
          style: 'danger',
          action_id: 'issue_call_stuck',
          value: mondayItem.id,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'View in Monday', emoji: true },
          url: mondayUrl,
          action_id: 'view_monday',
        },
      ],
    });

    const slackMessage = await slack.getClient().chat.postMessage({
      channel: issueCallChannelId,
      blocks: issueCallBlocks,
      text: `📞 Issue Call${issueDescription ? `: ${issueDescription}` : ''}`, // Fallback
    });

    if (!slackMessage.ts) {
      throw new Error('Failed to post to issue call channel');
    }

    // Store Slack thread ID on Monday item for syncing
    // Pass the issue call channel ID so syncs go to the right channel
    await monday.updateSlackThreadId(mondayItem.id, slackMessage.ts, issueCallChannelId);

    console.log(`Posted issue call to channel ${issueCallChannelId}, thread ${slackMessage.ts}`);

    // Send confirmation via response_url
    const slackThreadUrl = `https://slack.com/archives/${issueCallChannelId}/p${slackMessage.ts.replace('.', '')}`;
    const emailDisplay = emails.length === 1 ? emails[0] : emails.join(', ');
    await slack.sendResponseUrl(response_url,
      `✅ *Issue Call Created*\n\n` +
      `• *Team:* ${displayTeam}\n` +
      `• *Email${emails.length > 1 ? 's' : ''}:* ${emailDisplay}\n` +
      `• *Due:* ${dueDate}\n` +
      `${supporterUser ? `• *Supporter:* ${supporterUser.name}\n` : ''}` +
      `• *Monday:* <${mondayUrl}|View Item>\n` +
      `• *Slack Thread:* <${slackThreadUrl}|View Thread>\n` +
      `• *Run ID:* \`${runId.substring(0, 8)}\``
    );
  } catch (error) {
    console.error('/issuecall command error:', error);
    res.json({
      response_type: 'ephemeral',
      text: `:x: Error creating issue call: ${error instanceof Error ? error.message : 'Unknown error'}`,
    });
  }
});

// ============================================================================
// Slack /analyze Command - Analyze and cleanup existing Monday items
// ============================================================================

/**
 * /analyze slash command handler
 *
 * Analyzes existing Monday items to detect teams and suggest name improvements.
 * Usage: /analyze [preview|apply]
 * - preview (default): Show suggested changes without applying
 * - apply: Apply all suggested changes
 */
app.post('/webhook/slack/analyze', slackUrlEncodedWithRawBody, async (req: Request & { rawBody?: string }, res: Response): Promise<void> => {
  const { text, response_url, user_id } = req.body;
  const mode = (text || '').trim().toLowerCase() || 'preview';

  // Acknowledge immediately
  res.json({
    response_type: 'ephemeral',
    text: `🔍 Analyzing Monday items (mode: ${mode})...`,
  });

  try {
    console.log(`/analyze command received from ${user_id}: mode=${mode}`);

    // Import the analyze function
    const { analyzeItemName } = await import('./services/claude.js');

    // Get all non-done items
    const items = await monday.getItemsForBackfill('all');
    console.log(`Found ${items.length} non-done items to analyze`);

    // Filter items that might need team detection
    // Skip items that already have [Team] prefix
    const itemsToAnalyze = items.filter(item => !item.name.startsWith('['));
    console.log(`${itemsToAnalyze.length} items need analysis (no [Team] prefix)`);

    if (itemsToAnalyze.length === 0) {
      await slack.sendResponseUrl(response_url,
        `✅ All items already have [Team] prefix or are complete.\n\nNo changes needed.`
      );
      return;
    }

    // Analyze items (limit to first 20 to avoid timeout)
    const maxItems = 20;
    const itemsToProcess = itemsToAnalyze.slice(0, maxItems);
    const suggestions: Array<{
      id: string;
      currentName: string;
      suggestedName: string | null;
      detectedTeam: string | null;
      confidence: number;
    }> = [];

    for (const item of itemsToProcess) {
      const analysis = await analyzeItemName(item.name, item.taskType);
      if (analysis.suggestedName && analysis.confidence >= 0.7) {
        suggestions.push({
          id: item.id,
          currentName: item.name,
          suggestedName: analysis.suggestedName,
          detectedTeam: analysis.detectedTeam,
          confidence: analysis.confidence,
        });
      }
    }

    if (suggestions.length === 0) {
      await slack.sendResponseUrl(response_url,
        `✅ Analyzed ${itemsToProcess.length} items.\n\nNo team mentions detected with high confidence.` +
        (itemsToAnalyze.length > maxItems ? `\n\n_Note: Only analyzed first ${maxItems} items. ${itemsToAnalyze.length - maxItems} more items pending._` : '')
      );
      return;
    }

    if (mode === 'apply') {
      // Apply changes
      let applied = 0;
      for (const suggestion of suggestions) {
        try {
          // Update name
          if (suggestion.suggestedName) {
            await monday.updateItemName(suggestion.id, suggestion.suggestedName);
          }
          // Update team column if detected
          if (suggestion.detectedTeam) {
            await monday.updateTeam(suggestion.id, suggestion.detectedTeam);
          }
          applied++;
        } catch (err) {
          console.error(`Failed to update item ${suggestion.id}:`, err);
        }
      }

      await slack.sendResponseUrl(response_url,
        `✅ *Applied ${applied} changes:*\n\n` +
        suggestions.map(s => `• \`${s.currentName}\`\n  → \`${s.suggestedName}\``).join('\n\n') +
        (itemsToAnalyze.length > maxItems ? `\n\n_Note: Only processed first ${maxItems} items. Run again to process more._` : '')
      );
    } else {
      // Preview mode - just show suggestions
      await slack.sendResponseUrl(response_url,
        `🔍 *Found ${suggestions.length} suggested changes:*\n\n` +
        suggestions.map(s =>
          `• \`${s.currentName}\`\n  → \`${s.suggestedName}\` _(${s.detectedTeam}, ${Math.round(s.confidence * 100)}% confidence)_`
        ).join('\n\n') +
        `\n\n_Use \`/analyze apply\` to apply these changes._` +
        (itemsToAnalyze.length > maxItems ? `\n\n_Note: Only analyzed first ${maxItems} items. ${itemsToAnalyze.length - maxItems} more items pending._` : '')
      );
    }
  } catch (error) {
    console.error('/analyze command error:', error);
    await slack.sendResponseUrl(response_url,
      `:x: Error analyzing items: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
});

// ============================================================================
// Slack /rename-issuecalls Command - Clean up verbose issue call names
// ============================================================================

/**
 * /rename-issuecalls slash command handler
 *
 * Renames issue call items from verbose format to clean format.
 * Old: "[Team] Issue Call: Account Name - Description"
 * New: "Account Name - Description"
 *
 * Usage: /rename-issuecalls [preview|apply]
 * - /rename-issuecalls preview - Show what would be renamed (default)
 * - /rename-issuecalls apply - Actually rename the items
 */
app.post('/webhook/slack/rename-issuecalls', slackUrlEncodedWithRawBody, async (req: Request & { rawBody?: string }, res: Response): Promise<void> => {
  if (!verifySlackSignature(req)) {
    res.status(401).send('Invalid signature');
    return;
  }

  const { text, response_url, user_id } = req.body;
  const mode = (text || '').trim().toLowerCase() || 'preview';

  // Acknowledge immediately
  res.json({
    response_type: 'ephemeral',
    text: `🔄 Scanning issue call items (mode: ${mode})...`,
  });

  try {
    console.log(`/rename-issuecalls command received from ${user_id}: mode=${mode}`);

    const items = await monday.getIssueCallItems();

    if (items.length === 0) {
      await slack.sendResponseUrl(response_url,
        `:information_source: No issue call items found.`
      );
      return;
    }

    // Parse old format and generate new names
    // Old formats:
    // "[Team] Issue Call: Account Name - Description"
    // "[Team] Issue Call: Account Name"
    // "Issue Call: Account Name - Description"
    // "Issue Call: Account Name"
    const renamePattern = /^(?:\[.+?\]\s*)?Issue Call:\s*(.+)$/i;

    const toRename: Array<{ id: string; oldName: string; newName: string }> = [];

    for (const item of items) {
      const match = item.name.match(renamePattern);
      if (match) {
        const newName = match[1].trim();
        if (newName !== item.name) {
          toRename.push({
            id: item.id,
            oldName: item.name,
            newName,
          });
        }
      }
    }

    if (toRename.length === 0) {
      await slack.sendResponseUrl(response_url,
        `✅ *No items need renaming*\n\nAll ${items.length} issue call items already have clean names.`
      );
      return;
    }

    if (mode === 'preview') {
      // Preview mode - show what would be renamed
      const previewLines = toRename.slice(0, 20).map(item =>
        `• \`${item.oldName}\`\n   → \`${item.newName}\``
      );

      const moreText = toRename.length > 20 ? `\n\n...and ${toRename.length - 20} more` : '';

      await slack.sendResponseUrl(response_url,
        `📋 *Preview: ${toRename.length} items to rename*\n\n` +
        previewLines.join('\n\n') +
        moreText +
        `\n\n_Run \`/rename-issuecalls apply\` to apply these changes._`
      );
    } else if (mode === 'apply') {
      // Apply mode - actually rename the items
      let renamed = 0;
      const errors: string[] = [];

      for (const item of toRename) {
        try {
          await monday.updateItemName(item.id, item.newName);
          renamed++;

          // Rate limit - small delay between updates
          await new Promise(resolve => setTimeout(resolve, 300));
        } catch (error) {
          console.error(`Failed to rename item ${item.id}:`, error);
          errors.push(`• ${item.id}: ${error instanceof Error ? error.message : 'Unknown'}`);
        }
      }

      const errorText = errors.length > 0 ? `\n\n*Errors:*\n${errors.join('\n')}` : '';

      await slack.sendResponseUrl(response_url,
        `✅ *Renamed ${renamed} of ${toRename.length} items*` + errorText
      );
    } else {
      await slack.sendResponseUrl(response_url,
        `:x: Unknown mode: ${mode}\n\nUsage: \`/rename-issuecalls preview\` or \`/rename-issuecalls apply\``
      );
    }
  } catch (error) {
    console.error('/rename-issuecalls error:', error);
    await slack.sendResponseUrl(response_url,
      `:x: Error: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
});

// ============================================================================
// Slack /trigger-followups Command - DISABLED (replaced by digest system)
// ============================================================================
// Use /admin/digest/escalations instead for manual triggering

// ============================================================================
// Admin Test Endpoints
// ============================================================================

/**
 * Test endpoint for Phase 2 button testing
 * Posts a message with all 4 task buttons to the specified user's DM
 *
 * Usage: POST /admin/test/buttons/:mondayItemId?userId=U0144K906KA
 */
app.post('/admin/test/buttons/:mondayItemId', express.json(), async (req: Request, res: Response): Promise<void> => {
  const { mondayItemId } = req.params;
  const testUserId = req.query.userId as string;

  if (!testUserId) {
    res.status(400).json({ error: 'Missing required query parameter: userId' });
    return;
  }

  try {
    // Optionally fetch task name from Monday
    let taskName = `Test Task (${mondayItemId})`;
    try {
      const item = await monday.getItem(mondayItemId);
      if (item) {
        taskName = item.name;
      }
    } catch {
      // Use default name if fetch fails
    }

    const client = slack.getClient();

    const result = await client.chat.postMessage({
      channel: testUserId,
      text: `Button test for task ${mondayItemId}`,
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: '🧪 Button Test',
            emoji: true,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Task:* ${taskName}\n*Monday ID:* \`${mondayItemId}\`\n*URL:* <${configCompat.monday.boardUrl}/pulses/${mondayItemId}|View in Monday>`,
          },
        },
        {
          type: 'divider',
        },
        {
          type: 'actions',
          block_id: `test_task_${mondayItemId}_controls`,
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: '👀 Acknowledge', emoji: true },
              action_id: 'task_acknowledge',
              value: mondayItemId,
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: '🟡 Working', emoji: true },
              action_id: 'task_working',
              value: mondayItemId,
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: '✅ Complete', emoji: true },
              style: 'primary',
              action_id: 'task_complete',
              value: mondayItemId,
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: '🔴 Stuck', emoji: true },
              style: 'danger',
              action_id: 'task_stuck',
              value: mondayItemId,
            },
          ],
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: '_Click any button to test interactivity. Check server logs for `[Interactivity]` entries._',
            },
          ],
        },
      ],
    });

    res.json({
      success: true,
      message: `Test message sent to <@${testUserId}>`,
      ts: result.ts,
      mondayItemId,
    });

    console.log(`[Test] Button test message sent for item ${mondayItemId}`);
  } catch (error) {
    console.error('[Test] Failed to send button test:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Migration endpoint: Add buttons to existing task threads
 * Safe to re-run (skips threads that already have buttons)
 *
 * Usage: POST /admin/migrate/thread-buttons
 */
app.post('/admin/migrate/thread-buttons', express.json(), async (_req: Request, res: Response): Promise<void> => {
  try {
    const { runMigration } = await import('./scripts/migrateThreadButtons.js');
    const result = await runMigration();
    res.json(result);
  } catch (error) {
    console.error('[Migration] Failed:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Migration endpoint: Add buttons to existing issue call messages
 * Safe to re-run (skips messages that already have buttons)
 * Also auto-marks status based on reactions (✅=Done, 🔴=Stuck, 🟡=Working)
 *
 * Usage: GET or POST /admin/migrate/issue-call-buttons
 */
app.all('/admin/migrate/issue-call-buttons', express.json(), async (_req: Request, res: Response): Promise<void> => {
  try {
    const { runIssueCallButtonMigration } = await import('./scripts/migrateIssueCallButtons.js');
    const result = await runIssueCallButtonMigration();
    res.json(result);
  } catch (error) {
    console.error('[Issue Call Button Migration] Failed:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Migration endpoint: Move "View in Monday" button from section accessory to bottom actions block
 *
 * Usage: POST /admin/migrate/view-button-position
 */
app.post('/admin/migrate/view-button-position', express.json(), async (_req: Request, res: Response): Promise<void> => {
  try {
    const { runMigration } = await import('./scripts/migrateViewButtonPosition.js');
    const result = await runMigration();
    res.json(result);
  } catch (error) {
    console.error('[View Button Migration] Failed:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Migration endpoint: Convert old verbose messages to new compact format
 *
 * Usage: POST /admin/migrate/compact-format
 */
app.post('/admin/migrate/compact-format', express.json(), async (_req: Request, res: Response): Promise<void> => {
  try {
    const { runMigration } = await import('./scripts/migrateCompactFormat.js');
    const result = await runMigration();
    res.json(result);
  } catch (error) {
    console.error('[Compact Format Migration] Failed:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ============================================================================
// Digest System Manual Triggers
// ============================================================================

import * as digestScheduler from './services/digestScheduler.js';

/**
 * Get digest scheduler status
 * Usage: GET /admin/digest/status
 */
app.get('/admin/digest/status', (_req: Request, res: Response): void => {
  const status = digestScheduler.getSchedulerStatus();
  res.json(status);
});

/**
 * Manually trigger morning digests for all users
 * Usage: POST /admin/digest/morning
 */
app.post('/admin/digest/morning', express.json(), async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await digestScheduler.triggerMorningDigests();
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('[DigestTrigger] Morning digest failed:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Manually trigger personal digest for a specific user
 * Usage: POST /admin/digest/personal/:slackUserId
 */
app.post('/admin/digest/personal/:slackUserId', express.json(), async (req: Request, res: Response): Promise<void> => {
  const { slackUserId } = req.params;

  try {
    const result = await digestScheduler.triggerPersonalDigest(slackUserId);
    res.json({ ...result, slackUserId });
  } catch (error) {
    console.error(`[DigestTrigger] Personal digest for ${slackUserId} failed:`, error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Manually trigger issue call digest
 * Usage: POST /admin/digest/issue-calls
 */
app.post('/admin/digest/issue-calls', express.json(), async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await digestScheduler.triggerIssueCallDigest();
    res.json(result);
  } catch (error) {
    console.error('[DigestTrigger] Issue call digest failed:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Manually trigger team overview
 * Usage: POST /admin/digest/team-overview
 */
app.post('/admin/digest/team-overview', express.json(), async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await digestScheduler.triggerTeamOverview();
    res.json(result);
  } catch (error) {
    console.error('[DigestTrigger] Team overview failed:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Manually trigger tomorrow prep for all users
 * Usage: POST /admin/digest/tomorrow-prep
 */
app.post('/admin/digest/tomorrow-prep', express.json(), async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await digestScheduler.triggerTomorrowPrep();
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('[DigestTrigger] Tomorrow prep failed:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Manually trigger issue call EOD
 * Usage: POST /admin/digest/issue-call-eod
 */
app.post('/admin/digest/issue-call-eod', express.json(), async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await digestScheduler.triggerIssueCallEOD();
    res.json(result);
  } catch (error) {
    console.error('[DigestTrigger] Issue call EOD failed:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Manually trigger escalation checks
 * Usage: POST /admin/digest/escalations
 */
app.post('/admin/digest/escalations', express.json(), async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await digestScheduler.triggerEscalationCheck();
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('[DigestTrigger] Escalation check failed:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Reset today's digest tracking (for testing)
 * Usage: POST /admin/digest/reset
 */
app.post('/admin/digest/reset', express.json(), (_req: Request, res: Response): void => {
  try {
    digestScheduler.resetTodayTracking();
    res.json({ success: true, message: 'Digest tracking reset' });
  } catch (error) {
    console.error('[DigestTrigger] Reset failed:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ============================================================================
// Daily Supervisor & Executive Reports (6 PM EST)
// ============================================================================

/**
 * Manually trigger all daily reports (Garet, Ruzzell, Executive)
 * Usage: POST /admin/report/all
 */
app.post('/admin/report/all', express.json(), async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await digestScheduler.triggerDailyReports();
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('[ReportTrigger] All reports failed:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Manually trigger executive report (Edward)
 * Usage: POST /admin/report/executive
 */
app.post('/admin/report/executive', express.json(), async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await digestScheduler.triggerExecutiveReport();
    res.json(result);
  } catch (error) {
    console.error('[ReportTrigger] Executive report failed:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Manually trigger Garet's supervisor report (non-issue call tasks)
 * Usage: POST /admin/report/supervisor/garet
 */
app.post('/admin/report/supervisor/garet', express.json(), async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await digestScheduler.triggerGaretReport();
    res.json(result);
  } catch (error) {
    console.error('[ReportTrigger] Garet report failed:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Manually trigger Ruzzell's supervisor report (issue calls only)
 * Usage: POST /admin/report/supervisor/ruzzell
 */
app.post('/admin/report/supervisor/ruzzell', express.json(), async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await digestScheduler.triggerRuzzellReport();
    res.json(result);
  } catch (error) {
    console.error('[ReportTrigger] Ruzzell report failed:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ============================================================================
// Error Handling
// ============================================================================

// Error handling middleware
app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled error:', error);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
  });
});

// Start the server
async function start() {
  // Load remote config from core-api first
  console.log('Loading config from core-api...');
  await initRemoteConfig();

  validateConfig();

  // Log sheets configuration for debugging
  logSheetsConfiguration();

  // Initialize job queue and register processors
  initializeJobQueue();
  monday.registerMondayJobProcessors();
  console.log('Job queue initialized with processors');

  // Start idempotency key cleanup interval (cleans expired keys every 15 minutes)
  startIdempotencyCleanup();

  app.listen(config.port, () => {
    console.log(`Server listening on port ${config.port}`);
    console.log('');
    console.log('Endpoints:');
    console.log(`  Health:          http://localhost:${config.port}/health`);
    console.log(`  Email webhook:   http://localhost:${config.port}/webhook/email`);
    console.log(`  JSON webhook:    http://localhost:${config.port}/webhook/json`);
    console.log(`  Slack events:    http://localhost:${config.port}/webhook/slack/events`);
    console.log(`  Slack interactivity: http://localhost:${config.port}/webhook/slack/interactivity`);
    console.log(`  Slack /task:     http://localhost:${config.port}/webhook/slack/task`);
    console.log(`  Slack /taskdebug: http://localhost:${config.port}/webhook/slack/taskdebug`);
    console.log(`  Slack /issuecall: http://localhost:${config.port}/webhook/slack/issuecall`);
    console.log(`  Slack /analyze:  http://localhost:${config.port}/webhook/slack/analyze`);
    console.log(`  Monday webhook:  http://localhost:${config.port}/webhook/monday`);
    console.log(`  Relay events:    http://localhost:${config.port}/relay/events`);
    console.log('');

    // Start digest scheduler (Phase 4 - Digest Notification System)
    digestScheduler.startDigestScheduler();
    console.log('Digest scheduler started (morning digests, escalations, EOD)');
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

export { app };
