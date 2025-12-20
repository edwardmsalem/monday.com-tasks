/**
 * Two-way sync service between Monday.com and Slack
 *
 * Handles:
 * - Slack thread replies → Monday updates
 * - Monday updates → Slack thread replies
 * - Smart @ mention translation between platforms
 * - Status sync (checkmark ↔ complete)
 * - AI-powered natural language task creation
 */

import { config } from '../config/environment.js';
import * as monday from './monday.js';
import * as slack from './slack.js';
import { getAllUsers, findUserByName, type UnifiedUser } from './userResolver.js';
import { parseTaskWithAI, parseFollowUpAnswers, type ParsedTask } from './taskParser.js';
import {
  storePendingTask,
  getPendingTask,
  clearPendingTask,
  getMissingFields,
  generateQuestionBlocks,
  generateConfirmationBlocks,
  type PendingTask,
} from './conversationState.js';

/**
 * Translate @ mentions from Slack format to Monday format
 * <@U12345> → finds matching Monday user and returns their name/id
 */
export async function translateSlackMentionsToMonday(text: string): Promise<string> {
  const users = await getAllUsers();
  const slackMentionRegex = /<@([A-Z0-9]+)>/g;

  let result = text;
  let match;

  while ((match = slackMentionRegex.exec(text)) !== null) {
    const slackUserId = match[1];
    const user = users.find(u => u.slackId === slackUserId);

    if (user) {
      // Replace Slack mention with Monday-friendly @name
      result = result.replace(match[0], `@${user.name}`);
    }
  }

  return result;
}

/**
 * Translate @ mentions from Monday format to Slack format
 * @John Smith → finds matching Slack user and returns <@U12345>
 */
