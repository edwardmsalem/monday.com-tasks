/**
 * Claude AI service for intelligent email analysis
 *
 * Uses Claude to extract task details from natural language emails,
 * eliminating the need for rigid line-by-line formatting.
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config/environment.js';
import { TASK_TYPE_MAPPINGS } from '../config/taskTypes.js';
import { getUserNamesString } from './userResolver.js';
import type { TaskDetails } from '../types/index.js';

let anthropicClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({
      apiKey: config.anthropic.apiKey,
    });
  }
  return anthropicClient;
}

// Build task type context (static, doesn't need dynamic loading)
const availableTaskTypes = TASK_TYPE_MAPPINGS.map(t =>
  `${t.displayName} (aliases: ${t.aliases.join(', ')})`
).join('\n  - ');

/**
 * Build the system prompt with dynamic user names
 */
function buildSystemPrompt(userNames: string): string {
  return `You are an email analysis assistant. Your job is to extract task assignment details from forwarded emails.

Available team members to assign tasks to:
${userNames}

Available task types:
  - ${availableTaskTypes}

When analyzing an email, extract:
1. **Owner**: Who should this task be assigned to? Match to one of the available team members by first name or full name.
2. **Supporters**: Additional team members who should help with this task (NOT the owner). Look for:
   - "X for support" or "X as support"
   - "with X's help" or "have X help"
   - "CC X" or "copy X"
   - "X to assist" or "X for backup"
   - Return an empty array if no supporters mentioned
3. **Due Date**: When is this due? Can be:
   - Relative: "tomorrow", "next week", "in 3 days" → convert to "+N" format (e.g., "+1", "+7", "+3")
   - Absolute: Any date format → convert to "MM/DD/YY" format
   - "today" or "due today" → "+0" (NOT null, NOT ASAP)
   - If no date mentioned, default to "+1" (tomorrow)
4. **Task Type**: What kind of task is this? Match to one of the available types.
   - Payment Plan: payment plans, payment arrangements, installments
   - Refund: refund requests, money back
   - Decline: declined payments, card issues
   - Revoked: revoked tickets, cancellations
   - Renewal: renewals, season ticket renewals
   - Relocation: seat relocations, moves
   - Opportunity: sales opportunities, upsells
   - Issue Call: customer complaints, issues requiring a call
   - General: anything else
5. **Priority**: Detect urgency level:
   - high: Contains "ASAP", "urgent", "immediately", "critical", "emergency", angry customer, escalation
   - medium: Standard task with a deadline, customer waiting
   - low: FYI, informational, no rush, when you get a chance
6. **Notes**: Clean up the forwarding notes for grammar and clarity ONLY. Rules:
   - Only use words and concepts the forwarder actually wrote
   - Fix spelling, grammar, punctuation
   - Do NOT add context from the email being forwarded
   - Do NOT explain what the customer wants or who is involved
   - Do NOT infer or add details like product names, ticket types, etc.
   - If they wrote "opt in for all 3" keep it as "opt in for all 3" - don't specify what the 3 are
   - If there are no notes beyond assignment info, leave notes empty.
7. **Meeting Request**: Detect if the email contains a meeting/appointment request:
   - Look for phrases like "let's meet", "can we schedule", "are you available", "let's set up a call"
   - Extract proposed date(s) and time(s) if mentioned
   - Note the timezone if specified (default to EST/America/New_York)
8. **Team**: ONLY extract a sports team if explicitly mentioned in the email. Rules:
   - Only recognize: MLB, NFL, NBA, NHL, MLS teams, and NCAA Division 1 teams
   - Examples: Yankees, Mets, Knicks, Nets, Rangers, Islanders, Giants, Jets, Devils, etc.
   - Return null if no team is clearly mentioned - NEVER guess
   - Do NOT infer team from context (e.g., "basketball tickets" does not mean Knicks)

IMPORTANT: For notes, ONLY use words the forwarder wrote. Do NOT pull in context from the forwarded email content. Do NOT add "Customer wants" or explain what the email is about.

Be smart about inferring the owner, date, and task type. For example:
- "Send this to Dayna for next Friday" → owner: dayna, due date: calculate days until Friday
- "Refund request - handle ASAP" → task type: Refund, due date: +1, priority: high
- "FYI - customer feedback" → priority: low
- "Jamie for support" → supporters: ["jamie"]
- "Dayna with help from Jamie and John" → owner: dayna, supporters: ["jamie", "john"]`;
}

