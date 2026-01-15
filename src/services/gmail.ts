/**
 * Gmail API Service
 *
 * Searches the forwarding inbox for related emails by subject
 * Used for the /scan feature to find all recipients with their appointment times
 *
 * Uses OAuth2 with refresh token (no domain-wide delegation needed)
 */

import { google } from 'googleapis';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config/environment.js';
import { gmailCircuit, claudeCircuit } from './circuitBreaker.js';

let gmailClient: ReturnType<typeof google.gmail> | null = null;
let anthropicClient: Anthropic | null = null;

// ============================================================================
// Batch Processing Utilities
// ============================================================================

/**
 * Execute async functions in batches with concurrency control
 * Prevents Gmail rate limiting while maximizing throughput
 *
 * @param items - Array of items to process
 * @param fn - Async function to apply to each item
 * @param concurrency - Max concurrent requests (default: 5)
 * @returns Array of results (or errors) in same order as input
 */
async function batchWithConcurrency<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number = 5
): Promise<Array<{ success: true; value: R } | { success: false; error: Error }>> {
  const results: Array<{ success: true; value: R } | { success: false; error: Error }> = [];

  // Process in chunks of `concurrency` size
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);

    const chunkResults = await Promise.all(
      chunk.map(async (item) => {
        try {
          const value = await fn(item);
          return { success: true as const, value };
        } catch (error) {
          return { success: false as const, error: error instanceof Error ? error : new Error(String(error)) };
        }
      })
    );

    results.push(...chunkResults);
  }

  return results;
}

/**
 * Initialize Gmail API client with OAuth2 refresh token
 */
async function getGmailClient() {
  if (gmailClient) return gmailClient;

  const { clientId, clientSecret, refreshToken } = config.google;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'Gmail OAuth not configured. Required: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN'
    );
  }

  const oauth2Client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    'https://developers.google.com/oauthplayground' // redirect URI used during token generation
  );

  oauth2Client.setCredentials({
    refresh_token: refreshToken,
  });

  gmailClient = google.gmail({ version: 'v1', auth: oauth2Client });

  return gmailClient;
}

function getAnthropicClient(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({
      apiKey: config.anthropic.apiKey,
    });
  }
  return anthropicClient;
}

/**
 * Normalize subject by removing FWD:, Fwd:, RE:, Re:, etc.
 */
export function normalizeSubject(subject: string): string {
  return subject
    .replace(/^(fwd?|re|fw):\s*/gi, '') // Remove FWD:, Fwd:, RE:, Re:, FW:, Fw:
    .replace(/^(fwd?|re|fw):\s*/gi, '') // Do it twice for "RE: FWD:" cases
    .trim();
}

// Keywords that indicate emails may contain appointment times
const APPOINTMENT_KEYWORDS = [
  'presale',
  'pre-sale',
  'relocation',
  'selection',
  'appointment',
  'scheduled',
  'your time',
  'your slot',
];

// Domains to exclude from recipient scanning (automation/internal services)
const EXCLUDED_RECIPIENT_DOMAINS = [
  'make.com',
  'salemseats.com',
  'slack.com',
];

/**
 * Check if an email address should be excluded from recipient list
 * Matches both exact domain (@make.com) and subdomains (@hook.us1.make.com)
 */
function shouldExcludeRecipient(email: string): boolean {
  const lowerEmail = email.toLowerCase();
  const emailDomain = lowerEmail.split('@')[1] || '';
  return EXCLUDED_RECIPIENT_DOMAINS.some(domain =>
    emailDomain === domain || emailDomain.endsWith(`.${domain}`)
  );
}

/**
 * Check if text contains appointment-related keywords
 */
function hasAppointmentKeywords(text: string): boolean {
  const lowerText = text.toLowerCase();
  return APPOINTMENT_KEYWORDS.some(keyword => lowerText.includes(keyword));
}

/**
 * Recipient with their appointment information and optional code/link
 */
export interface RecipientWithAppointment {
  email: string;
  appointmentDate: string | null;  // e.g., "Tue Dec 20" (date only)
  appointmentTime: string | null;  // e.g., "2:00 PM" (time only)
  rawDateTime: string | null;      // ISO format for sorting
  code: string | null;             // Presale code if found
  link: string | null;             // Presale link if found
}

// ============================================================================
// Code & Link Extraction (for /scan feature)
// ============================================================================

/**
 * Common presale code patterns (alphanumeric, typically 6-12 chars)
 */
