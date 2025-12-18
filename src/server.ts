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
import multer from 'multer';
import { config, validateConfig } from './config/environment.js';
import { parseIncomingEmail } from './services/emailParser.js';
import { executeWorkflowSafe } from './workflow.js';
import * as sync from './services/sync.js';
import * as monday from './services/monday.js';
import * as slack from './services/slack.js';
import { startFollowUpScheduler } from './services/autoFollowUp.js';

const app = express();

// Configure multer for handling multipart form data (email attachments)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB max file size
  },
});

// Raw body parser for Slack signature verification
app.use('/webhook/slack', express.raw({ type: 'application/json' }));

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * One-time cleanup endpoint - deletes recent bot messages
 * Usage: POST /cleanup?minutes=60
 */
app.post('/cleanup', async (req: Request, res: Response): Promise<void> => {
  const minutes = parseInt(req.query.minutes as string) || 60;
  console.log(`Cleanup requested: deleting bot messages from last ${minutes} minutes`);

  try {
    const deleted = await slack.deleteRecentBotMessages(minutes);
    res.json({ success: true, deletedCount: deleted });
  } catch (error) {
    console.error('Cleanup error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Main webhook endpoint for receiving emails
 *
 * Supports multiple formats:
 * 1. Raw email (Content-Type: message/rfc822)
 * 2. JSON payload with base64 encoded email
 * 3. Multipart form data (common for email services)
 */
app.post(
  '/webhook/email',
  upload.any(),
  async (req: Request, res: Response): Promise<void> => {
    console.log('Received webhook request');
    console.log('Content-Type:', req.headers['content-type']);

    try {
      let rawEmail: Buffer | string;

      // Handle different content types
      if (req.is('message/rfc822')) {
        // Raw email body
        rawEmail = req.body as Buffer;
      } else if (req.is('application/json')) {
        // JSON payload with base64 email
        const body = req.body as { email?: string; raw?: string };
        const emailData = body.email ?? body.raw;
        if (!emailData) {
          res.status(400).json({ error: 'Missing email data in JSON payload' });
          return;
        }
        rawEmail = Buffer.from(emailData, 'base64');
      } else if (req.is('multipart/form-data')) {
        // Multipart form data - look for email file or field
        const files = req.files as Express.Multer.File[] | undefined;
        const emailFile = files?.find(
          f => f.fieldname === 'email' || f.mimetype === 'message/rfc822'
        );

        if (emailFile) {
          rawEmail = emailFile.buffer;
        } else if (req.body?.email) {
          // Email might be in a form field
          rawEmail = req.body.email as string;
        } else {
          res.status(400).json({ error: 'No email found in multipart data' });
          return;
        }
      } else {
        // Try to use body directly
        rawEmail = req.body as Buffer;
      }

      if (!rawEmail || (Buffer.isBuffer(rawEmail) && rawEmail.length === 0)) {
        res.status(400).json({ error: 'Empty email data' });
        return;
      }

      // Parse the email
      console.log('Parsing email...');
      const email = await parseIncomingEmail(rawEmail);
      console.log('Email parsed:', email.subject);

      // Execute the workflow
      const result = await executeWorkflowSafe({ email });

      if (result.success) {
        res.json({
          success: true,
          mondayItemId: result.mondayItemId,
          slackThreadTs: result.slackThreadTs,
        });
      } else {
        res.status(500).json({
          success: false,
          error: result.error,
        });
      }
    } catch (error) {
      console.error('Webhook error:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
);

/**
 * Alternative endpoint that accepts JSON directly
 * Useful for testing or custom integrations
 */
app.post('/webhook/json', express.json(), async (req: Request, res: Response): Promise<void> => {
  console.log('Received JSON webhook request');

  try {
    const body = req.body as {
      subject?: string;
      text?: string;
      attachments?: Array<{
        filename: string;
        content: string; // base64
        contentType: string;
      }>;
    };

    if (!body.subject || !body.text) {
      res.status(400).json({ error: 'Missing required fields: subject, text' });
      return;
    }

    const email = {
      subject: body.subject,
      text: body.text,
      fromEmail: null,
      toEmail: null,
      attachments: (body.attachments ?? []).map(att => ({
        filename: att.filename,
        content: Buffer.from(att.content, 'base64'),
        contentType: att.contentType,
      })),
    };

    const result = await executeWorkflowSafe({ email });

    if (result.success) {
      res.json({
        success: true,
        mondayItemId: result.mondayItemId,
        slackThreadTs: result.slackThreadTs,
      });
    } else {
      res.status(500).json({
        success: false,
        error: result.error,
      });
    }
  } catch (error) {
    console.error('JSON webhook error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ============================================================================
// Slack Events API
// ============================================================================

interface SlackEvent {
  type: string;
  challenge?: string;
  event?: {
    type: string;
    user?: string;
    text?: string;
    thread_ts?: string;
    ts?: string;
    channel?: string;
    reaction?: string;
    item?: {
      type: string;
      ts: string;
      channel: string;
    };
  };
}

/**
 * Slack Events API webhook
 * Handles: message events (thread replies), reaction events (checkmarks)
 */
app.post('/webhook/slack/events', async (req: Request, res: Response): Promise<void> => {
  try {
    const body = JSON.parse(req.body.toString()) as SlackEvent;

    // Handle URL verification challenge
    if (body.type === 'url_verification' && body.challenge) {
      res.json({ challenge: body.challenge });
      return;
    }

    // Acknowledge receipt immediately (Slack requires response within 3s)
    res.status(200).send();

    // Process event asynchronously
    if (body.type === 'event_callback' && body.event) {
      const event = body.event;

      // Handle thread replies - sync to Monday
      if (event.type === 'message' && event.thread_ts && event.text && event.user) {
        // Ignore bot messages to prevent loops
        if (!event.text.startsWith('[From Monday')) {
          console.log('Slack thread reply detected, syncing to Monday...');
          await sync.syncSlackToMonday(event.thread_ts, event.text, event.user);
        }
      }

      // Handle reaction added - 👀 = acknowledged, ✅ = complete
      if (event.type === 'reaction_added' && event.reaction && event.item) {
        if (event.reaction === 'eyes') {
          console.log('Eyes reaction added, marking Monday item acknowledged...');
          await sync.markAcknowledgedFromSlack(event.item.ts);
        } else if (['white_check_mark', 'heavy_check_mark', 'ballot_box_with_check'].includes(event.reaction)) {
          console.log('Checkmark reaction added, marking Monday item complete...');
          await sync.markCompleteFromSlack(event.item.ts);
        }
      }

      // Handle reaction removed - undo completion
      if (event.type === 'reaction_removed' && event.reaction && event.item) {
        if (['white_check_mark', 'heavy_check_mark', 'ballot_box_with_check'].includes(event.reaction)) {
          console.log('Checkmark reaction removed, unmarking Monday item...');
          await sync.unmarkCompleteFromSlack(event.item.ts);
        }
      }
    }
  } catch (error) {
    console.error('Slack event error:', error);
    // Don't send error response - already sent 200
  }
});

// ============================================================================
// Slack Slash Commands (AI-powered with follow-up questions)
// ============================================================================

// Allowed channels for /seasontask command (restrict to season tickets channels)
const SEASONTASK_ALLOWED_CHANNELS = ['C06BSL06WJK', 'C08QCFC4Y0H'];

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
app.post('/webhook/slack/seasontask', express.urlencoded({ extended: true }), async (req: Request, res: Response): Promise<void> => {
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
app.post('/webhook/slack/command', express.urlencoded({ extended: true }), async (req: Request, res: Response): Promise<void> => {
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

/**
 * /cleanup slash command - Delete recent bot messages
 * Usage: /cleanup 60 (deletes messages from last 60 minutes)
 * Admin only - restricted to specific user IDs
 */
const CLEANUP_ADMIN_USERS = ['U08PKPYSZ2Z']; // Add your Slack user ID here

app.post('/webhook/slack/cleanup', express.urlencoded({ extended: true }), async (req: Request, res: Response): Promise<void> => {
  try {
    const { text, user_id } = req.body as {
      text: string;
      user_id: string;
    };

    console.log(`Cleanup command received from ${user_id}: ${text}`);

    // Check if user is admin
    if (!CLEANUP_ADMIN_USERS.includes(user_id)) {
      res.json({
        response_type: 'ephemeral',
        text: ':no_entry: You do not have permission to use this command.',
      });
      return;
    }

    // Parse minutes from text (default 60)
    const minutes = parseInt(text.trim()) || 60;

    // Respond immediately (Slack requires response within 3s)
    res.json({
      response_type: 'ephemeral',
      text: `:hourglass: Deleting bot messages from the last ${minutes} minutes...`,
    });

    // Run cleanup asynchronously
    const deleted = await slack.deleteRecentBotMessages(minutes);
    console.log(`Cleanup complete: deleted ${deleted} messages`);

  } catch (error) {
    console.error('Cleanup command error:', error);
    res.json({
      response_type: 'ephemeral',
      text: ':x: Error running cleanup.',
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
app.post('/webhook/slack/interactive', express.urlencoded({ extended: true }), async (req: Request, res: Response): Promise<void> => {
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
// Monday.com Webhooks
// ============================================================================

interface MondayWebhook {
  challenge?: string;
  event?: {
    type: string;
    pulseId?: number;
    pulseName?: string;
    columnId?: string;
    value?: {
      label?: { text: string };
    };
    previousValue?: {
      label?: { text: string };
    };
    userId?: number;
    textBody?: string;
  };
}

/**
 * Monday.com webhook handler
 * Handles: status changes, item updates
 */
app.post('/webhook/monday', express.json(), async (req: Request, res: Response): Promise<void> => {
  try {
    const body = req.body as MondayWebhook;

    // Handle challenge verification
    if (body.challenge) {
      res.json({ challenge: body.challenge });
      return;
    }

    // Acknowledge receipt
    res.status(200).send();

    if (body.event) {
      const event = body.event;

      // Handle workflow status change to "Complete"
      if (event.type === 'change_column_value' && event.columnId === config.monday.columns.workflowStatus) {
        const newStatus = event.value?.label?.text;
        const oldStatus = event.previousValue?.label?.text;

        if (newStatus === 'Complete' && oldStatus !== 'Complete' && event.pulseId) {
          console.log('Monday item marked as Complete, notifying Slack...');
          const mondayUser = event.userId ? await monday.getUser(event.userId) : null;
          await sync.notifySlackOfCompletion(
            String(event.pulseId),
            mondayUser?.name ?? 'Someone'
          );
        }
      }

      // Handle item updates (comments)
      if (event.type === 'create_update' && event.pulseId && event.textBody && event.userId) {
        // Only sync if not from Slack (avoid loops)
        if (!event.textBody.startsWith('[From Slack')) {
          console.log('Monday update created, syncing to Slack...');
          await sync.syncMondayToSlack(
            String(event.pulseId),
            event.textBody,
            event.userId
          );
        }
      }
    }
  } catch (error) {
    console.error('Monday webhook error:', error);
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
    console.log(`  Slack interact:  http://localhost:${config.port}/webhook/slack/interactive`);
    console.log(`  Monday webhook:  http://localhost:${config.port}/webhook/monday`);
    console.log('');

    // Start auto follow-up scheduler (checks every hour)
    startFollowUpScheduler();
    console.log('Auto follow-up scheduler started (hourly)');
  });
}

start();

export { app };
