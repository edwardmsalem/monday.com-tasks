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
import { google as coreApiGoogle, claude as coreApiClaude, getCachedConfig } from '../services/coreApi.js';
import { normalizeSubject, findRelatedRecipients, enrichRecipientsWithAppointments } from '../services/gmail.js';
import { createScanSheet, createCustomSheet, detectContentType, batchLookupAccountsForScan, backfillNoAppointmentSection, backfillPlanTypeAndPacks } from '../services/sheets.js';
import * as calendar from '../services/calendar.js';
import { detectEventType } from '../services/calendar.js';
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

function decodeHtmlEntities(text: string): string {
  let decoded = text;

  for (let i = 0; i < 3; i++) {
    const next = decoded
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&apos;/gi, "'")
      .replace(/&#39;/gi, "'")
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));

    if (next === decoded) break;
    decoded = next;
  }

  return decoded;
}

function extractEmailBody(payload: any): string {
  if (!payload) return '';

  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeHtmlEntities(Buffer.from(payload.body.data, 'base64').toString('utf-8'));
  }

  if (payload.mimeType === 'text/html' && payload.body?.data) {
    const html = Buffer.from(payload.body.data, 'base64').toString('utf-8');
    return decodeHtmlEntities(html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
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

export interface TaskReviewResult {
  taskName: string;
  owner: { mondayId: string; name: string } | null;
  dueDate: string | null;
  taskType: string;
  taskTypeConfident: boolean;
  urgency: 'High' | 'Medium' | 'Low';
  team: string | null;
  supporters: Array<{ mondayId: string; name: string }> | null;
  cleanedNotes: string;
  missingFields: Array<{ field: string; question: string; suggestions: string[] }> | null;
}

/** Extracted from /tasks/review so the same Claude review logic can be invoked
 *  in-process from other routes (e.g. the Slack claim-button handler). */
export async function reviewTaskForEmail(messageId: string, notes: string): Promise<TaskReviewResult> {
  const msg = await coreApiGoogle.gmail.getMessage(messageId, 'full');
  const headers = msg.payload?.headers ?? [];
  const subject = getHeader(headers, 'subject') ?? '(no subject)';
  const fromEmail = getHeader(headers, 'from');
  const toEmail = getHeader(headers, 'to');
  const bodyText = extractEmailBody(msg.payload);

  const analysisBody = notes
    ? `Instructions from user: ${notes}\n\n${bodyText}`
    : bodyText;

  const analysis: AnalysisResult = await analyzeEmailSafe(
    subject,
    analysisBody,
    subject,
    fromEmail,
    toEmail,
    bodyText
  );

  const ownerUser = await findUserByName(analysis.owner);
  const taskType = getTaskTypeDisplayName(analysis.taskType);

  let dueDate: string | null = parseDate(analysis.dueDate);
  const asapDetected = isAsapDate(analysis.dueDate);
  if (asapDetected) dueDate = null;

  const urgency = asapDetected ? 'High' : mapPriorityToUrgency(analysis.priority);
  const taskName = normalizeSubject(subject);

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

  const missingFields: Array<{ field: string; question: string; suggestions: string[] }> = [];
  if (!ownerUser) {
    missingFields.push({
      field: 'owner',
      question: `Could not resolve owner "${analysis.owner}". Who should this be assigned to?`,
      suggestions: [],
    });
  }

  return {
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
    missingFields: missingFields.length > 0 ? missingFields : null,
  };
}

router.post('/tasks/review', async (req: Request, res: Response): Promise<void> => {
  if (!verifyApiKey(req, res)) return;

  const { messageId, notes } = req.body as ReviewRequestBody;

  if (!messageId) {
    res.status(400).json({ error: 'messageId is required' });
    return;
  }

  try {
    const result = await reviewTaskForEmail(messageId, notes ?? '');
    res.json({ ...result, typoFixes: null });
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

  const { messageId, messageIds: rawMessageIds, teamName: clientTeamName, instructions, skipSheet, skipCalendar, eventName: clientEventName, sheetId: clientSheetId, extractCodes: clientExtractCodes, extractLinks: clientExtractLinks } = req.body as {
    messageId?: string;
    messageIds?: string[];
    teamName?: string;
    instructions?: string;
    skipSheet?: boolean;
    skipCalendar?: boolean;
    eventName?: string;
    sheetId?: string;
    extractCodes?: boolean;
    extractLinks?: boolean;
  };

  // Support both single messageId and array messageIds
  const allMessageIds: string[] = rawMessageIds?.length
    ? rawMessageIds
    : messageId ? [messageId] : [];

  if (allMessageIds.length === 0) {
    res.status(400).json({ success: false, error: 'messageId or messageIds is required' });
    return;
  }

  console.log(`[Triage Scan] Scanning ${allMessageIds.length} message(s)`);

  try {
    // 1. Fetch subjects and metadata for all messages
    const sportPrefixes = ['NBA', 'MLB', 'NFL', 'NHL', 'WNBA', 'MLS', 'NCAA'];
    let teamName = clientTeamName;
    let sportFromLabel: import('../services/sheets.js').Sport | undefined;
    const subjects: string[] = [];
    let allLabels: any[] | null = null;

    for (const msgId of allMessageIds) {
      const msg = await coreApiGoogle.gmail.getMessage(msgId, 'metadata');
      const subject = getHeader(msg.payload?.headers ?? [], 'subject') ?? '';
      subjects.push(subject);

      // Resolve sport prefix from labels (always check, even when client provides teamName —
      // we need the sport to route NCAA teams correctly since TEAM_SPORT_MAP lacks them).
      if (!sportFromLabel && msg.labelIds?.length) {
        try {
          if (!allLabels) allLabels = await coreApiGoogle.gmail.listLabels();
          const labelMap = new Map(allLabels!.map((l: any) => [l.id, l.name]));
          for (const labelId of msg.labelIds) {
            const labelName = labelMap.get(labelId);
            if (labelName) {
              const slashIdx = labelName.indexOf('/');
              if (slashIdx > 0) {
                const prefix = labelName.substring(0, slashIdx);
                if (sportPrefixes.includes(prefix)) {
                  sportFromLabel = prefix.toLowerCase() as import('../services/sheets.js').Sport;
                  if (!teamName) {
                    teamName = labelName.substring(slashIdx + 1);
                    console.log(`[Triage Scan] Resolved team from label: "${teamName}"`);
                  }
                  console.log(`[Triage Scan] Resolved sport from label: "${sportFromLabel}"`);
                  break;
                }
              }
            }
          }
        } catch (labelError) {
          console.warn('[Triage Scan] Label lookup failed:', labelError);
        }
      }
    }

    // Use first subject as primary for sheet title, event name, etc.
    const primarySubject = subjects[0];

    // If team still unresolved, try extracting from sender display name
    // (e.g. "Arizona Cardinals <noreply@paclive.com>" → "Arizona Cardinals")
    if (!teamName) {
      const firstMsg = await coreApiGoogle.gmail.getMessage(allMessageIds[0], 'metadata');
      const fromHeader = getHeader(firstMsg.payload?.headers ?? [], 'from') ?? '';
      const senderMatch = fromHeader.match(/^([^<]+)</);
      if (senderMatch) {
        const senderName = senderMatch[1].trim().replace(/^"|"$/g, '');
        if (senderName && senderName.length > 2 && senderName.length < 60) {
          teamName = senderName;
          console.log(`[Triage Scan] Resolved team from sender: "${teamName}"`);
        }
      }
    }

    const teamForLookup = teamName || primarySubject;
    console.log(`[Triage Scan] ${subjects.length} subjects, team: "${teamForLookup}"`);

    // 2. Detect content type from primary subject
    const contentType = detectContentType(primarySubject);
    // Explicit client flags OR'd with legacy instruction-text regex for backward compat
    const wantsCodes = clientExtractCodes === true || /password|code/i.test(instructions ?? '');
    const wantsLinks = clientExtractLinks === true || /login\s*(link|url)/i.test(instructions ?? '');
    const extractCodesAndLinks = wantsCodes || wantsLinks;

    // 3. Find related recipients across ALL subjects, dedup by email+time
    const recipientMap = new Map<string, import('../services/gmail.js').RecipientWithAppointment>();

    for (const subject of subjects) {
      const scanned = await findRelatedRecipients(subject, {
        extractCodesAndLinks,
        instructions,
      });
      const enriched = await enrichRecipientsWithAppointments(subject, scanned, instructions);

      for (const r of enriched) {
        const email = r.email.toLowerCase();
        const existing = recipientMap.get(email);
        if (!existing) {
          // New email — add it
          recipientMap.set(email, r);
        } else if (r.rawDateTime && r.rawDateTime !== existing.rawDateTime) {
          // Same email, different appointment time — keep the one with a time,
          // or if both have times and they differ, prefer the newer entry
          // (multi-subject means different events, keep latest)
          recipientMap.set(email, r);
        }
        // Same email, same time (or both null) — skip duplicate
      }
    }

    const enrichedRecipients = Array.from(recipientMap.values());
    console.log(`[Triage Scan] ${enrichedRecipients.length} unique recipients after cross-subject dedup`);

    if (enrichedRecipients.length === 0) {
      res.json({ success: true, recipientCount: 0, sheetUrl: null, calendarEventCount: 0, recipients: [] });
      return;
    }

    const recipientsWithTimes = enrichedRecipients.filter(r => r.rawDateTime);

    // 5. Look up account info (skip if no sheet needed)
    let accountInfo: Map<string, import('../services/sheets.js').ScanAccountInfo> | undefined;
    let allAccounts: Map<string, import('../services/sheets.js').ScanAccountInfo> | undefined;
    if (!skipSheet) {
      try {
        const lookupResult = await batchLookupAccountsForScan(
          teamForLookup,
          enrichedRecipients.map(r => r.email),
          clientSheetId,
          sportFromLabel
        );
        accountInfo = lookupResult.matched;
        allAccounts = lookupResult.allAccounts;
        console.log(`[Triage Scan] Account lookup: ${accountInfo.size} matched, ${allAccounts.size} total`);
      } catch (accountError) {
        console.error('[Triage Scan] Account lookup failed (non-fatal):', accountError);
      }
    }

    // 6. Create scan sheet (unless skipped)
    let sheetUrl: string | null = null;
    if (!skipSheet) {
      const sheetResult = await createScanSheet({
        title: primarySubject,
        recipients: enrichedRecipients,
        contentType,
        accountInfo,
        allAccounts,
        teamName,
      });
      sheetUrl = sheetResult.spreadsheetUrl;
    }

    // 7. Create calendar events (unless skipped)
    let calendarEventCount = 0;
    if (!skipCalendar && calendar.isCalendarEnabled() && recipientsWithTimes.length > 0) {
      try {
        let calendarEvents;
        if (clientEventName) {
          calendarEvents = await calendar.createScanAppointmentEventsWithName(
            clientEventName,
            recipientsWithTimes.map(r => ({ email: r.email, rawDateTime: r.rawDateTime! })),
            sheetUrl ?? ""
          );
        } else {
          calendarEvents = await calendar.createScanAppointmentEvents(
            teamForLookup,
            primarySubject,
            enrichedRecipients,
            "",
            sheetUrl ?? ""
          );
        }
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
      rawDateTime: r.rawDateTime ?? null,
      code: wantsCodes ? r.code : null,
      link: wantsLinks ? (r.link ?? null) : null,
      custom: r.custom,
    }));

    // Build proposed event name from primary subject
    const currentYear = new Date().getFullYear();
    const eventType = detectEventType(primarySubject);
    const proposedEventName = `${teamForLookup} ${eventType} ${currentYear}`;

    res.json({
      success: true,
      recipientCount: enrichedRecipients.length,
      sheetUrl,
      calendarEventCount,
      recipients: recipientSummary,
      proposedEventName,
    });
  } catch (error) {
    console.error('[Triage API] Scan failed:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Scan failed',
    });
  }
});

// ============================================================================
// POST /tasks/scan/calendar
// ============================================================================

router.post('/tasks/scan/calendar', async (req: Request, res: Response): Promise<void> => {
  if (!verifyApiKey(req, res)) return;

  const { eventName, recipients, sheetUrl } = req.body as {
    eventName: string;
    recipients: Array<{ email: string; rawDateTime: string }>;
    sheetUrl?: string;
  };

  if (!eventName || !recipients || recipients.length === 0) {
    res.status(400).json({ success: false, error: 'eventName and recipients are required' });
    return;
  }

  try {
    const events = await calendar.createScanAppointmentEventsWithName(
      eventName,
      recipients,
      sheetUrl
    );
    res.json({ success: true, calendarEventCount: events.length });
  } catch (error) {
    console.error('[Triage API] Calendar creation failed:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Calendar creation failed',
    });
  }
});

