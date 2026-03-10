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
import { normalizeSubject, findRelatedRecipients } from '../services/gmail.js';
import { createScanSheet, detectContentType } from '../services/sheets.js';
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

    // Build task name
    const taskName = formatTaskName(normalizeSubject(subject), analysis.team);

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

    // Create Monday.com item
    log.log('Creating Monday.com item...');
    const mondayItem = await monday.createItem({
      name: body.taskName,
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

  const { messageId } = req.body as { messageId: string };

  if (!messageId) {
    res.status(400).json({ success: false, error: 'messageId is required' });
    return;
  }

  try {
    // Fetch email subject
    const msg = await coreApiGoogle.gmail.getMessage(messageId, 'metadata');
    const subject = getHeader(msg.payload?.headers ?? [], 'subject') ?? '';

    // Detect content type
    const contentType = detectContentType(subject);
    const extractCodesAndLinks = contentType === 'presale';

    // Find related recipients
    const recipients = await findRelatedRecipients(subject, { extractCodesAndLinks });

    if (recipients.length === 0) {
      res.json({ success: true, recipientCount: 0, sheetUrl: null });
      return;
    }

    // Create scan sheet
    const sheet = await createScanSheet({ title: subject, recipients, contentType });

    res.json({
      success: true,
      recipientCount: recipients.length,
      sheetUrl: sheet.spreadsheetUrl,
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
