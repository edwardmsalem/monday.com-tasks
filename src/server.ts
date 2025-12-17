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

      // Handle reaction added - checkmark = complete
      if (event.type === 'reaction_added' && event.reaction && event.item) {
        if (['white_check_mark', 'heavy_check_mark', 'ballot_box_with_check'].includes(event.reaction)) {
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
// Slack Slash Commands
// ============================================================================

/**
 * Slack slash command handler
 * Usage: /monday add Task name @assignee due:friday type:issue
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

    // Parse the command
    const parsed = sync.parseSlashCommand(text);

    if (parsed.action === 'add' && parsed.name) {
      // Acknowledge immediately
      res.json({
        response_type: 'ephemeral',
        text: ':hourglass: Creating task...',
      });

      // Create the task
      try {
        const result = await sync.createQuickTask({
          name: parsed.name,
          assignee: parsed.assignee,
          dueDate: parsed.dueDate,
          taskType: parsed.taskType,
          slackUserId: user_id,
          slackChannelId: channel_id,
        });
        console.log('Quick task created:', result.mondayItemId);
      } catch (err) {
        console.error('Failed to create quick task:', err);
      }
    } else if (parsed.action === 'help' || !parsed.action) {
      res.json({
        response_type: 'ephemeral',
        text: `*Monday.com Slash Commands*\n\n` +
          `\`/monday add <task name>\` - Create a new task\n\n` +
          `*Options:*\n` +
          `• \`@name\` - Assign to someone (default: you)\n` +
          `• \`due:friday\` - Set due date (today, tomorrow, +3, friday, 12/25)\n` +
          `• \`type:issue\` - Set task type\n\n` +
          `*Examples:*\n` +
          `• \`/monday add Fix the login bug @john due:friday type:issue\`\n` +
          `• \`/monday add Review contract due:tomorrow\`\n` +
          `• \`/monday add Team standup due:+1\``,
      });
    } else {
      res.json({
        response_type: 'ephemeral',
        text: `Unknown command: \`${parsed.action}\`. Try \`/monday help\` for usage.`,
      });
    }
  } catch (error) {
    console.error('Slash command error:', error);
    res.json({
      response_type: 'ephemeral',
      text: ':x: Error processing command. Please try again.',
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

      // Handle status change to "Done"
      if (event.type === 'change_column_value' && event.columnId === config.monday.columns.status) {
        const newStatus = event.value?.label?.text;
        const oldStatus = event.previousValue?.label?.text;

        if (newStatus === 'Done' && oldStatus !== 'Done' && event.pulseId) {
          console.log('Monday item marked as Done, notifying Slack...');
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
    console.log(`  Health:         http://localhost:${config.port}/health`);
    console.log(`  Email webhook:  http://localhost:${config.port}/webhook/email`);
    console.log(`  JSON webhook:   http://localhost:${config.port}/webhook/json`);
    console.log(`  Slack events:   http://localhost:${config.port}/webhook/slack/events`);
    console.log(`  Slack command:  http://localhost:${config.port}/webhook/slack/command`);
    console.log(`  Monday webhook: http://localhost:${config.port}/webhook/monday`);
  });
}

start();

export { app };