// ============================================================================
// POST /tasks/scan/backfill
// Retroactively add "No Appointment" section to an existing scan sheet
// ============================================================================

router.post('/tasks/scan/backfill', async (req: Request, res: Response): Promise<void> => {
  if (!verifyApiKey(req, res)) return;

  const { sheetUrl, teamName } = req.body as {
    sheetUrl: string;
    teamName: string;
  };

  if (!sheetUrl || !teamName) {
    res.status(400).json({ success: false, error: 'sheetUrl and teamName are required' });
    return;
  }

  try {
    const result = await backfillNoAppointmentSection(sheetUrl, teamName);
    res.json({ success: true, addedCount: result.addedCount });
  } catch (error) {
    console.error('[Triage API] Backfill failed:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Backfill failed',
    });
  }
});

// POST /tasks/scan/backfill-columns
// Adds Plan Type and Pack Members columns to a pre-existing scan sheet,
// and re-runs pack detection with the dupe-range fix.
router.post('/tasks/scan/backfill-columns', async (req: Request, res: Response): Promise<void> => {
  if (!verifyApiKey(req, res)) return;

  const { sheetUrl, teamName } = req.body as {
    sheetUrl: string;
    teamName: string;
  };

  if (!sheetUrl || !teamName) {
    res.status(400).json({ success: false, error: 'sheetUrl and teamName are required' });
    return;
  }

  try {
    const result = await backfillPlanTypeAndPacks(sheetUrl, teamName);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('[Triage API] Backfill columns failed:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Backfill columns failed',
    });
  }
});

