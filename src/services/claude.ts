/**
 * Claude AI service for intelligent email analysis
 *
 * Uses Claude to extract task details from natural language emails,
 * eliminating the need for rigid line-by-line formatting.
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config/environment.js';
import { USER_MAPPINGS } from '../config/users.js';
import { TASK_TYPE_MAPPINGS } from '../config/taskTypes.js';
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

// Build context about available options
const availableOwners = USER_MAPPINGS.map(u => u.name).join(', ');
const availableTaskTypes = TASK_TYPE_MAPPINGS.map(t =>
  `${t.displayName} (aliases: ${t.aliases.join(', ')})`
).join('\n  - ');

const SYSTEM_PROMPT = `You are an email analysis assistant. Your job is to extract task assignment details from forwarded emails.

Available team members to assign tasks to:
${availableOwners}

Available task types:
  - ${availableTaskTypes}

When analyzing an email, extract:
1. **Owner**: Who should this task be assigned to? Match to one of the available team members.
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
4. **Notes**: Any additional context or important details from the email.

Be smart about inferring information. For example:
- "Send this to Dayna for next Friday" → owner: dayna, due date: calculate days until Friday
- "Refund request - handle ASAP" → task type: Refund, due date: +1
- "Customer wants to discuss payment options" → task type: Payment Plan`;

// Tool definition for structured output
const extractTaskTool: Anthropic.Tool = {
  name: 'extract_task_details',
  description: 'Extract task assignment details from the email',
  input_schema: {
    type: 'object' as const,
    properties: {
      owner: {
        type: 'string',
        description: `The team member to assign this task to. Must be one of: ${availableOwners}`,
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
      notes: {
        type: 'string',
        description: 'Additional context or important details extracted from the email',
      },
      confidence: {
        type: 'number',
        description: 'Confidence score from 0 to 1 for the extraction',
      },
    },
    required: ['owner', 'dueDate', 'taskType', 'notes', 'confidence'],
  },
};

export interface AnalysisResult extends TaskDetails {
  confidence: number;
}

/**
 * Analyze an email using Claude AI to extract task details
 */
export async function analyzeEmail(
  emailSubject: string,
  emailBody: string,
  emlSubject?: string | null,
  emlFrom?: string | null,
  emlTo?: string | null
): Promise<AnalysisResult> {
  const client = getClient();

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

  console.log('Sending email to Claude for analysis...');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
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
    notes: string;
    confidence: number;
  };

  console.log('Claude analysis result:', input);

  return {
    owner: input.owner.toLowerCase(),
    dueDate: input.dueDate,
    taskType: input.taskType,
    notes: input.notes,
    confidence: input.confidence,
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
  emlTo?: string | null
): Promise<AnalysisResult> {
  try {
    return await analyzeEmail(emailSubject, emailBody, emlSubject, emlFrom, emlTo);
  } catch (error) {
    console.error('Claude analysis failed, using fallback:', error);

    // Fallback: try to parse the old format (line by line)
    const lines = emailBody.split(/\r?\n/).filter(line => line.trim() !== '');

    return {
      owner: (lines[0] ?? '').replace(/@/g, '').trim().toLowerCase(),
      dueDate: (lines[1] ?? '+1').trim(),
      taskType: (lines[2] ?? 'general').trim().toLowerCase(),
      notes: lines.slice(3).join('\n').trim(),
      confidence: 0.3, // Low confidence for fallback parsing
    };
  }
}
