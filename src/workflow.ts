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
 */

import type {
  ParsedEmail,
  WorkflowResult,
  Priority,
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
 * Execute the complete workflow
 */
export async function executeWorkflow(input: WorkflowInput): Promise<WorkflowResult> {
  const { email } = input;

  console.log('Starting workflow for email:', email.subject);

  // Step 1: Find the EML attachment
  const emlAttachment = findEmlAttachment(email.attachments);
  if (!emlAttachment) {
    throw new Error('No EML attachment found in the email');
  }

  // Step 2: Parse EML headers and body (needed for Claude analysis)
  console.log('Parsing EML attachment...');
  const emlHeaders = await parseEmlAttachment(emlAttachment.content);
  console.log('EML headers:', emlHeaders);
  if (emlHeaders.body) {
    console.log('EML body length:', emlHeaders.body.length, 'chars');
  }

  // Step 3: Use Claude AI to analyze the email and extract task details
  // Now includes the actual EML body for meeting detection, etc.
  console.log('Analyzing email with Claude AI...');
  const analysisResult = await analyzeEmailSafe(
    email.subject,
    email.text,
    emlHeaders.subject,
    emlHeaders.from,
    emlHeaders.to,
    emlHeaders.body  // Pass the EML body content
  );
  console.log('Claude analysis:', analysisResult);
  console.log(`Confidence: ${(analysisResult.confidence * 100).toFixed(0)}%`);
  if (analysisResult.meeting.hasMeetingRequest) {
    console.log('Meeting detected:', analysisResult.meeting);
  }

  // Step 4: Resolve the task type (Claude might return alias or display name)
  const taskType = getTaskTypeDisplayName(analysisResult.taskType);
  console.log('Task type:', taskType);

  // Step 5: Parse the due date (may be null for ASAP)
  const formattedDueDate = parseDate(analysisResult.dueDate);
  const urgency = mapPriorityToUrgency(analysisResult.priority);
  console.log('Due date:', formattedDueDate ?? 'ASAP (no date)');
  console.log('Urgency:', urgency);

  // If ASAP detected and priority wasn't already high, set to high
  const finalUrgency = formattedDueDate === null ? 'High' : urgency;

  // Step 6: Resolve user dynamically from Monday.com/Slack
  const user = await findUserByName(analysisResult.owner);
  if (!user) {
    const availableUsers = await getUserNamesString();
    throw new Error(`Unknown user: ${analysisResult.owner}. Available users: ${availableUsers}`);
  }
  console.log('Resolved user:', user.name, 'Monday ID:', user.mondayId, 'Slack ID:', user.slackId ?? 'N/A');

  // Step 7: Convert EML to PDF (can run in parallel with Monday item creation)
  console.log('Converting EML to PDF...');
  const pdfFile = await convertEmlToPdf(emlAttachment.content, emlAttachment.filename);
  console.log('PDF generated:', pdfFile.filename);

  // Step 8: Create Monday.com item
  // Use normalized subject (strip FWD:/RE:) as task name
  const taskName = normalizeSubject(email.subject);
  console.log('Creating Monday.com item...');
  const mondayItem = await monday.createItem({
    name: taskName,
    dueDate: formattedDueDate,  // May be null for ASAP
    ownerIds: [user.mondayId],  // Support multiple owners
    taskType,
    source: 'Forwarding Tasks',
    urgency: finalUrgency,  // Map Claude priority to Monday urgency
    fromEmail: emlHeaders.from,
    toEmail: emlHeaders.to,
  });
  console.log('Monday item created:', mondayItem.id);

  // Create initial update (comment) on the Monday item with notes
  if (analysisResult.notes) {
    console.log('Creating Monday update with notes...');
    await monday.createUpdate(mondayItem.id, analysisResult.notes);
  }

  // Step 8.5: Check for /scan command in email body
  // If present, search Gmail for related recipients and create subtasks with appointment times
  let sheetUrl: string | null = null;
  if (shouldScanForRecipients(email.text)) {
    console.log('/scan detected - searching for related recipients and appointments...');
    try {
      const recipients = await findRelatedRecipients(email.subject);
      if (recipients.length > 0) {
        console.log(`Found ${recipients.length} related recipients, creating subtasks...`);
        // Format subtask names with appointment times (e.g., "john@client.com - Tue Dec 20, 2:00 PM")
        const subtaskNames = recipients.map(formatRecipientSubtaskName);
        const subtasks = await monday.createSubitems(mondayItem.id, subtaskNames);
        console.log(`Created ${subtasks.length} subtasks for recipients`);

        // Create Google Sheet for presale/relocation emails
        if (shouldCreateSheet(taskName)) {
          console.log('Creating Google Sheet for recipient tracking...');
          try {
            const sheet = await createRecipientSheet(taskName, recipients);
            sheetUrl = sheet.spreadsheetUrl;
            console.log(`Google Sheet created: ${sheetUrl}`);

            // Post sheet link as Monday update
            await monday.createUpdate(
              mondayItem.id,
              `📊 Recipient tracking spreadsheet created:\n${sheetUrl}`
            );
          } catch (sheetError) {
            console.error('Failed to create Google Sheet:', sheetError);
          }
        }
      } else {
        console.log('No related recipients found in the last 48 hours');
      }
    } catch (error) {
      console.error('/scan failed:', error);
      // Don't fail the whole workflow if scan fails
    }
  }

  // Step 9: Use Slack ID from unified user mapping (already matched by email)
  const slackMention = user.slackId || user.name;

  // Step 10: Send Slack notification
  console.log('Sending Slack notification...');
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
  console.log('Slack message sent:', slackMessage.ts);

  // Step 11: Upload PDF - Slack first (human value), then Monday (best effort with retry)
  // Attachment failures do NOT fail the workflow
  console.log('Uploading PDF attachments...');

  // Track attachment status
  let slackUploaded = false;
  let mondayUploaded = false;
  let mondayRetryScheduled = false;

  // Step 11a: Upload to Slack first (priority for human visibility)
  try {
    await slack.uploadFileToThread(slackMessage.ts, pdfFile.filename, pdfFile.data, 'Email PDF');
    slackUploaded = true;
    console.log('PDF uploaded to Slack thread');
  } catch (slackError) {
    console.error('Slack file upload failed (non-fatal):', slackError);
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
      console.log('PDF uploaded to Monday');
    } else if (mondayRetryScheduled) {
      console.log('Monday upload failed, retries scheduled in background');
    }
  } catch (mondayError) {
    console.error('Monday file upload failed (non-fatal):', mondayError);
    // Continue - Monday upload failure is not critical, task still exists
  }

  console.log(`Attachment status: Slack=${slackUploaded}, Monday=${mondayUploaded}, RetryScheduled=${mondayRetryScheduled}`);

  // Step 11.5: Post Google Sheet link to Slack thread (if created)
  if (sheetUrl) {
    console.log('Posting Google Sheet link to Slack thread...');
    await slack.postToThread(
      slackMessage.ts,
      `📊 *Recipient Tracking Sheet*\n${sheetUrl}\n_Edit this spreadsheet to track status and add notes._`
    );
  }

  // Step 12: Update Monday with Slack thread ID
  console.log('Updating Monday with Slack thread ID...');
  await monday.updateSlackThreadId(mondayItem.id, slackMessage.ts);
  console.log('Monday item updated with Slack thread ID');

  // Step 13: Create Google Calendar event (if enabled and has a due date)
  // Skip calendar event for ASAP tasks with no date
  if (calendar.isCalendarEnabled() && formattedDueDate) {
    console.log('Creating Google Calendar event...');
    const calendarEvent = await calendar.createTaskEvent({
      title: `[${taskType}] ${taskName}`,
      description: analysisResult.notes,
      dueDate: formattedDueDate,
      assigneeEmail: user.email,
      mondayItemId: mondayItem.id,
    });
    if (calendarEvent) {
      console.log('Calendar event created:', calendarEvent.eventId);
    }
  } else if (calendar.isCalendarEnabled() && !formattedDueDate) {
    console.log('Skipping calendar event for ASAP task (no due date)');
  }

  // Note: Slack reminders require a user token, not a bot token
  // Skipping reminder - users can set their own via Monday due date notifications

  console.log('Workflow completed successfully!');

  return {
    mondayItemId: mondayItem.id,
    slackThreadTs: slackMessage.ts,
    success: true,
    attachmentStatus: {
      slackUploaded,
      mondayUploaded,
      mondayRetryScheduled,
      pdfUrl: pdfFile.url,
    },
  };
}

/**
 * Execute workflow with error handling
 */
export async function executeWorkflowSafe(input: WorkflowInput): Promise<WorkflowResult> {
  try {
    return await executeWorkflow(input);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Workflow failed:', errorMessage);

    return {
      mondayItemId: '',
      slackThreadTs: '',
      success: false,
      error: errorMessage,
    };
  }
}