// ============================================================================
// POST /tasks/closer-lookup
// ============================================================================

router.post('/tasks/closer-lookup', async (req: Request, res: Response): Promise<void> => {
  if (!verifyApiKey(req, res)) return;

  const { email } = req.body as { email?: string };

  if (!email) {
    res.status(400).json({ error: 'email is required' });
    return;
  }

  try {
    const closer = await monday.findCloserByEmail(email);

    if (!closer) {
      res.json({ closer: null, closerSlackId: null, ruzzellSlackId: null });
      return;
    }

    const closerUser = await findUserByName(closer);

    if (closerUser?.slackId) {
      // Closer is in Slack — return their Slack ID
      res.json({ closer: closerUser.name, closerSlackId: closerUser.slackId, ruzzellSlackId: null });
    } else {
      // Closer not in Slack — also resolve Ruzzell so client can @mention him
      const ruzzellUser = await findUserByName('Ruzzell');
      res.json({
        closer: closerUser?.name ?? closer,
        closerSlackId: null,
        ruzzellSlackId: ruzzellUser?.slackId ?? null,
      });
    }
  } catch (error) {
    console.error('[Triage API] Closer lookup failed:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Closer lookup failed',
    });
  }
});

// ============================================================================
// POST /tasks/ai-chat
// AI command center with Claude tool-use
// ============================================================================

const AI_CHAT_SYSTEM_PROMPT = `You are the AI assistant for Salem Triage, a ticket brokerage email management app for Salem Seats LLC.

CAPABILITIES:
- Search and analyze emails
- Manage Gmail filters (create, update, delete, preview)
- Bulk operations (archive, mark read, trash)
- Create Monday.com tasks from emails
- Share emails to Slack channels
- Draft email replies (saved as Gmail drafts — user sends manually)
- Analyze email attachments (PDFs, documents, spreadsheets)
- Fix email classification errors

RULES:
- Write operations (anything that changes data) MUST be returned as proposed actions. Never execute without user confirmation.
- Before bulk operations, always search first to show the user what will be affected (count + sample).
- Before creating filters, always preview to show match count.
- For draft replies, always get the full email detail first so the reply is contextual.
- When analyzing attachments, use get_attachment_content — it extracts text from PDFs and documents.
- Use tables for lists of 3+ items. Include sender, subject, date.
- Be concise and business-focused. This is a ticket brokerage — emails are about season tickets, transfers, orders, gameday, and newsletters.

EFFICIENCY:
- When you need details from 3+ emails, use get_emails_bulk instead of calling get_email_detail one at a time.
- Always produce a final text response. If you extracted data, summarize it.

SHEET CREATION (create_sheet_from_emails):
When the user asks for a "sheet" or "spreadsheet" from emails:
1. Call get_email_detail on ONE sample email to understand the body format
2. Describe the format in plain English in the extractionPrompt — what headers to check, what the body structure looks like, how to group/transform data
3. Call create_sheet_from_emails with: title, all messageIds, column headers, and the extractionPrompt
4. The server fetches all emails in parallel, sends all bodies to Claude in ONE batch extraction call, and creates the Google Sheet
- Be specific in extractionPrompt about the email format you observed (HTML tables, specific fields, grouping logic)
- Example: "Each email has an HTML table with SECTION, ROW, SEAT#, PLAN columns. The recipient email is in the X-Forwarded-For header. Group consecutive seats in the same section+row into packs with low seat, high seat, and quantity."

TRIAGE PATTERNS:
- "What needs my attention?" → search unread, summarize by urgency/team
- "Catch me up on [team]" → search by team + recent dates, summarize threads
- "Archive all [category]" → search, show count + sample, propose bulk_archive
- "Draft a reply" → get_email_detail first, then propose create_draft
- "Analyze the attachment" → get_attachment_content, summarize findings
- "Create a task" → propose create_task with extracted details
- "Share to Slack" → propose share_to_slack with channel and context
- "Make a sheet from emails" → get_email_detail on ONE sample, analyze body format, propose extract_and_create_sheet with regex patterns

CONTEXT:
- When messageIds are provided, those emails are the user's focus
- When no messageIds are provided, use search_emails to find relevant messages
- teamName provides the sports team context (e.g., "Cardinals", "Cubs")`;

