/**
 * Email Task Workflow
 *
 * Handles /emailtask command workflow:
 * - Search Gmail for emails matching criteria
 * - Use Claude AI to analyze email content
 * - Create Monday.com item with task details
 * - Send Slack notification
 * - Handle PDF attachments (if provided)
 */

import { randomUUID } from 'crypto';
import type {
  WorkflowResult,
  AttachmentState,
} from '../types/index.js';
import { analyzeEmailSafe } from '../services/claude.js';
import * as monday from '../services/monday.js';
import * as slack from '../services/slack.js';
import { findUserByName, getUserNamesString } from '../services/userResolver.js';
import { getTaskTypeDisplayName } from '../config/taskTypes.js';
import { config } from '../config/environment.js';
import { parseDate, formatDateForDisplay, isAsapDate } from '../utils/dateParser.js';
import { normalizeSubject } from '../services/gmail.js';
import { mapPriorityToUrgency, createLogger, postRunIdToSlack, applyIntentModeWithLogging, createFailedResult } from './shared.js';

// ============================================================================
// Types
// ============================================================================

export interface EmailTaskInput {
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  fromEmail: string | null;
  toEmail: string | null;
  emailDate: Date;
  pdfBuffer: Buffer | null;
  pdfFilename: string;
  source?: string;
  // Optional: Slack ID of the person who initiated this task creation (for authorization checks)
  initiatorSlackId?: string;
}

// ============================================================================
// Workflow Execution
// ============================================================================

/**
 * Execute /emailtask workflow
 * Creates a task from Gmail email content (no EML attachment needed)
 */
