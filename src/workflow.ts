/**
 * Main workflow orchestration
 *
 * This module coordinates the entire email forwarding workflow:
 * 1. Parse the incoming email and EML attachment
 * 2. Use Claude AI to intelligently extract task details
 * 3. Convert EML to PDF
 * 4. Create Monday.com item
 * 5. Send Slack notification
 * 6. Upload PDF to both Monday and Slack (graceful failure handling)
 * 7. Update Monday with Slack thread ID
 *
 * Key reliability features:
 * - Attachment failures don't fail the workflow
 * - Monday file upload has retry with backoff (2min, 10min, 30min)
 * - PDF URL stored for retry scenarios
 * - Priority mapped to Monday Urgency column
 * - Run ID for distributed tracing across logs, Monday, and Slack
 *
 * Board philosophy:
 * - Columns are for STATE and ROUTING only
 * - All narrative context goes to Monday Updates
 * - Errors go to Updates/Slack, not columns
 */

import { randomUUID } from 'crypto';
import type {
  ParsedEmail,
  WorkflowResult,
  Priority,
  AttachmentState,
} from './types/index.js';
import {
  parseEmlAttachment,
  findEmlAttachment,
} from './services/emailParser.js';
import { analyzeEmailSafe } from './services/claude.js';
import { convertEmlToPdf } from './services/convertApi.js';
import * as monday from './services/monday.js';
import * as slack from './services/slack.js';
import * as calendar from './services/calendar.js';
import { findUserByName, getUserNamesString } from './services/userResolver.js';
import { getTaskTypeDisplayName } from './config/taskTypes.js';
import { parseDate, formatDateForDisplay, isAsapDate } from './utils/dateParser.js';
import { shouldScanForRecipients, findRelatedRecipients, normalizeSubject, formatRecipientSubtaskName } from './services/gmail.js';
import { createRecipientSheet, shouldCreateSheet } from './services/sheets.js';
import * as todoist from './services/todoist.js';

/**
 * Map Claude priority to Monday urgency label
 */
function mapPriorityToUrgency(priority: Priority): 'High' | 'Medium' | 'Low' {
  switch (priority) {
    case 'high': return 'High';
    case 'medium': return 'Medium';
    case 'low': return 'Low';
    default: return 'Medium';
  }
}

export interface WorkflowInput {
  email: ParsedEmail;
}

/**
 * Create a logger prefixed with Run ID for tracing
 */
function createLogger(runId: string) {
  const prefix = `[${runId.substring(0, 8)}]`;
  return {
    log: (...args: unknown[]) => console.log(prefix, ...args),
    warn: (...args: unknown[]) => console.warn(prefix, ...args),
    error: (...args: unknown[]) => console.error(prefix, ...args),
  };
}

/**
 * Execute the complete workflow
 */
