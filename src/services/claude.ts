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
2. **Due Date**: When is this due? Can be:
   - Relative: "tomorrow", "next week", "in 3 days" → convert to "+N" format (e.g., "+1", "+7", "+3")
   - Absolute: Any date format → convert to "MM/DD/YY" format
   - If no date mentioned, default to "+1" (tomorrow)
3. **Task Type**: What kind of task is this? Match to one of the available types.
   - Payment Plan: payment plans, payment arrangements, installments
   - Refund: refund requests, money back
   - Decline: declined payments, card issues
   - Revoked: revoked tickets, cancellations
   - Renewal: renewals, season ticket renewals
   - Relocation: seat relocations, moves
   - Opportunity: sales opportunities, upsells
   - Issue Call: customer complaints, issues requiring a call
   - General: anything else
4. **Priority**: Detect urgency level:
   - high: Contains "ASAP", "urgent", "immediately", "critical", "emergency", angry customer, escalation
   - medium: Standard task with a deadline, customer waiting
   - low: FYI, informational, no rush, when you get a chance
5. **Notes**: Clean up the forwarding notes for grammar and clarity ONLY. Rules:
   - Only use words and concepts the forwarder actually wrote
   - Fix spelling, grammar, punctuation
   - Do NOT add context from the email being forwarded
   - Do NOT explain what the customer wants or who is involved
   - Do NOT infer or add details like product names, ticket types, etc.
   - If they wrote "opt in for all 3" keep it as "opt in for all 3" - don't specify what the 3 are
   - If there are no notes beyond assignment info, leave notes empty.
6. **Meeting Request**: Detect if the email contains a meeting/appointment request:
   - Look for phrases like "let's meet", "can we schedule", "are you available", "let's set up a call"
   - Extract proposed date(s) and time(s) if mentioned
   - Note the timezone if specified (default to EST/America/New_York)
7. **Team**: ONLY extract a sports team if explicitly mentioned in the email. Rules:
   - Only recognize: MLB, NFL, NBA, NHL, MLS teams, and NCAA Division 1 teams
   - Examples: Yankees, Mets, Knicks, Nets, Rangers, Islanders, Giants, Jets, Devils, etc.
   - Return null if no team is clearly mentioned - NEVER guess
   - Do NOT infer team from context (e.g., "basketball tickets" does not mean Knicks)

IMPORTANT: For notes, ONLY use words the forwarder wrote. Do NOT pull in context from the forwarded email content. Do NOT add "Customer wants" or explain what the email is about.

Be smart about inferring the owner, date, and task type. For example:
- "Send this to Dayna for next Friday" → owner: dayna, due date: calculate days until Friday
- "Refund request - handle ASAP" → task type: Refund, due date: +1, priority: high
- "FYI - customer feedback" → priority: low`;
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
    };
  }
}