export async function translateMondayMentionsToSlack(text: string): Promise<string> {
  const users = await getAllUsers();

  let result = text;

  // Sort users by name length (longest first) to avoid partial matches
  const sortedUsers = [...users].sort((a, b) => b.name.length - a.name.length);

  for (const user of sortedUsers) {
    if (!user.slackId) continue;

    // Match @Name or @FirstName patterns
    const patterns = [
      new RegExp(`@${escapeRegex(user.name)}\\b`, 'gi'),
      new RegExp(`@${escapeRegex(user.name.split(' ')[0])}\\b`, 'gi'),
    ];

    for (const pattern of patterns) {
      result = result.replace(pattern, `<@${user.slackId}>`);
    }
  }

  return result;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Sync a Slack thread message to Monday as an update
 */
export async function syncSlackToMonday(
  slackThreadTs: string,
  messageText: string,
  slackUserId: string
): Promise<void> {
  console.log(`Looking up Monday item for Slack thread: ${slackThreadTs}`);

  // Find the Monday item ID from the Slack thread
  const mondayItemId = await monday.findItemBySlackThread(slackThreadTs);

  if (!mondayItemId) {
    console.warn(`No Monday item found for Slack thread ${slackThreadTs} - check if thread ID is stored correctly in Monday`);
    return;
  }

  console.log(`Found Monday item ${mondayItemId} for thread ${slackThreadTs}`);

  // Translate Slack mentions to Monday format
  const translatedText = await translateSlackMentionsToMonday(messageText);

  // Get the user's name for the update
  const users = await getAllUsers();
  const user = users.find(u => u.slackId === slackUserId);
  const authorName = user?.name ?? 'Slack User';

  // Create update in Monday
  await monday.createUpdate(mondayItemId, `[From Slack - ${authorName}]\n${translatedText}`);

  console.log(`Synced Slack message to Monday item ${mondayItemId}`);
}

/**
 * Sync a Monday update to Slack as a thread reply
 */
export async function syncMondayToSlack(
  mondayItemId: string,
  updateText: string,
  mondayUserId: number
): Promise<void> {
  // Get the Slack thread ID from the Monday item
  const slackThreadTs = await monday.getSlackThreadId(mondayItemId);

  if (!slackThreadTs) {
    console.warn(`No Slack thread found for Monday item ${mondayItemId}`);
    return;
  }

  // Translate Monday mentions to Slack format
  const translatedText = await translateMondayMentionsToSlack(updateText);

  // Get the user's name for the message
  const mondayUser = await monday.getUser(mondayUserId);
  const authorName = mondayUser?.name ?? 'Monday User';

  // Post to Slack thread
  await slack.postToThread(slackThreadTs, `*[From Monday - ${authorName}]*\n${translatedText}`);

  console.log(`Synced Monday update to Slack thread ${slackThreadTs}`);
}

/**
 * Mark Monday item as acknowledged when 👀 reaction added in Slack
 */
export async function markAcknowledgedFromSlack(slackThreadTs: string): Promise<void> {
  const mondayItemId = await monday.findItemBySlackThread(slackThreadTs);

  if (!mondayItemId) {
    console.warn(`No Monday item found for Slack thread ${slackThreadTs}`);
    return;
  }

  await monday.updateWorkflowStatus(mondayItemId, 'Acknowledged');
  console.log(`Marked Monday item ${mondayItemId} as Acknowledged from Slack 👀 reaction`);
}

/**
 * Mark Monday item as complete when checkmark reaction added in Slack
 */
export async function markCompleteFromSlack(slackThreadTs: string): Promise<void> {
  const mondayItemId = await monday.findItemBySlackThread(slackThreadTs);

  if (!mondayItemId) {
    console.warn(`No Monday item found for Slack thread ${slackThreadTs}`);
    return;
  }

  await monday.updateWorkflowStatus(mondayItemId, 'Complete');
  console.log(`Marked Monday item ${mondayItemId} as Complete from Slack reaction`);
}

/**
 * Remove completion from Monday when checkmark reaction removed in Slack
 */
export async function unmarkCompleteFromSlack(slackThreadTs: string): Promise<void> {
  const mondayItemId = await monday.findItemBySlackThread(slackThreadTs);

  if (!mondayItemId) {
    console.warn(`No Monday item found for Slack thread ${slackThreadTs}`);
    return;
  }

  await monday.updateWorkflowStatus(mondayItemId, 'Working on it');
  console.log(`Unmarked Monday item ${mondayItemId} from Slack reaction removal`);
}

/**
 * Post completion update to Slack when Monday status changes to Complete
 */
export async function notifySlackOfCompletion(
  mondayItemId: string,
  completedBy: string
): Promise<void> {
  const slackThreadTs = await monday.getSlackThreadId(mondayItemId);

  if (!slackThreadTs) {
    console.warn(`No Slack thread found for Monday item ${mondayItemId}`);
    return;
  }

  await slack.postToThread(
    slackThreadTs,
    `:white_check_mark: *Task completed* by ${completedBy}`
  );

  // Also add checkmark reaction to the original message
  await slack.addReaction(slackThreadTs, 'white_check_mark');

  console.log(`Notified Slack of completion for Monday item ${mondayItemId}`);
}

/**
 * Create a Monday item from a Slack slash command
 */
export interface QuickTaskInput {
  name: string;
  assignee?: string;
  dueDate?: string;
  taskType?: string;
  slackUserId: string;
  slackChannelId: string;
}

export async function createQuickTask(input: QuickTaskInput): Promise<{
  mondayItemId: string;
  mondayUrl: string;
}> {
  const users = await getAllUsers();

  // Find assignee - default to the user who ran the command
  let assignee: UnifiedUser | undefined;

  if (input.assignee) {
    // Try to find by name
    const searchName = input.assignee.toLowerCase().replace(/^@/, '');
    assignee = users.find(
      u =>
        u.name.toLowerCase() === searchName ||
        u.name.split(' ')[0].toLowerCase() === searchName
    );
  }

  if (!assignee) {
    // Default to command user
    assignee = users.find(u => u.slackId === input.slackUserId);
  }

  if (!assignee) {
    throw new Error('Could not determine task assignee');
  }

  // Parse due date or default to tomorrow
  const dueDate = input.dueDate ?? getTomorrowDate();

  // Create the Monday item
  const mondayItem = await monday.createItem({
    name: input.name,
    dueDate,
    ownerIds: [assignee.mondayId],  // Support multiple owners
    taskType: input.taskType ?? 'General',
    source: 'Slack Tasks',
    // NOTE: From/To not applicable for Slack-created tasks
  });

  const mondayUrl = monday.getItemUrl(mondayItem.id);

  // Post confirmation to Slack
  await slack.postEphemeral(
    input.slackChannelId,
    input.slackUserId,
    `:white_check_mark: Task created!\n*${input.name}*\nAssigned to: ${assignee.name}\nDue: ${dueDate}\n<${mondayUrl}|View in Monday>`
  );

  return {
    mondayItemId: mondayItem.id,
    mondayUrl,
  };
}

function getTomorrowDate(): string {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return tomorrow.toISOString().split('T')[0];
}

/**
 * Parse slash command arguments
 * /monday add Fix the bug @john due:friday type:issue
 */
export function parseSlashCommand(text: string): {
  action: string;
  name: string;
  assignee?: string;
  dueDate?: string;
  taskType?: string;
} {
  const parts = text.trim().split(/\s+/);
  const action = parts[0]?.toLowerCase() ?? '';

  // Extract special flags
  let assignee: string | undefined;
  let dueDate: string | undefined;
  let taskType: string | undefined;
  const nameParts: string[] = [];

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];

    if (part.startsWith('@')) {
      assignee = part.slice(1);
    } else if (part.toLowerCase().startsWith('due:')) {
      dueDate = parseDueFlag(part.slice(4));
    } else if (part.toLowerCase().startsWith('type:')) {
      taskType = part.slice(5);
    } else {
      nameParts.push(part);
    }
  }

  return {
    action,
    name: nameParts.join(' '),
    assignee,
    dueDate,
    taskType,
  };
}