// Tool definitions for Claude
const AI_TOOLS = [
  // ── Read-only tools (auto-execute) ──
  {
    name: 'list_gmail_filters',
    description: 'List all Gmail filters with their criteria and actions.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [] as string[],
    },
  },
  {
    name: 'preview_filter',
    description: 'Preview how many existing emails match a filter criteria. Always call this before creating or updating a filter.',
    input_schema: {
      type: 'object' as const,
      properties: {
        criteria: {
          type: 'object' as const,
          description: 'Gmail filter criteria',
          properties: {
            from: { type: 'string' as const, description: 'Sender email or pattern' },
            to: { type: 'string' as const, description: 'Recipient email or pattern' },
            subject: { type: 'string' as const, description: 'Subject contains' },
            query: { type: 'string' as const, description: 'Gmail search query' },
            negatedQuery: { type: 'string' as const, description: 'Exclude messages matching this query' },
            hasAttachment: { type: 'boolean' as const, description: 'Must have attachment' },
          },
        },
      },
      required: ['criteria'],
    },
  },
  {
    name: 'search_emails',
    description: 'Search Gmail for emails matching a query. Returns subjects, senders, and dates.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string' as const, description: 'Gmail search query (e.g. "from:nfl.com", "subject:gameday", "is:unread")' },
        maxResults: { type: 'number' as const, description: 'Max results to return (default 10, max 50)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_email_detail',
    description: 'Get full email body + metadata for a single message. Use when you need to read the email content (e.g., before drafting a reply or analyzing content).',
    input_schema: {
      type: 'object' as const,
      properties: {
        messageId: { type: 'string' as const, description: 'Gmail message ID' },
      },
      required: ['messageId'],
    },
  },
  {
    name: 'get_attachment_content',
    description: 'Download and extract text from an email attachment. Supports PDFs, text files, and CSVs.',
    input_schema: {
      type: 'object' as const,
      properties: {
        messageId: { type: 'string' as const, description: 'Gmail message ID' },
        attachmentId: { type: 'string' as const, description: 'Attachment ID from the message' },
        filename: { type: 'string' as const, description: 'Original filename (used for content type detection)' },
      },
      required: ['messageId', 'attachmentId', 'filename'],
    },
  },
  {
    name: 'get_emails_bulk',
    description: 'Get full email body + metadata for multiple messages at once. Much faster than calling get_email_detail repeatedly. Use this when you need to read 3+ emails.',
    input_schema: {
      type: 'object' as const,
      properties: {
        messageIds: { type: 'array' as const, items: { type: 'string' as const }, description: 'Array of Gmail message IDs (max 50)' },
      },
      required: ['messageIds'],
    },
  },
  {
    name: 'get_inbox_summary',
    description: 'Get a summary of inbox state: unread count, starred count, and recent message breakdown by sender/team.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [] as string[],
    },
  },
  {
    name: 'get_classification',
    description: 'Get how a message is classified (filtered/inbox, reason, category).',
    input_schema: {
      type: 'object' as const,
      properties: {
        messageId: { type: 'string' as const, description: 'Gmail message ID' },
      },
      required: ['messageId'],
    },
  },
  // ── Write tools (proposed → confirmed) ──
  {
    name: 'create_gmail_filter',
    description: 'Create a new Gmail filter. Write operation — return as proposed action.',
    input_schema: {
      type: 'object' as const,
      properties: {
        criteria: {
          type: 'object' as const,
          properties: {
            from: { type: 'string' as const },
            to: { type: 'string' as const },
            subject: { type: 'string' as const },
            query: { type: 'string' as const },
            negatedQuery: { type: 'string' as const },
            hasAttachment: { type: 'boolean' as const },
          },
        },
        action: {
          type: 'object' as const,
          properties: {
            addLabelIds: { type: 'array' as const, items: { type: 'string' as const } },
            removeLabelIds: { type: 'array' as const, items: { type: 'string' as const } },
            shouldArchive: { type: 'boolean' as const, description: 'Skip the inbox (remove INBOX label)' },
            shouldMarkAsRead: { type: 'boolean' as const },
            shouldStar: { type: 'boolean' as const },
            shouldTrash: { type: 'boolean' as const },
            shouldNeverSpam: { type: 'boolean' as const },
          },
        },
        description: { type: 'string' as const, description: 'Human-readable description of what this filter does' },
        previewCount: { type: 'number' as const, description: 'Number of existing emails that match (from preview_filter)' },
      },
      required: ['criteria', 'action', 'description'],
    },
  },
  {
    name: 'update_gmail_filter',
    description: 'Update an existing Gmail filter (delete + recreate). Write operation — return as proposed action.',
    input_schema: {
      type: 'object' as const,
      properties: {
        filterId: { type: 'string' as const, description: 'ID of the filter to update' },
        criteria: { type: 'object' as const },
        action: { type: 'object' as const },
        description: { type: 'string' as const, description: 'Human-readable description of the change' },
      },
      required: ['filterId', 'criteria', 'action', 'description'],
    },
  },
  {
    name: 'delete_gmail_filter',
    description: 'Delete a Gmail filter. Write operation — return as proposed action.',
    input_schema: {
      type: 'object' as const,
      properties: {
        filterId: { type: 'string' as const, description: 'ID of the filter to delete' },
        description: { type: 'string' as const, description: 'Human-readable description of which filter is being deleted' },
      },
      required: ['filterId', 'description'],
    },
  },
  {
    name: 'bulk_mark_read',
    description: 'Mark multiple messages as read. Write operation — return as proposed action. Always search first to show what will be affected.',
    input_schema: {
      type: 'object' as const,
      properties: {
        messageIds: { type: 'array' as const, items: { type: 'string' as const }, description: 'Array of Gmail message IDs' },
        description: { type: 'string' as const, description: 'Human-readable description of what is being marked read' },
      },
      required: ['messageIds', 'description'],
    },
  },
  {
    name: 'bulk_archive',
    description: 'Archive multiple messages (remove from inbox). Write operation — return as proposed action. Always search first to show what will be affected.',
    input_schema: {
      type: 'object' as const,
      properties: {
        messageIds: { type: 'array' as const, items: { type: 'string' as const }, description: 'Array of Gmail message IDs' },
        description: { type: 'string' as const, description: 'Human-readable description of what is being archived' },
      },
      required: ['messageIds', 'description'],
    },
  },
  {
    name: 'bulk_trash',
    description: 'Move multiple messages to trash. Write operation — return as proposed action. Always search first to show what will be affected.',
    input_schema: {
      type: 'object' as const,
      properties: {
        messageIds: { type: 'array' as const, items: { type: 'string' as const }, description: 'Array of Gmail message IDs' },
        description: { type: 'string' as const, description: 'Human-readable description of what is being trashed' },
      },
      required: ['messageIds', 'description'],
    },
  },
  {
    name: 'create_draft',
    description: 'Create a Gmail draft reply to a message. The draft is saved — the user sends it manually. Write operation — return as proposed action.',
    input_schema: {
      type: 'object' as const,
      properties: {
        messageId: { type: 'string' as const, description: 'Gmail message ID to reply to' },
        body: { type: 'string' as const, description: 'The reply text (plain text)' },
        description: { type: 'string' as const, description: 'Brief summary of the draft content' },
      },
      required: ['messageId', 'body', 'description'],
    },
  },
  {
    name: 'create_task',
    description: 'Create a Monday.com task from an email. Write operation — return as proposed action.',
    input_schema: {
      type: 'object' as const,
      properties: {
        messageId: { type: 'string' as const, description: 'Gmail message ID to create task from' },
        taskName: { type: 'string' as const, description: 'Name for the task' },
        notes: { type: 'string' as const, description: 'Additional notes/instructions for the task' },
        description: { type: 'string' as const, description: 'Human-readable description of the task being created' },
      },
      required: ['messageId', 'taskName', 'description'],
    },
  },
  {
    name: 'share_to_slack',
    description: 'Share an email to a Slack channel. Write operation — return as proposed action.',
    input_schema: {
      type: 'object' as const,
      properties: {
        channelId: { type: 'string' as const, description: 'Slack channel ID' },
        messageId: { type: 'string' as const, description: 'Gmail message ID to share' },
        text: { type: 'string' as const, description: 'Optional context message to include with the share' },
        description: { type: 'string' as const, description: 'Human-readable description of what is being shared and where' },
      },
      required: ['channelId', 'messageId', 'description'],
    },
  },
  {
    name: 'correct_classification',
    description: 'Fix a misclassified email. Use when user says an email should be in inbox instead of filtered, or vice versa. Write operation — return as proposed action.',
    input_schema: {
      type: 'object' as const,
      properties: {
        messageId: { type: 'string' as const, description: 'Gmail message ID to correct' },
        correction: { type: 'string' as const, description: 'The correction (e.g., "should_be_inbox", "should_be_filtered", or a freeform explanation)' },
        description: { type: 'string' as const, description: 'Human-readable description of the classification correction' },
      },
      required: ['messageId', 'correction', 'description'],
    },
  },
  {
    name: 'create_sheet_from_emails',
    description: `Create a Google Sheet by extracting data from emails. WORKFLOW: First call get_email_detail on ONE sample email to understand the body format. Then call this tool describing what to extract in plain English. The server fetches all emails in parallel, uses Claude to extract the data in one batch call, and creates the Google Sheet. Write operation — return as proposed action.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string' as const, description: 'Sheet title (e.g., "Cardinals Seat Selections 2026")' },
        messageIds: { type: 'array' as const, items: { type: 'string' as const }, description: 'Gmail message IDs to process' },
        columns: { type: 'array' as const, items: { type: 'string' as const }, description: 'Column headers for the sheet (e.g., ["Email", "Section", "Row", "Low Seat", "High Seat", "QTY"])' },
        extractionPrompt: { type: 'string' as const, description: 'Plain English instructions for what to extract from each email body and how to group/transform the data. Be specific about the email format you observed in the sample. Example: "Each email has an HTML table with SECTION, ROW, SEAT#, PLAN columns. Extract the recipient email from X-Forwarded-For header. Group consecutive seats in the same section+row into packs. Output one row per pack with low seat, high seat, and quantity."' },
        description: { type: 'string' as const, description: 'Human-readable description of the sheet being created' },
      },
      required: ['title', 'messageIds', 'columns', 'extractionPrompt', 'description'],
    },
  },
];

const WRITE_TOOLS = new Set([
  'create_gmail_filter', 'update_gmail_filter', 'delete_gmail_filter',
  'bulk_mark_read', 'bulk_archive', 'bulk_trash',
  'create_draft', 'create_task', 'share_to_slack', 'correct_classification',
  'create_sheet_from_emails',
]);

interface AIChatRequestBody {
  messageIds?: string[];
  prompt: string;
  conversationHistory?: Array<{ role: string; content: string }>;
  teamName?: string;
  confirmedAction?: {
    id: string;
    toolName: string;
    toolInput: Record<string, unknown>;
  };
}

// In-memory job store for polling-based progress
interface AIChatJob {
  status: 'processing' | 'done' | 'error';
  phase: string;              // Current status text for the client
  result?: {
    message: string;
    table: { headers: string[]; rows: string[][] } | null;
    actions: Array<{ id: string; label: string; description: string; status: string; toolName: string; toolInput: Record<string, unknown> }> | null;
  };
  error?: string;
  createdAt: number;
}

const aiChatJobs = new Map<string, AIChatJob>();

// Clean up jobs older than 10 minutes
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [id, job] of aiChatJobs) {
    if (job.createdAt < cutoff) aiChatJobs.delete(id);
  }
}, 60_000);

// GET /tasks/ai-chat/status/:jobId — poll for job progress
router.get('/tasks/ai-chat/status/:jobId', (req: Request, res: Response): void => {
  if (!verifyApiKey(req, res)) return;
  const job = aiChatJobs.get(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  res.json({
    status: job.status,
    phase: job.phase,
    result: job.result || null,
    error: job.error || null,
  });
});

router.post('/tasks/ai-chat', async (req: Request, res: Response): Promise<void> => {
  if (!verifyApiKey(req, res)) return;

  const { prompt, conversationHistory, messageIds, teamName, confirmedAction } = req.body as AIChatRequestBody;

  if (!prompt && !confirmedAction) {
    res.status(400).json({ error: 'prompt or confirmedAction is required' });
    return;
  }

  // Confirmed write actions run synchronously (they're fast — one API call)
  if (confirmedAction) {
    try {
      if (!WRITE_TOOLS.has(confirmedAction.toolName)) {
        res.status(400).json({ error: `Invalid tool: ${confirmedAction.toolName}` });
        return;
      }
      if (!confirmedAction.toolInput || typeof confirmedAction.toolInput !== 'object') {
        res.status(400).json({ error: 'toolInput is required' });
        return;
      }

      // For sheet creation, use job-based polling (it's slow)
      if (confirmedAction.toolName === 'create_sheet_from_emails') {
        const jobId = randomUUID();
        aiChatJobs.set(jobId, { status: 'processing', phase: 'Starting sheet creation...', createdAt: Date.now() });
        res.json({ jobId });

        // Process in background
        executeSheetCreation(jobId, confirmedAction.toolInput).catch((error) => {
          console.error('[AI Chat] Sheet creation failed:', error);
          const job = aiChatJobs.get(jobId);
          if (job) {
            job.status = 'error';
            job.error = error instanceof Error ? error.message : 'Sheet creation failed';
            job.phase = 'Failed';
          }
        });
        return;
      }

      const result = await executeWriteAction(confirmedAction.toolName, confirmedAction.toolInput);
      res.json({
        message: result.message,
        table: result.table || null,
        actions: null,
      });
    } catch (error) {
      console.error('[Triage API] AI chat confirm failed:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Action failed' });
    }
    return;
  }

  // Tool-use loop: runs in background, client polls for progress
  const jobId = randomUUID();
  aiChatJobs.set(jobId, { status: 'processing', phase: 'Thinking...', createdAt: Date.now() });
  res.json({ jobId });

  // Process in background
  runToolUseLoop(jobId, prompt, conversationHistory, messageIds, teamName).catch((error) => {
    console.error('[AI Chat] Tool-use loop failed:', error);
    const job = aiChatJobs.get(jobId);
    if (job) {
      job.status = 'error';
      job.error = error instanceof Error ? error.message : 'AI chat failed';
      job.phase = 'Failed';
    }
  });
});

// Background tool-use loop
async function runToolUseLoop(
  jobId: string,
  prompt: string,
  conversationHistory: Array<{ role: string; content: string }> | undefined,
  messageIds: string[] | undefined,
  teamName: string | undefined,
) {
  const job = aiChatJobs.get(jobId)!;

  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  if (conversationHistory) {
    const entries = conversationHistory.slice(-20);
    for (const entry of entries) {
      if (entry.role === 'user' || entry.role === 'assistant') {
        messages.push({ role: entry.role, content: entry.content });
      }
    }
  }

  let userContent = prompt;
  if (messageIds?.length) {
    userContent = `[Context: User has selected ${messageIds.length} email(s) with IDs: ${messageIds.join(', ')}]\n\n${prompt}`;
  }
  if (teamName) {
    userContent = `[Context: Current team is "${teamName}"]\n\n${userContent}`;
  }
  messages.push({ role: 'user', content: userContent });

  let responseText: string | null = null;
  let proposedActions: Array<{ id: string; label: string; description: string; status: string; toolName: string; toolInput: Record<string, unknown> }> = [];
  let responseTable: { headers: string[]; rows: string[][] } | null = null;

  for (let i = 0; i < 100; i++) {
    job.phase = i === 0 ? 'Thinking...' : 'Thinking...';

    const claudeResponse = await coreApiClaude.toolUse({
      model: getCachedConfig().claude.models.default,
      maxTokens: 4096,
      systemPrompt: AI_CHAT_SYSTEM_PROMPT,
      tools: AI_TOOLS,
      toolChoice: { type: 'auto' },
      messages,
    });

    if (!claudeResponse.toolUse) {
      responseText = claudeResponse.text;
      break;
    }

    const { name: toolName, input: toolInput } = claudeResponse.toolUse as {
      name: string;
      input: Record<string, unknown>;
      id: string;
    };

    if (WRITE_TOOLS.has(toolName)) {
      const input = toolInput as Record<string, unknown>;
      const description = (input.description as string) || `Execute ${toolName}`;
      const previewCount = input.previewCount as number | undefined;
      const label = getWriteToolLabel(toolName);
      const actionId = randomUUID();
      proposedActions.push({
        id: actionId, label,
        description: previewCount ? `${description} (${previewCount} existing emails match)` : description,
        status: 'proposed', toolName, toolInput,
      });
      responseText = claudeResponse.text || `I'd like to ${description.toLowerCase()}. Please confirm to proceed.`;
      break;
    }

    // Read-only tool — update status, execute, update again
    job.phase = toolDisplayName(toolName);

    const toolResult = await executeReadOnlyTool(toolName, toolInput as Record<string, unknown>);

    job.phase = `✓ ${toolResultSummary(toolName, toolResult.data)}`;

    if (toolResult.table) responseTable = toolResult.table;

    const assistantText = claudeResponse.text
      ? `${claudeResponse.text}\n[Called ${toolName}]`
      : `[Called ${toolName}]`;
    messages.push({ role: 'assistant', content: assistantText });
    const toolResultJson = JSON.stringify(toolResult.data);
    const truncatedResult = toolResultJson.length > 8000
      ? toolResultJson.slice(0, 8000) + '... (truncated)'
      : toolResultJson;
    messages.push({ role: 'user', content: `[Tool result for ${toolName}]:\n${truncatedResult}` });
  }

  if (!responseText && proposedActions.length === 0) {
    if (responseTable && responseTable.rows.length > 0) {
      responseText = `Found ${responseTable.rows.length} result(s). Let me know what you'd like to do with them.`;
    } else {
      responseText = 'I wasn\'t able to process that request. Could you rephrase it?';
    }
  }

  job.status = 'done';
  job.phase = 'Done';
  job.result = {
    message: responseText || '',
    table: responseTable,
    actions: proposedActions.length > 0 ? proposedActions : null,
  };
}