export async function executeWorkflow(input: WorkflowInput): Promise<WorkflowResult> {
  const { email } = input;

  // Generate unique Run ID for this workflow run
  const runId = randomUUID();
  const log = createLogger(runId);

  log.log('Starting workflow for email:', email.subject);

  // Step 1: Find the EML attachment
  const emlAttachment = findEmlAttachment(email.attachments);
  if (!emlAttachment) {
    throw new Error('No EML attachment found in the email');
  }

  // Step 2: Parse EML headers and body (needed for Claude analysis)
  log.log('Parsing EML attachment...');
  const emlHeaders = await parseEmlAttachment(emlAttachment.content);
  log.log('EML headers:', emlHeaders);
  if (emlHeaders.body) {
    log.log('EML body length:', emlHeaders.body.length, 'chars');
  }

  // Step 3: Use Claude AI to analyze the email and extract task details
  // Now includes the actual EML body for meeting detection, etc.
  log.log('Analyzing email with Claude AI...');
  const analysisResult = await analyzeEmailSafe(
    email.subject,
    email.text,
    emlHeaders.subject,
    emlHeaders.from,
    emlHeaders.to,
    emlHeaders.body  // Pass the EML body content
  );
  log.log('Claude analysis:', analysisResult);
  log.log(`Confidence: ${(analysisResult.confidence * 100).toFixed(0)}%`);
  if (analysisResult.meeting.hasMeetingRequest) {
    log.log('Meeting detected:', analysisResult.meeting);
  }

  // Step 4: Resolve the task type (Claude might return alias or display name)
  const taskType = getTaskTypeDisplayName(analysisResult.taskType);
  log.log('Task type:', taskType);

  // Step 5: Parse the due date (may be null for ASAP)
  const formattedDueDate = parseDate(analysisResult.dueDate);
  const urgency = mapPriorityToUrgency(analysisResult.priority);
  log.log('Due date:', formattedDueDate ?? 'ASAP (no date)');
  log.log('Urgency:', urgency);

  // If ASAP detected and priority wasn't already high, set to high
  const finalUrgency = formattedDueDate === null ? 'High' : urgency;

  // Step 6: Resolve user dynamically from Monday.com/Slack
  const user = await findUserByName(analysisResult.owner);
  if (!user) {
    const availableUsers = await getUserNamesString();
    throw new Error(`Unknown user: ${analysisResult.owner}. Available users: ${availableUsers}`);
  }
  log.log('Resolved user:', user.name, 'Monday ID:', user.mondayId, 'Slack ID:', user.slackId ?? 'N/A');

  // Step 7: Convert EML to PDF (can run in parallel with Monday item creation)
  log.log('Converting EML to PDF...');
  const pdfFile = await convertEmlToPdf(emlAttachment.content, emlAttachment.filename);
  log.log('PDF generated:', pdfFile.filename);

  // Step 8: Create Monday.com item
  // Use normalized subject (strip FWD:/RE:) as task name
  const taskName = normalizeSubject(email.subject);
  log.log('Creating Monday.com item...');
  const mondayItem = await monday.createItem({
    name: taskName,
    dueDate: formattedDueDate,  // May be null for ASAP
    ownerIds: [user.mondayId],  // Support multiple owners
    taskType,
    source: 'Forwarding Tasks',
    urgency: finalUrgency,  // Map Claude priority to Monday urgency
    // NOTE: From/To go to initial Update, not columns (locked architecture)
  });
  log.log('Monday item created:', mondayItem.id);

  // Store Run ID on Monday item (Text column for debugging/tracing)
  await monday.storeRunId(mondayItem.id, runId);

  // Set initial attachment state to Queued
  await monday.updateAttachmentState(mondayItem.id, 'Queued');

  // Create FIRST Monday update with all narrative context
  // LOCKED ARCHITECTURE: Columns = STATE + ROUTING only
  // All narrative/context/provenance goes to Updates
  const initialUpdateParts: string[] = [];

  // Notes (if present)
  if (analysisResult.notes) {
    initialUpdateParts.push(`📝 ${analysisResult.notes}`);
  }

  // Email provenance (From/To)
  if (emlHeaders.from) {
    initialUpdateParts.push(`📧 From: ${emlHeaders.from}`);
  }
  if (emlHeaders.to) {
    initialUpdateParts.push(`📬 To: ${emlHeaders.to}`);
  }

  // BCC recipients (only if present - do not add placeholders)
  if (emlHeaders.bcc && emlHeaders.bcc.length > 0) {
    const bccList = emlHeaders.bcc.map(email => `- ${email}`).join('\n');
    initialUpdateParts.push(`👁️ BCC Recipients:\n${bccList}`);
  }

  // Run ID (always)
  initialUpdateParts.push(`🔗 Run ID: ${runId.substring(0, 8)}`);

  log.log('Creating initial Monday update...');
  await monday.createUpdate(mondayItem.id, initialUpdateParts.join('\n\n'));

  // Step 8.5: Project to Todoist (if enabled)
  if (todoist.isEnabled()) {
    log.log('Projecting task to Todoist...');
    const todoistTask = await todoist.projectFromMonday({
      mondayItemId: mondayItem.id,
      taskName,
      taskType,
      owner: user.name,
      dueDate: formattedDueDate,
      priority: analysisResult.priority,
      notes: analysisResult.notes,
    });
    if (todoistTask) {
      log.log('Task projected to Todoist:', todoistTask.id);
    }
  }

  // Step 8.6: Check for /scan command in email body
  // If present, search Gmail for related recipients and create subtasks with appointment times
  let sheetUrl: string | null = null;
  if (shouldScanForRecipients(email.text)) {
    log.log('/scan detected - searching for related recipients and appointments...');
    try {
      const recipients = await findRelatedRecipients(email.subject);
      if (recipients.length > 0) {
        log.log(`Found ${recipients.length} related recipients, creating subtasks...`);
        // Format subtask names with appointment times (e.g., "john@client.com - Tue Dec 20, 2:00 PM")
        const subtaskNames = recipients.map(formatRecipientSubtaskName);
        const subtasks = await monday.createSubitems(mondayItem.id, subtaskNames);
        log.log(`Created ${subtasks.length} subtasks for recipients`);

        // Create Google Sheet for presale/relocation emails
        if (shouldCreateSheet(taskName)) {
          log.log('Creating Google Sheet for recipient tracking...');
          try {
            const sheet = await createRecipientSheet(taskName, recipients);
            sheetUrl = sheet.spreadsheetUrl;
            log.log(`Google Sheet created: ${sheetUrl}`);

            // Post sheet link as Monday update
            await monday.createUpdate(
              mondayItem.id,
              `📊 Recipient tracking spreadsheet created:\n${sheetUrl}`
            );
          } catch (sheetError) {
            log.error('Failed to create Google Sheet:', sheetError);
          }
        }
      } else {
        log.log('No related recipients found in the last 48 hours');
      }
    } catch (error) {
      log.error('/scan failed:', error);
      // Don't fail the whole workflow if scan fails
    }
  }

  // Step 9: Use Slack ID from unified user mapping (already matched by email)
  const slackMention = user.slackId || user.name;

  // Step 10: Send Slack notification
  log.log('Sending Slack notification...');
  const slackMessage = await slack.sendNotification({
    taskType,
    subject: taskName,  // Use normalized subject (no FWD:/RE:)
    assigneeSlackId: slackMention,
    dueDate: formatDateForDisplay(formattedDueDate),
    priority: analysisResult.priority,
    notes: analysisResult.notes,
    fromEmail: emlHeaders.from,
    toEmail: emlHeaders.to,
    mondayItemId: mondayItem.id,
    meeting: analysisResult.meeting,  // Include meeting info
  });
  log.log('Slack message sent:', slackMessage.ts);

  // Post Run ID to Slack thread for debugging/tracing
  await slack.postToThread(
    slackMessage.ts,
    `🔗 _Run ID: ${runId.substring(0, 8)}_`
  );

  // Step 11: Upload PDF - Slack first (human value), then Monday (best effort with retry)
  // Attachment failures do NOT fail the workflow
  log.log('Uploading PDF attachments...');

  // Track attachment status
  let slackUploaded = false;
  let mondayUploaded = false;
  let mondayRetryScheduled = false;
  let attachmentState: AttachmentState = 'Queued';

  // Step 11a: Upload to Slack first (priority for human visibility)
  try {
    await slack.uploadFileToThread(slackMessage.ts, pdfFile.filename, pdfFile.data, 'Email PDF');
    slackUploaded = true;
    log.log('PDF uploaded to Slack thread');
  } catch (slackError) {
    log.error('Slack file upload failed (non-fatal):', slackError);
    // Post error to Slack thread (errors go to Updates/Slack, not columns)
    await slack.postToThread(slackMessage.ts, `⚠️ Slack PDF upload failed: ${slackError instanceof Error ? slackError.message : 'Unknown error'}`);
    // Continue - Slack upload failure is not critical
  }

  // Step 11b: Store durable PDF URL for retry scenarios
  if (pdfFile.url) {
    await monday.storePdfUrl(mondayItem.id, pdfFile.url);
  }

  // Step 11c: Upload to Monday with retry logic
  // Create a function to post to Slack thread for retry notifications
  const postToSlackThread = async (message: string) => {
    await slack.postToThread(slackMessage.ts, message);
  };

  try {
    const uploadResult = await monday.uploadFileToItemWithRetry(
      mondayItem.id,
      pdfFile.filename,
      pdfFile.data,
      slackMessage.ts,
      postToSlackThread
    );
    mondayUploaded = uploadResult.success;
    mondayRetryScheduled = uploadResult.retryScheduled;

    if (mondayUploaded) {
      log.log('PDF uploaded to Monday');
      attachmentState = 'Uploaded';
    } else if (mondayRetryScheduled) {
      log.log('Monday upload failed, retries scheduled in background');
      attachmentState = 'Retrying';
    }
  } catch (mondayError) {
    log.error('Monday file upload failed (non-fatal):', mondayError);
    attachmentState = 'Failed';
    // Post error to Monday update (errors go to Updates/Slack, not columns)
    await monday.createUpdate(mondayItem.id, `⚠️ Monday PDF upload failed: ${mondayError instanceof Error ? mondayError.message : 'Unknown error'}`);
    // Continue - Monday upload failure is not critical, task still exists
  }

  // Update attachment state column (status only, no error text)
  await monday.updateAttachmentState(mondayItem.id, attachmentState);

  log.log(`Attachment status: Slack=${slackUploaded}, Monday=${mondayUploaded}, RetryScheduled=${mondayRetryScheduled}, State=${attachmentState}`);

  // Step 11.5: Post Google Sheet link to Slack thread (if created)
  if (sheetUrl) {
    log.log('Posting Google Sheet link to Slack thread...');
    await slack.postToThread(
      slackMessage.ts,
      `📊 *Recipient Tracking Sheet*\n${sheetUrl}\n_Edit this spreadsheet to track status and add notes._`
    );
  }

  // Step 12: Update Monday with Slack thread ID
  log.log('Updating Monday with Slack thread ID...');
  await monday.updateSlackThreadId(mondayItem.id, slackMessage.ts);
  log.log('Monday item updated with Slack thread ID');

  // Step 13: Create Google Calendar event (if enabled and has a due date)
  // Skip calendar event for ASAP tasks with no date
  if (calendar.isCalendarEnabled() && formattedDueDate) {
    log.log('Creating Google Calendar event...');
    const calendarEvent = await calendar.createTaskEvent({
      title: `[${taskType}] ${taskName}`,
      description: analysisResult.notes,
      dueDate: formattedDueDate,
      assigneeEmail: user.email,
      mondayItemId: mondayItem.id,
    });
    if (calendarEvent) {
      log.log('Calendar event created:', calendarEvent.eventId);
    }
  } else if (calendar.isCalendarEnabled() && !formattedDueDate) {
    log.log('Skipping calendar event for ASAP task (no due date)');
  }

  // Note: Slack reminders require a user token, not a bot token
  // Skipping reminder - users can set their own via Monday due date notifications

  log.log('Workflow completed successfully!');

  return {
    mondayItemId: mondayItem.id,
    slackThreadTs: slackMessage.ts,
    success: true,
    runId,
    attachmentStatus: {
      slackUploaded,
      mondayUploaded,
      mondayRetryScheduled,
      pdfUrl: pdfFile.url,
      state: attachmentState,
    },
  };
}

