/**
 * Email Webhook Routes
 *
 * Handles incoming emails from various sources:
 * - /webhook/email: Raw email or multipart
 * - /webhook/json: JSON with email data
 * - /webhook/make: Make.com integration (EML attachment)
 * - /webhook/make/parsed: Make.com with pre-converted PDF
 */

import { Router, type Request, type Response } from 'express';
import express from 'express';
import multer from 'multer';
import { config } from '../config/environment.js';
import { parseIncomingEmail } from '../services/emailParser.js';
import { executeWorkflowSafe } from '../workflow.js';
import {
  checkIdempotency,
  setIdempotencyKey,
  generateEmailIdempotencyKey,
} from '../services/idempotency.js';

const router = Router();

// Configure multer for handling multipart form data
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB max file size
  },
});

// ============================================================================
// /webhook/email - Main email webhook
// ============================================================================

/**
 * Main webhook endpoint for receiving emails
 *
 * Supports multiple formats:
 * 1. Raw email (Content-Type: message/rfc822)
 * 2. JSON payload with base64 encoded email
 * 3. Multipart form data (common for email services)
 */
router.post('/webhook/email', upload.any(), async (req: Request, res: Response): Promise<void> => {
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
      rawEmail = req.body as Buffer;
    } else if (req.is('application/json')) {
      const body = req.body as { email?: string; raw?: string };
      const emailData = body.email ?? body.raw;
      if (!emailData) {
        res.status(400).json({ error: 'Missing email data in JSON payload' });
        return;
      }
      rawEmail = Buffer.from(emailData, 'base64');
    } else if (req.is('multipart/form-data')) {
      const files = req.files as Express.Multer.File[] | undefined;
      const emailFile = files?.find(
        (f) => f.fieldname === 'email' || f.mimetype === 'message/rfc822'
      );

      if (emailFile) {
        rawEmail = emailFile.buffer;
      } else if (req.body?.email) {
        rawEmail = req.body.email as string;
      } else {
        res.status(400).json({ error: 'No email found in multipart data' });
        return;
      }
    } else {
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

    // Check idempotency to prevent duplicate processing
    const dateKey = new Date(
      Math.floor(Date.now() / (5 * 60 * 1000)) * (5 * 60 * 1000)
    ).toISOString();
    const idempotencyKey = generateEmailIdempotencyKey(
      email.subject,
      email.fromEmail ?? 'unknown',
      dateKey
    );
    const { isDuplicate, cachedResult } = checkIdempotency(idempotencyKey);
    if (isDuplicate) {
      console.log(`[Idempotency] Duplicate email request detected: ${idempotencyKey}`);
      res.json(cachedResult || { success: true, duplicate: true, message: 'Already processed' });
      return;
    }

    // Execute the workflow
    const result = await executeWorkflowSafe({ email });

    // Store result for idempotency
    if (result.success) {
      setIdempotencyKey(idempotencyKey, {
        success: true,
        mondayItemId: result.mondayItemId,
        slackThreadTs: result.slackThreadTs,
      });
    }

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
});

// ============================================================================
// /webhook/json - JSON webhook
// ============================================================================

/**
 * Alternative endpoint that accepts JSON directly
 * Useful for testing or custom integrations
 */
