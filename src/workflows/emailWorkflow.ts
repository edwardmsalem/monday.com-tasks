/**
 * Email Forwarding Workflow
 *
 * Coordinates the complete email forwarding workflow:
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
 */

import { randomUUID } from 'crypto';
import type {
  ParsedEmail,
  WorkflowResult,
  AttachmentState,
} from '../types/index.js';
import {
  parseEmlAttachment,
  findEmlAttachment,
} from '../services/emailParser.js';
import { analyzeEmailSafe } from '../services/claude.js';
import { convertEmlToPdf } from '../services/convertApi.js';
import * as monday from '../services/monday.js';
import * as slack from '../services/slack.js';
import * as calendar from '../services/calendar.js';
import { findUserByName, getUserNamesString } from '../services/userResolver.js';
import { getTaskTypeDisplayName } from '../config/taskTypes.js';
import { config } from '../config/environment.js';
import { parseDate, formatDateForDisplay } from '../utils/dateParser.js';
import { shouldScanForRecipients, findRelatedRecipients, normalizeSubject, formatRecipientSubtaskName } from '../services/gmail.js';
import { createRecipientSheet, shouldCreateSheet } from '../services/sheets.js';
import * as todoist from '../services/todoist.js';
import { mapPriorityToUrgency, createLogger, postRunIdToSlack, applyIntentModeWithLogging, createFailedResult } from './shared.js';

// ============================================================================
// Types
// ============================================================================

export interface WorkflowInput {
  email: ParsedEmail;
}

// ============================================================================
// Email Workflow
// ============================================================================

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

  // Step 8.5: Apply intent-driven mode behavior (Phase 4/5)
  // - Relocation: Creates 4 checklist subitems with owners from Slack config
  // - Exclusive Presale: Detection only (uses /scan for recipients)
  await applyIntentModeWithLogging(mondayItem.id, taskType, taskName, log);

  // Step 8.6: Project to Todoist (if enabled)
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
    assigneeName: user.name,  // For after-hours display (QW-02)
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
  await postRunIdToSlack(slackMessage.ts, runId);

  // Step 11: Upload PDF - Slack first (human value), then Monday (best effort with retry)
  // Attachment failures do NOT fail the workflow
  // Respect ATTACHMENTS_MODE safety valve
  const attachmentsMode = config.safetyValves.attachmentsMode;
  log.log(`Uploading PDF attachments (mode: ${attachmentsMode})...`);

  // Track attachment status
  let slackUploaded = false;
  let mondayUploaded = false;
  let mondayRetryScheduled = false;
  let attachmentState: AttachmentState = attachmentsMode === 'off' ? 'Skipped' : 'Queued';

  // Step 11a: Upload to Slack first (priority for human visibility)
  if (attachmentsMode === 'slack_only' || attachmentsMode === 'both') {
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
  } else {
    log.log('Slack upload skipped (ATTACHMENTS_MODE)');
  }

  // Step 11b: Store durable PDF URL for retry scenarios (always, for manual recovery)
  if (pdfFile.url) {
    await monday.storePdfUrl(mondayItem.id, pdfFile.url);
  }

  // Step 11c: Upload to Monday with retry logic
  if (attachmentsMode === 'monday_only' || attachmentsMode === 'both') {
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
  } else {
    log.log('Monday upload skipped (ATTACHMENTS_MODE)');
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
    return createFailedResult(errorMessage, runId);
  }
}