/**
 * Execute workflow with error handling
 */
export async function executeWorkflowSafe(input: WorkflowInput): Promise<WorkflowResult> {
  // Generate runId for error tracking even if workflow fails early
  const runId = randomUUID();
  const log = createLogger(runId);

  try {
    return await executeWorkflow(input);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error('Workflow failed:', errorMessage);

    return {
      mondayItemId: '',
      slackThreadTs: '',
      success: false,
      error: errorMessage,
      runId,
    };
  }
}

// ============================================================================
// Slack Task Creation (/task command)
// ============================================================================

export interface SlackTaskInput {
  /** Raw text from /task command */
  text: string;
  /** Slack user ID of the creator */
  creatorSlackId: string;
}

export interface ParsedSlackTask {
  assigneeSlackId: string | null;
  description: string;
  dueDate: string | null;  // Parsed date or null for ASAP
  urgency: 'High' | 'Medium' | 'Low';
  taskType: string;
  notes: string | null;
}

/**
 * Parse /task command input (single-line or multiline)
 *
 * Supported formats:
 * - Single-line: /task @assignee refund due fri urgency high notes: customer called twice
 * - Multiline:
 *   @assignee
 *   due fri
 *   refund
 *   notes...
 */
export function parseSlackTaskInput(text: string): ParsedSlackTask {
  const lines = text.trim().split('\n').map(l => l.trim()).filter(l => l.length > 0);

  let assigneeSlackId: string | null = null;
  let description = '';
  let dueDate: string | null = null;
  let urgency: 'High' | 'Medium' | 'Low' = 'Medium';
  let taskType = 'General';
  let notes: string | null = null;

  // Extract @mentions (Slack format: <@U123ABC> or <@U123ABC|name>)
  const mentionRegex = /<@([A-Z0-9]+)(?:\|[^>]+)?>/g;

  // Check if multiline format (lines with patterns like "due", "urgency", "@")
  const isMultiline = lines.length > 1 && lines.some(l =>
    /^<@[A-Z0-9]+/.test(l) ||
    /^due\s/i.test(l) ||
    /^urgency\s/i.test(l) ||
    /^type\s/i.test(l) ||
    /^notes:/i.test(l)
  );

  if (isMultiline) {
    // Multiline parsing
    const remainingLines: string[] = [];

    for (const line of lines) {
      // Assignee line
      const mentionMatch = line.match(mentionRegex);
      if (mentionMatch && !assigneeSlackId) {
        const idMatch = mentionMatch[0].match(/<@([A-Z0-9]+)/);
        if (idMatch) {
          assigneeSlackId = idMatch[1];
        }
        // If line is just the mention, skip it
        if (line.replace(mentionRegex, '').trim().length === 0) continue;
      }

      // Due date line
      if (/^due\s/i.test(line)) {
        dueDate = line.replace(/^due\s+/i, '').trim();
        continue;
      }

      // Urgency line
      if (/^urgency\s/i.test(line)) {
        const urg = line.replace(/^urgency\s+/i, '').trim().toLowerCase();
        if (urg === 'high') urgency = 'High';
        else if (urg === 'low') urgency = 'Low';
        else urgency = 'Medium';
        continue;
      }

      // Type line
      if (/^type\s/i.test(line)) {
        taskType = getTaskTypeDisplayName(line.replace(/^type\s+/i, '').trim());
        continue;
      }

      // Notes line (everything after "notes:")
      if (/^notes:/i.test(line)) {
        notes = line.replace(/^notes:\s*/i, '').trim();
        continue;
      }

      // Everything else is description
      remainingLines.push(line);
    }

    description = remainingLines.join(' ').trim();
  } else {
    // Single-line parsing
    let remaining = text.trim();

    // Extract assignee
    const mentionMatch = remaining.match(mentionRegex);
    if (mentionMatch) {
      const idMatch = mentionMatch[0].match(/<@([A-Z0-9]+)/);
      if (idMatch) {
        assigneeSlackId = idMatch[1];
      }
      remaining = remaining.replace(mentionRegex, '').trim();
    }

    // Extract "due X" pattern
    const dueMatch = remaining.match(/\bdue\s+(\S+)/i);
    if (dueMatch) {
      dueDate = dueMatch[1];
      remaining = remaining.replace(dueMatch[0], '').trim();
    }

    // Extract "urgency X" pattern
    const urgencyMatch = remaining.match(/\burgency\s+(high|medium|low)/i);
    if (urgencyMatch) {
      const urg = urgencyMatch[1].toLowerCase();
      if (urg === 'high') urgency = 'High';
      else if (urg === 'low') urgency = 'Low';
      else urgency = 'Medium';
      remaining = remaining.replace(urgencyMatch[0], '').trim();
    }

    // Extract "type X" pattern
    const typeMatch = remaining.match(/\btype\s+(\S+)/i);
    if (typeMatch) {
      taskType = getTaskTypeDisplayName(typeMatch[1]);
      remaining = remaining.replace(typeMatch[0], '').trim();
    }

    // Extract "notes: X" pattern (everything after notes:)
    const notesMatch = remaining.match(/\bnotes:\s*(.+)$/i);
    if (notesMatch) {
      notes = notesMatch[1].trim();
      remaining = remaining.replace(notesMatch[0], '').trim();
    }

    description = remaining.trim();
  }

  // Handle ASAP due date
  if (dueDate && isAsapDate(dueDate)) {
    dueDate = null;
    urgency = 'High';  // ASAP always sets High urgency
  }

  return {
    assigneeSlackId,
    description,
    dueDate,
    urgency,
    taskType,
    notes,
  };
}