// Background sheet creation with progress updates
async function executeSheetCreation(jobId: string, toolInput: Record<string, unknown>) {
  const job = aiChatJobs.get(jobId)!;
  const title = toolInput.title as string;
  const messageIds = toolInput.messageIds as string[];
  const columns = toolInput.columns as string[];
  const extractionPrompt = toolInput.extractionPrompt as string;

  // Step 1: Fetch all emails in parallel
  job.phase = `Fetching ${messageIds.length} emails...`;
  const emailBodies: Array<{ id: string; headers: Record<string, string>; body: string }> = [];

  const fetchResults = await Promise.all(
    messageIds.map(async (id) => {
      try {
        const msg = await coreApiGoogle.gmail.getMessage(id, 'full');
        return { success: true as const, id, msg };
      } catch (e) {
        console.error(`[AI Sheet] Failed to fetch ${id}:`, e);
        return { success: false as const, id };
      }
    })
  );

  for (const result of fetchResults) {
    if (!result.success) continue;
    const msg = result.msg as any;
    const msgHeaders = msg.payload?.headers ?? [];
    const headerMap: Record<string, string> = {};
    for (const h of msgHeaders) {
      headerMap[h.name?.toLowerCase() || ''] = h.value || '';
    }

    // Extract body text
    const extractBody = (part: any): string => {
      if (!part) return '';
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf-8');
      }
      if (part.parts) {
        for (const p of part.parts) {
          const text = extractBody(p);
          if (text) return text;
        }
      }
      if (part.mimeType === 'text/html' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf-8');
      }
      return '';
    };

    emailBodies.push({
      id: result.id,
      headers: headerMap,
      body: extractBody(msg.payload).slice(0, 6000),
    });
  }

  job.phase = `Extracting data from ${emailBodies.length} emails...`;

  // Step 2: Single Claude call to extract all data
  const emailSummaries = emailBodies.map((e, i) =>
    `--- EMAIL ${i + 1} ---\nFrom: ${e.headers['from'] || ''}\nTo: ${e.headers['to'] || ''}\nX-Forwarded-For: ${e.headers['x-forwarded-for'] || ''}\nDelivered-To: ${e.headers['delivered-to'] || ''}\nSubject: ${e.headers['subject'] || ''}\n\nBody:\n${e.body}`
  ).join('\n\n');

  const extractionSystemPrompt = `You are a data extraction assistant. Extract structured data from email bodies and return ONLY valid JSON — no markdown, no code fences, no explanation.`;

  const extractionUserPrompt = `Extract data from these ${emailBodies.length} emails.

COLUMNS: ${columns.join(', ')}

EXTRACTION INSTRUCTIONS:
${extractionPrompt}

Return a JSON array of objects. Each object has keys matching the column names exactly. If an email produces multiple rows (e.g., multiple seat packs), output multiple objects for that email.

EMAILS:
${emailSummaries}`;

  const extractionResponse = await coreApiClaude.toolUse({
    model: getCachedConfig().claude.models.default,
    maxTokens: 8192,
    systemPrompt: extractionSystemPrompt,
    tools: [],
    toolChoice: { type: 'auto' },
    messages: [{ role: 'user', content: extractionUserPrompt }],
  });

  job.phase = 'Creating Google Sheet...';

  // Parse the JSON response
  let extractedRows: Record<string, string>[] = [];
  try {
    const text = extractionResponse.text || '';
    // Try to find JSON array in the response (handle markdown code fences)
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      extractedRows = JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    console.error('[AI Sheet] Failed to parse extraction response:', e);
    throw new Error('Failed to parse extracted data from emails');
  }

  // Step 3: Create Google Sheet
  const headers = columns;
  const rows = extractedRows.map(row => headers.map(h => String(row[h] ?? '')));

  const sheetResult = await createCustomSheet(title, headers, rows);

  job.status = 'done';
  job.phase = 'Done';
  job.result = {
    message: `Google Sheet created with ${rows.length} rows.\n\n${sheetResult.spreadsheetUrl}`,
    table: rows.length <= 50 ? { headers, rows } : null,
    actions: null,
  };
}