/**
 * Build the tool definition with dynamic user names
 */
function buildExtractTaskTool(userNames: string): Anthropic.Tool {
  return {
    name: 'extract_task_details',
    description: 'Extract task assignment details from the email',
    input_schema: {
      type: 'object' as const,
      properties: {
        owner: {
          type: 'string',
          description: `The team member to assign this task to. Should match one of: ${userNames}. Use first name or full name.`,
        },
        supporters: {
          type: 'array',
          items: { type: 'string' },
          description: `Additional team members to help with this task (NOT the owner). Look for "X for support", "with X's help", "CC X". Match to: ${userNames}. Return empty array if none.`,
        },
        dueDate: {
          type: 'string',
          description: 'The due date in either relative format (+N days) or absolute format (MM/DD/YY)',
        },
        taskType: {
          type: 'string',
          enum: TASK_TYPE_MAPPINGS.flatMap(t => [t.displayName, ...t.aliases]),
          description: 'The type of task',
        },
        priority: {
          type: 'string',
          enum: ['high', 'medium', 'low'],
          description: 'Priority level: high (urgent/ASAP), medium (standard), low (FYI/no rush)',
        },
        notes: {
          type: 'string',
          description: 'Additional context or important details extracted from the email',
        },
        confidence: {
          type: 'number',
          description: 'Confidence score from 0 to 1 for the extraction',
        },
        hasMeetingRequest: {
          type: 'boolean',
          description: 'True if the email contains a meeting or appointment request',
        },
        meetingDateTime: {
          type: 'string',
          description: 'If meeting requested, the proposed date and time in ISO 8601 format (e.g., "2025-12-20T14:00:00"). Null if no specific time mentioned.',
        },
        meetingDateTimeAlt: {
          type: 'string',
          description: 'If multiple times proposed, the alternative date/time in ISO 8601 format. Null if only one option.',
        },
        team: {
          type: 'string',
          description: 'Sports team name ONLY if explicitly mentioned (MLB, NFL, NBA, NHL, MLS, NCAA D1). Return null if not clearly stated - never guess.',
        },
      },
      required: ['owner', 'dueDate', 'taskType', 'priority', 'notes', 'confidence', 'hasMeetingRequest'],
    },
  };
}

export type Priority = 'high' | 'medium' | 'low';

export interface MeetingInfo {
  hasMeetingRequest: boolean;
  meetingDateTime: string | null;
  meetingDateTimeAlt: string | null;
}

export interface AnalysisResult extends TaskDetails {
  priority: Priority;
  confidence: number;
  meeting: MeetingInfo;
  team: string | null;
  supporters: string[];  // Team member names who should help (not the owner)
}

/**
 * Analyze an email using Claude AI to extract task details
 */
export async function analyzeEmail(
  emailSubject: string,
  emailBody: string,
  emlSubject?: string | null,
  emlFrom?: string | null,
  emlTo?: string | null,
  emlBody?: string | null
): Promise<AnalysisResult> {
  const client = getClient();

  // Get dynamic user names from Monday.com/Slack
  const userNames = await getUserNamesString();
  console.log('Available users for assignment:', userNames);

  // Build dynamic prompt and tool
  const systemPrompt = buildSystemPrompt(userNames);
  const extractTaskTool = buildExtractTaskTool(userNames);

  // Build the message content
  let content = `Please analyze this forwarded email and extract task assignment details.\n\n`;
  content += `**Forwarding Email Subject:** ${emailSubject}\n\n`;
  content += `**Forwarding Email Body:**\n${emailBody}\n\n`;

  if (emlSubject || emlFrom || emlTo) {
    content += `**Original Email Details:**\n`;
    if (emlSubject) content += `- Subject: ${emlSubject}\n`;
    if (emlFrom) content += `- From: ${emlFrom}\n`;
    if (emlTo) content += `- To: ${emlTo}\n`;
  }

  // Include the actual email content from the EML attachment
  if (emlBody) {
    content += `\n**Original Email Content (from EML attachment):**\n${emlBody}\n`;
  }

  console.log('Sending email to Claude for analysis...');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: systemPrompt,
    tools: [extractTaskTool],
    tool_choice: { type: 'tool', name: 'extract_task_details' },
    messages: [
      {
        role: 'user',
        content,
      },
    ],
  });

  // Extract the tool use response
  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
  );

  if (!toolUse || toolUse.name !== 'extract_task_details') {
    throw new Error('Claude did not return task extraction results');
  }

  const input = toolUse.input as {
    owner: string;
    supporters?: string[];
    dueDate: string;
    taskType: string;
    priority: Priority;
    notes: string;
    confidence: number;
    hasMeetingRequest: boolean;
    meetingDateTime?: string;
    meetingDateTimeAlt?: string;
    team?: string;
  };

  console.log('Claude analysis result:', input);

  // Normalize supporters to lowercase
  const supporters = (input.supporters ?? []).map(s => s.toLowerCase().trim()).filter(s => s.length > 0);

  return {
    owner: input.owner.toLowerCase(),
    dueDate: input.dueDate,
    taskType: input.taskType,
    priority: input.priority,
    notes: input.notes,
    confidence: input.confidence,
    meeting: {
      hasMeetingRequest: input.hasMeetingRequest,
      meetingDateTime: input.meetingDateTime ?? null,
      meetingDateTimeAlt: input.meetingDateTimeAlt ?? null,
    },
    team: input.team ?? null,
    supporters,
  };
}