export interface SlackTaskWorkflowInput {
  parsed: ParsedSlackTask;
  creatorSlackId: string;
}

/**
 * Execute Slack task creation workflow
 * Identical to email workflow but with Slack-specific Update format
 */
export async function executeSlackTaskWorkflow(input: SlackTaskWorkflowInput): Promise<WorkflowResult> {
  const { parsed, creatorSlackId } = input;

  // Generate unique Run ID for this workflow run
  const runId = randomUUID();
  const log = createLogger(runId);

  log.log('Starting Slack task workflow:', parsed.description);

  // Step 1: Resolve assignee
  // Import here to avoid circular dependency
  const { findUserBySlackId, getUserNamesString } = await import('./services/userResolver.js');

  if (!parsed.assigneeSlackId) {
    throw new Error('Assignee is required. Use @mention to assign.');
  }

  const user = await findUserBySlackId(parsed.assigneeSlackId);
  if (!user) {
    const availableUsers = await getUserNamesString();
    throw new Error(`Unknown user: <@${parsed.assigneeSlackId}>. Available users: ${availableUsers}`);
  }
  log.log('Resolved user:', user.name, 'Monday ID:', user.mondayId);

  // Step 2: Parse due date
  const formattedDueDate = parsed.dueDate ? parseDate(parsed.dueDate) : null;
  const finalUrgency = formattedDueDate === null ? 'High' : parsed.urgency;
  log.log('Due date:', formattedDueDate ?? 'ASAP (no date)');
  log.log('Urgency:', finalUrgency);

  // Step 3: Create Monday.com item
  const taskName = parsed.description || 'Slack Task';
  log.log('Creating Monday.com item...');
  const mondayItem = await monday.createItem({
    name: taskName,
    dueDate: formattedDueDate,
    ownerIds: [user.mondayId],
    taskType: parsed.taskType,
    source: 'Slack',  // Source = Slack for /task command
    urgency: finalUrgency,
  });
  log.log('Monday item created:', mondayItem.id);

  // Store Run ID on Monday item
  await monday.storeRunId(mondayItem.id, runId);

  // Set initial attachment state to Skipped (no attachments for Slack tasks)
  await monday.updateAttachmentState(mondayItem.id, 'Skipped');

  // Step 4: Create initial Monday Update
  // LOCKED ARCHITECTURE: Slack-created tasks have different format (no From/To/BCC)
  const initialUpdateParts: string[] = [];

  // Notes (if present)
  if (parsed.notes) {
    initialUpdateParts.push(`📝 ${parsed.notes}`);
  }

  // Creator provenance (Slack-specific)
  initialUpdateParts.push(`✍️ Created via Slack by <@${creatorSlackId}>`);

  // Run ID (always)
  initialUpdateParts.push(`🔗 Run ID: ${runId.substring(0, 8)}`);

  log.log('Creating initial Monday update...');
  await monday.createUpdate(mondayItem.id, initialUpdateParts.join('\n\n'));

  // Step 5: Send Slack notification (respects quiet-hours)
  log.log('Sending Slack notification...');
  const slackMessage = await slack.sendNotification({
    taskType: parsed.taskType,
    subject: taskName,
    assigneeSlackId: user.slackId || user.name,
    dueDate: formatDateForDisplay(formattedDueDate),
    priority: finalUrgency === 'High' ? 'high' : finalUrgency === 'Low' ? 'low' : 'medium',
    notes: parsed.notes ?? '',
    fromEmail: null,  // No From for Slack tasks
    toEmail: null,    // No To for Slack tasks
    mondayItemId: mondayItem.id,
    // No meeting detection for Slack-created tasks
  });
  log.log('Slack message sent:', slackMessage.ts);

  // Post Run ID to Slack thread
  await slack.postToThread(
    slackMessage.ts,
    `🔗 _Run ID: ${runId.substring(0, 8)}_`
  );

  // Step 6: Update Monday with Slack thread ID
  log.log('Updating Monday with Slack thread ID...');
  await monday.updateSlackThreadId(mondayItem.id, slackMessage.ts);

  log.log('Slack task workflow completed successfully!');

  return {
    mondayItemId: mondayItem.id,
    slackThreadTs: slackMessage.ts,
    success: true,
    runId,
    attachmentStatus: {
      slackUploaded: false,
      mondayUploaded: false,
      mondayRetryScheduled: false,
      pdfUrl: undefined,
      state: 'Skipped',
    },
  };
}

/**
 * Execute Slack task workflow with error handling
 */
export async function executeSlackTaskWorkflowSafe(input: SlackTaskWorkflowInput): Promise<WorkflowResult> {
  const runId = randomUUID();
  const log = createLogger(runId);

  try {
    return await executeSlackTaskWorkflow(input);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error('Slack task workflow failed:', errorMessage);

    return {
      mondayItemId: '',
      slackThreadTs: '',
      success: false,
      error: errorMessage,
      runId,
    };
  }
}