// Map tool names to user-friendly display text for SSE progress
function toolDisplayName(tool: string): string {
  switch (tool) {
    case 'search_emails': return 'Searching Gmail...';
    case 'get_email_detail': return 'Reading email...';
    case 'get_emails_bulk': return 'Reading emails...';
    case 'get_attachment_content': return 'Analyzing attachment...';
    case 'list_gmail_filters': return 'Loading filters...';
    case 'preview_filter': return 'Previewing filter matches...';
    case 'get_inbox_summary': return 'Scanning inbox...';
    case 'get_classification': return 'Checking classification...';
    default: return `Running ${tool}...`;
  }
}

// Generate a brief summary from a tool result
function toolResultSummary(tool: string, data: unknown): string {
  if (!data || typeof data !== 'object') return 'Done';
  const d = data as Record<string, unknown>;

  switch (tool) {
    case 'search_emails': {
      const messages = d.messages as unknown[] | undefined;
      const count = messages?.length ?? d.totalResults ?? 0;
      return `Found ${count} email${count === 1 ? '' : 's'}`;
    }
    case 'get_email_detail':
      return `Loaded: ${(d.subject as string)?.slice(0, 50) || 'email'}`;
    case 'get_emails_bulk': {
      const emails = d.emails as unknown[] | undefined;
      return `Loaded ${emails?.length ?? 0} emails`;
    }
    case 'list_gmail_filters': {
      const filters = d.filters as unknown[] | undefined;
      const count = filters?.length ?? 0;
      return `Loaded ${count} filter${count === 1 ? '' : 's'}`;
    }
    case 'preview_filter':
      return `${d.matchCount ?? 0} emails match`;
    case 'get_inbox_summary':
      return `Inbox summarized`;
    case 'get_attachment_content':
      return 'Attachment analyzed';
    case 'get_classification':
      return `Classification: ${d.classification || 'loaded'}`;
    default:
      return 'Done';
  }
}

