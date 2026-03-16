/**
 * Triage API Routes
 *
 * REST endpoints for the Salem Triage iOS/macOS app.
 * Two-step flow: review (AI analysis) → create (Monday + Slack).
 *
 * Auth: Bearer token matching CORE_API_KEY
 */

import express, { Router, type Request, type Response } from 'express';
import { config } from '../config/environment.js';
import { analyzeEmailSafe, type AnalysisResult } from '../services/claude.js';
import { google as coreApiGoogle } from '../services/coreApi.js';
import { normalizeSubject, findRelatedRecipients, enrichRecipientsWithAppointments } from '../services/gmail.js';
import { createScanSheet, detectContentType, batchLookupAccountsForScan } from '../services/sheets.js';
import * as calendar from '../services/calendar.js';
import { findUserByName, findUserByMondayId } from '../services/userResolver.js';
import { getTaskTypeDisplayName } from '../config/taskTypes.js';
import { parseDate, formatDateForDisplay, isAsapDate } from '../utils/dateParser.js';
import { formatTaskName } from '../utils/taskName.js';
import { mapPriorityToUrgency, createLogger, postRunIdToSlack, applyIntentModeWithLogging } from '../workflows/shared.js';
import * as monday from '../services/monday.js';
import * as slack from '../services/slack.js';
import { randomUUID } from 'crypto';

const router = Router();
router.use(express.json());

// ============================================================================
// Auth Middleware
// ============================================================================

function verifyApiKey(req: Request, res: Response): boolean {
  const authHeader = req.headers.authorization;
  const expectedKey = config.coreApi.apiKey;

  if (!expectedKey) {
    console.error('[Triage API] CORE_API_KEY not configured');
    res.status(500).json({ error: 'Server misconfigured' });
    return false;
  }

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return false;
  }

  const token = authHeader.slice(7);
  if (token !== expectedKey) {
    res.status(401).json({ error: 'Invalid API key' });
    return false;
  }

  return true;
}

// ============================================================================
// Helpers
// ============================================================================

function extractEmailBody(payload: any): string {
  if (!payload) return '';

  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }

  if (payload.mimeType === 'text/html' && payload.body?.data) {
    const html = Buffer.from(payload.body.data, 'base64').toString('utf-8');
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      const text = extractEmailBody(part);
      if (text) return text;
    }
  }

  return '';
}

function getHeader(headers: Array<{ name?: string; value?: string }>, name: string): string | null {
  const header = headers.find(h => h.name?.toLowerCase() === name.toLowerCase());
  return header?.value ?? null;
}

// ============================================================================
// POST /tasks/review
// ============================================================================

interface ReviewRequestBody {
  messageId: string;
  notes: string;
}

router.post('/tasks/review', async (req: Request, res: Response): Promise<void> => {
  if (!verifyApiKey(req, res)) return;

  const { messageId, notes } = req.body as ReviewRequestBody;

  if (!messageId) {
    res.status(400).json({ error: 'messageId is required' });
    return;
  }

  try {
    // Fetch the email from Gmail via core-api
    const msg = await coreApiGoogle.gmail.getMessage(messageId, 'full');
    const headers = msg.payload?.headers ?? [];

    const subject = getHeader(headers, 'subject') ?? '(no subject)';
    const fromEmail = getHeader(headers, 'from');
    const toEmail = getHeader(headers, 'to');
    const bodyText = extractEmailBody(msg.payload);

    // Combine user notes with body for AI analysis
    const analysisBody = notes
      ? `Instructions from user: ${notes}\n\n${bodyText}`
      : bodyText;

    // Run Claude AI analysis
    const analysis: AnalysisResult = await analyzeEmailSafe(
      subject,
      analysisBody,
      subject,
      fromEmail,
      toEmail,
      bodyText
    );

    // Resolve owner
    const ownerUser = await findUserByName(analysis.owner);

    // Resolve task type
    const taskType = getTaskTypeDisplayName(analysis.taskType);

    // Parse due date
    let dueDate: string | null = parseDate(analysis.dueDate);
    const asapDetected = isAsapDate(analysis.dueDate);
    if (asapDetected) {
      dueDate = null;
    }

    // Map priority to urgency
    const urgency = asapDetected ? 'High' : mapPriorityToUrgency(analysis.priority);

    // Build task name (no [Team] prefix — team shown as separate field in triage app)
    const taskName = normalizeSubject(subject);

    // Resolve supporters
    const supporters: Array<{ mondayId: string; name: string }> = [];
    for (const supporterName of analysis.supporters) {
      const supporterUser = await findUserByName(supporterName);
      if (supporterUser) {
        supporters.push({
          mondayId: supporterUser.mondayId.toString(),
          name: supporterUser.name,
        });
      }
    }

    // Detect missing fields
    const missingFields: Array<{ field: string; question: string; suggestions: string[] }> = [];
    if (!ownerUser) {
      missingFields.push({
        field: 'owner',
        question: `Could not resolve owner "${analysis.owner}". Who should this be assigned to?`,
        suggestions: [],
      });
    }

    res.json({
      taskName,
      owner: ownerUser
        ? { mondayId: ownerUser.mondayId.toString(), name: ownerUser.name }
        : null,
      dueDate,
      taskType,
      taskTypeConfident: analysis.confidence >= 0.7,
      urgency,
      team: analysis.team ?? null,
      supporters: supporters.length > 0 ? supporters : null,
      cleanedNotes: analysis.notes || notes || '',
      typoFixes: null,
      missingFields: missingFields.length > 0 ? missingFields : null,
    });
  } catch (error) {
    console.error('[Triage API] Review failed:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Review failed',
    });
  }
});

