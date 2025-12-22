/**
 * Slack Task Workflow
 *
 * Handles /task command workflow:
 * - AI-powered natural language parsing (same as email workflow)
 * - Resolve owner and support users
 * - Create Monday.com item
 * - Send Slack notification
 * - Apply intent-driven modes
 */

import { randomUUID } from 'crypto';
import type { WorkflowResult } from '../types/index.js';
import * as monday from '../services/monday.js';
import * as slack from '../services/slack.js';
import { getTaskTypeDisplayName } from '../config/taskTypes.js';
import { parseDate, formatDateForDisplay, isAsapDate } from '../utils/dateParser.js';
import { createLogger, postRunIdToSlack, applyIntentModeWithLogging, createFailedResult, mapPriorityToUrgency } from './shared.js';
import { analyzeSlackTaskSafe, type SlackTaskAnalysisResult } from '../services/claude.js';

// ============================================================================
// Types
// ============================================================================

export interface SlackTaskInput {
  /** Raw text from /task command */
  text: string;
  /** Slack user ID of the creator */
  creatorSlackId: string;
}

export interface ParsedSlackTask {
  ownerSlackId: string | null;       // Owner (restricted - only authorized users can assign to others)
  supportSlackIds: string[];          // Support users (anyone can set)
  ownerExplicitlySet: boolean;        // True if user explicitly used "owner:" prefix
  description: string;
  dueDate: string | null;  // Parsed date or null for ASAP
  urgency: 'High' | 'Medium' | 'Low';
  taskType: string;
  notes: string | null;
}

export interface SlackTaskWorkflowInput {
  parsed: ParsedSlackTask;
  creatorSlackId: string;
}

// ============================================================================
// Parser
// ============================================================================

/**
 * Parse /task command input (single-line or multiline)
 *
 * Supported formats:
 * - Single-line: /task @support1 @support2 refund due fri urgency high notes: customer called twice
 * - With explicit owner (authorized users only):
 *   /task owner: @john @support Fix the bug due friday
 * - Multiline:
 *   owner: @john
 *   support: @jane
 *   due fri
 *   refund
 *   notes...
 *
 * Owner vs Support:
 * - owner: Sets the task owner (ONLY authorized users can use this - others: owner = creator)
 * - support: or plain @mentions → Support users (anyone can set this, not auto-pinged)
 * - Default owner is always the task creator (set in handler, not here)
 */
