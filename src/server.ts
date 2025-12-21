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
import {
  executeWorkflowSafe,
  parseSlackTaskInput,
  executeSlackTaskWorkflowSafe,
  executeEmailTaskWorkflowSafe,
} from './workflow.js';
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

    // Safety valve: skip email processing if disabled
    if (config.safetyValves.disableEmailAutomation) {
      console.log('⚠️ Email automation disabled via DISABLE_EMAIL_AUTOMATION - logging receipt only');
      res.json({
        success: true,
        message: 'Email received but automation disabled',
        safetyValve: 'DISABLE_EMAIL_AUTOMATION',
      });
      return;
    }

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
        team: analysisResult.team ?? undefined,
        // NOTE: From/To go to initial Update, not columns (locked architecture)
      });
      console.log('Monday item created:', mondayItem.id);

      // Create FIRST Monday update with all narrative context
      // LOCKED ARCHITECTURE: Columns = STATE + ROUTING only
      const initialUpdateParts: string[] = [];
      if (analysisResult.notes) {
        initialUpdateParts.push(`📝 ${analysisResult.notes}`);
      }
      if (fromEmail) {
        initialUpdateParts.push(`📧 From: ${fromEmail}`);
      }
      if (toEmail) {
        initialUpdateParts.push(`📬 To: ${toEmail}`);
      }
      // Note: BCC not available in this endpoint

      if (initialUpdateParts.length > 0) {
        console.log('Creating initial Monday update...');
        await monday.createUpdate(mondayItem.id, initialUpdateParts.join('\n\n'));
      }

      // If team wasn't identified, ask for clarification
      if (!analysisResult.team) {
        await monday.createUpdate(mondayItem.id, '⚠️ Team not identified. Please update the Team field if this relates to a specific sports team.');
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
  console.log('=== Slack event received ===');
  try {
    const body = JSON.parse(req.body.toString()) as SlackEvent;
    console.log('Slack event type:', body.type, body.event?.type);

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
// Slack Debug Commands
// ============================================================================

/**
 * /taskdebug slash command handler
 * Shows all tracking info for a Monday item (for debugging)
 *
 * Usage: /taskdebug <monday_item_id>
 * Example: /taskdebug 1234567890
 */
app.post('/webhook/slack/taskdebug', express.urlencoded({ extended: true }), async (req: Request, res: Response): Promise<void> => {
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
app.post('/webhook/slack/task', express.urlencoded({ extended: true }), async (req: Request, res: Response): Promise<void> => {
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

    // Handle missing assignee - default to on-call user
    if (!parsed.assigneeSlackId) {
      const onCallUserId = config.slack.quietHours.onCallUserId;
      if (onCallUserId) {
        parsed.assigneeSlackId = onCallUserId;
        parsed.urgency = 'Medium';  // Default urgency when defaulting assignee
        console.log(`No assignee specified, defaulting to on-call user: ${onCallUserId}`);
      } else {
        res.json({
          response_type: 'ephemeral',
          text: `:warning: *Assignee required*\n\n` +
            `Please use \`@mention\` to assign the task.\n\n` +
            `Example: \`/task @john Fix the login bug due friday\``,
        });
        return;
      }
    }

    // Acknowledge immediately (Slack requires response within 3 seconds)
    res.json({
      response_type: 'ephemeral',
      text: `⏳ Creating task...`,
    });

    // Execute the workflow asynchronously
    const result = await executeSlackTaskWorkflowSafe({
      parsed,
      creatorSlackId: user_id,
    });

    // Send confirmation or error via response_url
    if (result.success) {
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

/**
 * /emailtask slash command handler
 * Search Gmail for emails by subject and create a task from the result
 *
 * Usage:
 * - /emailtask subject: Your Subject Here
 * - /emailtask subject: Your Subject Here days: 7
 * - /emailtask subject: Your Subject Here match: equals
 *
 * Options:
 * - subject: (required) The subject line to search for
 * - days: Number of days to search (0 = today only, default)
 * - match: 'equals' (exact) or 'contains' (partial, default)
 */
app.post('/webhook/slack/emailtask', express.urlencoded({ extended: true }), async (req: Request, res: Response): Promise<void> => {
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
          `*Usage:*\n` +
          `\`/emailtask subject: Your Subject Here\`\n\n` +
          `*Options:*\n` +
          `• \`subject:\` - Required. The subject line to search\n` +
          `• \`days:\` - Search window (0 = today only, default)\n` +
          `• \`match:\` - 'equals' (exact) or 'contains' (partial)\n\n` +
          `*Examples:*\n` +
          `• \`/emailtask subject: Knicks 2025 Presale\`\n` +
          `• \`/emailtask subject: Yankees Relocation days: 7\`\n` +
          `• \`/emailtask subject: Season Tickets match: contains\`\n\n` +
          `_Default: today only, contains match_`,
      });
      return;
    }

    // Parse the input
    const subjectMatch = trimmedText.match(/subject:\s*(.+?)(?=\s+(?:days:|match:)|$)/i);
    const daysMatch = trimmedText.match(/days:\s*(\d+)/i);
    const matchModeMatch = trimmedText.match(/match:\s*(equals|contains)/i);

    if (!subjectMatch) {
      res.json({
        response_type: 'ephemeral',
        text: `:warning: *Subject required*\n\n` +
          `Please specify a subject to search for.\n\n` +
          `Example: \`/emailtask subject: Knicks Presale 2025\``,
      });
      return;
    }

    const subject = subjectMatch[1].trim();
    const daysBack = daysMatch ? parseInt(daysMatch[1], 10) : 0;
    const matchMode: gmail.EmailMatchMode = matchModeMatch?.[1]?.toLowerCase() === 'equals' ? 'equals' : 'contains';

    // Acknowledge immediately
    res.json({
      response_type: 'ephemeral',
      text: `⏳ Searching Gmail for "${subject}"...`,
    });

    // Search Gmail
    const emails = await gmail.searchEmailsBySubject(subject, matchMode, daysBack);

    // Handle no matches
    if (emails.length === 0) {
      const suggestion = daysBack === 0
        ? `Try widening the search: \`/emailtask subject: ${subject} days: 7\``
        : daysBack < 30
          ? `Try widening the search: \`/emailtask subject: ${subject} days: 30\``
          : `No emails found matching "${subject}" in the last ${daysBack} days.`;

      await slack.sendResponseUrl(response_url,
        `:mag: *No emails found*\n\n` +
        `No emails matching "${subject}" found${daysBack === 0 ? ' today' : ` in the last ${daysBack} days`}.\n\n` +
        `${suggestion}`
      );
      return;
    }

    // Handle multiple matches - use the most recent
    let selectedEmail = emails[0];
    let multipleNote = '';
    if (emails.length > 1) {
      multipleNote = `\n_Found ${emails.length} emails, using most recent from ${selectedEmail.date.toLocaleDateString('en-US', { timeZone: 'America/New_York' })}_`;
      console.log(`Multiple emails found (${emails.length}), using most recent: ${selectedEmail.messageId}`);
    }

    // Generate PDF from email
    let pdfBuffer: Buffer | null = null;
    let pdfFilename = 'email.pdf';

    try {
      if (selectedEmail.bodyHtml) {
        const pdfResult = await convertHtmlToPdf(selectedEmail.bodyHtml, subject);
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
      // Continue without PDF
    }

    // Execute the email task workflow
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
    });

    if (result.success) {
      const mondayUrl = monday.getItemUrl(result.mondayItemId);
      const slackThreadUrl = `https://slack.com/app_redirect?channel=${config.slack.channelId}&message_ts=${result.slackThreadTs}`;

      // Post attribution to thread
      await slack.postToThread(
        result.slackThreadTs,
        `📧 Created via \`/emailtask\` by <@${user_id}>${multipleNote}`
      );

      await slack.sendResponseUrl(response_url,
        `✅ *Task Created from Email*\n\n` +
        `• *Subject:* ${selectedEmail.subject}\n` +
        `• *Monday:* <${mondayUrl}|View Item>\n` +
        `• *Slack Thread:* <${slackThreadUrl}|View Thread>\n` +
        `• *Run ID:* \`${result.runId?.substring(0, 8)}\`${multipleNote}`
      );
    } else {
      console.error('Email task creation failed:', result.error);
      await slack.sendResponseUrl(response_url,
        `:x: *Task Creation Failed*\n\n${result.error}`
      );
    }
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
    boardId?: number;
  };
}

// In-memory cooldown for direct creation guidance DMs (24 hours)
// Key: Slack user ID, Value: timestamp of last DM
const directCreationDmCooldown = new Map<string, number>();
const DM_COOLDOWN_MS = 24 * 60 * 60 * 1000;  // 24 hours

/**
 * Check if a user is on DM cooldown
 */
function isOnDmCooldown(slackUserId: string): boolean {
  const lastDm = directCreationDmCooldown.get(slackUserId);
  if (!lastDm) return false;
  return Date.now() - lastDm < DM_COOLDOWN_MS;
}

/**
 * Record that we sent a DM to a user
 */
function recordDmSent(slackUserId: string): void {
  directCreationDmCooldown.set(slackUserId, Date.now());
}

/**
 * Send guidance DM to a user who created an item directly in Monday
 * This is informational, not an error.
 * Includes 24-hour cooldown per user to prevent spam.
 */
async function sendDirectCreationGuidance(mondayUserId: number): Promise<void> {
  try {
    // Get the Monday user's details
    const mondayUser = await monday.getUser(mondayUserId);
    if (!mondayUser?.email) {
      console.log(`Cannot send guidance: no email for Monday user ${mondayUserId}`);
      return;
    }

    // Find the corresponding Slack user
    const { findUserByEmail } = await import('./services/userResolver.js');
    const user = await findUserByEmail(mondayUser.email);

    if (!user?.slackId) {
      console.log(`Cannot send guidance: no Slack ID for ${mondayUser.email}`);
      return;
    }

    // Check cooldown - don't spam the same user
    if (isOnDmCooldown(user.slackId)) {
      console.log(`Skipping guidance DM to ${user.name} - on 24h cooldown`);
      return;
    }

    // Send Slack DM with guidance
    const client = slack.getClient();
    await client.chat.postMessage({
      channel: user.slackId,  // DM to user
      text: `📋 *Task Creation Guidance*\n\n` +
        `I noticed you created a task directly in Monday.com.\n\n` +
        `To keep everything in sync, please use one of these methods:\n` +
        `• *Email:* Forward emails to the forwarding inbox\n` +
        `• *Slack:* Use the \`/task\` command\n\n` +
        `This ensures tasks have proper tracking, Slack threads, and Run IDs.\n\n` +
        `_This is just a friendly reminder – your task was still created._`,
    });

    // Record cooldown
    recordDmSent(user.slackId);

    console.log(`Sent direct creation guidance to ${user.name}`);
  } catch (error) {
    console.error('Failed to send direct creation guidance:', error);
  }
}

/**
 * Monday.com webhook handler
 * Handles: status changes, item updates, direct item creation detection
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

      // Handle direct item creation - send guidance to user
      // Note: This fires for ALL item creations, so we wait 5 seconds
      // then check if item was created via automation (Run ID or Source)
      if (event.type === 'create_item' && event.pulseId && event.userId) {
        console.log(`Item ${event.pulseId} created by user ${event.userId}, checking if direct creation...`);

        // Wait 5 seconds for automated workflow to populate Run ID and Source
        setTimeout(async () => {
          try {
            const automation = await monday.checkItemAutomation(String(event.pulseId));

            if (!automation.isAutomated && event.userId) {
              console.log(`Item ${event.pulseId} not automated (Run ID: ${automation.hasRunId}, Source: ${automation.source}) - sending guidance`);
              await sendDirectCreationGuidance(event.userId);
            } else if (automation.isAutomated) {
              console.log(`Item ${event.pulseId} is automated (Run ID: ${automation.hasRunId}, Source: ${automation.source}) - no guidance needed`);
            }
          } catch (error) {
            console.error('Error checking for direct creation:', error);
          }
        }, 5000);  // 5 second delay
      }

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
    console.log(`  Slack /task:     http://localhost:${config.port}/webhook/slack/task`);
    console.log(`  Slack /emailtask: http://localhost:${config.port}/webhook/slack/emailtask`);
    console.log(`  Slack /taskdebug: http://localhost:${config.port}/webhook/slack/taskdebug`);
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