function parseDueFlag(value: string): string {
  const lower = value.toLowerCase();

  // Handle relative dates
  if (lower === 'today') {
    return new Date().toISOString().split('T')[0];
  }
  if (lower === 'tomorrow') {
    return getTomorrowDate();
  }

  // Handle day names
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const dayIndex = days.indexOf(lower);
  if (dayIndex !== -1) {
    const today = new Date();
    const currentDay = today.getDay();
    let daysUntil = dayIndex - currentDay;
    if (daysUntil <= 0) daysUntil += 7; // Next week if today or past
    today.setDate(today.getDate() + daysUntil);
    return today.toISOString().split('T')[0];
  }

  // Handle +N format
  if (lower.startsWith('+')) {
    const days = parseInt(lower.slice(1), 10);
    if (!isNaN(days)) {
      const date = new Date();
      date.setDate(date.getDate() + days);
      return date.toISOString().split('T')[0];
    }
  }

  // Try parsing as date
  const parsed = new Date(value);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString().split('T')[0];
  }

  // Default to tomorrow
  return getTomorrowDate();
}

// ============================================================================
// AI-Powered Task Creation (with follow-up questions)
// ============================================================================

export interface SmartTaskResponse {
  type: 'created' | 'needs_info' | 'confirmation' | 'cancelled' | 'error';
  message?: string;
  blocks?: unknown[];
  mondayItemId?: string;
  mondayUrl?: string;
}

/**
 * Start creating a task from natural language input
 * Uses Claude AI to parse the request and asks follow-up questions if needed
 */
