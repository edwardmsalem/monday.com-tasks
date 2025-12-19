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

/**
 * Make.com webhook endpoint
 * Accepts the .eml attachment directly (not nested in a forwarding email)
 *
 * Expected fields:
 * - from: sender email
 * - subject: email subject
 * - body-plain: email body text
 * - email: the .eml file attachment (file upload)
 */
app.post(
  '/webhook/make',
  upload.any(),
  async (req: Request, res: Response): Promise<void> => {
    console.log('=== Make.com webhook request ===');
    console.log('Content-Type:', req.headers['content-type']);
    console.log('Body fields:', Object.keys(req.body));

    // Log each body field type and preview
    for (const [key, value] of Object.entries(req.body)) {
      const valType = typeof value;
      const preview = valType === 'string'
        ? (value as string).substring(0, 100) + ((value as string).length > 100 ? '...' : '')
        : valType === 'object' ? JSON.stringify(value).substring(0, 100) : String(value);
      console.log(`  ${key}: (${valType}) ${preview}`);
    }

    const files = req.files as Express.Multer.File[] | undefined;
    console.log('Files count:', files?.length || 0);
    if (files && files.length > 0) {
      console.log('Files:', files.map(f => ({
        fieldname: f.fieldname,
        mimetype: f.mimetype,
        size: f.size,
        originalname: f.originalname,
        originalnameType: typeof f.originalname,
        hasBuffer: Buffer.isBuffer(f.buffer),
      })));
    }

    try {
      // Get form fields
      const subject = req.body.subject || req.body['subject'] || 'No Subject';
      const bodyText = req.body['body-plain'] || req.body.text || '';
      const from = req.body.from || '';

      let emlBuffer: Buffer;
      let emlFilename = 'forwarded.eml';

      // Method 1: Check for file upload (multipart form data)
      const emlFile = files?.find(
        f => f.fieldname === 'email' ||
             f.fieldname === 'attachment-1' ||
             (typeof f.originalname === 'string' && f.originalname?.endsWith('.eml')) ||
             f.mimetype === 'message/rfc822'
      );

      // Method 2: Check for base64-encoded EML in body (easier for Make.com)
      const emlBase64 = req.body.emlData || req.body.attachmentData || req.body.fileData;
      const emlFilenameFromBody = req.body.emlFilename || req.body.attachmentFilename || req.body.fileName;

      if (emlFile && Buffer.isBuffer(emlFile.buffer)) {
        // Use uploaded file
        emlBuffer = emlFile.buffer;
        if (typeof emlFile.originalname === 'string' && emlFile.originalname) {
          emlFilename = emlFile.originalname;
        } else if (emlFile.originalname && typeof emlFile.originalname === 'object') {
          const nameObj = emlFile.originalname as Record<string, unknown>;
          if (typeof nameObj.name === 'string') {
            emlFilename = nameObj.name;
          } else if (typeof nameObj.filename === 'string') {
            emlFilename = nameObj.filename;
          }
        }
        console.log('Using uploaded file:', emlFile.fieldname, emlFilename, emlBuffer.length, 'bytes');
      } else if (emlBase64 && typeof emlBase64 === 'string') {
        // Use base64-encoded data from body
        emlBuffer = Buffer.from(emlBase64, 'base64');
        if (typeof emlFilenameFromBody === 'string' && emlFilenameFromBody) {
          emlFilename = emlFilenameFromBody;
        }
        console.log('Using base64 data from body:', emlFilename, emlBuffer.length, 'bytes');
      } else {
        console.log('No EML data found in request');
        // Build debug info
        const debugInfo: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(req.body)) {
          debugInfo[key] = {
            type: typeof value,
            length: typeof value === 'string' ? value.length : undefined,
            preview: typeof value === 'string' ? value.substring(0, 50) : typeof value,
          };
        }
        res.status(400).json({
          success: false,
          error: 'No EML attachment found. Send as file upload (field: "email") or base64 in body (field: "emlData")',
          hint: 'Use {{toString(3.Attachments[1].Data; "base64")}} for emlData field',
          receivedBodyFields: debugInfo,
          receivedFiles: files?.map(f => ({ name: f.fieldname, type: f.mimetype, hasBuffer: Buffer.isBuffer(f.buffer) })) || [],
        });
        return;
      }

      // Ensure filename ends with .eml
      if (!emlFilename.toLowerCase().endsWith('.eml')) {
        emlFilename = emlFilename + '.eml';
      }

      console.log('Processing EML:', { filename: emlFilename, size: emlBuffer.length });

      // Create a mock "forwarding email" with the .eml as an attachment
      // This matches what the workflow expects
      const email = {
        subject: String(subject),
        text: String(bodyText),
        fromEmail: from ? String(from) : null,
        toEmail: null,
        attachments: [{
          filename: String(emlFilename),
          content: emlBuffer,
          contentType: 'message/rfc822',
        }],
      };

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
      console.error('Make.com webhook error:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
);

/**
 * Make.com webhook endpoint for PRE-CONVERTED PDF
 * Make.com handles: email receiving + EML→PDF conversion
 * Server handles: AI analysis, user resolution, Monday/Slack creation
 *
 * Expected fields:
 * - subject: forwarding email subject
 * - body: forwarding email body (contains @owner, due date, task type, notes)
 * - fromEmail: original sender email (from the .eml)
 * - toEmail: original recipient email (from the .eml)
 * - pdfData: base64-encoded PDF file (converted by Make.com)
 * - pdfFilename: PDF filename
 */
app.post(
  '/webhook/make/parsed',
  upload.any(),
  async (req: Request, res: Response): Promise<void> => {
    console.log('=== Make.com PARSED webhook request ===');
    console.log('Body fields:', Object.keys(req.body));

    try {
      // Extract fields from Make.com
      const subject = String(req.body.subject || 'No Subject');
      const bodyText = String(req.body.body || req.body['body-plain'] || req.body.text || '');
      const fromEmail = req.body.fromEmail || req.body.from || null;
      const toEmail = req.body.toEmail || req.body.to || null;

      // Get PDF data - either from base64 in body or file upload
      let pdfBuffer: Buffer | null = null;
      let pdfFilename = 'email.pdf';

      const files = req.files as Express.Multer.File[] | undefined;
      const pdfFile = files?.find(f =>
        f.fieldname === 'pdf' ||
        f.fieldname === 'pdfFile' ||
        f.mimetype === 'application/pdf'
      );

      if (pdfFile && Buffer.isBuffer(pdfFile.buffer)) {
        pdfBuffer = pdfFile.buffer;
        pdfFilename = typeof pdfFile.originalname === 'string' ? pdfFile.originalname : 'email.pdf';
        console.log('Using uploaded PDF:', pdfFilename, pdfBuffer.length, 'bytes');
      } else if (req.body.pdfData && typeof req.body.pdfData === 'string') {
        pdfBuffer = Buffer.from(req.body.pdfData, 'base64');
        pdfFilename = String(req.body.pdfFilename || 'email.pdf');
        console.log('Using base64 PDF:', pdfFilename, pdfBuffer.length, 'bytes');
      }

      console.log('Received data:', { subject, bodyText: bodyText.substring(0, 100), fromEmail, toEmail, hasPdf: !!pdfBuffer });

      // Import required modules
      const { analyzeEmailSafe } = await import('./services/claude.js');
      const { findUserByName, getUserNamesString } = await import('./services/userResolver.js');
      const monday = await import('./services/monday.js');
      const slack = await import('./services/slack.js');
      const { parseDate, formatDateForDisplay } = await import('./utils/dateParser.js');
      const { getTaskTypeDisplayName } = await import('./config/taskTypes.js');
      const { normalizeSubject } = await import('./services/gmail.js');

      // Use Claude AI to analyze the email and extract task details
      console.log('Analyzing email with Claude AI...');
      const analysisResult = await analyzeEmailSafe(
        subject,      // forwarding email subject
        bodyText,     // forwarding email body (contains @owner, due date, etc.)
        subject,      // EML subject (use same as forwarding for now)
        fromEmail,    // from the EML
        toEmail,      // from the EML
        null          // no EML body needed
      );
      console.log('Claude analysis:', analysisResult);

      // Resolve task type
      const taskType = getTaskTypeDisplayName(analysisResult.taskType);
      console.log('Task type:', taskType);

      // Parse due date
      const formattedDueDate = parseDate(analysisResult.dueDate);
      console.log('Due date:', formattedDueDate);

      // Resolve user
      const user = await findUserByName(analysisResult.owner);
      if (!user) {
        const availableUsers = await getUserNamesString();
        res.status(400).json({
          success: false,
          error: `Unknown user: ${analysisResult.owner}. Available users: ${availableUsers}`,
        });
        return;
      }
      console.log('Resolved user:', user.name, 'Monday ID:', user.mondayId, 'Slack ID:', user.slackId);

      // Use original subject as task name (just strip FWD:/RE: prefixes)
      const taskName = normalizeSubject(subject);
      console.log('Task name:', taskName);

      // Create Monday item
      console.log('Creating Monday.com item...');
      const mondayItem = await monday.createItem({
        name: taskName,
        dueDate: formattedDueDate,
        ownerIds: [user.mondayId],
        taskType: taskType,
        source: 'Forwarding Tasks',
        fromEmail: fromEmail,
        toEmail: toEmail,
      });
      console.log('Monday item created:', mondayItem.id);

      // Create initial update (comment) on the Monday item with notes
      if (analysisResult.notes) {
        console.log('Creating Monday update with notes...');
        await monday.createUpdate(mondayItem.id, analysisResult.notes);
      }

      // Send Slack notification
      console.log('Sending Slack notification...');
      const slackMessage = await slack.sendNotification({
        taskType: taskType,
        subject: taskName,
        assigneeSlackId: user.slackId || user.name,
        dueDate: formatDateForDisplay(formattedDueDate),
        priority: analysisResult.priority,
        notes: analysisResult.notes,
        fromEmail: fromEmail,
        toEmail: toEmail,
        mondayItemId: mondayItem.id,
        meeting: analysisResult.meeting,
      });
      console.log('Slack message sent:', slackMessage.ts);

      // Upload PDF if available (non-blocking - failures won't stop workflow)
      if (pdfBuffer) {
        console.log('Uploading PDF to Monday and Slack...');

        // Upload to Slack (more reliable)
        try {
          await slack.uploadFileToThread(slackMessage.ts, pdfFilename, pdfBuffer, 'Email PDF');
          console.log('PDF uploaded to Slack');
        } catch (slackErr) {
          console.error('Slack PDF upload failed:', slackErr);
        }

        // Upload to Monday (has been problematic)
        try {
          await monday.uploadFileToItem(mondayItem.id, pdfFilename, pdfBuffer);
          console.log('PDF uploaded to Monday');
        } catch (mondayErr) {
          console.error('Monday PDF upload failed (non-fatal):', mondayErr);
          // Don't fail the whole workflow for Monday file upload
        }
      }

      // Update Monday with Slack thread ID
      await monday.updateSlackThreadId(mondayItem.id, slackMessage.ts);

      // Note: Slack reminders require a user token, not a bot token
      // Skipping reminder - users can set their own via Monday due date notifications

      console.log('Workflow completed successfully!');

      res.json({
        success: true,
        mondayItemId: mondayItem.id,
        slackThreadTs: slackMessage.ts,
      });
    } catch (error) {
      console.error('Make.com parsed webhook error:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
);

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
          console.log('Slack thread reply detected:', { thread_ts: event.thread_ts, user: event.user, text: event.text.substring(0, 50) });
          try {
            await sync.syncSlackToMonday(event.thread_ts, event.text, event.user);
          } catch (syncError) {
            console.error('Failed to sync Slack to Monday:', syncError);
          }
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
  });
}

start();

export { app };