export function parseSlackTaskInput(text: string): ParsedSlackTask {
  const lines = text.trim().split('\n').map(l => l.trim()).filter(l => l.length > 0);

  let ownerSlackId: string | null = null;
  let supportSlackIds: string[] = [];
  let ownerExplicitlySet = false;
  let description = '';
  let dueDate: string | null = null;
  let urgency: 'High' | 'Medium' | 'Low' = 'Medium';
  let taskType = 'General';
  let notes: string | null = null;

  // Extract @mentions (Slack format: <@U123ABC> or <@U123ABC|name>)
  const mentionRegex = /<@([A-Z0-9]+)(?:\|[^>]+)?>/g;
  // Extract single mention ID
  const extractMentionId = (str: string): string | null => {
    const match = str.match(/<@([A-Z0-9]+)(?:\|[^>]+)?>/);
    return match ? match[1] : null;
  };
  // Extract all mention IDs from a string
  const extractAllMentionIds = (str: string): string[] => {
    const ids: string[] = [];
    let match;
    const regex = /<@([A-Z0-9]+)(?:\|[^>]+)?>/g;
    while ((match = regex.exec(str)) !== null) {
      ids.push(match[1]);
    }
    return ids;
  };

  // Check if multiline format (lines with patterns like "due", "urgency", "@", "owner:", "support:")
  const isMultiline = lines.length > 1 && lines.some(l =>
    /^<@[A-Z0-9]+/.test(l) ||
    /^owner:/i.test(l) ||
    /^support:/i.test(l) ||
    /^due\s/i.test(l) ||
    /^urgency\s/i.test(l) ||
    /^type\s/i.test(l) ||
    /^notes:/i.test(l)
  );

  if (isMultiline) {
    // Multiline parsing
    const remainingLines: string[] = [];

    for (const line of lines) {
      // Explicit owner: line (only authorized users can use this)
      if (/^owner:/i.test(line)) {
        const ownerPart = line.replace(/^owner:\s*/i, '').trim();
        const ownerId = extractMentionId(ownerPart);
        if (ownerId) {
          ownerSlackId = ownerId;
          ownerExplicitlySet = true;
        }
        continue;
      }

      // Explicit support: line (can have multiple @mentions)
      if (/^support:/i.test(line)) {
        const supportPart = line.replace(/^support:\s*/i, '').trim();
        const supportIds = extractAllMentionIds(supportPart);
        supportSlackIds.push(...supportIds);
        continue;
      }

      // Plain @mention line → goes to Support (NOT owner)
      const mentionMatch = line.match(mentionRegex);
      if (mentionMatch) {
        const ids = extractAllMentionIds(line);
        supportSlackIds.push(...ids);
        // If line is just mentions, skip adding to description
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

    // Extract explicit "owner: @user" pattern first
    const ownerMatch = remaining.match(/\bowner:\s*(<@[A-Z0-9]+(?:\|[^>]+)?>)/i);
    if (ownerMatch) {
      const id = extractMentionId(ownerMatch[1]);
      if (id) {
        ownerSlackId = id;
        ownerExplicitlySet = true;
      }
      remaining = remaining.replace(ownerMatch[0], '').trim();
    }

    // Extract "support: @user @user2" pattern (greedy - all consecutive mentions after support:)
    const supportMatch = remaining.match(/\bsupport:\s*((?:<@[A-Z0-9]+(?:\|[^>]+)?>\s*)+)/i);
    if (supportMatch) {
      const ids = extractAllMentionIds(supportMatch[1]);
      supportSlackIds.push(...ids);
      remaining = remaining.replace(supportMatch[0], '').trim();
    }

    // Extract any remaining @mentions as Support (NOT owner)
    // Plain mentions always go to Support - owner can only be set via explicit owner:
    const plainMentions = extractAllMentionIds(remaining);
    if (plainMentions.length > 0) {
      supportSlackIds.push(...plainMentions);
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
    ownerSlackId,
    supportSlackIds,
    ownerExplicitlySet,
    description,
    dueDate,
    urgency,
    taskType,
    notes,
  };
}

// ============================================================================
// Workflow Execution
// ============================================================================

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

  // Step 1: Resolve owner
  // Import here to avoid circular dependency
  const { findUserBySlackId, getUserNamesString } = await import('../services/userResolver.js');

  if (!parsed.ownerSlackId) {
    throw new Error('Owner is required. Use @mention to assign.');
  }

  const owner = await findUserBySlackId(parsed.ownerSlackId);
  if (!owner) {
    const availableUsers = await getUserNamesString();
    throw new Error(`Unknown user: <@${parsed.ownerSlackId}>. Available users: ${availableUsers}`);
  }
  log.log('Resolved owner:', owner.name, 'Monday ID:', owner.mondayId);

  // Step 1b: Resolve support users (if any)
  const supportUsers: Array<{ mondayId: string; slackId: string; name: string }> = [];
  for (const supportSlackId of parsed.supportSlackIds) {
    const supportUser = await findUserBySlackId(supportSlackId);
    if (supportUser) {
      supportUsers.push({
        mondayId: String(supportUser.mondayId),  // Convert to string for Monday API
        slackId: supportUser.slackId || supportSlackId,
        name: supportUser.name,
      });
      log.log('Resolved support user:', supportUser.name);
    } else {
      log.warn(`Could not resolve support user <@${supportSlackId}>`);
    }
  }

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
    ownerIds: [owner.mondayId],
    supportIds: supportUsers.map(u => u.mondayId),
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

  // Step 4.5: Apply intent-driven mode behavior (Phase 4/5)
  await applyIntentModeWithLogging(mondayItem.id, parsed.taskType, taskName, log);

  // Step 5: Send Slack notification (respects quiet-hours)
  // Build assignee mentions (owner + support)
  const ownerMention = owner.slackId || owner.name;
  const supportMentions = supportUsers.map(u => u.slackId || u.name);

  log.log('Sending Slack notification...');
  const slackMessage = await slack.sendNotification({
    taskType: parsed.taskType,
    subject: taskName,
    assigneeSlackId: ownerMention,
    assigneeName: owner.name,  // For after-hours display (QW-02)
    supportSlackIds: supportMentions,
    dueDate: formatDateForDisplay(formattedDueDate),
    priority: finalUrgency === 'High' ? 'high' : finalUrgency === 'Low' ? 'low' : 'medium',
    notes: parsed.notes ?? '',
    fromEmail: null,  // No From for Slack tasks
    toEmail: null,    // No To for Slack tasks
    mondayItemId: mondayItem.id,
    // No meeting detection for Slack-created tasks
  });
  log.log('Slack message sent:', slackMessage.ts);

  // Step 5.5: Notify supporters in their respective channels
  if (supportUsers.length > 0) {
    log.log(`Notifying ${supportUsers.length} supporter(s) in their channels...`);
    const supporterPriority = finalUrgency === 'High' ? 'high' : finalUrgency === 'Low' ? 'low' : 'medium';
    for (const supporter of supportUsers) {
      if (supporter.slackId) {
        try {
          await slack.notifySupporterInChannel(
            supporter.slackId,
            supporter.name,
            {
              taskSubject: taskName,
              taskType: parsed.taskType,
              ownerName: owner.name,
              dueDate: formatDateForDisplay(formattedDueDate),
              priority: supporterPriority,
              notes: parsed.notes || undefined,
            },
            slackMessage.ts,
            mondayItem.id
          );
        } catch (err) {
          log.warn(`Failed to notify supporter ${supporter.name} in their channel`);
        }
      }
    }
  }

  // Post Run ID to Slack thread
  await postRunIdToSlack(slackMessage.ts, runId);

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
    return createFailedResult(errorMessage, runId);
  }
}

// ============================================================================
// AI-Powered Workflow (Same as Email Workflow)
// ============================================================================

export interface AISlackTaskInput {
  /** Raw text from /task command */
  text: string;
  /** Slack user ID of the creator */
  creatorSlackId: string;
}

/**
 * Execute AI-powered Slack task workflow
 * Works exactly like the email workflow - natural language in, structured task out
 */
export async function executeAISlackTaskWorkflow(input: AISlackTaskInput): Promise<WorkflowResult> {
  const { text, creatorSlackId } = input;

  // Generate unique Run ID for this workflow run
  const runId = randomUUID();
  const log = createLogger(runId);

  log.log('Starting AI-powered Slack task workflow:', text);

  // Step 1: Use Claude AI to analyze the task text (just like email workflow)
  log.log('Analyzing task with Claude AI...');
  const analysis = await analyzeSlackTaskSafe(text, creatorSlackId);
  log.log('Claude analysis:', analysis);
  log.log(`Confidence: ${(analysis.confidence * 100).toFixed(0)}%`);

  // Step 2: Resolve task type
  const taskType = getTaskTypeDisplayName(analysis.taskType);
  log.log('Task type:', taskType);

  // Step 3: Parse due date (may be null for ASAP)
  const formattedDueDate = parseDate(analysis.dueDate);
  const urgency = mapPriorityToUrgency(analysis.priority);
  log.log('Due date:', formattedDueDate ?? 'ASAP (no date)');
  log.log('Urgency:', urgency);

  // If ASAP detected and priority wasn't already high, set to high
  const finalUrgency = formattedDueDate === null ? 'High' : urgency;

  // Step 4: Resolve owner
  const { findUserByName, findUserBySlackId, getUserNamesString } = await import('../services/userResolver.js');

  let owner;

  // Check if owner was specified
  if (analysis.owner) {
    // Check for slack_mention:U12345 format (from @mention)
    const slackMentionMatch = analysis.owner.match(/^slack_mention:([A-Z0-9]+)$/i);
    if (slackMentionMatch) {
      owner = await findUserBySlackId(slackMentionMatch[1]);
    } else {
      // Try to find by name
      owner = await findUserByName(analysis.owner);
    }
  }

  // If no owner found, default to creator
  if (!owner) {
    owner = await findUserBySlackId(creatorSlackId);
    if (analysis.owner) {
      log.warn(`Could not find owner "${analysis.owner}", defaulting to creator`);
    } else {
      log.log('No owner specified, defaulting to creator');
    }
  }

  if (!owner) {
    const availableUsers = await getUserNamesString();
    throw new Error(`Could not resolve owner. Available users: ${availableUsers}`);
  }
  log.log('Resolved owner:', owner.name, 'Monday ID:', owner.mondayId);

  // Step 5: Resolve support users (if any)
  const supportUsers: Array<{ mondayId: string; slackId: string; name: string }> = [];
  for (const supporterName of analysis.supporters) {
    // Check for slack_mention format
    const slackMentionMatch = supporterName.match(/^slack_mention:([A-Z0-9]+)$/i);
    let supportUser;
    if (slackMentionMatch) {
      supportUser = await findUserBySlackId(slackMentionMatch[1]);
    } else {
      supportUser = await findUserByName(supporterName);
    }

    if (supportUser) {
      supportUsers.push({
        mondayId: String(supportUser.mondayId),
        slackId: supportUser.slackId || '',
        name: supportUser.name,
      });
      log.log('Resolved support user:', supportUser.name);
    } else {
      log.warn(`Could not resolve support user "${supporterName}"`);
    }
  }

  // Step 6: Create Monday.com item
  const taskName = analysis.description || 'Slack Task';
  log.log('Creating Monday.com item...');
  const mondayItem = await monday.createItem({
    name: taskName,
    dueDate: formattedDueDate,
    ownerIds: [owner.mondayId],
    supportIds: supportUsers.map(u => u.mondayId),
    taskType,
    source: 'Slack Tasks',
    urgency: finalUrgency,
    team: analysis.team ?? undefined,
  });
  log.log('Monday item created:', mondayItem.id);

  // Store Run ID on Monday item
  await monday.storeRunId(mondayItem.id, runId);

  // Set initial attachment state to Skipped (no attachments for Slack tasks)
  await monday.updateAttachmentState(mondayItem.id, 'Skipped');

  // Step 7: Create initial Monday Update
  const initialUpdateParts: string[] = [];

  // Notes (if present)
  if (analysis.notes) {
    initialUpdateParts.push(`📝 ${analysis.notes}`);
  }

  // Creator provenance
  initialUpdateParts.push(`✍️ Created via Slack by <@${creatorSlackId}>`);

  // Run ID (always)
  initialUpdateParts.push(`🔗 Run ID: ${runId.substring(0, 8)}`);

  log.log('Creating initial Monday update...');
  await monday.createUpdate(mondayItem.id, initialUpdateParts.join('\n\n'));

  // Step 8: Apply intent-driven mode behavior
  await applyIntentModeWithLogging(mondayItem.id, taskType, taskName, log);

  // Step 9: Send Slack notification (respects quiet-hours)
  const ownerMention = owner.slackId || owner.name;
  const supportMentions = supportUsers.map(u => u.slackId || u.name);

  log.log('Sending Slack notification...');
  const slackMessage = await slack.sendNotification({
    taskType,
    subject: taskName,
    assigneeSlackId: ownerMention,
    assigneeName: owner.name,
    supportSlackIds: supportMentions,
    dueDate: formatDateForDisplay(formattedDueDate),
    priority: analysis.priority,
    notes: analysis.notes ?? '',
    fromEmail: null,
    toEmail: null,
    mondayItemId: mondayItem.id,
  });
  log.log('Slack message sent:', slackMessage.ts);

  // Step 10: Notify supporters in their respective channels
  if (supportUsers.length > 0) {
    log.log(`Notifying ${supportUsers.length} supporter(s) in their channels...`);
    for (const supporter of supportUsers) {
      if (supporter.slackId) {
        try {
          await slack.notifySupporterInChannel(
            supporter.slackId,
            supporter.name,
            {
              taskSubject: taskName,
              taskType,
              ownerName: owner.name,
              dueDate: formatDateForDisplay(formattedDueDate),
              priority: analysis.priority,
              notes: analysis.notes || undefined,
            },
            slackMessage.ts,
            mondayItem.id
          );
        } catch (err) {
          log.warn(`Failed to notify supporter ${supporter.name} in their channel`);
        }
      }
    }
  }

  // Post Run ID to Slack thread
  await postRunIdToSlack(slackMessage.ts, runId);

  // Step 11: Update Monday with Slack thread ID
  log.log('Updating Monday with Slack thread ID...');
  await monday.updateSlackThreadId(mondayItem.id, slackMessage.ts);

  log.log('AI Slack task workflow completed successfully!');

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
 * Execute AI Slack task workflow with error handling
 */
export async function executeAISlackTaskWorkflowSafe(input: AISlackTaskInput): Promise<WorkflowResult> {
  const runId = randomUUID();
  const log = createLogger(runId);

  try {
    return await executeAISlackTaskWorkflow(input);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error('AI Slack task workflow failed:', errorMessage);
    return createFailedResult(errorMessage, runId);
  }
}
