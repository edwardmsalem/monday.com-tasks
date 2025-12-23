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
import { config, validateConfig } from './config/environment.js';
import {
  executeAISlackTaskWorkflowSafe,
} from './workflow.js';
import * as monday from './services/monday.js';
import * as slack from './services/slack.js';
import { findUserByName, findUserBySlackId } from './services/userResolver.js';
import { startFollowUpScheduler } from './services/autoFollowUp.js';
import { startScheduler as startAfterHoursScheduler } from './services/afterHoursScheduler.js';
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

// Import middleware
import { requestLogger } from './middleware/index.js';

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
      const slackThreadUrl = `https://slack.com/app_redirect?channel=${config.slack.channelId}&message_ts=${result.slackThreadTs}`;

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

import { lookupAccountForIssueCall, formatIssueCallAccount } from './services/sheets.js';
import {
  registerIssueCall,
  CLOSERS_GROUP_ID,
} from './services/issueCallTracker.js';

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
    const issueCallChannelId = config.slack.issueCallChannelId;
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
        text: `*Issue Call - Create Task with Account Lookup*\n\n` +
          `Create an issue call task and look up account information.\n\n` +
          `*Usage:* \`/issuecall [team] [email] [@supporter]\`\n\n` +
          `*Examples:*\n` +
          `• \`/issuecall astros john@example.com\`\n` +
          `• \`/issuecall astros john@example.com @jamie\`\n` +
          `• \`/issuecall houston astros john@example.com\`\n\n` +
          `_Mention someone to suggest them as supporter. They'll be pinged first to confirm._`,
      });
      return;
    }

    // Parse team, email, and optional @mention from input
    const parts = trimmedText.split(/\s+/);
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const mentionPattern = /^<@([A-Z0-9]+)>$/;

    // Find the email in the parts
    const emailIndex = parts.findIndex(p => emailPattern.test(p));
    if (emailIndex === -1) {
      res.json({
        response_type: 'ephemeral',
        text: `:x: Please provide a valid email address.\n\nUsage: \`/issuecall [team] [email] [@supporter]\`\n\nExample: \`/issuecall astros john@example.com @jamie\``,
      });
      return;
    }

    const email = parts[emailIndex];
    const teamParts = parts.slice(0, emailIndex);

    // Check for @mention after email (suggested supporter)
    let suggestedSupporterSlackId: string | undefined;
    const afterEmail = parts.slice(emailIndex + 1);
    for (const part of afterEmail) {
      const mentionMatch = part.match(mentionPattern);
      if (mentionMatch) {
        suggestedSupporterSlackId = mentionMatch[1];
        break;
      }
    }

    if (teamParts.length === 0) {
      res.json({
        response_type: 'ephemeral',
        text: `:x: Please provide a team name.\n\nUsage: \`/issuecall [team] [email] [@supporter]\`\n\nExample: \`/issuecall astros john@example.com @jamie\``,
      });
      return;
    }

    const teamName = teamParts.join(' ');

    // Acknowledge immediately
    res.json({
      response_type: 'ephemeral',
      text: `⏳ Creating issue call for ${email} (${teamName})...`,
    });

    // Look up the account
    const accountResult = await lookupAccountForIssueCall(teamName, email);

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

    // Create Monday item
    const taskName = `Issue Call: ${accountResult.success ? accountResult.name || email : email} (${accountResult.team || teamName})`;
    const mondayItem = await monday.createItem({
      name: taskName,
      dueDate,
      ownerIds: [dayna.mondayId, ruzzell.mondayId],
      supportIds: [], // Will be assigned when someone claims
      taskType: 'Issue Call',
      source: 'Slack Tasks',
      urgency: 'High',
      team: accountResult.team || teamName,
    });

    console.log(`Created Monday item ${mondayItem.id} for issue call`);

    // Store run ID
    await monday.storeRunId(mondayItem.id, runId);

    // Create initial update with account info
    const creator = await findUserBySlackId(user_id);
    const creatorName = creator?.name ?? 'Unknown';

    let updateHtml = `<p><strong>Issue Call Task</strong></p>` +
      `<p>Created by: ${creatorName}</p>`;

    if (accountResult.success) {
      updateHtml += `<p><strong>Account Info:</strong></p>` +
        `<p>Name: ${accountResult.name || 'N/A'}</p>` +
        `<p>Email: ${accountResult.email}</p>` +
        `<p>Phone: ${accountResult.phone || 'N/A'}</p>` +
        `<p>Seats: ${accountResult.seats || 'N/A'}</p>` +
        `<p>Address: ${accountResult.address || 'N/A'}</p>` +
        `<p>Card: ${accountResult.cardInfo || 'N/A'}</p>`;
    } else {
      updateHtml += `<p><em>Account lookup failed: ${accountResult.error}</em></p>`;
    }

    await monday.createUpdate(mondayItem.id, updateHtml);

    // Build Slack message
    const mondayUrl = monday.getItemUrl(mondayItem.id);
    const accountInfo = accountResult.success
      ? formatIssueCallAccount(accountResult)
      : `⚠️ Account lookup failed: ${accountResult.error}`;

    // Include suggested supporter mention if provided
    const supporterLine = suggestedSupporterSlackId
      ? `*Suggested Supporter:* <@${suggestedSupporterSlackId}> - please confirm by reacting 👀\n`
      : '';

    const slackMessage = await slack.getClient().chat.postMessage({
      channel: issueCallChannelId,
      text: `📞 *Issue Call*\n\n` +
        `${accountInfo}\n\n` +
        `*Due:* ${dueDate}\n` +
        `*Owners:* <@${dayna.slackId}> & <@${ruzzell.slackId}>\n` +
        `${supporterLine}\n` +
        `⏳ *Waiting for supporter* - React with 👀 or reply to claim this issue.\n\n` +
        `<${mondayUrl}|View on Monday.com>`,
    });

    if (!slackMessage.ts) {
      throw new Error('Failed to post to issue call channel');
    }

    // Store Slack thread ID on Monday item for syncing
    await monday.updateSlackThreadId(mondayItem.id, slackMessage.ts);

    // Register this issue call for monitoring (20-min pings until claimed)
    registerIssueCall({
      mondayItemId: mondayItem.id,
      slackThreadTs: slackMessage.ts,
      channelId: issueCallChannelId,
      createdAt: Date.now(),
      ownerSlackIds: [dayna.slackId, ruzzell.slackId].filter((id): id is string => !!id),
      suggestedSupporterSlackId,
    });

    console.log(`Posted issue call to channel ${issueCallChannelId}, thread ${slackMessage.ts}`);

    // Send confirmation via response_url
    const slackThreadUrl = `https://slack.com/app_redirect?channel=${issueCallChannelId}&message_ts=${slackMessage.ts}`;
    await slack.sendResponseUrl(response_url,
      `✅ *Issue Call Created*\n\n` +
      `• *Team:* ${accountResult.team || teamName}\n` +
      `• *Email:* ${email}\n` +
      `• *Due:* ${dueDate}\n` +
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
function start() {
  validateConfig();

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
    console.log(`  Slack /task:     http://localhost:${config.port}/webhook/slack/task`);
    console.log(`  Slack /taskdebug: http://localhost:${config.port}/webhook/slack/taskdebug`);
    console.log(`  Slack /issuecall: http://localhost:${config.port}/webhook/slack/issuecall`);
    console.log(`  Monday webhook:  http://localhost:${config.port}/webhook/monday`);
    console.log(`  Relay events:    http://localhost:${config.port}/relay/events`);
    console.log('');

    // Start auto follow-up scheduler (checks every hour)
    startFollowUpScheduler();
    console.log('Auto follow-up scheduler started (hourly)');

    // Start after-hours scheduler (8 AM release, 11 AM reminder)
    startAfterHoursScheduler();
    console.log('After-hours scheduler started (8 AM release, 11 AM reminder)');
  });
}

start();

export { app };
