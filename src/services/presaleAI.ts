/**
 * Presale AI Service
 *
 * Uses Claude to detect if a presale email is "exclusive" (personalized link,
 * unique code, exclusive language) vs generic fan presales with public codes.
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config/environment.js';
import { claudeCircuit } from './circuitBreaker.js';

let anthropicClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({
      apiKey: config.anthropic.apiKey,
    });
  }
  return anthropicClient;
}

// ============================================================================
// Types
// ============================================================================

export interface ExclusivityCheckResult {
  isExclusive: boolean;
  confidence: number;
  reason: string;
  deadline: string | null;  // Extracted deadline if detected
}

// ============================================================================
// System Prompt
// ============================================================================

const EXCLUSIVITY_SYSTEM_PROMPT = `You are a presale email analyst for Salem Seats, a ticket brokerage that manages multiple season ticket accounts across various sports teams.

CONTEXT:
- Salem Seats has season ticket accounts with many teams (NBA, MLB, NFL, NHL, MLS, NCAA)
- When a team sends presale emails, we may receive the SAME email across dozens of accounts
- We want to identify EXCLUSIVE presales that require action (personalized codes/links)
- We want to SKIP generic fan presales that anyone can use (public codes)

YOUR TASK:
Analyze presale emails to determine if they are EXCLUSIVE (require our action) or GENERIC (skip).

EXCLUSIVE presales have ONE OR MORE of these characteristics:
1. **Personalized Links**: URLs with unique tokens, account-specific parameters, or "personalized" language
   - Example: "Your exclusive link: tickets.com/presale?token=abc123"
   - Example: "Click here to access YOUR presale" (implies personalized)

2. **Unique Codes**: Codes that are explicitly described as unique, personal, or one-time-use
   - Example: "Your personal presale code: JONES2025"
   - Example: "This code is unique to your account"

3. **Exclusive Language**: Clear indication this is special access not available to general public
   - Example: "As a season ticket member, you have exclusive access"
   - Example: "This offer is only available to select account holders"

GENERIC presales (SKIP these) have these characteristics:
1. **Public Codes**: Codes that are generic or widely shared
   - Example: "Use code PRESALE2025" (no personalization)
   - Example: "Fan presale code: FANS" (clearly generic)

2. **General Fan Presales**: Available to anyone who signs up or follows the team
   - Example: "Fan Club presale starts Tuesday"
   - Example: "Sign up to get presale access"

3. **No Personalization**: No unique links, codes, or account-specific content

ALSO EXTRACT:
- Any deadline mentioned for the presale (date/time when it expires)`;

// ============================================================================
// Tool Definition
// ============================================================================

const EXCLUSIVITY_TOOL: Anthropic.Tool = {
  name: 'check_presale_exclusivity',
  description: 'Analyze a presale email to determine if it is exclusive or generic',
  input_schema: {
    type: 'object' as const,
    properties: {
      isExclusive: {
        type: 'boolean',
        description: 'True if this is an exclusive presale requiring action, false if generic/public',
      },
      confidence: {
        type: 'number',
        description: 'Confidence score from 0 to 1. 1.0 = definitely exclusive/generic, 0.5 = uncertain',
      },
      reason: {
        type: 'string',
        description: 'Brief explanation of why this is exclusive or generic (1-2 sentences)',
      },
      deadline: {
        type: 'string',
        description: 'Presale deadline/expiration if mentioned in the email (e.g., "Friday 10 PM EST", "Dec 15 at noon"). Null if not found.',
      },
    },
    required: ['isExclusive', 'confidence', 'reason'],
  },
};

// ============================================================================
// API Functions
// ============================================================================

/**
 * Check if a presale email is exclusive (requires action) or generic (skip)
 *
 * @param subject - Email subject line
 * @param bodySnippet - Email body (can be truncated for efficiency)
 * @returns Exclusivity check result with confidence score
 */
export async function checkPresaleExclusivity(
  subject: string,
  bodySnippet: string
): Promise<ExclusivityCheckResult> {
  const client = getClient();

  // Build the message content
  const content = `Analyze this presale email to determine if it's EXCLUSIVE (requires our action) or GENERIC (skip).

**Subject:** ${subject}

**Email Body:**
${bodySnippet.slice(0, 3000)}`;

  console.log('[PresaleAI] Checking exclusivity for:', subject.substring(0, 50));

  try {
    // Wrapped in circuit breaker
    const response = await claudeCircuit.execute(() =>
      client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 512,
        system: EXCLUSIVITY_SYSTEM_PROMPT,
        tools: [EXCLUSIVITY_TOOL],
        tool_choice: { type: 'tool', name: 'check_presale_exclusivity' },
        messages: [
          {
            role: 'user',
            content,
          },
        ],
      })
    );

    // Extract the tool use response
    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
    );

    if (!toolUse || toolUse.name !== 'check_presale_exclusivity') {
      console.error('[PresaleAI] Claude did not return exclusivity check results');
      // Default to not exclusive if we can't determine
      return {
        isExclusive: false,
        confidence: 0,
        reason: 'Failed to analyze email',
        deadline: null,
      };
    }

    const input = toolUse.input as {
      isExclusive: boolean;
      confidence: number;
      reason: string;
      deadline?: string;
    };

    console.log('[PresaleAI] Result:', input.isExclusive ? 'EXCLUSIVE' : 'GENERIC', `(${input.confidence})`);

    return {
      isExclusive: input.isExclusive,
      confidence: input.confidence,
      reason: input.reason,
      deadline: input.deadline ?? null,
    };
  } catch (error) {
    console.error('[PresaleAI] Error checking exclusivity:', error);
    // Default to not exclusive if there's an error
    return {
      isExclusive: false,
      confidence: 0,
      reason: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      deadline: null,
    };
  }
}

/**
 * Safe wrapper that catches all errors
 */
export async function checkPresaleExclusivitySafe(
  subject: string,
  bodySnippet: string
): Promise<ExclusivityCheckResult> {
  try {
    return await checkPresaleExclusivity(subject, bodySnippet);
  } catch (error) {
    console.error('[PresaleAI] Unexpected error:', error);
    return {
      isExclusive: false,
      confidence: 0,
      reason: `Unexpected error: ${error instanceof Error ? error.message : 'Unknown'}`,
      deadline: null,
    };
  }
}