// ============================================================================
// /emailtask Input Parsing
// ============================================================================

/**
 * Parsed /emailtask search parameters
 */
export interface EmailTaskSearchParams {
  subject: string;
  matchMode: 'equals' | 'contains';
  daysBack: number;
  useLatest: boolean;  // If true, auto-select most recent match
}

/**
 * Parse natural language /emailtask input using Claude AI
 *
 * Supports:
 * - Natural language: "Knicks Presale 2025 from last week"
 * - Structured: "subject: Knicks Presale days: 7 match: equals"
 * - Mixed: "find Yankees email from yesterday use most recent"
 *
 * @param input - Raw user input from /emailtask command
 * @returns Parsed search parameters
 */
export async function parseEmailTaskInput(input: string): Promise<EmailTaskSearchParams> {
  const client = getClient();

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 512,
    system: `You are parsing a Gmail search command. Extract search parameters from natural language input.

Rules:
- subject: The email subject line to search for. This is the MOST IMPORTANT field.
- matchMode: "equals" for exact match (default), "contains" for partial match
  - Use "contains" ONLY if user explicitly says "contains", "partial", "includes", or similar
- daysBack: Number of days to search (0 = today only, default)
  - "today" or no time mentioned → 0
  - "yesterday" → 1
  - "last week" → 7
  - "last month" → 30
  - "last N days" → N
- useLatest: true ONLY if user explicitly says "use most recent", "latest", "newest", or similar

Examples:
- "Knicks Presale 2025" → subject: "Knicks Presale 2025", matchMode: equals, daysBack: 0, useLatest: false
- "Yankees relocation from last week" → subject: "Yankees relocation", matchMode: equals, daysBack: 7, useLatest: false
- "any email containing season tickets" → subject: "season tickets", matchMode: contains, daysBack: 0, useLatest: false
- "Rangers presale use most recent" → subject: "Rangers presale", matchMode: equals, daysBack: 0, useLatest: true
- "subject: Knicks days: 7 match: contains" → subject: "Knicks", matchMode: contains, daysBack: 7, useLatest: false`,
    tools: [{
      name: 'extract_search_params',
      description: 'Extract Gmail search parameters from user input',
      input_schema: {
        type: 'object' as const,
        properties: {
          subject: {
            type: 'string',
            description: 'The email subject line to search for',
          },
          matchMode: {
            type: 'string',
            enum: ['equals', 'contains'],
            description: 'equals = exact match (default), contains = partial match',
          },
          daysBack: {
            type: 'number',
            description: 'Number of days to search (0 = today only)',
          },
          useLatest: {
            type: 'boolean',
            description: 'Whether to auto-select the most recent match',
          },
        },
        required: ['subject', 'matchMode', 'daysBack', 'useLatest'],
      },
    }],
    tool_choice: { type: 'tool', name: 'extract_search_params' },
    messages: [{ role: 'user', content: input }],
  });

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
  );

  if (!toolUse || toolUse.name !== 'extract_search_params') {
    throw new Error('Claude did not return search parameters');
  }

  const params = toolUse.input as {
    subject: string;
    matchMode: 'equals' | 'contains';
    daysBack: number;
    useLatest: boolean;
  };

  console.log('Parsed /emailtask params:', params);

  return {
    subject: params.subject,
    matchMode: params.matchMode || 'equals',
    daysBack: params.daysBack ?? 0,
    useLatest: params.useLatest ?? false,
  };
}