const CODE_PATTERNS = [
  /(?:code|password|passcode|promo|offer\s*code)[\s:]+([A-Z0-9]{4,16})/gi,
  /(?:use|enter|apply)\s+(?:code|password)[\s:]+([A-Z0-9]{4,16})/gi,
  /your\s+(?:code|password|access\s*code)\s+(?:is[\s:]+)?([A-Z0-9]{4,16})/gi,
  /\bCODE[\s:]+([A-Z0-9]{4,16})\b/g,
  /[`'""]([A-Z0-9]{6,12})[`'""]/gi,
];

/**
 * Presale link patterns - ticketmaster, team sites, etc.
 */
const LINK_PATTERNS = [
  /https?:\/\/(?:www\.)?ticketmaster\.com\/[^\s<>"'\]]+(?:presale|offer|unlock|token)[^\s<>"'\]]+/gi,
  /https?:\/\/(?:www\.)?[a-z0-9-]+\.(?:com|net|org)\/[^\s<>"'\]]*presale[^\s<>"'\]]+/gi,
  /https?:\/\/[^\s<>"'\]]+(?:access[_-]?token|unlock|offer[_-]?id|code=)[^\s<>"'\]]+/gi,
  /https?:\/\/[^\s<>"'\]]+[?&][a-z_]+=([a-f0-9]{32,}|[A-Za-z0-9+\/=]{32,})[^\s<>"'\]]*/gi,
];

/**
 * Extract the first presale code from email body text
 */
export function extractCodeFromBody(text: string): string | null {
  for (const pattern of CODE_PATTERNS) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (match && match[1]) {
      const code = match[1].toUpperCase().trim();
      if (code.length >= 4 &&
          !['HTTP', 'HTTPS', 'HTML', 'TEXT', 'CODE', 'NULL', 'TRUE', 'FALSE'].includes(code)) {
        return code;
      }
    }
  }
  return null;
}

/**
 * Extract the first presale link from email body text
 */
export function extractLinkFromBody(text: string, html?: string): string | null {
  const combinedText = html ? `${text} ${html}` : text;

  for (const pattern of LINK_PATTERNS) {
    pattern.lastIndex = 0;
    const match = pattern.exec(combinedText);
    if (match) {
      const link = match[0].trim().replace(/[.,;:!?)\]]+$/, '');
      return link;
    }
  }
  return null;
}

/**
 * Search for emails with the same subject within the last 48 hours
 * Returns recipients with appointment times and optional codes/links
 *
 * @param subject - Email subject to search for
 * @param extractCodesAndLinks - If true, also extract presale codes and links (default: false)
 */
export async function findRelatedRecipients(subject: string, extractCodesAndLinks: boolean = false): Promise<RecipientWithAppointment[]> {
  const gmail = await getGmailClient();

  const normalizedSubject = normalizeSubject(subject);

  console.log(`[Gmail] Subject "${normalizedSubject}" - extractCodesAndLinks: ${extractCodesAndLinks}`);

  // Build search query - last 48 hours
  const twoDaysAgo = new Date();
  twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
  const afterDate = twoDaysAgo.toISOString().split('T')[0].replace(/-/g, '/');

  const query = `subject:"${normalizedSubject}" after:${afterDate}`;
  console.log(`Gmail search query: ${query}`);

  try {
    // Search for messages (wrapped in circuit breaker TD-05)
    const searchResponse = await gmailCircuit.execute(() =>
      gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: 200,
      })
    );

    const messages = searchResponse.data.messages ?? [];
    console.log(`Found ${messages.length} related emails`);

    if (messages.length === 0) {
      return [];
    }

    // Map to track unique recipients (by email) with their appointment info
    const recipientMap = new Map<string, RecipientWithAppointment>();

    // Filter messages with valid IDs
    const validMessages = messages.filter(m => m.id);
    const startTime = Date.now();

    // Batch fetch all messages with concurrency control (5 concurrent requests)
    // Each fetch wrapped in circuit breaker (TD-05)
    console.log(`[Gmail] Fetching ${validMessages.length} messages with concurrency=5...`);
    const fetchResults = await batchWithConcurrency(
      validMessages,
      async (message) => {
        const msgResponse = await gmailCircuit.execute(() =>
          gmail.users.messages.get({
            userId: 'me',
            id: message.id!,
            format: 'full',
          })
        );
        return msgResponse.data;
      },
      5 // concurrency limit to avoid Gmail rate limits
    );

    const fetchTime = Date.now() - startTime;
    const successCount = fetchResults.filter(r => r.success).length;
    const failCount = fetchResults.filter(r => !r.success).length;
    console.log(`[Gmail] Fetched ${successCount} messages in ${fetchTime}ms (${failCount} failed)`);

    // Log any failures
    fetchResults.forEach((result, idx) => {
      if (!result.success) {
        console.error(`[Gmail] Failed to fetch message ${validMessages[idx].id}:`, result.error.message);
      }
    });

    // Process successful fetches - extract recipients and prepare for appointment extraction
    interface MessageWithBody {
      toEmails: string[];
      bodyText: string;
      bodyHtml: string | null;
    }
    const messagesToProcess: MessageWithBody[] = [];

    for (const result of fetchResults) {
      if (!result.success) continue;

      const msgData = result.value;
      const headers = msgData.payload?.headers ?? [];
      const toHeader = headers.find((h: any) => h.name === 'To');

      if (!toHeader?.value) continue;

      const recipientEmails = extractEmailAddresses(toHeader.value);
      // Always extract body for appointments, optionally for codes/links
      const bodyText = extractEmailBody(msgData.payload);
      const bodyHtml = extractCodesAndLinks ? extractEmailBodyHtml(msgData.payload) : null;

      messagesToProcess.push({ toEmails: recipientEmails, bodyText, bodyHtml });
    }

    // Always extract appointments with Claude (3 concurrent to avoid API limits)
    if (messagesToProcess.length > 0) {
      const appointmentStartTime = Date.now();
      console.log(`[Gmail] Extracting appointments from ${messagesToProcess.length} emails with concurrency=3...`);

      const appointmentResults = await batchWithConcurrency(
        messagesToProcess,
        async (msg) => extractAppointmentTime(msg.bodyText),
        3 // lower concurrency for Claude API
      );

      const appointmentTime = Date.now() - appointmentStartTime;
      const appointmentSuccess = appointmentResults.filter(r => r.success).length;
      console.log(`[Gmail] Extracted ${appointmentSuccess} appointments in ${appointmentTime}ms`);

      // Combine recipients with their appointment info and optional codes/links
      messagesToProcess.forEach((msg, idx) => {
        const appointmentResult = appointmentResults[idx];
        const appointmentInfo = appointmentResult.success
          ? appointmentResult.value
          : { appointmentDate: null, appointmentTime: null, rawDateTime: null };

        // Extract code and link if requested
        const code = extractCodesAndLinks ? extractCodeFromBody(msg.bodyText) : null;
        const link = extractCodesAndLinks ? extractLinkFromBody(msg.bodyText, msg.bodyHtml ?? undefined) : null;

        for (const email of msg.toEmails) {
          const normalizedEmail = email.toLowerCase();

          // Skip the forwarding inbox itself and excluded domains
          if (normalizedEmail === config.google.forwardingEmail?.toLowerCase()) continue;
          if (shouldExcludeRecipient(normalizedEmail)) continue;

          // Only add if we don't have this recipient yet, or if this one has appointment info
          if (!recipientMap.has(normalizedEmail) || appointmentInfo.appointmentDate) {
            recipientMap.set(normalizedEmail, {
              email: normalizedEmail,
              appointmentDate: appointmentInfo.appointmentDate,
              appointmentTime: appointmentInfo.appointmentTime,
              rawDateTime: appointmentInfo.rawDateTime,
              code,
              link,
            });
          }
        }
      });
    }

    const totalTime = Date.now() - startTime;
    console.log(`[Gmail] Total findRelatedRecipients: ${totalTime}ms for ${validMessages.length} messages`);

    const results = Array.from(recipientMap.values());

    // Sort by appointment date (nulls last)
    results.sort((a, b) => {
      if (!a.rawDateTime && !b.rawDateTime) return 0;
      if (!a.rawDateTime) return 1;
      if (!b.rawDateTime) return -1;
      return a.rawDateTime.localeCompare(b.rawDateTime);
    });

    console.log(`Found ${results.length} unique recipients with appointments`);
    return results;

  } catch (error) {
    console.error('Gmail search error:', error);
    throw error;
  }
}

