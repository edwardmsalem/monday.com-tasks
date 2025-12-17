/**
 * Main workflow orchestration
 *
 * This module coordinates the entire email forwarding workflow:
 * 1. Parse the incoming email and EML attachment
 * 2. Use Claude AI to intelligently extract task details
 * 3. Convert EML to PDF
 * 4. Create Monday.com item
 * 5. Send Slack notification
 * 6. Upload PDF to both Monday and Slack
 * 7. Update Monday with Slack thread ID
 */

import type {
  ParsedEmail,
  WorkflowResult,
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
import { parseDate, formatDateForDisplay } from './utils/dateParser.js';

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

  // Step 2: Parse EML headers first (needed for Claude analysis)
  console.log('Parsing EML attachment...');
  const emlHeaders = await parseEmlAttachment(emlAttachment.content);
  console.log('EML headers:', emlHeaders);

  // Step 3: Use Claude AI to analyze the email and extract task details
  console.log('Analyzing email with Claude AI...');
  const analysisResult = await analyzeEmailSafe(
    email.subject,
    email.text,
    emlHeaders.subject,
    emlHeaders.from,
    emlHeaders.to
  );
  console.log('Claude analysis:', analysisResult);
  console.log(`Confidence: ${(analysisResult.confidence * 100).toFixed(0)}%`);

  // Step 4: Resolve the task type (Claude might return alias or display name)
  const taskType = getTaskTypeDisplayName(analysisResult.taskType);
  console.log('Task type:', taskType);

  // Step 5: Parse the due date
  const formattedDueDate = parseDate(analysisResult.dueDate);
  console.log('Due date:', formattedDueDate);

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
  console.log('Creating Monday.com item...');
  const mondayItem = await monday.createItem({
    name: email.subject,
    dueDate: formattedDueDate,
    ownerIds: [user.mondayId],  // Support multiple owners
    taskType,
    source: 'Forwarding Tasks',
    fromEmail: emlHeaders.from,
    toEmail: emlHeaders.to,
    notes: analysisResult.notes,
  });
  console.log('Monday item created:', mondayItem.id);

  // Step 9: Use Slack ID from unified user mapping (already matched by email)
  const slackMention = user.slackId || user.name;

  // Step 10: Send Slack notification
  console.log('Sending Slack notification...');
  const slackMessage = await slack.sendNotification({
    taskType,
    subject: email.subject,
    assigneeSlackId: slackMention,
    dueDate: formatDateForDisplay(formattedDueDate),
    priority: analysisResult.priority,
    notes: analysisResult.notes,
    fromEmail: emlHeaders.from,
    toEmail: emlHeaders.to,
    mondayItemId: mondayItem.id,
  });
  console.log('Slack message sent:', slackMessage.ts);

  // Step 11: Upload PDF to both services in parallel
  console.log('Uploading PDF to Monday and Slack...');
  await Promise.all([
    monday.uploadFileToItem(mondayItem.id, pdfFile.filename, pdfFile.data),
    slack.uploadFileToThread(slackMessage.ts, pdfFile.filename, pdfFile.data, 'Email PDF'),
  ]);
  console.log('PDF uploaded to both services');

  // Step 12: Update Monday with Slack thread ID
  console.log('Updating Monday with Slack thread ID...');
  await monday.updateSlackThreadId(mondayItem.id, slackMessage.ts);
  console.log('Monday item updated with Slack thread ID');

  // Step 13: Create Google Calendar event (if enabled)
  if (calendar.isCalendarEnabled()) {
    console.log('Creating Google Calendar event...');
    const calendarEvent = await calendar.createTaskEvent({
      title: `[${taskType}] ${email.subject}`,
      description: analysisResult.notes,
      dueDate: formattedDueDate,
      assigneeEmail: user.email,
      mondayItemId: mondayItem.id,
    });
    if (calendarEvent) {
      console.log('Calendar event created:', calendarEvent.eventId);
    }
  }

  // Step 14: Set Slack reminder for assignee (if they have a Slack ID)
  if (user.slackId) {
    console.log('Setting Slack reminder...');
    await slack.setReminder({
      userId: user.slackId,
      text: `Task due: ${email.subject}\n${monday.getItemUrl(mondayItem.id)}`,
      dueDate: formattedDueDate,
    });
  }

  console.log('Workflow completed successfully!');

  return {
    mondayItemId: mondayItem.id,
    slackThreadTs: slackMessage.ts,
    success: true,
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
