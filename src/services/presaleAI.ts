/**
 * Presale AI Service
 *
 * Uses Claude to detect if a presale email is "exclusive" (personalized link,
 * unique code, exclusive language) vs generic fan presales with public codes.
 *
 * Also distinguishes between:
 * - REGISTRATION: Sign up for future presale access
 * - UPCOMING: Presale is scheduled, code provided, just wait
 * - LIVE: Presale is happening now, use this code
 */

import { claude as coreApiClaude } from './coreApi.js';
import { claudeCircuit } from './circuitBreaker.js';

// ============================================================================
// Types
// ============================================================================

export type PresaleType = 'registration' | 'upcoming' | 'live';

export interface ExclusivityCheckResult {
  isExclusive: boolean;
  confidence: number;
  reason: string;
  presaleType: PresaleType;
  eventName: string | null;    // The event/artist name (e.g., "Bruno Mars", "Playoff Round 1")
  presaleDate: string | null;  // For registration/upcoming: when presale starts (e.g., "Wed, Jan 14 at 12 PM")
  presaleCode: string | null;  // For upcoming/live: the presale code to use
  deadline: string | null;     // When the presale expires
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
1. Determine if this is an EXCLUSIVE presale (requires action) or GENERIC (skip)
2. Classify the presale type: REGISTRATION, UPCOMING, or LIVE

EXCLUSIVE presales have ONE OR MORE of these characteristics:
1. **Personalized Links**: URLs with unique tokens, account-specific parameters, or "personalized" language
2. **Unique Codes**: Codes explicitly described as unique, personal, or one-time-use
3. **Exclusive Language**: Clear indication this is special access not available to general public
   - "As a season ticket member", "exclusive access", "select account holders"

GENERIC presales (SKIP these):
1. **Public Codes**: Generic codes like "PRESALE2025", "FANS"
2. **General Fan Presales**: Available to anyone who signs up
3. **No Personalization**: No unique links or account-specific content

PRESALE TYPES:

**REGISTRATION** - Future presale, must sign up/register
- Contains: "Sign up", "register", "RSVP", "reserve your spot"
- Requires action NOW to get access later
- No code provided yet - will receive code after registering
- Example: "Register now for exclusive access starting January 14"

**UPCOMING** - Future presale, code already provided, just wait
- Contains: "Mark your calendar", "starts on", "beginning [future date]"
- Code/password is already included in the email
- Presale date is in the FUTURE - no action needed now
- Example: "Your presale starts January 14 at 10 AM. Use code: STHG5L8Q"

**LIVE** - Presale is active NOW
- Contains: "Begins today", "now available", "use code", "starts now", "happening now"
- Has an active presale code/password to use immediately
- Example: "Your exclusive presale begins NOW! Use code: STHG5L8Q"

EXTRACT:
- **Event Name**: The artist, show, or event (e.g., "Bruno Mars", "Playoff Round 1", "Taylor Swift"). Use short, recognizable names.
- For REGISTRATION: The presale start date/time (e.g., "Wed, Jan 14 at 12 PM")
- For UPCOMING: Both the presale date AND the code
- For LIVE: The presale code (e.g., "STHG5L8Q")
- Deadline when the presale expires (if mentioned)`;

// ============================================================================
// Tool Definition
// ============================================================================

const EXCLUSIVITY_TOOL = {
  name: 'check_presale_exclusivity',
  description: 'Analyze a presale email to determine if it is exclusive or generic, and classify its type',
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
      presaleType: {
        type: 'string',
        enum: ['registration', 'upcoming', 'live'],
        description: 'Type: "registration" (must sign up), "upcoming" (code provided, wait for date), "live" (active now)',
      },
      eventName: {
        type: 'string',
        description: 'The event/artist name (e.g., "Bruno Mars", "Playoff Round 1", "Taylor Swift"). Short, recognizable name.',
      },
      presaleDate: {
        type: 'string',
        description: 'For registration/upcoming: when presale starts (e.g., "Wed, Jan 14 at 12 PM"). Null for live.',
      },
      presaleCode: {
        type: 'string',
        description: 'For upcoming/live: the presale code (e.g., "STHG5L8Q"). Null for registration.',
      },
      deadline: {
        type: 'string',
        description: 'Presale deadline/expiration if mentioned (e.g., "Friday 10 PM EST"). Null if not found.',
      },
    },
    required: ['isExclusive', 'confidence', 'reason', 'presaleType', 'eventName'],
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
 * @returns Exclusivity check result with confidence score and type classification
 */
export async function checkPresaleExclusivity(
  subject: string,
  bodySnippet: string
): Promise<ExclusivityCheckResult> {
  // Build the message content
  const content = `Analyze this presale email to determine:
1. Is it EXCLUSIVE (requires our action) or GENERIC (skip)?
2. Is it a REGISTRATION (sign up for future) or LIVE (active now)?

**Subject:** ${subject}

**Email Body:**
${bodySnippet.slice(0, 3000)}`;

  console.log('[PresaleAI] Checking exclusivity for:', subject.substring(0, 50));

  try {
    // Wrapped in circuit breaker
    const response = await claudeCircuit.execute(() =>
      coreApiClaude.toolUse({
        model: 'claude-sonnet-4-5-20250514',
        maxTokens: 512,
        systemPrompt: EXCLUSIVITY_SYSTEM_PROMPT,
        tools: [EXCLUSIVITY_TOOL],
        toolChoice: { type: 'tool', name: 'check_presale_exclusivity' },
        messages: [
          {
            role: 'user',
            content,
          },
        ],
      })
    );

    if (!response.toolUse || response.toolUse.name !== 'check_presale_exclusivity') {
      console.error('[PresaleAI] Claude did not return exclusivity check results');
      return {
        isExclusive: false,
        confidence: 0,
        reason: 'Failed to analyze email',
        presaleType: 'live',
        eventName: null,
        presaleDate: null,
        presaleCode: null,
        deadline: null,
      };
    }

    const input = response.toolUse.input as {
      isExclusive: boolean;
      confidence: number;
      reason: string;
      presaleType: PresaleType;
      eventName?: string;
      presaleDate?: string;
      presaleCode?: string;
      deadline?: string;
    };

    console.log('[PresaleAI] Result:',
      input.isExclusive ? 'EXCLUSIVE' : 'GENERIC',
      `(${input.presaleType})`,
      `confidence: ${input.confidence}`
    );

    return {
      isExclusive: input.isExclusive,
      confidence: input.confidence,
      reason: input.reason,
      presaleType: input.presaleType,
      eventName: input.eventName ?? null,
      presaleDate: input.presaleDate ?? null,
      presaleCode: input.presaleCode ?? null,
      deadline: input.deadline ?? null,
    };
  } catch (error) {
    console.error('[PresaleAI] Error checking exclusivity:', error);
    return {
      isExclusive: false,
      confidence: 0,
      reason: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      presaleType: 'live',
      eventName: null,
      presaleDate: null,
      presaleCode: null,
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
      presaleType: 'live',
      eventName: null,
      presaleDate: null,
      presaleCode: null,
      deadline: null,
    };
  }
}