/**
 * Extract plain text body from Gmail message payload
 */
function extractEmailBody(payload: any): string {
  if (!payload) return '';

  // Check for plain text part
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }

  // Check for HTML part (fallback)
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    const html = Buffer.from(payload.body.data, 'base64').toString('utf-8');
    // Strip HTML tags for plain text
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // Recursively check parts (for multipart messages)
  if (payload.parts) {
    for (const part of payload.parts) {
      const text = extractEmailBody(part);
      if (text) return text;
    }
  }

  return '';
}

/**
 * Use Claude to extract appointment date/time from email body
 */
async function extractAppointmentTime(emailBody: string): Promise<{
  appointmentDate: string | null;
  appointmentTime: string | null;
  rawDateTime: string | null;
}> {
  if (!emailBody || emailBody.length < 20) {
    return { appointmentDate: null, appointmentTime: null, rawDateTime: null };
  }

  try {
    const client = getAnthropicClient();

    // Wrapped in circuit breaker (TD-05)
    // Use current year for date examples to avoid Claude defaulting to old years
    const currentYear = new Date().getFullYear();

    const response = await claudeCircuit.execute(() =>
      client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 256,
        system: `Extract appointment/event date and time from emails. Look for:
- Presale appointments
- Relocation meetings
- Selection appointments
- Scheduled times for ticket-related events

Today's date is ${new Date().toISOString().split('T')[0]}. When dates don't specify a year, use ${currentYear} (or ${currentYear + 1} if the date has clearly passed this year).

Return ONLY a JSON object with:
- appointmentDate: Human readable DATE only like "Tue Dec 20" or "December 20, ${currentYear}" or null if not found
- appointmentTime: Human readable TIME only like "2:00 PM" or "14:00" or null if not found
- rawDateTime: ISO 8601 format like "${currentYear}-12-20T14:00:00" or null if not found

If no appointment is mentioned, return null for all fields.`,
        messages: [
          {
            role: 'user',
            content: `Extract the appointment date/time from this email:\n\n${emailBody.slice(0, 2000)}`,
          },
        ],
      })
    );

    const textContent = response.content.find(c => c.type === 'text');
    if (!textContent || textContent.type !== 'text') {
      return { appointmentDate: null, appointmentTime: null, rawDateTime: null };
    }

    // Parse JSON from response
    const jsonMatch = textContent.text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        appointmentDate: parsed.appointmentDate || null,
        appointmentTime: parsed.appointmentTime || null,
        rawDateTime: parsed.rawDateTime || null,
      };
    }

    return { appointmentDate: null, appointmentTime: null, rawDateTime: null };
  } catch (error) {
    console.error('Error extracting appointment time:', error);
    return { appointmentDate: null, appointmentTime: null, rawDateTime: null };
  }
}