// ============================================================================
// POST /tasks/from-email
// ============================================================================

interface CreateRequestBody {
  messageId: string;
  taskName: string;
  ownerId: string;
  dueDate: string | null;
  taskType: string;
  urgency: string;
  team: string | null;
  supporterIds: string[] | null;
  notes: string;
}

router.post('/tasks/from-email', async (req: Request, res: Response): Promise<void> => {
  if (!verifyApiKey(req, res)) return;

  const body = req.body as CreateRequestBody;

  if (!body.taskName || !body.ownerId || !body.taskType || !body.urgency) {
    res.status(400).json({ error: 'taskName, ownerId, taskType, and urgency are required' });
    return;
  }

  const runId = randomUUID();
  const log = createLogger(runId);

  try {
    log.log('Triage task creation started:', body.taskName);

    // Resolve owner by Monday ID
    const ownerId = parseInt(body.ownerId, 10);
    if (isNaN(ownerId)) {
      res.status(400).json({ error: 'ownerId must be a numeric Monday.com user ID' });
      return;
    }

    const ownerUser = await findUserByMondayId(ownerId);
    if (!ownerUser) {
      res.status(400).json({ error: `Unknown Monday.com user ID: ${body.ownerId}` });
      return;
    }

    // Fetch the original email for context
    let fromEmail: string | null = null;
    let toEmail: string | null = null;
    let emailDate = new Date();

    if (body.messageId) {
      try {
        const msg = await coreApiGoogle.gmail.getMessage(body.messageId, 'metadata');
        const headers = msg.payload?.headers ?? [];
        fromEmail = getHeader(headers, 'from');
        toEmail = getHeader(headers, 'to');
        const dateHeader = getHeader(headers, 'date');
        if (dateHeader) {
          const parsed = new Date(dateHeader);
          if (!isNaN(parsed.getTime())) {
            emailDate = parsed;
          }
        }
      } catch (err) {
        log.warn('Could not fetch email metadata (non-fatal):', err);
      }
    }

    // Resolve support user IDs
    const supportMondayIds: number[] = [];
    const supportSlackIds: string[] = [];
    if (body.supporterIds && body.supporterIds.length > 0) {
      for (const sid of body.supporterIds) {
        const supportId = parseInt(sid, 10);
        if (!isNaN(supportId)) {
          const supportUser = await findUserByMondayId(supportId);
          if (supportUser) {
            supportMondayIds.push(supportUser.mondayId);
            if (supportUser.slackId) {
              supportSlackIds.push(supportUser.slackId);
            }
          }
        }
      }
    }

    // Create Monday.com item (add [Team] prefix for Monday board visibility)
    const mondayTaskName = formatTaskName(body.taskName, body.team);
    log.log('Creating Monday.com item...');
    const mondayItem = await monday.createItem({
      name: mondayTaskName,
      dueDate: body.dueDate ?? null,
      ownerIds: [ownerId],
      supportIds: supportMondayIds.length > 0 ? supportMondayIds.map(id => id.toString()) : undefined,
      taskType: body.taskType,
      source: 'Triage App',
      team: body.team ?? undefined,
      urgency: body.urgency as 'High' | 'Medium' | 'Low',
    });
    log.log('Monday item created:', mondayItem.id);

    // Store Run ID
    await monday.storeRunId(mondayItem.id, runId);

    // Create Monday update with context
    const updateParts: string[] = [];
    if (body.notes) {
      updateParts.push(`📝 ${body.notes}`);
    }
    if (fromEmail) {
      updateParts.push(`📧 From: ${fromEmail}`);
    }
    if (toEmail) {
      updateParts.push(`📬 To: ${toEmail}`);
    }
    updateParts.push(`📅 Email Date: ${emailDate.toLocaleString('en-US', { timeZone: 'America/New_York' })}`);
    updateParts.push(`🔗 Run ID: ${runId.substring(0, 8)}`);
    updateParts.push(`📱 Created from Salem Triage`);

    await monday.createUpdate(mondayItem.id, updateParts.join('\n\n'));

    if (!body.team) {
      await monday.createUpdate(mondayItem.id, '⚠️ Team not identified. Please update the Team field if this relates to a specific sports team.');
    }

    // Apply intent-driven mode
    await applyIntentModeWithLogging(mondayItem.id, body.taskType, body.taskName, log);

    // Send Slack notification
    const priorityMap: Record<string, 'high' | 'medium' | 'low'> = {
      High: 'high',
      Medium: 'medium',
      Low: 'low',
    };
    const priority = priorityMap[body.urgency] ?? 'medium';

    log.log('Sending Slack notification...');
    const slackMessage = await slack.sendNotification({
      taskType: body.taskType,
      subject: body.taskName,
      assigneeSlackId: ownerUser.slackId || ownerUser.name,
      assigneeName: ownerUser.name,
      supportSlackIds: supportSlackIds.length > 0 ? supportSlackIds : undefined,
      dueDate: formatDateForDisplay(body.dueDate),
      priority,
      notes: body.notes,
      fromEmail,
      toEmail,
      mondayItemId: mondayItem.id,
      team: body.team ?? undefined,
    });
    log.log('Slack message sent:', slackMessage.ts);

    await postRunIdToSlack(slackMessage.ts, runId);
    await monday.updateSlackThreadId(mondayItem.id, slackMessage.ts);

    log.log('Triage task creation completed!');

    res.json({
      success: true,
      mondayItemId: mondayItem.id,
      mondayItemUrl: monday.getItemUrl(mondayItem.id),
      slackMessageTs: slackMessage.ts,
      error: null,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error('Triage task creation failed:', errorMessage);
    res.status(500).json({
      success: false,
      mondayItemId: null,
      mondayItemUrl: null,
      slackMessageTs: null,
      error: errorMessage,
    });
  }
});

// ============================================================================
// POST /tasks/scan
// ============================================================================

router.post('/tasks/scan', async (req: Request, res: Response): Promise<void> => {
  if (!verifyApiKey(req, res)) return;

  const { messageId, instructions, skipSheet, skipCalendar } = req.body as {
    messageId: string;
    instructions?: string;
    skipSheet?: boolean;
    skipCalendar?: boolean;
  };

  if (!messageId) {
    res.status(400).json({ success: false, error: 'messageId is required' });
    return;
  }

  try {
    // 1. Fetch email subject
    const msg = await coreApiGoogle.gmail.getMessage(messageId, 'metadata');
    const subject = getHeader(msg.payload?.headers ?? [], 'subject') ?? '';

    // 2. Detect content type
    const contentType = detectContentType(subject);
    const extractCodesAndLinks = contentType === 'presale';

    // 3. Find related recipients
    const scannedRecipients = await findRelatedRecipients(subject, {
      extractCodesAndLinks,
      instructions,
    });

    if (scannedRecipients.length === 0) {
      res.json({ success: true, recipientCount: 0, sheetUrl: null, calendarEventCount: 0, recipients: [] });
      return;
    }

    // 4. Look up account info from sport-specific sheets (skip if no sheet needed)
    let accountInfo: Map<string, import('../services/sheets.js').ScanAccountInfo> | undefined;
    if (!skipSheet) {
      try {
        accountInfo = await batchLookupAccountsForScan(
          subject,
          scannedRecipients.map(r => r.email)
        );
        console.log(`[Triage Scan] Account lookup: ${accountInfo.size} accounts matched`);
      } catch (accountError) {
        console.error('[Triage Scan] Account lookup failed (non-fatal):', accountError);
      }
    }

    // 5. Enrich recipients with appointment times
    const enrichedRecipients = await enrichRecipientsWithAppointments(subject, scannedRecipients, instructions);
    const recipientsWithTimes = enrichedRecipients.filter(r => r.rawDateTime);

    // 6. Create scan sheet with account info (unless skipped)
    let sheetUrl: string | null = null;
    if (!skipSheet) {
      const sheetResult = await createScanSheet({
        title: subject,
        recipients: enrichedRecipients,
        contentType,
        accountInfo,
      });
      sheetUrl = sheetResult.spreadsheetUrl;
    }

    // 7. Create calendar events (unless skipped)
    let calendarEventCount = 0;
    if (!skipCalendar && calendar.isCalendarEnabled() && recipientsWithTimes.length > 0) {
      try {
        const calendarEvents = await calendar.createScanAppointmentEvents(
          subject,
          enrichedRecipients,
          "",  // no mondayItemId in this context
          sheetUrl ?? ""
        );
        calendarEventCount = calendarEvents.length;
        console.log(`[Triage Scan] Created ${calendarEventCount} calendar events`);
      } catch (calendarError) {
        console.error('[Triage Scan] Calendar events failed (non-fatal):', calendarError);
      }
    }

    // Build recipient summary for client
    const recipientSummary = enrichedRecipients.map(r => ({
      email: r.email,
      appointmentDate: r.appointmentDate,
      appointmentTime: r.appointmentTime,
      code: r.code,
      custom: r.custom,
    }));

    res.json({
      success: true,
      recipientCount: enrichedRecipients.length,
      sheetUrl,
      calendarEventCount,
      recipients: recipientSummary,
    });
  } catch (error) {
    console.error('[Triage API] Scan failed:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Scan failed',
    });
  }
});

export default router;
