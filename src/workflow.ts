/**
 * Main workflow orchestration
 *
 * This module coordinates the entire email forwarding workflow:
 * 1. Parse the incoming email and extract task details
 * 2. Parse the EML attachment for original email headers
 * 3. Convert EML to PDF (in parallel with step 4)
 * 4. Resolve user IDs for Monday and Slack
 * 5. Create Monday.com item
 * 6. Send Slack notification (can start after user resolution)
 * 7. Upload PDF to both Monday and Slack thread
 * 8. Update Monday with Slack thread ID
 */

import type {
  ParsedEmail,
  EmailAttachment,
  WorkflowResult,
  ConvertedFile,
} from './types/index.js';
import {
  parseTaskDetails,
  parseEmlAttachment,
  findEmlAttachment,
} from './services/emailParser.js';
import { convertEmlToPdf } from './services/convertApi.js';
import * as monday from './services/monday.js';
import * as slack from './services/slack.js';
import { findUserByName } from './config/users.js';
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

  // Step 2: Parse task details from email body
  const taskDetails = parseTaskDetails(email.text);
  console.log('Parsed task details:', taskDetails);

  // Step 3: Resolve the task type
  const taskType = getTaskTypeDisplayName(taskDetails.taskType);
  console.log('Task type:', taskType);

  // Step 4: Parse the due date
  const formattedDueDate = parseDate(taskDetails.dueDate);
  console.log('Due date:', formattedDueDate);

  // Step 5: Resolve user - from unified mapping (no API calls needed!)
  const user = findUserByName(taskDetails.owner);
  if (!user) {
    throw new Error(`Unknown user: ${taskDetails.owner}`);
  }
  console.log('Resolved user:', user.name, 'Monday ID:', user.mondayId);

  // Step 6: Run these in parallel:
  // - Parse EML headers
  // - Convert EML to PDF
  console.log('Starting parallel operations: EML parsing + PDF conversion');
  const [emlHeaders, pdfFile] = await Promise.all([
    parseEmlAttachment(emlAttachment.content),
    convertEmlToPdf(emlAttachment.content, emlAttachment.filename),
  ]);
  console.log('EML headers:', emlHeaders);
  console.log('PDF generated:', pdfFile.filename);

  // Step 7: Create Monday.com item
  console.log('Creating Monday.com item...');
  const mondayItem = await monday.createItem({
    name: email.subject,
    dueDate: formattedDueDate,
    ownerId: user.mondayId,
    taskType,
    fromEmail: emlHeaders.from,
    toEmail: emlHeaders.to,
    notes: taskDetails.notes,
  });
  console.log('Monday item created:', mondayItem.id);

  // Step 8: Resolve Slack user ID
  // Use the unified mapping first, fall back to API lookup
  let slackUserId = user.slackId;
  if (!slackUserId && user.email) {
    console.log('Looking up Slack user by email...');
    slackUserId = (await slack.findUserByEmail(user.email)) ?? '';
  }

  // If we still don't have a Slack ID, we'll mention them by name
  const slackMention = slackUserId || taskDetails.owner;

  // Step 9: Send Slack notification
  console.log('Sending Slack notification...');
  const slackMessage = await slack.sendNotification({
    taskType,
    subject: email.subject,
    assigneeSlackId: slackMention,
    dueDate: formatDateForDisplay(formattedDueDate),
    notes: taskDetails.notes,
    fromEmail: emlHeaders.from,
    toEmail: emlHeaders.to,
    mondayItemId: mondayItem.id,
  });
  console.log('Slack message sent:', slackMessage.ts);

  // Step 10: Upload PDF to both services in parallel
  console.log('Uploading PDF to Monday and Slack...');
  await Promise.all([
    monday.uploadFileToItem(mondayItem.id, pdfFile.filename, pdfFile.data),
    slack.uploadFileToThread(slackMessage.ts, pdfFile.filename, pdfFile.data, 'Email PDF'),
  ]);
  console.log('PDF uploaded to both services');

  // Step 11: Update Monday with Slack thread ID (for bidirectional linking)
  console.log('Updating Monday with Slack thread ID...');
  await monday.updateSlackThreadId(mondayItem.id, slackMessage.ts);
  console.log('Monday item updated with Slack thread ID');

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
