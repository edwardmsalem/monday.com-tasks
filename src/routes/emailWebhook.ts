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
    fileSize: 75 * 1024 * 1024, // 75MB max file size
    fieldSize: 75 * 1024 * 1024, // 75MB max field value size (for pdfData base64 which inflates ~33%)
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
      date: null,
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
      date: null,
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
      const { formatTaskName } = await import('../utils/taskName.js');
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

      // Resolve supporters (if any)
      const supportUsers: Array<{ mondayId: string; slackId: string | null; name: string }> = [];
      if (analysisResult.supporters && analysisResult.supporters.length > 0) {
        console.log('Resolving supporters:', analysisResult.supporters);
        for (const supporterName of analysisResult.supporters) {
          const supporter = await findUserByName(supporterName);
          if (supporter) {
            supportUsers.push({
              mondayId: String(supporter.mondayId),
              slackId: supporter.slackId,
              name: supporter.name,
            });
            console.log('Resolved supporter:', supporter.name, 'Monday ID:', supporter.mondayId);
          } else {
            console.warn(`Could not resolve supporter: ${supporterName}`);
          }
        }
      }

      const taskName = formatTaskName(normalizeSubject(subject), analysisResult.team);
      console.log('Task name:', taskName);

      console.log('Creating Monday.com item...');
      const mondayItem = await monday.createItem({
        name: taskName,
        dueDate: formattedDueDate,
        ownerIds: [user.mondayId],
        supportIds: supportUsers.map(u => u.mondayId),
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

      // Check for /scan command in body text (now also matches /scantimes - merged behavior)
      const { shouldScanForRecipients, findRelatedRecipients, enrichRecipientsWithAppointments } = await import('../services/gmail.js');
      const { createScanSheet, detectContentType, batchLookupAccountsForScan } = await import('../services/sheets.js');

      // Just detect if scan is needed - we'll run it AFTER sending the response
      const scanDetected = shouldScanForRecipients(bodyText);
      console.log('=== /SCAN DETECTION ===');
      console.log('shouldScanForRecipients result:', scanDetected);

      console.log('Sending Slack notification...');
      const supportSlackIds = supportUsers
        .filter(u => u.slackId)
        .map(u => u.slackId as string);
      const slackMessage = await slack.sendNotification({
        taskType: taskType,
        subject: taskName,
        assigneeSlackId: user.slackId || user.name,
        assigneeName: user.name,
        supportSlackIds: supportSlackIds,
        dueDate: formatDateForDisplay(formattedDueDate),
        priority: analysisResult.priority,
        notes: analysisResult.notes,
        fromEmail: fromEmail,
        toEmail: toEmail,
        mondayItemId: mondayItem.id,
        meeting: analysisResult.meeting,
        team: analysisResult.team ?? undefined,  // Include team in header if detected
      });
      console.log('Slack message sent:', slackMessage.ts);

      // Notify supporters in their respective channels
      if (supportUsers.length > 0) {
        console.log(`Notifying ${supportUsers.length} supporter(s) in their channels...`);
        for (const supporter of supportUsers) {
          if (supporter.slackId) {
            try {
              await slack.notifySupporterInChannel(
                supporter.slackId,
                supporter.name,
                {
                  taskSubject: taskName,
                  taskType: taskType,
                  ownerName: user.name,
                  dueDate: formatDateForDisplay(formattedDueDate),
                  priority: analysisResult.priority,
                  notes: analysisResult.notes || undefined,
                },
                slackMessage.ts,
                mondayItem.id
              );
            } catch (err) {
              console.warn(`Failed to notify supporter ${supporter.name} in their channel`);
            }
          }
        }
      }

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

      console.log('Workflow completed successfully - sending response to Make.com');

      // Send response FIRST so Make.com doesn't timeout
      res.json({
        success: true,
        mondayItemId: mondayItem.id,
        slackThreadTs: slackMessage.ts,
      });

      // Run scan AFTER response is sent (async, won't block Make.com)
      if (scanDetected) {
        console.log('/scan detected - running scan in background...');
        setImmediate(async () => {
          try {
            const contentType = detectContentType(subject);
            const extractCodesAndLinks = contentType === 'presale';
            console.log(`[Background Scan] Content type: ${contentType}, extracting codes/links: ${extractCodesAndLinks}`);

            // STEP 1: Get recipients FAST (skip appointment extraction)
            const scannedRecipients = await findRelatedRecipients(subject, {
              extractCodesAndLinks,
              skipAppointmentExtraction: true, // Get emails first, appointments later
            });

            if (scannedRecipients.length === 0) {
              console.log('[Background Scan] No related recipients found in the last 48 hours');
              return;
            }

            console.log(`[Background Scan] Found ${scannedRecipients.length} related recipients`);

            // STEP 2: Post email list and lookup account info in parallel
            const teamName = analysisResult.team || 'this team';
            const teamForTitle = analysisResult.team || 'Team';

            // Lookup account info from sport sheets (single API call)
            let accountInfo: Map<string, import('../services/sheets.js').ScanAccountInfo> | undefined;
            try {
              accountInfo = await batchLookupAccountsForScan(
                teamForTitle,
                scannedRecipients.map(r => r.email)
              );
              console.log(`[Background Scan] Account lookup: ${accountInfo.size} accounts matched`);
            } catch (accountErr) {
              console.error('[Background Scan] Failed to lookup accounts:', accountErr);
            }

            try {
              const emailList = scannedRecipients.map(r => {
                const account = accountInfo?.get(r.email.toLowerCase());
                const info = account ? ` (${account.name}${account.seats ? ' - ' + account.seats : ''})` : '';
                return `• ${r.email}${info}`;
              }).join('\n');
              const scanMessage = `📧 *Scanned ${scannedRecipients.length} email addresses* (from forwarded emails in the last 14 days):\n\n${emailList}\n\n⚠️ _Note: Some emails may not have been forwarded. Please verify against all accounts for ${teamName}._`;
              await slack.postToThread(slackMessage.ts, scanMessage);
              console.log('[Background Scan] Posted email list to Slack thread');
            } catch (threadErr) {
              console.error('[Background Scan] Failed to post email list:', threadErr);
            }

            // STEP 3: Create Google Sheet with emails and account info
            let sheetUrl = '';
            try {
              const sheetResult = await createScanSheet({
                title: teamForTitle,
                recipients: scannedRecipients,
                contentType,
                accountInfo,
              });
              sheetUrl = sheetResult.spreadsheetUrl;
              console.log('[Background Scan] Google Sheet created:', sheetUrl);
              await monday.createUpdate(
                mondayItem.id,
                `📊 Recipient tracking spreadsheet created:\n${sheetUrl}`
              );
            } catch (sheetError) {
              console.error('[Background Scan] Failed to create sheet:', sheetError);
            }

            // STEP 4: NOW extract appointment times (slow, uses Claude)
            console.log('[Background Scan] Extracting appointment times...');
            const enrichedRecipients = await enrichRecipientsWithAppointments(subject, scannedRecipients);
            const recipientsWithTimes = enrichedRecipients.filter(r => r.appointmentDate || r.appointmentTime);

            // STEP 5: Post appointment times if found
            if (recipientsWithTimes.length > 0) {
              try {
                const timesMessage = recipientsWithTimes.map(r => {
                  const timeStr = [r.appointmentDate, r.appointmentTime].filter(Boolean).join(' ');
                  const account = accountInfo?.get(r.email.toLowerCase());
                  const nameStr = account?.name ? ` (${account.name})` : '';
                  return `• ${r.email}${nameStr} - ${timeStr}`;
                }).join('\n');
                await slack.postToThread(slackMessage.ts, `📅 *Appointment times found:*\n\n${timesMessage}`);
                console.log(`[Background Scan] Posted ${recipientsWithTimes.length} appointment times`);
              } catch (timesErr) {
                console.error('[Background Scan] Failed to post appointment times:', timesErr);
              }

              // Update the sheet with appointment times + account info
              if (sheetUrl) {
                try {
                  await createScanSheet({
                    title: teamForTitle,
                    recipients: enrichedRecipients,
                    contentType,
                    accountInfo,
                  });
                  console.log('[Background Scan] Updated sheet with appointment times');
                } catch (updateErr) {
                  console.error('[Background Scan] Failed to update sheet with times:', updateErr);
                }
              }
            }

            // STEP 6: Create calendar events if we have appointment times
            let calendarEventCount = 0;
            const calendar = await import('../services/calendar.js');
            if (calendar.isCalendarEnabled() && recipientsWithTimes.length > 0) {
              console.log('[Background Scan] Creating calendar events...');
              try {
                const calendarEvents = await calendar.createScanAppointmentEvents(
                  teamForTitle,
                  enrichedRecipients,
                  mondayItem.id,
                  sheetUrl
                );
                calendarEventCount = calendarEvents.length;
                if (calendarEvents.length > 0) {
                  console.log(`[Background Scan] Created ${calendarEvents.length} calendar events`);
                  await monday.createUpdate(
                    mondayItem.id,
                    `📅 Created ${calendarEvents.length} calendar event(s) for appointments`
                  );
                }
              } catch (calendarError) {
                console.error('[Background Scan] Failed to create calendar events:', calendarError);
              }
            }

            // STEP 7: Post final summary
            try {
              const scanSummaryText = [
                `✅ *Scan Complete*`,
                `• ${scannedRecipients.length} accounts found`,
                recipientsWithTimes.length > 0
                  ? `• ${recipientsWithTimes.length} with appointment times`
                  : `• No appointment times found`,
                calendarEventCount > 0
                  ? `• ${calendarEventCount} calendar event(s) created`
                  : null,
                sheetUrl ? `• <${sheetUrl}|View Tracking Sheet>` : null,
              ].filter(Boolean).join('\n');
              await slack.postToThread(slackMessage.ts, scanSummaryText);
              console.log('[Background Scan] Posted scan summary to Slack thread');
            } catch (summaryError) {
              console.error('[Background Scan] Failed to post scan summary:', summaryError);
            }

            console.log('[Background Scan] Scan completed successfully!');
          } catch (scanError) {
            console.error('[Background Scan] Scan failed:', scanError);
          }
        });
      }
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
// /test-scan-sheet - Test endpoint for scan sheet creation with account data
// ============================================================================

/**
 * Test endpoint to verify scan sheet creation with account data pull.
 * Creates a test sheet with real account data from sport sheets.
 * Does NOT create calendar events, Gmail search, or Slack messages.
 *
 * Usage: GET /test-scan-sheet?team=dolphins&emails=test1@example.com,test2@example.com
 *
 * If no emails provided, uses first 3 accounts from the team sheet.
 */
router.get('/test-scan-sheet', async (req: Request, res: Response): Promise<void> => {
  try {
    const team = req.query.team as string;
    if (!team) {
      res.status(400).json({ error: 'Missing required query param: team' });
      return;
    }

    const emailsParam = req.query.emails as string;
    let emails: string[] = emailsParam ? emailsParam.split(',').map(e => e.trim()) : [];

    console.log(`[Test] Starting test-scan-sheet for team="${team}", emails=${emails.length > 0 ? emails.join(', ') : '(auto)'}`);

    // Import sheets service
    const sheets = await import('../services/sheets.js');

    // If no emails provided, fetch team accounts and use first few
    if (emails.length === 0) {
      console.log('[Test] No emails provided, fetching team accounts to get test emails...');
      const teamResult = await sheets.lookupTeamAccounts(team);
      if (!teamResult.success) {
        res.status(400).json({ error: `Failed to lookup team: ${teamResult.error}` });
        return;
      }

      // Find email column and extract first 3 emails
      const headers = teamResult.headers;
      const emailIdx = headers.findIndex(h =>
        h.toLowerCase().includes('email') || h.toLowerCase().includes('e-mail')
      );
      if (emailIdx === -1) {
        res.status(400).json({ error: 'No email column found in team sheet' });
        return;
      }

      emails = teamResult.accounts
        .slice(0, 5) // Get up to 5 accounts
        .map(acc => acc.rowData[emailIdx]?.trim())
        .filter(Boolean);

      console.log(`[Test] Using ${emails.length} emails from team sheet: ${emails.join(', ')}`);
    }

    // Pull account data using the real batchLookupAccountsForScan function
    console.log('[Test] Calling batchLookupAccountsForScan...');
    const accountInfo = await sheets.batchLookupAccountsForScan(team, emails);
    console.log(`[Test] Got account info for ${accountInfo.size} emails`);

    // Log the account data for debugging
    for (const [email, info] of accountInfo.entries()) {
      console.log(`[Test] Account ${email}:`);
      console.log(`  Name: ${info.name}`);
      console.log(`  Seats: ${info.seats.replace(/\n/g, ' | ')}`);
      console.log(`  Locations: ${info.seatLocations.length}`);
      console.log(`  Connecting: ${info.connecting || '(none)'}`);
    }

    // Create mock recipients with appointment times
    const now = new Date();
    const recipients = emails.map((email, idx) => {
      const apptTime = new Date(now.getTime() + idx * 30 * 60 * 1000);
      return {
        email,
        appointmentDate: apptTime.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
        appointmentTime: apptTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
        rawDateTime: apptTime.toISOString(),
        code: null,
        link: null,
      };
    });

    // Create the scan sheet
    console.log('[Test] Creating scan sheet...');
    const sheetResult = await sheets.createScanSheet({
      title: `TEST ${team}`,
      recipients,
      contentType: 'relocation',
      accountInfo,
    });

    console.log(`[Test] Created sheet: ${sheetResult.spreadsheetUrl}`);

    res.json({
      success: true,
      message: 'Test sheet created successfully',
      spreadsheetUrl: sheetResult.spreadsheetUrl,
      spreadsheetId: sheetResult.spreadsheetId,
      title: sheetResult.title,
      accountsMatched: accountInfo.size,
      emails,
    });
  } catch (error) {
    console.error('[Test] Error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