/**
 * Extract email addresses from a header value
 * Handles formats like: "John Doe <john@example.com>, jane@example.com"
 */
function extractEmailAddresses(headerValue: string): string[] {
  const emails: string[] = [];

  // Match email addresses in angle brackets or standalone
  const emailRegex = /(?:<([^>]+)>|([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}))/g;

  let match;
  while ((match = emailRegex.exec(headerValue)) !== null) {
    const email = match[1] || match[2];
    if (email) {
      emails.push(email.trim());
    }
  }

  return emails;
}

/**
 * Check if /scan command is in the email body
 * Now matches both /scan and /scantimes (merged behavior - always extracts times)
 */
export function shouldScanForRecipients(emailBody: string): boolean {
  return /\/scan(?:times)?\b/i.test(emailBody);
}

/**
 * Format recipient with appointment for subtask name
 */
export function formatRecipientSubtaskName(recipient: RecipientWithAppointment): string {
  if (recipient.appointmentDate && recipient.appointmentTime) {
    return `${recipient.email} - ${recipient.appointmentDate}, ${recipient.appointmentTime}`;
  }
  if (recipient.appointmentDate) {
    return `${recipient.email} - ${recipient.appointmentDate}`;
  }
  if (recipient.appointmentTime) {
    return `${recipient.email} - ${recipient.appointmentTime}`;
  }
  return recipient.email;
}

// ============================================================================
// /emailtask - Gmail Search for Task Creation
// ============================================================================

/**
 * Email found via Gmail search for /emailtask
 */
export interface GmailEmailResult {
  messageId: string;
  subject: string;
  from: string | null;
  to: string | null;
  date: Date;
  bodyText: string;
  bodyHtml: string | null;
}

export type EmailMatchMode = 'equals' | 'contains';

/**
 * Get today's date in Eastern Time as YYYY/MM/DD for Gmail query
 */
function getTodayEastern(): string {
  const now = new Date();
  // Format in Eastern time
  const eastern = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  // Convert from YYYY-MM-DD to YYYY/MM/DD
  return eastern.replace(/-/g, '/');
}

/**
 * Search Gmail for emails by subject
 *
 * @param subject - The subject to search for
 * @param matchMode - 'equals' for exact match, 'contains' for partial match
 * @param daysBack - Number of days to search (0 = today only, default)
 * @returns Array of matching emails sorted by date (most recent first)
 */