router.post('/webhook/json', express.json(), async (req: Request, res: Response): Promise<void> => {
  console.log('Received JSON webhook request');

  try {
    const body = req.body as {
      subject?: string;
      text?: string;
      attachments?: Array<{
        filename: string;
        content: string;
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
      attachments: (body.attachments ?? []).map((att) => ({
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
// /webhook/make - Make.com EML webhook
// ============================================================================

/**
 * Make.com webhook endpoint
 * Accepts the .eml attachment directly (not nested in a forwarding email)
 */
router.post('/webhook/make', upload.any(), async (req: Request, res: Response): Promise<void> => {
  console.log('=== Make.com webhook request ===');
  console.log('Content-Type:', req.headers['content-type']);
  console.log('Body fields:', Object.keys(req.body));

  // Log each body field type and preview
  for (const [key, value] of Object.entries(req.body)) {
    const valType = typeof value;
    const preview =
      valType === 'string'
        ? (value as string).substring(0, 100) + ((value as string).length > 100 ? '...' : '')
        : valType === 'object'
          ? JSON.stringify(value).substring(0, 100)
          : String(value);
    console.log(`  ${key}: (${valType}) ${preview}`);
  }

  const files = req.files as Express.Multer.File[] | undefined;
  console.log('Files count:', files?.length || 0);
  if (files && files.length > 0) {
    console.log(
      'Files:',
      files.map((f) => ({
        fieldname: f.fieldname,
        mimetype: f.mimetype,
        size: f.size,
        originalname: f.originalname,
        originalnameType: typeof f.originalname,
        hasBuffer: Buffer.isBuffer(f.buffer),
      }))
    );
  }

  try {
    const subject = req.body.subject || req.body['subject'] || 'No Subject';
    const bodyText = req.body['body-plain'] || req.body.text || '';
    const from = req.body.from || '';

    let emlBuffer: Buffer;
    let emlFilename = 'forwarded.eml';

    // Method 1: Check for file upload
    const emlFile = files?.find(
      (f) =>
        f.fieldname === 'email' ||
        f.fieldname === 'attachment-1' ||
        (typeof f.originalname === 'string' && f.originalname?.endsWith('.eml')) ||
        f.mimetype === 'message/rfc822'
    );

    // Method 2: Check for base64-encoded EML in body
    const emlBase64 = req.body.emlData || req.body.attachmentData || req.body.fileData;
    const emlFilenameFromBody =
      req.body.emlFilename || req.body.attachmentFilename || req.body.fileName;

    if (emlFile && Buffer.isBuffer(emlFile.buffer)) {
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
      emlBuffer = Buffer.from(emlBase64, 'base64');
      if (typeof emlFilenameFromBody === 'string' && emlFilenameFromBody) {
        emlFilename = emlFilenameFromBody;
      }
      console.log('Using base64 data from body:', emlFilename, emlBuffer.length, 'bytes');
    } else {
      console.log('No EML data found in request');
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
        error:
          'No EML attachment found. Send as file upload (field: "email") or base64 in body (field: "emlData")',
        hint: 'Use {{toString(3.Attachments[1].Data; "base64")}} for emlData field',
        receivedBodyFields: debugInfo,
        receivedFiles:
          files?.map((f) => ({
            name: f.fieldname,
            type: f.mimetype,
            hasBuffer: Buffer.isBuffer(f.buffer),
          })) || [],
      });
      return;
    }

    // Ensure filename ends with .eml
    if (!emlFilename.toLowerCase().endsWith('.eml')) {
      emlFilename = emlFilename + '.eml';
    }

    console.log('Processing EML:', { filename: emlFilename, size: emlBuffer.length });

    const email = {
      subject: String(subject),
      text: String(bodyText),
      fromEmail: from ? String(from) : null,
      toEmail: null,
      attachments: [
        {
          filename: String(emlFilename),
          content: emlBuffer,
          contentType: 'message/rfc822',
        },
      ],
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
    console.error('Make.com webhook error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ============================================================================
// /webhook/make/parsed - Make.com with pre-converted PDF
// ============================================================================

/**
 * Make.com webhook endpoint for PRE-CONVERTED PDF
 * Make.com handles: email receiving + EML→PDF conversion
 * Server handles: AI analysis, user resolution, Monday/Slack creation
 */
router.post(
  '/webhook/make/parsed',
  upload.any(),
  async (req: Request, res: Response): Promise<void> => {
    console.log('=== Make.com PARSED webhook request ===');
    console.log('Body fields:', Object.keys(req.body));

    try {
      const subject = String(req.body.subject || 'No Subject');
      const bodyText = String(req.body.body || req.body['body-plain'] || req.body.text || '');
      const fromEmail = req.body.fromEmail || req.body.from || null;
      const toEmail = req.body.toEmail || req.body.to || null;

      // Enhanced logging for debugging
      console.log('=== FULL BODY TEXT START ===');
      console.log(bodyText);
      console.log('=== FULL BODY TEXT END ===');
      console.log('Body text length:', bodyText.length);
      console.log('Contains /scan?', bodyText.toLowerCase().includes('/scan'));

      let pdfBuffer: Buffer | null = null;
      let pdfFilename = 'email.pdf';

      const files = req.files as Express.Multer.File[] | undefined;
      const pdfFile = files?.find(
        (f) =>
          f.fieldname === 'pdf' || f.fieldname === 'pdfFile' || f.mimetype === 'application/pdf'
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

      console.log('Received data:', {
        subject,
        bodyText: bodyText.substring(0, 100),
        fromEmail,
        toEmail,
        hasPdf: !!pdfBuffer,
      });

      // Dynamic imports to avoid circular dependencies
      const { analyzeEmailSafe } = await import('../services/claude.js');
      const { findUserByName, getUserNamesString } = await import('../services/userResolver.js');
      const monday = await import('../services/monday.js');
      const slack = await import('../services/slack.js');
      const { parseDate, formatDateForDisplay } = await import('../utils/dateParser.js');
      const { getTaskTypeDisplayName } = await import('../config/taskTypes.js');
      const { normalizeSubject } = await import('../services/gmail.js');

      console.log('Analyzing email with Claude AI...');
      const analysisResult = await analyzeEmailSafe(
        subject,
        bodyText,
        subject,
        fromEmail,
        toEmail,
        null
      );
      console.log('Claude analysis:', JSON.stringify(analysisResult, null, 2));
      console.log('Claude raw dueDate:', analysisResult.dueDate);
      console.log('Today is:', new Date().toISOString().split('T')[0]);

      const taskType = getTaskTypeDisplayName(analysisResult.taskType);
      console.log('Task type:', taskType);

      const formattedDueDate = parseDate(analysisResult.dueDate);
      console.log('Parsed due date:', formattedDueDate, '(from raw:', analysisResult.dueDate, ')');

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

      const taskName = normalizeSubject(subject);
      console.log('Task name:', taskName);

      console.log('Creating Monday.com item...');
      const mondayItem = await monday.createItem({
        name: taskName,
        dueDate: formattedDueDate,
        ownerIds: [user.mondayId],
        taskType: taskType,
        source: 'Forwarding Tasks',
        team: analysisResult.team ?? undefined,
      });
      console.log('Monday item created:', mondayItem.id);

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

      if (initialUpdateParts.length > 0) {
        console.log('Creating initial Monday update...');
        await monday.createUpdate(mondayItem.id, initialUpdateParts.join('\n\n'));
      }

      if (!analysisResult.team) {
        await monday.createUpdate(
          mondayItem.id,
          '⚠️ Team not identified. Please update the Team field if this relates to a specific sports team.'
        );
      }

      // Check for /scan command in body text
      const { shouldScanForRecipients, findRelatedRecipients, formatRecipientSubtaskName } = await import('../services/gmail.js');
      const { shouldCreateSheet, createRecipientSheet } = await import('../services/sheets.js');

      let sheetUrl: string | null = null;
      const scanDetected = shouldScanForRecipients(bodyText);
      console.log('=== /SCAN DETECTION ===');
      console.log('shouldScanForRecipients result:', scanDetected);
      console.log('bodyText for scan check:', JSON.stringify(bodyText));

      if (scanDetected) {
        console.log('/scan detected - searching for related recipients...');
        try {
          const recipients = await findRelatedRecipients(subject);
          if (recipients.length > 0) {
            console.log(`Found ${recipients.length} related recipients, creating subtasks...`);
            const subtaskNames = recipients.map(r => formatRecipientSubtaskName(r));
            await monday.createSubitems(mondayItem.id, subtaskNames);
            console.log(`Created ${subtaskNames.length} subtasks`);

            // Create Google Sheet if subject matches presale/relocation/selection
            if (shouldCreateSheet(subject)) {
              console.log('Creating Google Sheet for recipient tracking...');
              try {
                const sheetResult = await createRecipientSheet(subject, recipients);
                sheetUrl = sheetResult.spreadsheetUrl;
                console.log('Google Sheet created:', sheetUrl);
                await monday.createUpdate(
                  mondayItem.id,
                  `📊 Recipient tracking sheet: ${sheetUrl}`
                );
              } catch (sheetError) {
                console.error('Failed to create Google Sheet:', sheetError);
              }
            }
          } else {
            console.log('No related recipients found in the last 48 hours');
          }
        } catch (scanError) {
          console.error('/scan failed:', scanError);
          // Don't fail the whole workflow if scan fails
        }
      } else {
        console.log('/scan NOT detected in body text');
      }

      console.log('Sending Slack notification...');
      const slackMessage = await slack.sendNotification({
        taskType: taskType,
        subject: taskName,
        assigneeSlackId: user.slackId || user.name,
        assigneeName: user.name,
        dueDate: formatDateForDisplay(formattedDueDate),
        priority: analysisResult.priority,
        notes: analysisResult.notes,
        fromEmail: fromEmail,
        toEmail: toEmail,
        mondayItemId: mondayItem.id,
        meeting: analysisResult.meeting,
      });
      console.log('Slack message sent:', slackMessage.ts);

      if (pdfBuffer) {
        console.log('Uploading PDF to Monday and Slack...');

        try {
          await slack.uploadFileToThread(slackMessage.ts, pdfFilename, pdfBuffer, 'Email PDF');
          console.log('PDF uploaded to Slack');
        } catch (slackErr) {
          console.error('Slack PDF upload failed:', slackErr);
        }

        try {
          await monday.uploadFileToItem(mondayItem.id, pdfFilename, pdfBuffer);
          console.log('PDF uploaded to Monday');
        } catch (mondayErr) {
          console.error('Monday PDF upload failed (non-fatal):', mondayErr);
        }
      }

      await monday.updateSlackThreadId(mondayItem.id, slackMessage.ts);

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

export default router;