/**
 * Analyze email with fallback to manual parsing if AI fails
 */
export async function analyzeEmailSafe(
  emailSubject: string,
  emailBody: string,
  emlSubject?: string | null,
  emlFrom?: string | null,
  emlTo?: string | null,
  emlBody?: string | null
): Promise<AnalysisResult> {
  try {
    return await analyzeEmail(emailSubject, emailBody, emlSubject, emlFrom, emlTo, emlBody);
  } catch (error) {
    console.error('Claude analysis failed, using fallback:', error);

    // Fallback: try to parse the old format (line by line)
    const lines = emailBody.split(/\r?\n/).filter(line => line.trim() !== '');

    // Try to detect priority from keywords
    const text = emailBody.toLowerCase();
    let priority: Priority = 'medium';
    if (text.includes('asap') || text.includes('urgent') || text.includes('immediately') || text.includes('critical')) {
      priority = 'high';
    } else if (text.includes('fyi') || text.includes('no rush') || text.includes('when you get a chance')) {
      priority = 'low';
    }

    return {
      owner: (lines[0] ?? '').replace(/@/g, '').trim().toLowerCase(),
      dueDate: (lines[1] ?? '+1').trim(),
      taskType: (lines[2] ?? 'general').trim().toLowerCase(),
      priority,
      notes: lines.slice(3).join('\n').trim(),
      confidence: 0.3, // Low confidence for fallback parsing
      meeting: {
        hasMeetingRequest: false,
        meetingDateTime: null,
        meetingDateTimeAlt: null,
      },
      team: null,
      supporters: [],  // No supporter detection in fallback
    };
  }
}

// ============================================================================
// /task Slash Command Parsing (AI-Powered)
// ============================================================================

/**
 * Parsed /task result from AI
 */
export interface SlackTaskAnalysisResult {
  owner: string;              // Owner name (to be resolved to Monday/Slack user)
  supporters: string[];       // Support user names
  description: string;        // Task description/name
  dueDate: string;            // Due date in +N or MM/DD/YY format
  taskType: string;           // Task type
  priority: Priority;         // high/medium/low
  notes: string | null;       // Additional notes
  team: string | null;        // Sports team (if mentioned)
  confidence: number;         // Confidence score
}

/**
 * Build the system prompt for /task parsing
 */
function buildSlackTaskSystemPrompt(userNames: string): string {
  return `You are a task parsing assistant. Your job is to extract task details from natural language Slack /task commands.

Available team members to assign tasks to:
${userNames}

Available task types:
  - ${availableTaskTypes}

When parsing a /task command, extract:
1. **Owner**: Who should own this task? Match to one of the available team members by first name or full name.
   - If a @mention like <@U12345> is present, note the name after | if available, or return "slack_mention:U12345"
   - If no owner is specified, return null (caller will default to creator)
2. **Supporters**: Additional team members who should help (NOT the owner). Look for:
   - "with X" or "X for support"
   - Additional @mentions beyond the first
   - Return an empty array if no supporters mentioned
3. **Description**: The main task name/description. This is the core of what needs to be done.
   - Extract the essential task, removing owner/date/priority markers
   - Keep it concise but complete
4. **Due Date**: When is this due? Can be:
   - Relative: "tomorrow", "next week", "friday", "next friday", "in 3 days" → convert to "+N" format
   - "today" → "+0"
   - "asap", "urgent", "immediately" → "+0" with high priority
   - Absolute: "12/25", "Dec 25" → convert to "MM/DD/YY" format
   - If no date mentioned, default to "+1" (tomorrow)
5. **Task Type**: What kind of task is this? Match to available types.
   - Refund: refund requests, money back, credits
   - Decline: declined payments, card issues, payment failed
   - Payment Plan: payment arrangements, installments
   - Renewal: renewals, season ticket renewals
   - Relocation: seat moves, relocations
   - Opportunity: sales opportunities, upsells
   - Issue Call: customer complaints, escalations, issues requiring a call
   - General: anything else
6. **Priority**: Detect urgency level:
   - high: "ASAP", "urgent", "immediately", "critical", "emergency", "hot", "fire"
   - medium: standard task with a deadline
   - low: "FYI", "when you can", "no rush", "low priority"
7. **Notes**: Any additional context or details that aren't part of the core task.
   - Details about the customer, situation, or special instructions
   - Return null if no additional notes
8. **Team**: ONLY extract a sports team if explicitly mentioned.
   - MLB, NFL, NBA, NHL, MLS teams, NCAA D1 teams
   - Return null if no team mentioned - never guess

Examples:
- "Dayna refund for angry customer next friday" → owner: dayna, description: refund for angry customer, dueDate: +N (days until friday), priority: medium, taskType: Refund
- "call back customer about Yankees tickets asap" → owner: null, description: call back customer about Yankees tickets, dueDate: +0, priority: high, taskType: Issue Call, team: Yankees
- "@jamie follow up on renewal with Sarah's help" → owner: jamie, supporters: [sarah], description: follow up on renewal, taskType: Renewal
- "urgent payment declined for season tickets" → priority: high, taskType: Decline, description: payment declined for season tickets`;
}