export async function executeEmailTaskWorkflow(input: EmailTaskInput): Promise<WorkflowResult> {
  const { subject, bodyText, fromEmail, toEmail, emailDate, pdfBuffer, pdfFilename, source = 'Email Task' } = input;

  // Generate unique Run ID for this workflow run
  const runId = randomUUID();
  const log = createLogger(runId);

  log.log('Starting email task workflow:', subject);

  // Step 1: Use Claude AI to analyze the email
  log.log('Analyzing email with Claude AI...');
  const analysisResult = await analyzeEmailSafe(
    subject,        // forwarding subject (use same as email)
    bodyText,       // forwarding body (use email body)
    subject,        // EML subject
    fromEmail,      // from the email
    toEmail,        // to the email
    bodyText        // EML body
  );
  log.log('Claude analysis:', analysisResult);

  // Step 2: Resolve task type
  const taskType = getTaskTypeDisplayName(analysisResult.taskType);
  log.log('Task type:', taskType);

  // Step 3: Parse due date (ASAP handling)
  let formattedDueDate = parseDate(analysisResult.dueDate);
  const asapDetected = isAsapDate(analysisResult.dueDate);
  if (asapDetected) {
    formattedDueDate = null;
    log.log('ASAP detected, no due date set');
  } else {
    log.log('Due date:', formattedDueDate ?? 'Not specified');
  }

  // Step 4: Resolve user from owner name (with authorization check)
  let resolvedOwner = analysisResult.owner;
  let ownerOverridden = false;

  // Authorization check: if initiator is not authorized, owner = initiator
  if (input.initiatorSlackId) {
    const ownerOverrideUserIds = config.slack.ownerOverrideUserIds;
    const isAuthorized = ownerOverrideUserIds.length === 0 || ownerOverrideUserIds.includes(input.initiatorSlackId);

    if (!isAuthorized) {
      // Non-authorized user: owner is the initiator, not what Claude detected
      const { findUserBySlackId } = await import('../services/userResolver.js');
      const initiator = await findUserBySlackId(input.initiatorSlackId);
      if (initiator) {
        resolvedOwner = initiator.name;
        ownerOverridden = true;
        log.log(`Owner overridden: ${analysisResult.owner} → ${initiator.name} (initiator not authorized)`);
      }
    }
  }

  const user = await findUserByName(resolvedOwner);
  if (!user) {
    const availableUsers = await getUserNamesString();
    throw new Error(`Unknown user: ${resolvedOwner}. Available users: ${availableUsers}`);
  }
  log.log('Resolved owner:', user.name, 'Monday ID:', user.mondayId, ownerOverridden ? '(overridden)' : '');

  // Step 5: Determine priority/urgency
  const finalUrgency = asapDetected ? 'High' : mapPriorityToUrgency(analysisResult.priority);
  log.log('Urgency:', finalUrgency);

  // Step 6: Use normalized subject as task name (strip FWD:/RE:)
  const taskName = normalizeSubject(subject);
  log.log('Task name:', taskName);

  // Step 7: Create Monday.com item
  log.log('Creating Monday.com item...');
  const mondayItem = await monday.createItem({
    name: taskName,
    dueDate: formattedDueDate,
    ownerIds: [user.mondayId],
    taskType,
    source,
    team: analysisResult.team ?? undefined,
    urgency: finalUrgency,
  });
  log.log('Monday item created:', mondayItem.id);

  // Store Run ID on Monday item
  await monday.storeRunId(mondayItem.id, runId);

  // Step 8: Create initial Monday Update with narrative context
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
  initialUpdateParts.push(`📅 Email Date: ${emailDate.toLocaleString('en-US', { timeZone: 'America/New_York' })}`);
  initialUpdateParts.push(`🔗 Run ID: ${runId.substring(0, 8)}`);

  log.log('Creating initial Monday update...');
  await monday.createUpdate(mondayItem.id, initialUpdateParts.join('\n\n'));

  // If team wasn't identified, ask for clarification
  if (!analysisResult.team) {
    await monday.createUpdate(mondayItem.id, '⚠️ Team not identified. Please update the Team field if this relates to a specific sports team.');
  }

  // Step 8.5: Apply intent-driven mode behavior (Phase 4/5)
  await applyIntentModeWithLogging(mondayItem.id, taskType, taskName, log);

  // Step 9: Send Slack notification
  log.log('Sending Slack notification...');
  const slackMessage = await slack.sendNotification({
    taskType,
    subject: taskName,
    assigneeSlackId: user.slackId || user.name,
    assigneeName: user.name,  // For after-hours display (QW-02)
    dueDate: formatDateForDisplay(formattedDueDate),
    priority: analysisResult.priority,
    notes: analysisResult.notes,
    fromEmail,
    toEmail,
    mondayItemId: mondayItem.id,
    meeting: analysisResult.meeting,
  });
  log.log('Slack message sent:', slackMessage.ts);

  // Post Run ID to Slack thread
  await postRunIdToSlack(slackMessage.ts, runId);

  // Step 10: Handle PDF upload (if provided)
  const attachmentsMode = config.safetyValves.attachmentsMode;
  log.log(`Uploading PDF attachments (mode: ${attachmentsMode})...`);

  let slackUploaded = false;
  let mondayUploaded = false;
  let mondayRetryScheduled = false;
  let attachmentState: AttachmentState = !pdfBuffer ? 'Skipped' : (attachmentsMode === 'off' ? 'Skipped' : 'Queued');

  if (pdfBuffer && attachmentsMode !== 'off') {
    // Upload to Slack
    if (attachmentsMode === 'slack_only' || attachmentsMode === 'both') {
      try {
        await slack.uploadFileToThread(slackMessage.ts, pdfFilename, pdfBuffer, 'Email PDF');
        slackUploaded = true;
        log.log('PDF uploaded to Slack thread');
      } catch (slackError) {
        log.error('Slack file upload failed (non-fatal):', slackError);
        await slack.postToThread(slackMessage.ts, `⚠️ Slack PDF upload failed: ${slackError instanceof Error ? slackError.message : 'Unknown error'}`);
      }
    }

    // Upload to Monday
    if (attachmentsMode === 'monday_only' || attachmentsMode === 'both') {
      const postToSlackThread = async (message: string) => {
        await slack.postToThread(slackMessage.ts, message);
      };

      try {
        const uploadResult = await monday.uploadFileToItemWithRetry(
          mondayItem.id,
          pdfFilename,
          pdfBuffer,
          slackMessage.ts,
          postToSlackThread
        );
        mondayUploaded = uploadResult.success;
        mondayRetryScheduled = uploadResult.retryScheduled;

        if (mondayUploaded) {
          log.log('PDF uploaded to Monday');
          attachmentState = 'Uploaded';
        } else if (mondayRetryScheduled) {
          log.log('Monday upload failed, retries scheduled');
          attachmentState = 'Retrying';
        }
      } catch (mondayError) {
        log.error('Monday file upload failed (non-fatal):', mondayError);
        attachmentState = 'Failed';
        await monday.createUpdate(mondayItem.id, `⚠️ Monday PDF upload failed: ${mondayError instanceof Error ? mondayError.message : 'Unknown error'}`);
      }
    }
  } else {
    attachmentState = 'Skipped';
  }

  // Update attachment state column
  await monday.updateAttachmentState(mondayItem.id, attachmentState);
  log.log(`Attachment status: Slack=${slackUploaded}, Monday=${mondayUploaded}, State=${attachmentState}`);

  // Step 11: Update Monday with Slack thread ID
  log.log('Updating Monday with Slack thread ID...');
  await monday.updateSlackThreadId(mondayItem.id, slackMessage.ts);

  log.log('Email task workflow completed successfully!');

  return {
    mondayItemId: mondayItem.id,
    slackThreadTs: slackMessage.ts,
    success: true,
    runId,
    attachmentStatus: {
      slackUploaded,
      mondayUploaded,
      mondayRetryScheduled,
      pdfUrl: undefined,
      state: attachmentState,
    },
  };
}

/**
 * Execute /emailtask workflow with error handling
 */
export async function executeEmailTaskWorkflowSafe(input: EmailTaskInput): Promise<WorkflowResult> {
  const runId = randomUUID();
  const log = createLogger(runId);

  try {
    return await executeEmailTaskWorkflow(input);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error('Email task workflow failed:', errorMessage);
    return createFailedResult(errorMessage, runId);
  }
}