// Map tool names to human-readable action labels
function getWriteToolLabel(toolName: string): string {
  switch (toolName) {
    case 'create_gmail_filter': return 'Create Filter';
    case 'update_gmail_filter': return 'Update Filter';
    case 'delete_gmail_filter': return 'Delete Filter';
    case 'bulk_mark_read': return 'Mark as Read';
    case 'bulk_archive': return 'Archive Messages';
    case 'bulk_trash': return 'Trash Messages';
    case 'create_draft': return 'Create Draft Reply';
    case 'create_task': return 'Create Task';
    case 'share_to_slack': return 'Share to Slack';
    case 'correct_classification': return 'Correct Classification';
    case 'create_sheet_from_emails': return 'Create Google Sheet';
    default: return 'Execute Action';
  }
}

// Execute read-only tools immediately
async function executeReadOnlyTool(
  toolName: string,
  input: Record<string, unknown>
): Promise<{ data: unknown; table?: { headers: string[]; rows: string[][] } }> {
  switch (toolName) {
    case 'list_gmail_filters': {
      const filters = await coreApiGoogle.gmail.listFilters();
      const headers = ['#', 'Criteria', 'Action', 'ID'];
      const rows = filters.map((f: any, i: number) => {
        const critParts: string[] = [];
        if (f.criteria?.from) critParts.push(`from: ${f.criteria.from}`);
        if (f.criteria?.to) critParts.push(`to: ${f.criteria.to}`);
        if (f.criteria?.subject) critParts.push(`subject: ${f.criteria.subject}`);
        if (f.criteria?.query) critParts.push(`query: ${f.criteria.query}`);
        if (f.criteria?.hasAttachment) critParts.push('has:attachment');

        const actionParts: string[] = [];
        if (f.action?.addLabelNames?.length) actionParts.push(`+label: ${f.action.addLabelNames.join(', ')}`);
        if (f.action?.removeLabelIds?.includes('INBOX')) actionParts.push('archive');
        if (f.action?.removeLabelIds?.includes('UNREAD')) actionParts.push('mark read');
        if (f.action?.shouldStar) actionParts.push('star');
        if (f.action?.shouldTrash) actionParts.push('trash');

        return [
          String(i + 1),
          critParts.join(', ') || '(no criteria)',
          actionParts.join(', ') || '(no action)',
          f.id || '',
        ];
      });
      return { data: filters, table: { headers, rows } };
    }

    case 'preview_filter': {
      const criteria = input.criteria as Record<string, unknown>;
      const preview = await coreApiGoogle.gmail.previewFilter(criteria);
      return { data: preview };
    }

    case 'search_emails': {
      const query = input.query as string;
      const maxResults = Math.min((input.maxResults as number) || 10, 50);
      const result = await coreApiGoogle.gmail.listTriageMessages({ q: query, maxResults });
      const messages = result.messages || [];
      const table = {
        headers: ['Subject', 'From', 'Date', 'ID'],
        rows: messages.map((m: any) => [m.subject || '', m.from || '', m.date || '', m.id || '']),
      };
      // Return compact summary — just id/subject/from/date per message
      // Claude uses messageIds for bulk ops, doesn't need to read each one
      return {
        data: {
          totalCount: result.totalCount || messages.length,
          count: messages.length,
          messageIds: messages.map((m: any) => m.id),
          messages: messages.map((m: any) => ({
            id: m.id, subject: m.subject, from: m.from, date: m.date,
          })),
        },
        table,
      };
    }

    case 'get_email_detail': {
      const messageId = input.messageId as string;
      const msg = await coreApiGoogle.gmail.getTriageMessage(messageId);
      // Truncate body to 8000 chars
      const body = (msg.textBody || msg.htmlBody || '').slice(0, 8000);
      return {
        data: {
          id: msg.id,
          subject: msg.subject,
          from: msg.from,
          to: msg.to,
          date: msg.date,
          body,
          attachments: msg.attachments || [],
        },
      };
    }

    case 'get_emails_bulk': {
      const messageIds = (input.messageIds as string[]).slice(0, 50);
      const results = await Promise.all(
        messageIds.map(async (id) => {
          try {
            const msg = await coreApiGoogle.gmail.getTriageMessage(id);
            const body = (msg.textBody || msg.htmlBody || '').slice(0, 4000);
            return { id: msg.id, subject: msg.subject, from: msg.from, to: msg.to, date: msg.date, body, attachments: msg.attachments || [] };
          } catch (e) {
            return { id, error: e instanceof Error ? e.message : 'fetch failed' };
          }
        })
      );
      return { data: { count: results.length, emails: results } };
    }

    case 'get_attachment_content': {
      const messageId = input.messageId as string;
      const attachmentId = input.attachmentId as string;
      const filename = (input.filename as string) || '';
      const data = await coreApiGoogle.gmail.getAttachment(messageId, attachmentId);

      let extractedText = '';
      const lowerFilename = filename.toLowerCase();

      if (lowerFilename.endsWith('.pdf')) {
        try {
          const { PDFParse } = await import('pdf-parse');
          const parser = new PDFParse({ data });
          const result = await parser.getText();
          extractedText = result.text;
        } catch (e) {
          extractedText = `[PDF extraction failed: ${e instanceof Error ? e.message : e}]`;
        }
      } else if (lowerFilename.endsWith('.csv') || lowerFilename.endsWith('.txt') || lowerFilename.endsWith('.json') || lowerFilename.endsWith('.xml') || lowerFilename.endsWith('.html')) {
        extractedText = data.toString('utf-8');
      } else {
        extractedText = `[Unsupported file type: ${filename}. Supported: PDF, TXT, CSV, JSON, XML, HTML]`;
      }

      // Cap at 50000 chars
      if (extractedText.length > 50000) {
        extractedText = extractedText.slice(0, 50000) + '\n... (truncated)';
      }

      return {
        data: {
          filename,
          size: data.length,
          extractedText,
        },
      };
    }

    case 'get_inbox_summary': {
      const [unreadResult, starredResult, recentResult] = await Promise.all([
        coreApiGoogle.gmail.listTriageMessages({ q: 'is:unread in:inbox', maxResults: 50 }),
        coreApiGoogle.gmail.listTriageMessages({ q: 'is:starred', maxResults: 10 }),
        coreApiGoogle.gmail.listTriageMessages({ q: 'in:inbox', maxResults: 50 }),
      ]);

      const unreadMessages = unreadResult.messages || [];
      const starredMessages = starredResult.messages || [];

      // Aggregate unread by sender
      const senderCounts: Record<string, number> = {};
      for (const msg of unreadMessages) {
        const sender = (msg.from || 'Unknown').replace(/<[^>]+>/, '').trim();
        senderCounts[sender] = (senderCounts[sender] || 0) + 1;
      }

      const topSenders = Object.entries(senderCounts)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 10)
        .map(([sender, count]) => ({ sender, count }));

      const table = {
        headers: ['Sender', 'Unread Count'],
        rows: topSenders.map(s => [s.sender, String(s.count)]),
      };

      return {
        data: {
          unreadCount: unreadResult.totalCount || unreadMessages.length,
          starredCount: starredResult.totalCount || starredMessages.length,
          topSenders,
        },
        table,
      };
    }

    case 'get_classification': {
      const messageId = input.messageId as string;
      const result = await coreApiGoogle.gmail.classify(messageId);
      return { data: result };
    }

    default:
      return { data: { error: `Unknown tool: ${toolName}` } };
  }
}