/**
 * Build the tool definition for /task parsing
 */
function buildSlackTaskTool(userNames: string): Anthropic.Tool {
  return {
    name: 'extract_slack_task',
    description: 'Extract task details from a Slack /task command',
    input_schema: {
      type: 'object' as const,
      properties: {
        owner: {
          type: 'string',
          nullable: true,
          description: `The team member to own this task. Match to: ${userNames}. Return null if not specified.`,
        },
        supporters: {
          type: 'array',
          items: { type: 'string' },
          description: `Additional team members to help (NOT the owner). Match to: ${userNames}. Return empty array if none.`,
        },
        description: {
          type: 'string',
          description: 'The core task description/name. Concise but complete.',
        },
        dueDate: {
          type: 'string',
          description: 'Due date in +N (relative days) or MM/DD/YY format.',
        },
        taskType: {
          type: 'string',
          enum: TASK_TYPE_MAPPINGS.flatMap(t => [t.displayName, ...t.aliases]),
          description: 'The type of task.',
        },
        priority: {
          type: 'string',
          enum: ['high', 'medium', 'low'],
          description: 'Priority level.',
        },
        notes: {
          type: 'string',
          nullable: true,
          description: 'Additional context or details. Null if none.',
        },
        team: {
          type: 'string',
          nullable: true,
          description: 'Sports team if explicitly mentioned. Null if not clearly stated.',
        },
        confidence: {
          type: 'number',
          description: 'Confidence score from 0 to 1.',
        },
      },
      required: ['description', 'dueDate', 'taskType', 'priority', 'confidence'],
    },
  };
}

/**
 * Analyze a /task command using Claude AI to extract task details
 * Works just like the email workflow - natural language in, structured data out
 */
export async function analyzeSlackTask(
  taskText: string,
  creatorSlackId: string
): Promise<SlackTaskAnalysisResult> {
  const client = getClient();

  // Get dynamic user names from Monday.com/Slack
  const userNames = await getUserNamesString();
  console.log('Available users for /task assignment:', userNames);

  // Build dynamic prompt and tool
  const systemPrompt = buildSlackTaskSystemPrompt(userNames);
  const extractTaskTool = buildSlackTaskTool(userNames);

  const content = `Parse this /task command and extract the task details:\n\n${taskText}`;

  console.log('Sending /task to Claude for analysis...');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: systemPrompt,
    tools: [extractTaskTool],
    tool_choice: { type: 'tool', name: 'extract_slack_task' },
    messages: [
      {
        role: 'user',
        content,
      },
    ],
  });

  // Extract the tool use response
  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
  );

  if (!toolUse || toolUse.name !== 'extract_slack_task') {
    throw new Error('Claude did not return task extraction results');
  }

  const input = toolUse.input as {
    owner?: string | null;
    supporters?: string[];
    description: string;
    dueDate: string;
    taskType: string;
    priority: Priority;
    notes?: string | null;
    team?: string | null;
    confidence: number;
  };

  console.log('Claude /task analysis result:', input);

  // Normalize owner and supporters to lowercase
  const owner = input.owner?.toLowerCase().trim() || '';
  const supporters = (input.supporters ?? []).map(s => s.toLowerCase().trim()).filter(s => s.length > 0);

  return {
    owner,
    supporters,
    description: input.description,
    dueDate: input.dueDate,
    taskType: input.taskType,
    priority: input.priority,
    notes: input.notes || null,
    team: input.team || null,
    confidence: input.confidence,
  };
}

/**
 * Analyze /task with fallback to simple parsing if AI fails
 */
