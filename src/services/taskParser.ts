/**
 * Claude AI-powered natural language task parser
 *
 * Understands freeform task descriptions and extracts:
 * - Task name/description
 * - Assignee
 * - Due date
 * - Task type
 * - Priority
 *
 * If required fields are missing, it identifies what questions to ask.
 */

import { claude as coreApiClaude } from './coreApi.js';
import { findUserByName, getAllUsers, type UnifiedUser } from './userResolver.js';

export interface ParsedTask {
  name: string | null;
  assignee: string | null;
  dueDate: string | null;
  taskType: string | null;
  priority: 'high' | 'medium' | 'low' | null;
  rawDueDate: string | null; // The original due date text before parsing
  team: string | null;       // Sports team if mentioned
}

export interface MissingFields {
  needsName: boolean;
  needsAssignee: boolean;
  needsDueDate: boolean;
}

export interface TaskParseResult {
  parsed: ParsedTask;
  missing: MissingFields;
  suggestedQuestions: string[];
  isComplete: boolean;
}

/**
 * Parse a natural language task description using Claude AI
 */
export async function parseTaskWithAI(
  text: string,
  slackUserId: string
): Promise<TaskParseResult> {
  // Get list of available users for context
  const users = await getAllUsers();
  const userNames = users.map(u => u.name).join(', ');

  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];

  const response = await coreApiClaude.toolUse({
    model: 'claude-sonnet-4-5-20250929',
    maxTokens: 1024,
    tools: [
      {
        name: 'extract_task',
        description: 'Extract task details from natural language input',
        input_schema: {
          type: 'object' as const,
          properties: {
            task_name: {
              type: 'string',
              description: 'The main task description/title. Should be clear and actionable.',
            },
            assignee: {
              type: 'string',
              description: 'The name of the person assigned to this task. Look for names, @mentions, or pronouns like "me", "myself".',
            },
            due_date: {
              type: 'string',
              description: 'The due date in YYYY-MM-DD format. Parse relative dates like "tomorrow", "next friday", "in 3 days", "end of week", etc.',
            },
            due_date_raw: {
              type: 'string',
              description: 'The original due date text as mentioned by the user (e.g., "friday", "next week", "asap").',
            },
            task_type: {
              type: 'string',
              description: 'The type/category of task if mentioned (e.g., "bug", "feature", "meeting", "review", "invoice", "refund").',
            },
            priority: {
              type: 'string',
              enum: ['high', 'medium', 'low'],
              description: 'Priority level based on urgency words like "urgent", "asap", "when you can", "low priority".',
            },
            team: {
              type: 'string',
              description: 'Sports team name if mentioned (e.g., "Yankees", "Knicks", "Rangers", "Giants"). Look for team names in the task description.',
            },
            missing_name: {
              type: 'boolean',
              description: 'True if no clear task description was provided.',
            },
            missing_assignee: {
              type: 'boolean',
              description: 'True if no assignee was mentioned or implied.',
            },
            missing_due_date: {
              type: 'boolean',
              description: 'True if no due date or timeframe was mentioned.',
            },
          },
          required: ['missing_name', 'missing_assignee', 'missing_due_date'],
        },
      },
    ],
    toolChoice: { type: 'tool', name: 'extract_task' },
    messages: [
      {
        role: 'user',
        content: `You are a task extraction assistant. Parse the following task request and extract all available information.

Today's date: ${todayStr} (${today.toLocaleDateString('en-US', { weekday: 'long' })})

Available team members: ${userNames}

User's Slack ID: ${slackUserId} (if they say "me" or "myself" or "I'll do it", use this)

Task request: "${text}"

Extract what you can and mark fields as missing if they're not provided. Be generous in interpretation - if someone says "friday" assume this friday (or next if today is friday). If they say "asap" or "urgent", set high priority but still mark due date as missing since we need a specific date.`,
      },
    ],
  });

  if (!response.toolUse) {
    throw new Error('Claude did not return task extraction');
  }

  const input = response.toolUse.input as {
    task_name?: string;
    assignee?: string;
    due_date?: string;
    due_date_raw?: string;
    task_type?: string;
    priority?: 'high' | 'medium' | 'low';
    team?: string;
    missing_name: boolean;
    missing_assignee: boolean;
    missing_due_date: boolean;
  };

  // Resolve assignee - check if "me" or similar
  let resolvedAssignee = input.assignee || null;
  if (resolvedAssignee) {
    const lowerAssignee = resolvedAssignee.toLowerCase();
    if (['me', 'myself', 'i', "i'll", 'self'].includes(lowerAssignee)) {
      // Will be resolved to the Slack user later
      resolvedAssignee = `<@${slackUserId}>`;
    }
  }

  const parsed: ParsedTask = {
    name: input.task_name || null,
    assignee: resolvedAssignee,
    dueDate: input.due_date || null,
    taskType: input.task_type || null,
    priority: input.priority || null,
    rawDueDate: input.due_date_raw || null,
    team: input.team || null,
  };

  const missing: MissingFields = {
    needsName: input.missing_name || !parsed.name,
    needsAssignee: input.missing_assignee || !parsed.assignee,
    needsDueDate: input.missing_due_date || !parsed.dueDate,
  };

  // Generate follow-up questions
  const questions: string[] = [];
  if (missing.needsName) {
    questions.push("What's the task? Please describe what needs to be done.");
  }
  if (missing.needsAssignee) {
    questions.push("Who should this be assigned to?");
  }
  if (missing.needsDueDate) {
    questions.push("When is this due?");
  }

  return {
    parsed,
    missing,
    suggestedQuestions: questions,
    isComplete: !missing.needsName && !missing.needsAssignee && !missing.needsDueDate,
  };
}

