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
import { config, validateConfig } from './config/environment.js';
import {
  parseSlackTaskInput,
  executeSlackTaskWorkflowSafe,
  executeEmailTaskWorkflowSafe,
} from './workflow.js';
import * as sync from './services/sync.js';
import * as monday from './services/monday.js';
import * as slack from './services/slack.js';
import { startFollowUpScheduler } from './services/autoFollowUp.js';
import { startScheduler as startAfterHoursScheduler } from './services/afterHoursScheduler.js';
import { initializeJobQueue } from './services/jobQueue.js';
import {
  checkIdempotency,
  setIdempotencyKey,
  generateTaskIdempotencyKey,
  generateEmailTaskIdempotencyKey,
  startCleanupInterval as startIdempotencyCleanup,
} from './services/idempotency.js';

// Import route modules
import {
  healthRouter,
  emailWebhookRouter,
  slackEventsRouter,
  mondayWebhookRouter,
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

// ============================================================================
// Slack Slash Commands (AI-powered with follow-up questions)
// ============================================================================

// Allowed channels for /seasontask command (from config - QW-06)
const SEASONTASK_ALLOWED_CHANNELS = config.slack.seasontaskAllowedChannels;

/**
 * /seasontask slash command handler - Restricted to specific channels
 * Uses Claude AI to understand natural language and asks follow-up questions
 * for missing required fields (assignee, due date)
 *
 * Examples:
 *   /seasontask Fix the login bug
 *   /seasontask Review the Yankees tickets for John by Friday
 *   /seasontask urgent: follow up on Knicks renewal @sarah
 */
app.post('/webhook/slack/seasontask', slackUrlEncodedWithRawBody, async (req: Request & { rawBody?: string }, res: Response): Promise<void> => {
  // Verify Slack signature (QW-07)
  if (!verifySlackSignature(req)) {
    res.status(401).send('Invalid signature');
    return;
  }

  try {
    const { text, user_id, channel_id, command } = req.body as {
      text: string;
      user_id: string;
      channel_id: string;
      command: string;
    };

    console.log(`Slash command received: ${command} ${text} in channel ${channel_id}`);

    // Check if channel is allowed
    if (!SEASONTASK_ALLOWED_CHANNELS.includes(channel_id)) {
      res.json({
        response_type: 'ephemeral',
        text: `:no_entry: This command only works in the season tickets channels.\n\n` +
          `If you need to create a task elsewhere, please use the appropriate channel.`,
      });
      return;
    }

    const trimmedText = text.trim().toLowerCase();

    // Handle help
    if (trimmedText === 'help' || trimmedText === '') {
      res.json({
        response_type: 'ephemeral',
        text: `*Season Tickets - Smart Task Creation*\n\n` +
          `Just describe your task naturally! I'll ask for any missing details.\n\n` +
          `*Examples:*\n` +
          `• \`/seasontask Follow up on Yankees renewal\`\n` +
          `• \`/seasontask Call John about Knicks tickets by friday\`\n` +
          `• \`/seasontask urgent: Rangers invoice needs review\`\n` +
          `• \`/seasontask Schedule Giants meeting next week @sarah\`\n\n` +
          `*Required info (I'll ask if missing):*\n` +
          `• Task description\n` +
          `• Assignee (who's responsible?)\n` +
          `• Due date (when is it due?)\n\n` +
          `*Team names I recognize:*\n` +
          `Yankees, Mets, Knicks, Nets, Rangers, Islanders, Giants, Jets, etc.\n\n` +
          `_Tip: Mention the team name and I'll automatically tag it!_`,
      });
      return;
    }

    // Handle cancel
    if (trimmedText === 'cancel') {
      const result = sync.cancelSmartTask(user_id, channel_id);
      res.json({
        response_type: 'ephemeral',
        text: result.message,
      });
      return;
    }

    // Check if there's a pending task (user is answering a question)
    if (sync.hasPendingTask(user_id, channel_id)) {
      const result = await sync.continueSmartTaskCreation(text, user_id, channel_id);
      res.json({
        response_type: 'ephemeral',
        text: result.message ?? '',
        blocks: result.blocks,
      });
      return;
    }

    // Start new task creation with AI
    const result = await sync.startSmartTaskCreation(text, user_id, channel_id);

    res.json({
      response_type: 'ephemeral',
      text: result.message ?? '',
      blocks: result.blocks,
    });
  } catch (error) {
    console.error('Seasontask command error:', error);
    res.json({
      response_type: 'ephemeral',
      text: ':x: Error processing command. Please try again.',
    });
  }
});

/**
 * Slack slash command handler (/monday - general purpose)
 * Uses Claude AI to understand natural language and asks follow-up questions
 * for missing required fields (assignee, due date)
 *
 * Examples:
 *   /monday Fix the login bug
 *   /monday Review the contract for John by Friday
 *   /monday urgent: deploy hotfix @sarah
 */
app.post('/webhook/slack/command', slackUrlEncodedWithRawBody, async (req: Request & { rawBody?: string }, res: Response): Promise<void> => {
  // Verify Slack signature (QW-07)
  if (!verifySlackSignature(req)) {
    res.status(401).send('Invalid signature');
    return;
  }

  try {
    const { text, user_id, channel_id, command } = req.body as {
      text: string;
      user_id: string;
      channel_id: string;
      command: string;
    };

    console.log(`Slash command received: ${command} ${text}`);

    const trimmedText = text.trim().toLowerCase();

    // Handle help
    if (trimmedText === 'help' || trimmedText === '') {
      res.json({
        response_type: 'ephemeral',
        text: `*Monday.com - Smart Task Creation*\n\n` +
          `Just describe your task naturally! I'll ask for any missing details.\n\n` +
          `*Examples:*\n` +
          `• \`/monday Fix the login bug\`\n` +
          `• \`/monday Review contract for @john by friday\`\n` +
          `• \`/monday urgent: deploy hotfix asap\`\n` +
          `• \`/monday Schedule meeting with team next week\`\n\n` +
          `*Required info (I'll ask if missing):*\n` +
          `• Task description\n` +
          `• Assignee (who's responsible?)\n` +
          `• Due date (when is it due?)\n\n` +
          `_Tip: The more detail you provide, the faster the task is created!_`,
      });
      return;
    }

    // Handle cancel
    if (trimmedText === 'cancel') {
      const result = sync.cancelSmartTask(user_id, channel_id);
      res.json({
        response_type: 'ephemeral',
        text: result.message,
      });
      return;
    }

    // Check if there's a pending task (user is answering a question)
    if (sync.hasPendingTask(user_id, channel_id)) {
      const result = await sync.continueSmartTaskCreation(text, user_id, channel_id);
      res.json({
        response_type: 'ephemeral',
        text: result.message ?? '',
        blocks: result.blocks,
      });
      return;
    }

    // Start new task creation with AI
    const result = await sync.startSmartTaskCreation(text, user_id, channel_id);

    res.json({
      response_type: 'ephemeral',
      text: result.message ?? '',
      blocks: result.blocks,
    });
  } catch (error) {
    console.error('Slash command error:', error);
    res.json({
      response_type: 'ephemeral',
      text: ':x: Error processing command. Please try again.',
    });
  }
});

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
 * Usage:
 * - Single-line: /task @assignee refund due fri urgency high notes: customer called twice
 * - Multiline:
 *     @assignee
 *     due fri
 *     refund
 *     notes...
 *
 * Behavior:
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
        text: `*Task Creation*\n\n` +
          `Create tasks directly from Slack.\n\n` +
          `*Single-line format:*\n` +
          `\`/task @assignee description due friday urgency high notes: details\`\n\n` +
          `*Multiline format:*\n` +
          `\`\`\`\n` +
          `@assignee\n` +
          `due friday\n` +
          `Task description here\n` +
          `notes: Additional details\n` +
          `\`\`\`\n\n` +
          `*Options:*\n` +
          `• \`@assignee\` - Required (use @ mention)\n` +
          `• \`due X\` - Date (fri, 12/25, tomorrow, ASAP)\n` +
          `• \`urgency high|medium|low\` - Priority\n` +
          `• \`type X\` - Task type (refund, shipping, etc.)\n` +
          `• \`notes: X\` - Additional notes\n\n` +
          `_ASAP sets due date to null and urgency to High._`,
      });
      return;
    }

    // Parse the input
    const parsed = parseSlackTaskInput(text);

    // Owner rules:
    // - Default owner is ALWAYS the creator
    // - owner: prefix can ONLY be used by authorized users (SLACK_OWNER_OVERRIDE_USER_IDS)
    // - Plain @mentions go to Support, not Owner
    const ownerOverrideUserIds = config.slack.ownerOverrideUserIds;
    const isOwnerAuthorized = ownerOverrideUserIds.length === 0 || ownerOverrideUserIds.includes(user_id);
    let ownerOverridden = false;

    if (parsed.ownerExplicitlySet && parsed.ownerSlackId) {
      // User explicitly used owner: prefix
      if (isOwnerAuthorized) {
        // Authorized user - allow owner override
        console.log(`Authorized owner override: ${user_id} set owner to ${parsed.ownerSlackId}`);
      } else {
        // Non-authorized user tried to use owner: - ignore it, set owner = creator
        console.log(`Owner override blocked: ${user_id} tried to use owner: prefix`);
        parsed.ownerSlackId = user_id;
        ownerOverridden = true;
      }
    } else {
      // No explicit owner: prefix - owner is always the creator
      parsed.ownerSlackId = user_id;
    }

    // Check idempotency to prevent duplicate tasks
    const idempotencyKey = generateTaskIdempotencyKey(user_id, parsed.description ?? text);
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
    const ackMessage = ownerOverridden
      ? `⏳ Creating task...\n\n_Note: The \`owner:\` prefix is restricted. Task owner set to you._`
      : `⏳ Creating task...`;
    res.json({
      response_type: 'ephemeral',
      text: ackMessage,
    });

    // Execute the workflow asynchronously
    const result = await executeSlackTaskWorkflowSafe({
      parsed,
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
// Slack /emailtask Command - Gmail Search → Task Creation
// ============================================================================

import * as gmail from './services/gmail.js';
import { convertHtmlToPdf, convertTextToPdf } from './services/convertApi.js';
import { parseEmailTaskInput } from './services/claude.js';
import {
  getPendingEmailSelection,
  setPendingEmailSelection,
  deletePendingEmailSelection,
  hasPendingEmailSelection,
  getDmCooldown,
  setDmCooldown,
  initializePendingState,
  PENDING_EMAIL_TTL,
  DM_COOLDOWN_TTL,
  type PendingEmailSelection,
} from './services/pendingState.js';

// TTL constant for expiresAt calculation
const SELECTION_TIMEOUT_MS = PENDING_EMAIL_TTL;

/**
 * Create task from selected email
 */
async function createTaskFromEmail(
  selectedEmail: gmail.GmailEmailResult,
  userId: string,
  responseUrl: string
): Promise<void> {
  // Check idempotency to prevent duplicate task creation from same email
  const idempotencyKey = generateEmailTaskIdempotencyKey(userId, selectedEmail.messageId);
  const { isDuplicate, cachedResult } = checkIdempotency(idempotencyKey);
  if (isDuplicate) {
    console.log(`[Idempotency] Duplicate /emailtask request detected: ${idempotencyKey}`);
    await slack.sendResponseUrl(responseUrl,
      cachedResult
        ? `✅ Task already created from this email (duplicate request ignored)`
        : `⚠️ This email is already being processed. Please wait.`
    );
    return;
  }

  // Generate PDF from email
  let pdfBuffer: Buffer | null = null;
  let pdfFilename = 'email.pdf';

  try {
    if (selectedEmail.bodyHtml) {
      const pdfResult = await convertHtmlToPdf(selectedEmail.bodyHtml, selectedEmail.subject);
      pdfBuffer = pdfResult.data;
      pdfFilename = pdfResult.filename;
    } else if (selectedEmail.bodyText) {
      const pdfResult = await convertTextToPdf(
        selectedEmail.bodyText,
        selectedEmail.subject,
        selectedEmail.from,
        selectedEmail.date
      );
      pdfBuffer = pdfResult.data;
      pdfFilename = pdfResult.filename;
    }
    console.log('PDF generated:', pdfFilename, pdfBuffer?.length, 'bytes');
  } catch (pdfError) {
    console.error('PDF generation failed (non-fatal):', pdfError);
  }

  // Execute the email task workflow (with initiator for authorization check)
  const result = await executeEmailTaskWorkflowSafe({
    subject: selectedEmail.subject,
    bodyText: selectedEmail.bodyText,
    bodyHtml: selectedEmail.bodyHtml,
    fromEmail: selectedEmail.from,
    toEmail: selectedEmail.to,
    emailDate: selectedEmail.date,
    pdfBuffer,
    pdfFilename,
    source: 'Email Task',
    initiatorSlackId: userId,  // Pass initiator for owner authorization check
  });

  if (result.success) {
    // Store result for idempotency
    setIdempotencyKey(idempotencyKey, {
      success: true,
      mondayItemId: result.mondayItemId,
      slackThreadTs: result.slackThreadTs,
    });

    const mondayUrl = monday.getItemUrl(result.mondayItemId);
    const slackThreadUrl = `https://slack.com/app_redirect?channel=${config.slack.channelId}&message_ts=${result.slackThreadTs}`;

    await slack.postToThread(
      result.slackThreadTs,
      `📧 Created via \`/emailtask\` by <@${userId}>`
    );

    await slack.sendResponseUrl(responseUrl,
      `✅ *Task Created from Email*\n\n` +
      `• *Subject:* ${selectedEmail.subject}\n` +
      `• *Monday:* <${mondayUrl}|View Item>\n` +
      `• *Slack Thread:* <${slackThreadUrl}|View Thread>\n` +
      `• *Run ID:* \`${result.runId?.substring(0, 8)}\``
    );
  } else {
    console.error('Email task creation failed:', result.error);
    await slack.sendResponseUrl(responseUrl, `:x: *Task Creation Failed*\n\n${result.error}`);
  }
}

/**
 * /emailtask slash command handler
 * Search Gmail for emails by subject and create a task from the result
 *
 * Supports natural language input:
 * - /emailtask Knicks Presale 2025
 * - /emailtask Yankees relocation from last week
 * - /emailtask Rangers email use most recent
 *
 * Also supports structured format:
 * - /emailtask subject: Your Subject Here days: 7 match: contains
 *
 * Defaults: today only (Eastern Time), exact match
 */
app.post('/webhook/slack/emailtask', slackUrlEncodedWithRawBody, async (req: Request & { rawBody?: string }, res: Response): Promise<void> => {
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

    console.log(`/emailtask command received from ${user_id}: ${text}`);

    // Check whitelist permissions (same as /task)
    const whitelist = config.slack.taskCommandWhitelist;
    if (whitelist.length > 0 && !whitelist.includes(user_id)) {
      res.json({
        response_type: 'ephemeral',
        text: `🔒 *Access Restricted*\n\n` +
          `The \`/emailtask\` command is currently limited to authorized users.\n\n` +
          `_Contact your admin if you need access._`,
      });
      return;
    }

    // Handle help or empty input
    const trimmedText = text.trim();
    if (!trimmedText || trimmedText.toLowerCase() === 'help') {
      res.json({
        response_type: 'ephemeral',
        text: `*Email Task Creation*\n\n` +
          `Search Gmail and create a task from the email.\n\n` +
          `*Natural language examples:*\n` +
          `• \`/emailtask Knicks Presale 2025\`\n` +
          `• \`/emailtask Yankees relocation from last week\`\n` +
          `• \`/emailtask Rangers email use most recent\`\n` +
          `• \`/emailtask email containing season tickets\`\n\n` +
          `*Structured format (optional):*\n` +
          `\`/emailtask subject: Your Subject days: 7 match: contains\`\n\n` +
          `*Defaults:*\n` +
          `• Search window: today only (Eastern Time)\n` +
          `• Match mode: exact match\n\n` +
          `*Multiple matches:*\n` +
          `If multiple emails match, you'll see a list to choose from.\n` +
          `Add "use most recent" to auto-select the newest one.`,
      });
      return;
    }

    // Check for "confirm" to create task from pending single-match preview
    if (trimmedText.toLowerCase() === 'confirm') {
      const pending = getPendingEmailSelection(user_id);
      if (pending && pending.expiresAt > Date.now() && pending.emails.length === 1) {
        deletePendingEmailSelection(user_id);
        res.json({
          response_type: 'ephemeral',
          text: `⏳ Creating task from confirmed email...`,
        });
        await createTaskFromEmail(pending.emails[0], user_id, response_url);
        return;
      }
      // No valid pending confirmation
      res.json({
        response_type: 'ephemeral',
        text: `:warning: No pending email to confirm. Run \`/emailtask\` with a search first.`,
      });
      return;
    }

    // Check for pending selection (user replying with 1-5)
    const selectionMatch = trimmedText.match(/^(\d)$/);
    if (selectionMatch) {
      const pending = getPendingEmailSelection(user_id);
      if (pending && pending.expiresAt > Date.now()) {
        const selection = parseInt(selectionMatch[1], 10) - 1;
        if (selection >= 0 && selection < pending.emails.length) {
          deletePendingEmailSelection(user_id);
          res.json({
            response_type: 'ephemeral',
            text: `⏳ Creating task from email #${selection + 1}...`,
          });
          await createTaskFromEmail(pending.emails[selection], user_id, response_url);
          return;
        }
      }
      // No valid pending selection
      res.json({
        response_type: 'ephemeral',
        text: `:warning: No pending email selection. Run \`/emailtask\` with a search first.`,
      });
      return;
    }

    // Check for "cancel" to clear pending selection
    if (trimmedText.toLowerCase() === 'cancel') {
      if (hasPendingEmailSelection(user_id)) {
        deletePendingEmailSelection(user_id);
        res.json({
          response_type: 'ephemeral',
          text: `🚫 Email selection cancelled.`,
        });
      } else {
        res.json({
          response_type: 'ephemeral',
          text: `No pending selection to cancel.`,
        });
      }
      return;
    }

    // Parse the input using Claude AI
    res.json({
      response_type: 'ephemeral',
      text: `⏳ Parsing search...`,
    });

    let searchParams;
    try {
      searchParams = await parseEmailTaskInput(trimmedText);
    } catch (parseError) {
      console.error('Failed to parse /emailtask input:', parseError);
      await slack.sendResponseUrl(response_url,
        `:warning: *Could not parse search*\n\n` +
        `Try a simpler format like:\n` +
        `\`/emailtask Knicks Presale 2025\`\n` +
        `\`/emailtask subject: Your Subject Here\``
      );
      return;
    }

    // Search Gmail
    console.log(`Searching Gmail: "${searchParams.subject}" (${searchParams.matchMode}, ${searchParams.daysBack} days)`);
    const emails = await gmail.searchEmailsBySubject(
      searchParams.subject,
      searchParams.matchMode,
      searchParams.daysBack
    );

    // Handle no matches
    if (emails.length === 0) {
      const suggestion = searchParams.daysBack === 0
        ? `Try: \`/emailtask ${searchParams.subject} from last week\``
        : searchParams.daysBack < 30
          ? `Try: \`/emailtask ${searchParams.subject} from last month\``
          : `No emails found in the last ${searchParams.daysBack} days.`;

      await slack.sendResponseUrl(response_url,
        `:mag: *No emails found*\n\n` +
        `No emails matching "${searchParams.subject}" found${searchParams.daysBack === 0 ? ' today (Eastern Time)' : ` in the last ${searchParams.daysBack} days`} (${searchParams.matchMode} match).\n\n` +
        `${suggestion}`
      );
      return;
    }

    // Check if user explicitly requested auto-select (useLatest)
    // This is the ONLY case where we bypass confirmation
    if (searchParams.useLatest) {
      await slack.sendResponseUrl(response_url,
        `⏳ Found ${emails.length} email${emails.length > 1 ? 's' : ''}, using most recent...`
      );
      await createTaskFromEmail(emails[0], user_id, response_url);
      return;
    }

    // Single match - require confirmation (do NOT auto-create)
    if (emails.length === 1) {
      const email = emails[0];
      const dateStr = email.date.toLocaleDateString('en-US', {
        timeZone: 'America/New_York',
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      });
      const timeStr = email.date.toLocaleTimeString('en-US', {
        timeZone: 'America/New_York',
        hour: 'numeric',
        minute: '2-digit',
      });
      const from = email.from?.replace(/<[^>]+>/, '').trim() || 'Unknown sender';

      // Store pending confirmation (persisted to disk)
      setPendingEmailSelection(user_id, {
        emails: [email],
        subject: searchParams.subject,
        responseUrl: response_url,
        expiresAt: Date.now() + SELECTION_TIMEOUT_MS,
      });

      await slack.sendResponseUrl(response_url,
        `:mag: *Found 1 email matching "${searchParams.subject}"*\n\n` +
        `*Subject:* ${email.subject}\n` +
        `*From:* ${from}\n` +
        `*Date:* ${dateStr} ${timeStr} (Eastern Time)\n\n` +
        `Reply \`/emailtask confirm\` to create task from this email.\n` +
        `Or \`/emailtask cancel\` to cancel.\n\n` +
        `_Select within 5 minutes. Tip: Add "use most recent" to skip confirmation._`
      );
      return;
    }

    // Multiple matches - show list for user to choose
    const topEmails = emails.slice(0, 5);
    const listItems = topEmails.map((email, i) => {
      const dateStr = email.date.toLocaleDateString('en-US', {
        timeZone: 'America/New_York',
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      });
      const timeStr = email.date.toLocaleTimeString('en-US', {
        timeZone: 'America/New_York',
        hour: 'numeric',
        minute: '2-digit',
      });
      const from = email.from?.replace(/<[^>]+>/, '').trim().substring(0, 30) || 'Unknown';
      return `*${i + 1}.* ${dateStr} ${timeStr} - ${from}`;
    });

    // Store pending selection (persisted to disk)
    setPendingEmailSelection(user_id, {
      emails: topEmails,
      subject: searchParams.subject,
      responseUrl: response_url,
      expiresAt: Date.now() + SELECTION_TIMEOUT_MS,
    });

    await slack.sendResponseUrl(response_url,
      `:mag: *Found ${emails.length} emails matching "${searchParams.subject}"*\n\n` +
      `${listItems.join('\n')}\n\n` +
      `Reply with \`/emailtask 1\` to \`/emailtask 5\` to select one.\n` +
      `Or \`/emailtask cancel\` to cancel.\n\n` +
      `_Select within 5 minutes. Tip: Add "use most recent" to auto-select the newest._`
    );
  } catch (error) {
    console.error('/emailtask command error:', error);
    res.json({
      response_type: 'ephemeral',
      text: `:x: Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
    });
  }
});

// ============================================================================
// Slack Interactive Messages (button clicks, etc.)
// ============================================================================

interface SlackInteraction {
  type: string;
  user: { id: string };
  channel: { id: string };
  actions?: Array<{ action_id: string }>;
  response_url?: string;
}

/**
 * Handle Slack interactive messages (button clicks)
 */
app.post('/webhook/slack/interactive', slackUrlEncodedWithRawBody, async (req: Request & { rawBody?: string }, res: Response): Promise<void> => {
  // Verify Slack signature (QW-07)
  if (!verifySlackSignature(req)) {
    res.status(401).send('Invalid signature');
    return;
  }

  try {
    const payload = JSON.parse(req.body.payload) as SlackInteraction;

    const userId = payload.user.id;
    const channelId = payload.channel.id;
    const actionId = payload.actions?.[0]?.action_id;

    console.log(`Slack interactive: ${actionId} from ${userId}`);

    if (actionId === 'confirm_task') {
      // User confirmed - create the task
      const result = await sync.confirmSmartTask(userId, channelId);
      res.json({
        response_type: 'ephemeral',
        text: result.message,
        replace_original: true,
      });
    } else if (actionId === 'cancel_task') {
      // User cancelled
      const result = sync.cancelSmartTask(userId, channelId);
      res.json({
        response_type: 'ephemeral',
        text: result.message,
        replace_original: true,
      });
    } else {
      res.json({ text: 'Unknown action' });
    }
  } catch (error) {
    console.error('Interactive message error:', error);
    res.json({
      response_type: 'ephemeral',
      text: ':x: Error processing action.',
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

  // Initialize pending state persistence (loads from disk, starts cleanup interval)
  initializePendingState();

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
    console.log(`  Slack /monday:   http://localhost:${config.port}/webhook/slack/command`);
    console.log(`  Slack /seasontask: http://localhost:${config.port}/webhook/slack/seasontask`);
    console.log(`  Slack /task:     http://localhost:${config.port}/webhook/slack/task`);
    console.log(`  Slack /emailtask: http://localhost:${config.port}/webhook/slack/emailtask`);
    console.log(`  Slack /taskdebug: http://localhost:${config.port}/webhook/slack/taskdebug`);
    console.log(`  Slack interact:  http://localhost:${config.port}/webhook/slack/interactive`);
    console.log(`  Monday webhook:  http://localhost:${config.port}/webhook/monday`);
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