// Translate Claude's friendly action fields to Gmail API format
function normalizeFilterAction(action: Record<string, unknown>): Record<string, unknown> {
  const gmailAction: Record<string, unknown> = { ...action };
  const removeLabels = new Set<string>((action.removeLabelIds as string[]) || []);
  const addLabels = new Set<string>((action.addLabelIds as string[]) || []);

  if (action.shouldArchive) {
    removeLabels.add('INBOX');
    delete gmailAction.shouldArchive;
  }
  if (action.shouldMarkAsRead) {
    removeLabels.add('UNREAD');
    delete gmailAction.shouldMarkAsRead;
  }
  if (action.shouldStar) {
    addLabels.add('STARRED');
    delete gmailAction.shouldStar;
  }
  if (action.shouldTrash) {
    addLabels.add('TRASH');
    removeLabels.add('INBOX');
    delete gmailAction.shouldTrash;
  }
  if (action.shouldNeverSpam) {
    removeLabels.add('SPAM');
    delete gmailAction.shouldNeverSpam;
  }

  if (removeLabels.size > 0) {
    gmailAction.removeLabelIds = [...removeLabels];
  }
  if (addLabels.size > 0) {
    gmailAction.addLabelIds = [...addLabels];
  }
  return gmailAction;
}

// Execute write tools after user confirmation
async function executeWriteAction(
  toolName: string,
  toolInput: Record<string, unknown>
): Promise<{ message: string; table?: { headers: string[]; rows: string[][] } }> {
  switch (toolName) {
    case 'create_gmail_filter': {
      const criteria = toolInput.criteria as Record<string, unknown>;
      const action = toolInput.action as Record<string, unknown>;
      const filter = await coreApiGoogle.gmail.createFilter(criteria, normalizeFilterAction(action));
      return {
        message: `Filter created successfully (ID: ${filter.id}). Note: this filter applies to future emails only — existing emails are not affected retroactively.`,
      };
    }

    case 'update_gmail_filter': {
      const filterId = toolInput.filterId as string;
      const criteria = toolInput.criteria as Record<string, unknown>;
      const action = toolInput.action as Record<string, unknown>;
      const filter = await coreApiGoogle.gmail.updateFilter(filterId, criteria, normalizeFilterAction(action));
      return {
        message: `Filter updated successfully (new ID: ${filter.id}). Gmail doesn't support in-place updates, so the old filter was replaced.`,
      };
    }

    case 'delete_gmail_filter': {
      const filterId = toolInput.filterId as string;
      await coreApiGoogle.gmail.deleteFilter(filterId);
      return {
        message: 'Filter deleted successfully.',
      };
    }

    case 'bulk_mark_read': {
      const messageIds = toolInput.messageIds as string[];
      const result = await coreApiGoogle.gmail.bulkMarkAsRead(messageIds);
      return {
        message: `Marked ${result.count} message(s) as read.`,
      };
    }

    case 'bulk_archive': {
      const messageIds = toolInput.messageIds as string[];
      const result = await coreApiGoogle.gmail.bulkArchive(messageIds);
      return {
        message: `Archived ${result.count} message(s).`,
      };
    }

    case 'bulk_trash': {
      const messageIds = toolInput.messageIds as string[];
      const result = await coreApiGoogle.gmail.bulkTrash(messageIds);
      return {
        message: `Moved ${result.count} message(s) to trash.`,
      };
    }

    case 'create_draft': {
      const messageId = toolInput.messageId as string;
      const body = toolInput.body as string;
      const result = await coreApiGoogle.gmail.createDraft(messageId, body);
      return {
        message: `Draft reply created (ID: ${result.draftId}). Open Gmail to review and send it.`,
      };
    }

    case 'create_task': {
      const messageId = toolInput.messageId as string;
      const taskName = toolInput.taskName as string;
      const notes = (toolInput.notes as string) || '';

      // Call the local review endpoint first, then we'd need to create — but the from-email
      // endpoint needs ownerId. For now, use the review endpoint to get AI analysis,
      // then return the result as a message (user can refine in task sheet).
      try {
        const CORE_API_KEY = process.env.CORE_API_KEY;
        const response = await fetch(`http://localhost:${process.env.PORT || 3000}/tasks/review`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${CORE_API_KEY}`,
          },
          body: JSON.stringify({ messageId, notes }),
        });
        const review = await response.json();
        return {
          message: `Task reviewed: "${review.taskName || taskName}"\nOwner: ${review.owner?.name || 'Unassigned'}\nType: ${review.taskType || 'General'}\nUrgency: ${review.urgency || 'Medium'}\nTeam: ${review.team || 'N/A'}\n\nOpen the task sheet in the app to finalize and create the Monday.com item.`,
        };
      } catch {
        return {
          message: `Task analysis requested for: "${taskName}". Open the task sheet in the app to create the Monday.com item.`,
        };
      }
    }

    case 'share_to_slack': {
      const channelId = toolInput.channelId as string;
      const messageId = toolInput.messageId as string;
      const text = (toolInput.text as string) || '';

      // Call core-api's share endpoint
      const CORE_API_URL = process.env.CORE_API_URL || 'http://core-api.railway.internal';
      const CORE_API_KEY = process.env.CORE_API_KEY;
      const response = await fetch(`${CORE_API_URL}/slack/share`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': CORE_API_KEY || '',
        },
        body: JSON.stringify({ channelId, messageId, text }),
      });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Slack share failed: ${err}`);
      }

      return {
        message: `Email shared to Slack channel successfully.`,
      };
    }

    case 'correct_classification': {
      const messageId = toolInput.messageId as string;
      const correction = toolInput.correction as string;
      await coreApiGoogle.gmail.correctClassification(messageId, correction);
      return {
        message: `Classification corrected for message. Correction noted: "${correction}".`,
      };
    }

    // create_sheet_from_emails is handled via job-based polling, not here

    default:
      return { message: `Unknown action: ${toolName}` };
  }
}

export default router;