/**
 * Parse a follow-up response that contains answers to multiple missing fields
 * Uses Claude to intelligently extract assignee and due date from natural language
 */
export async function parseFollowUpAnswers(
  existing: ParsedTask,
  answerText: string,
  missingFields: Array<'name' | 'assignee' | 'dueDate'>,
  slackUserId: string
): Promise<ParsedTask> {
  const users = await getAllUsers();
  const userNames = users.map(u => u.name).join(', ');

  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];

  // Build the prompt based on what we need
  const fieldsDescription = missingFields.map(f => {
    switch (f) {
      case 'name': return 'task description';
      case 'assignee': return 'assignee (person name)';
      case 'dueDate': return 'due date';
    }
  }).join(', ');

  const response = await coreApiClaude.toolUse({
    model: 'claude-sonnet-4-5-20250929',
    maxTokens: 512,
    tools: [
      {
        name: 'extract_answers',
        description: 'Extract task field values from the user response',
        input_schema: {
          type: 'object' as const,
          properties: {
            task_name: {
              type: 'string',
              description: 'The task description if provided',
            },
            assignee: {
              type: 'string',
              description: 'The assignee name. Look for names, "me", "myself", or @mentions',
            },
            due_date: {
              type: 'string',
              description: 'The due date in YYYY-MM-DD format',
            },
            due_date_raw: {
              type: 'string',
              description: 'The original due date text (e.g., "friday", "next week")',
            },
          },
        },
      },
    ],
    toolChoice: { type: 'tool', name: 'extract_answers' },
    messages: [
      {
        role: 'user',
        content: `Extract the following from the user's response: ${fieldsDescription}

Today's date: ${todayStr} (${today.toLocaleDateString('en-US', { weekday: 'long' })})
Available team members: ${userNames}
User's Slack ID: ${slackUserId} (if they say "me" or "myself", return "me")

User's response: "${answerText}"

Examples of valid responses:
- "john, friday" → assignee: john, due_date: this friday
- "assign to sarah due tomorrow" → assignee: sarah, due_date: tomorrow
- "me, next week" → assignee: me, due_date: next monday
- "friday for john" → assignee: john, due_date: this friday`,
      },
    ],
  });

  if (!response.toolUse) {
    return existing;
  }

  const input = response.toolUse.input as {
    task_name?: string;
    assignee?: string;
    due_date?: string;
    due_date_raw?: string;
  };

  // Build updated parsed task
  const updated = { ...existing };

  if (missingFields.includes('name') && input.task_name) {
    updated.name = input.task_name;
  }

  if (missingFields.includes('assignee') && input.assignee) {
    let assignee = input.assignee;
    if (['me', 'myself', 'i'].includes(assignee.toLowerCase())) {
      assignee = `<@${slackUserId}>`;
    }
    updated.assignee = assignee;
  }

  if (missingFields.includes('dueDate') && input.due_date) {
    updated.dueDate = input.due_date;
    updated.rawDueDate = input.due_date_raw || input.due_date;
  }

  return updated;
}

/**
 * Format a confirmation message for the parsed task
 */
export function formatTaskConfirmation(task: ParsedTask, assigneeName: string): string {
  const priorityEmoji = task.priority === 'high' ? ' :red_circle:' :
                        task.priority === 'low' ? ' :large_green_circle:' : '';

  let message = `*Task:* ${task.name}${priorityEmoji}\n` +
         `*Assigned to:* ${assigneeName}\n` +
         `*Due:* ${task.rawDueDate || task.dueDate}`;

  if (task.taskType) message += `\n*Type:* ${task.taskType}`;
  if (task.team) message += `\n*Team:* ${task.team}`;

  return message;
}