export async function analyzeSlackTaskSafe(
  taskText: string,
  creatorSlackId: string
): Promise<SlackTaskAnalysisResult> {
  try {
    return await analyzeSlackTask(taskText, creatorSlackId);
  } catch (error) {
    console.error('Claude /task analysis failed, using fallback:', error);

    // Simple fallback - just use the text as description
    const text = taskText.toLowerCase();
    let priority: Priority = 'medium';
    if (text.includes('asap') || text.includes('urgent') || text.includes('immediately')) {
      priority = 'high';
    } else if (text.includes('fyi') || text.includes('no rush')) {
      priority = 'low';
    }

    return {
      owner: '',  // Will default to creator
      supporters: [],
      description: taskText.trim(),
      dueDate: '+1',
      taskType: 'General',
      priority,
      notes: null,
      team: null,
      confidence: 0.2,
    };
  }
}

// ============================================================================
// Issue Call Parsing
// ============================================================================

export interface IssueCallParseResult {
  team: string;
  email: string;
  suggestedSupporter: string | null;
  confidence: number;
}

/**
 * Parse natural language issue call input to extract team, email, and optional supporter
 *
 * Examples:
 * - "astros john@example.com" → team: astros, email: john@example.com
 * - "issue call for houston astros customer jane@gmail.com" → team: houston astros, email: jane@gmail.com
 * - "texans account holder bob@email.com @jamie" → team: texans, email: bob@email.com, supporter: jamie
 * - "rockets fan@gmail.com with Sarah's help" → team: rockets, email: fan@gmail.com, supporter: Sarah
 */
export async function parseIssueCallInput(input: string): Promise<IssueCallParseResult> {
  const client = getClient();

  const systemPrompt = `You are an issue call parser. Extract the team name, email address, and optional suggested supporter from natural language input.

Sports teams to recognize:
- MLB: Astros, Rangers, Mariners, Athletics, Angels, Yankees, Mets, Red Sox, Cubs, Dodgers, etc.
- NFL: Texans, Cowboys, Eagles, Giants, Jets, Patriots, etc.
- NBA: Rockets, Mavericks, Spurs, Lakers, Knicks, Nets, Bulls, etc.
- NHL: Stars, Bruins, Rangers, Islanders, Devils, etc.
- MLS and other sports teams

Rules:
1. Team name: Required. Extract the sports team mentioned. Can be partial (e.g., "astros") or full (e.g., "houston astros").
2. Email: Required. Extract the email address from the input.
3. Suggested supporter: Optional. Look for:
   - @mentions like "@jamie" or "<@U12345>"
   - "with X's help" or "have X help"
   - "X for support" or "assign to X"
   - Return just the name (not the @), or null if none mentioned

Be flexible with input formats. Users might say:
- "astros john@example.com"
- "issue call for houston astros john@example.com"
- "astros customer john@example.com @jamie"
- "rockets account holder jane@gmail.com with Sarah's help"`;

  const tool: Anthropic.Tool = {
    name: 'parse_issue_call',
    description: 'Parse issue call input to extract team, email, and supporter',
    input_schema: {
      type: 'object' as const,
      properties: {
        team: {
          type: 'string',
          description: 'The sports team name (e.g., "astros", "houston astros", "rockets")',
        },
        email: {
          type: 'string',
          description: 'The email address of the account holder',
        },
        suggestedSupporter: {
          type: 'string',
          nullable: true,
          description: 'Name of suggested supporter if mentioned, null otherwise',
        },
        confidence: {
          type: 'number',
          description: 'Confidence score 0-1 for the extraction',
        },
      },
      required: ['team', 'email', 'confidence'],
    },
  };

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    system: systemPrompt,
    tools: [tool],
    tool_choice: { type: 'tool', name: 'parse_issue_call' },
    messages: [
      {
        role: 'user',
        content: `Parse this issue call input: "${input}"`,
      },
    ],
  });

  // Extract the tool use response
  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
  );

  if (!toolUse) {
    throw new Error('No tool response from Claude');
  }

  const result = toolUse.input as {
    team: string;
    email: string;
    suggestedSupporter?: string | null;
    confidence: number;
  };

  return {
    team: result.team,
    email: result.email,
    suggestedSupporter: result.suggestedSupporter || null,
    confidence: result.confidence,
  };
}

/**
 * Safe wrapper for parseIssueCallInput with fallback
 */
export async function parseIssueCallInputSafe(input: string): Promise<IssueCallParseResult | null> {
  try {
    return await parseIssueCallInput(input);
  } catch (error) {
    console.error('Claude issue call parsing failed:', error);
    return null;
  }
}