export async function startSmartTaskCreation(
  text: string,
  slackUserId: string,
  slackChannelId: string
): Promise<SmartTaskResponse> {
  try {
    // Parse the input with AI
    const result = await parseTaskWithAI(text, slackUserId);

    if (result.isComplete) {
      // All required fields present - store for confirmation and show confirm dialog
      storePendingTask(slackChannelId, slackUserId, {
        parsed: result.parsed,
        missing: result.missing,
        slackUserId,
        slackChannelId,
        awaitingFields: [],
        createdAt: Date.now(),
      });

      const assigneeName = await resolveAssigneeName(result.parsed.assignee!, slackUserId);

      return {
        type: 'confirmation',
        blocks: generateConfirmationBlocks(
          result.parsed.name!,
          assigneeName,
          result.parsed.rawDueDate || result.parsed.dueDate!,
          result.parsed.taskType,
          result.parsed.priority,
          result.parsed.team
        ),
      };
    }

    // Missing required fields - get ALL missing fields
    const missingFields = getMissingFields(result.missing);

    if (missingFields.length === 0) {
      // Shouldn't happen, but handle gracefully
      return {
        type: 'error',
        message: 'Something went wrong parsing your request. Please try again.',
      };
    }

    // Store the pending task with all missing fields
    storePendingTask(slackChannelId, slackUserId, {
      parsed: result.parsed,
      missing: result.missing,
      slackUserId,
      slackChannelId,
      awaitingFields: missingFields,
      createdAt: Date.now(),
    });

    // Ask all questions at once
    return {
      type: 'needs_info',
      blocks: generateQuestionBlocks(missingFields, result.parsed),
    };
  } catch (error) {
    console.error('Smart task creation error:', error);
    return {
      type: 'error',
      message: 'Sorry, I had trouble understanding that. Please try again or use `/monday help`.',
    };
  }
}

/**
 * Continue task creation with additional input (answers to all questions at once)
 */
export async function continueSmartTaskCreation(
  text: string,
  slackUserId: string,
  slackChannelId: string
): Promise<SmartTaskResponse> {
  const pending = getPendingTask(slackChannelId, slackUserId);

  if (!pending || pending.awaitingFields.length === 0) {
    // No pending task - treat as new request
    return startSmartTaskCreation(text, slackUserId, slackChannelId);
  }

  try {
    // Parse all answers at once using AI
    const updatedParsed = await parseFollowUpAnswers(
      pending.parsed,
      text,
      pending.awaitingFields,
      slackUserId
    );

    // Check what's still missing
    const newMissing = {
      needsName: !updatedParsed.name,
      needsAssignee: !updatedParsed.assignee,
      needsDueDate: !updatedParsed.dueDate,
    };

    const stillMissingFields = getMissingFields(newMissing);

    if (stillMissingFields.length === 0) {
      // All fields complete - show confirmation
      clearPendingTask(slackChannelId, slackUserId);

      const assigneeName = await resolveAssigneeName(updatedParsed.assignee!, slackUserId);

      // Store for confirmation
      storePendingTask(slackChannelId, slackUserId, {
        parsed: updatedParsed,
        missing: newMissing,
        slackUserId,
        slackChannelId,
        awaitingFields: [],
        createdAt: Date.now(),
      });

      return {
        type: 'confirmation',
        blocks: generateConfirmationBlocks(
          updatedParsed.name!,
          assigneeName,
          updatedParsed.rawDueDate || updatedParsed.dueDate!,
          updatedParsed.taskType,
          updatedParsed.priority,
          updatedParsed.team
        ),
      };
    }

    // Still missing some fields - ask again for what's still missing
    storePendingTask(slackChannelId, slackUserId, {
      parsed: updatedParsed,
      missing: newMissing,
      slackUserId,
      slackChannelId,
      awaitingFields: stillMissingFields,
      createdAt: Date.now(),
    });

    return {
      type: 'needs_info',
      message: "I'm still missing some info:",
      blocks: generateQuestionBlocks(stillMissingFields, updatedParsed),
    };
  } catch (error) {
    console.error('Continue task creation error:', error);
    return {
      type: 'error',
      message: 'Sorry, I had trouble understanding that. Please try again.',
    };
  }
}