export async function searchEmailsBySubject(
  subject: string,
  matchMode: EmailMatchMode = 'equals',
  daysBack: number = 0
): Promise<GmailEmailResult[]> {
  const gmail = await getGmailClient();

  const normalizedSubject = normalizeSubject(subject);

  // Build date range for Gmail query
  let afterDate: string;
  if (daysBack === 0) {
    afterDate = getTodayEastern();
  } else {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysBack);
    afterDate = startDate.toISOString().split('T')[0].replace(/-/g, '/');
  }

  // Gmail API uses "subject:" for partial match
  // We'll do exact matching client-side for 'equals' mode
  const query = `subject:"${normalizedSubject}" after:${afterDate}`;
  console.log(`Gmail search query: ${query} (matchMode: ${matchMode})`);

  try {
    // Wrapped in circuit breaker (TD-05)
    const searchResponse = await gmailCircuit.execute(() =>
      gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: 200,
      })
    );

    const messages = searchResponse.data.messages ?? [];
    console.log(`Gmail returned ${messages.length} messages`);

    if (messages.length === 0) {
      return [];
    }

    // Filter messages with valid IDs
    const validMessages = messages.filter(m => m.id);
    const startTime = Date.now();

    // Batch fetch all messages with concurrency control (5 concurrent requests)
    // Each fetch wrapped in circuit breaker (TD-05)
    console.log(`[Gmail] Fetching ${validMessages.length} messages with concurrency=5...`);
    const fetchResults = await batchWithConcurrency(
      validMessages,
      async (message) => {
        const msgResponse = await gmailCircuit.execute(() =>
          gmail.users.messages.get({
            userId: 'me',
            id: message.id!,
            format: 'full',
          })
        );
        return { id: message.id!, data: msgResponse.data };
      },
      5 // concurrency limit to avoid Gmail rate limits
    );

    const fetchTime = Date.now() - startTime;
    const successCount = fetchResults.filter(r => r.success).length;
    const failCount = fetchResults.filter(r => !r.success).length;
    console.log(`[Gmail] Fetched ${successCount} messages in ${fetchTime}ms (${failCount} failed)`);

    // Log any failures
    fetchResults.forEach((result, idx) => {
      if (!result.success) {
        console.error(`[Gmail] Failed to fetch message ${validMessages[idx].id}:`, result.error.message);
      }
    });

    // Process successful fetches
    const results: GmailEmailResult[] = [];

    for (const result of fetchResults) {
      if (!result.success) continue;

      const { id: messageId, data: msgData } = result.value;
      const headers = msgData.payload?.headers ?? [];
      const subjectHeader = headers.find((h: any) => h.name?.toLowerCase() === 'subject');
      const fromHeader = headers.find((h: any) => h.name?.toLowerCase() === 'from');
      const toHeader = headers.find((h: any) => h.name?.toLowerCase() === 'to');
      const dateHeader = headers.find((h: any) => h.name?.toLowerCase() === 'date');

      const emailSubject = subjectHeader?.value || '';
      const normalizedEmailSubject = normalizeSubject(emailSubject);

      // Apply client-side matching
      if (matchMode === 'equals') {
        // Exact match (case-insensitive)
        if (normalizedEmailSubject.toLowerCase() !== normalizedSubject.toLowerCase()) {
          continue; // Skip non-matching (log removed to reduce noise in batch mode)
        }
      }
      // 'contains' mode - Gmail already filtered, but double-check
      else if (!normalizedEmailSubject.toLowerCase().includes(normalizedSubject.toLowerCase())) {
        continue;
      }

      // Extract body
      const bodyText = extractEmailBody(msgData.payload);
      const bodyHtml = extractEmailBodyHtml(msgData.payload);

      // Parse date
      let date = new Date();
      if (dateHeader?.value) {
        const parsed = new Date(dateHeader.value);
        if (!isNaN(parsed.getTime())) {
          date = parsed;
        }
      }

      results.push({
        messageId,
        subject: emailSubject,
        from: fromHeader?.value || null,
        to: toHeader?.value || null,
        date,
        bodyText,
        bodyHtml,
      });
    }

    // Sort by date, most recent first
    results.sort((a, b) => b.date.getTime() - a.date.getTime());

    const totalTime = Date.now() - startTime;
    console.log(`[Gmail] Found ${results.length} emails matching "${normalizedSubject}" (${matchMode}) in ${totalTime}ms`);
    return results;

  } catch (error) {
    console.error('Gmail search error:', error);
    throw error;
  }
}

/**
 * Extract HTML body from Gmail message payload
 */
function extractEmailBodyHtml(payload: any): string | null {
  if (!payload) return null;

  // Check for HTML part
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }

  // Recursively check parts
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf-8');
      }
      const nested = extractEmailBodyHtml(part);
      if (nested) return nested;
    }
  }

  return null;
}