/**
 * Confirm and create the task
 */
export async function confirmSmartTask(
  slackUserId: string,
  slackChannelId: string
): Promise<SmartTaskResponse> {
  const pending = getPendingTask(slackChannelId, slackUserId);

  if (!pending) {
    return {
      type: 'error',
      message: 'No pending task found. Please start over with `/monday`.',
    };
  }

  const { parsed } = pending;

  if (!parsed.name || !parsed.assignee || !parsed.dueDate) {
    return {
      type: 'error',
      message: 'Task is missing required information. Please start over.',
    };
  }

  try {
    // Resolve assignee
    const assignee = await resolveAssignee(parsed.assignee, slackUserId);

    if (!assignee) {
      return {
        type: 'error',
        message: `Could not find user "${parsed.assignee}". Please try again.`,
      };
    }

    // Create the Monday item
    const mondayItem = await monday.createItem({
      name: parsed.name,
      dueDate: parsed.dueDate,
      ownerIds: [assignee.mondayId],  // Support multiple owners
      taskType: parsed.taskType ?? 'General',
      source: 'Slack Tasks',
      team: parsed.team ?? undefined,
      // NOTE: From/To not applicable for Slack-created tasks
    });

    const mondayUrl = monday.getItemUrl(mondayItem.id);

    // Clear the pending task
    clearPendingTask(slackChannelId, slackUserId);

    return {
      type: 'created',
      message: `:white_check_mark: *Task created!*\n\n*${parsed.name}*\nAssigned to: ${assignee.name}\nDue: ${parsed.rawDueDate || parsed.dueDate}\n\n<${mondayUrl}|View in Monday.com>`,
      mondayItemId: mondayItem.id,
      mondayUrl,
    };
  } catch (error) {
    console.error('Confirm task error:', error);
    return {
      type: 'error',
      message: 'Failed to create task. Please try again.',
    };
  }
}

/**
 * Cancel pending task creation
 */
export function cancelSmartTask(
  slackUserId: string,
  slackChannelId: string
): SmartTaskResponse {
  clearPendingTask(slackChannelId, slackUserId);
  return {
    type: 'cancelled',
    message: ':x: Task creation cancelled.',
  };
}

/**
 * Check if there's a pending task for this user
 */
export function hasPendingTask(slackUserId: string, slackChannelId: string): boolean {
  return getPendingTask(slackChannelId, slackUserId) !== null;
}

/**
 * Resolve assignee name from Slack ID or name
 */
async function resolveAssigneeName(assignee: string, fallbackSlackId: string): Promise<string> {
  const users = await getAllUsers();

  // Check if it's a Slack mention
  const slackMatch = assignee.match(/<@([A-Z0-9]+)>/);
  if (slackMatch) {
    const user = users.find(u => u.slackId === slackMatch[1]);
    return user?.name ?? 'Unknown';
  }

  // Try to find by name
  const user = await findUserByName(assignee);
  if (user) {
    return user.name;
  }

  // Fallback to the requesting user
  const fallbackUser = users.find(u => u.slackId === fallbackSlackId);
  return fallbackUser?.name ?? assignee;
}

/**
 * Resolve assignee to a UnifiedUser
 */
async function resolveAssignee(assignee: string, fallbackSlackId: string): Promise<UnifiedUser | null> {
  const users = await getAllUsers();

  // Check if it's a Slack mention
  const slackMatch = assignee.match(/<@([A-Z0-9]+)>/);
  if (slackMatch) {
    return users.find(u => u.slackId === slackMatch[1]) ?? null;
  }

  // Try to find by name
  const user = await findUserByName(assignee);
  if (user) {
    return user;
  }

  // Fallback to the requesting user
  return users.find(u => u.slackId === fallbackSlackId) ?? null;
}
