/**
 * Gmail API Service
 *
 * Searches the forwarding inbox for related emails by subject
 * Used for the /scan feature to find all recipients with their appointment times
 *
 * Migrated to use core-api instead of direct googleapis
 */

import { config } from '../config/environment.js';
import { gmailCircuit, claudeCircuit } from './circuitBreaker.js';
import { google as coreApiGoogle, claude as coreApiClaude } from './coreApi.js';

// ============================================================================
// Gmail API Types (from core-api responses)
// ============================================================================

interface GmailMessageListItem {
  id: string;
  threadId: string;
}

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: {
    size: number;
    data?: string;
  };
  parts?: GmailMessagePart[];
}

interface GmailMessageFull {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailMessagePart & {
    headers?: GmailHeader[];
  };
}

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

// Gmail client is now accessed via coreApi.google.gmail
// Claude client is now accessed via coreApi.claude

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
  custom: Record<string, string | null> | null;  // Custom extracted fields from instructions
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
 * Search for emails with the same subject within the last 14 days
 * Returns recipients with appointment times and optional codes/links
 *
 * @param subject - Email subject to search for
 * @param options.extractCodesAndLinks - If true, also extract presale codes and links (default: false)
 * @param options.skipAppointmentExtraction - If true, skip Claude appointment extraction (default: false)
 */
export async function findRelatedRecipients(
  subject: string,
  extractCodesAndLinksOrOptions: boolean | { extractCodesAndLinks?: boolean; skipAppointmentExtraction?: boolean; instructions?: string } = false
): Promise<RecipientWithAppointment[]> {
  // Support both old boolean signature and new options object
  const options = typeof extractCodesAndLinksOrOptions === 'boolean'
    ? { extractCodesAndLinks: extractCodesAndLinksOrOptions, skipAppointmentExtraction: false, instructions: undefined as string | undefined }
    : { extractCodesAndLinks: false, skipAppointmentExtraction: false, instructions: undefined as string | undefined, ...extractCodesAndLinksOrOptions };

  const { extractCodesAndLinks, skipAppointmentExtraction, instructions } = options;
  const normalizedSubject = normalizeSubject(subject);

  console.log(`[Gmail] Subject "${normalizedSubject}" - extractCodesAndLinks: ${extractCodesAndLinks}, skipAppointmentExtraction: ${skipAppointmentExtraction}`);

  // Build search query - last 14 days
  const fourteenDaysAgo = new Date();
  fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);
  const afterStr = fourteenDaysAgo.toISOString().split('T')[0].replace(/-/g, '/');

  const query = `subject:"${normalizedSubject}" after:${afterStr}`;
  console.log(`Gmail search query: ${query}`);

  try {
    // Search for messages via core-api (wrapped in circuit breaker TD-05)
    const searchResponse = await gmailCircuit.execute(() =>
      coreApiGoogle.gmail.listMessages({
        maxResults: 200,
        q: query,
      })
    );

    // core-api's listMessages returns the array directly, not wrapped in { messages: [...] }
    const messages = (Array.isArray(searchResponse) ? searchResponse : []) as GmailMessageFull[];
    console.log(`Found ${messages.length} related emails`);

    if (messages.length === 0) {
      return [];
    }

    // Map to track unique recipients (by email) with their appointment info
    const recipientMap = new Map<string, RecipientWithAppointment>();

    // Filter messages with valid IDs
    const validMessages = messages.filter((m: GmailMessageListItem) => m.id);
    const startTime = Date.now();

    // Batch fetch all messages with concurrency control (5 concurrent requests)
    // Each fetch wrapped in circuit breaker via core-api (TD-05)
    console.log(`[Gmail] Fetching ${validMessages.length} messages with concurrency=5...`);
    const fetchResults = await batchWithConcurrency(
      validMessages,
      async (message: GmailMessageListItem) => {
        const msgResponse = await gmailCircuit.execute(() =>
          coreApiGoogle.gmail.getMessage(message.id!)
        );
        return msgResponse as GmailMessageFull;
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
      fromEmail: string;
      bodyText: string;
      bodyHtml: string | null;
    }
    const messagesToProcess: MessageWithBody[] = [];

    for (const result of fetchResults) {
      if (!result.success) continue;

      const msgData = result.value as GmailMessageFull;
      const headers = msgData.payload?.headers ?? [];
      const fromHeader = headers.find((h: GmailHeader) => h.name?.toLowerCase() === 'from');
      const fromEmail = fromHeader?.value || '';

      // Always extract body - needed for original recipient extraction
      const bodyText = extractEmailBody(msgData.payload);
      const bodyHtml = extractCodesAndLinks ? extractEmailBodyHtml(msgData.payload) : null;

      // For auto-forwarded emails, check X-Forwarded-For header first (contains original recipient)
      // Then try Delivered-To headers, body extraction, and finally To header
      let recipientEmails: string[] = [];

      // Try X-Forwarded-For header (Gmail auto-forward includes original recipient here)
      const xForwardedFor = headers.find((h: GmailHeader) => h.name?.toLowerCase() === 'x-forwarded-for');
      if (xForwardedFor?.value) {
        // Format: "original@email.com forwarding@inbox.com" - we want the first one
        const parts = xForwardedFor.value.split(/\s+/);
        if (parts.length > 0 && parts[0].includes('@')) {
          recipientEmails.push(parts[0]);
          console.log(`[Gmail] Found recipient from X-Forwarded-For: ${parts[0]}`);
        }
      }

      // Try Delivered-To headers (there can be multiple - find one that's not the forwarding inbox)
      if (recipientEmails.length === 0) {
        const deliveredToHeaders = headers.filter((h: GmailHeader) => h.name?.toLowerCase() === 'delivered-to');
        for (const header of deliveredToHeaders) {
          if (header.value) {
            const email = header.value.trim().toLowerCase();
            // Skip the forwarding inbox itself and excluded domains
            if (email === config.google.forwardingEmail?.toLowerCase()) continue;
            if (shouldExcludeRecipient(email)) continue;
            recipientEmails.push(email);
            console.log(`[Gmail] Found recipient from Delivered-To: ${email}`);
            break; // Take the first valid one
          }
        }
      }

      // Try extracting from body (for manually forwarded emails with "To:" in body)
      if (recipientEmails.length === 0) {
        recipientEmails = extractOriginalToFromBody(bodyText);
        if (recipientEmails.length > 0) {
          console.log(`[Gmail] Found recipient from body: ${recipientEmails.join(', ')}`);
        }
      }

      // Fallback: try the header "To"
      if (recipientEmails.length === 0) {
        const toHeader = headers.find((h: GmailHeader) => h.name?.toLowerCase() === 'to');
        if (toHeader?.value) {
          recipientEmails = extractEmailAddresses(toHeader.value);
          if (recipientEmails.length > 0) {
            console.log(`[Gmail] Found recipient from To header: ${recipientEmails.join(', ')}`);
          }
        }
      }

      if (recipientEmails.length === 0) {
        console.log(`[Gmail] No recipients found for message`);
        continue;
      }

      messagesToProcess.push({ toEmails: recipientEmails, fromEmail, bodyText, bodyHtml });
    }

    // Extract appointments with Claude unless skipped (3 concurrent to avoid API limits)
    let appointmentResults: Array<{ success: true; value: { appointmentDate: string | null; appointmentTime: string | null; rawDateTime: string | null; custom: Record<string, string | null> | null } } | { success: false; error: Error }> = [];

    if (messagesToProcess.length > 0 && !skipAppointmentExtraction) {
      const appointmentStartTime = Date.now();
      console.log(`[Gmail] Extracting appointments from ${messagesToProcess.length} emails with concurrency=3...`);

      appointmentResults = await batchWithConcurrency(
        messagesToProcess,
        async (msg) => extractAppointmentTime(msg.bodyText, normalizedSubject, msg.fromEmail, instructions),
        3 // lower concurrency for Claude API
      );

      const appointmentTime = Date.now() - appointmentStartTime;
      const appointmentSuccess = appointmentResults.filter(r => r.success).length;
      console.log(`[Gmail] Extracted ${appointmentSuccess} appointments in ${appointmentTime}ms`);
    } else if (skipAppointmentExtraction) {
      console.log(`[Gmail] Skipping appointment extraction (skipAppointmentExtraction=true)`);
    }

    // Combine recipients with their appointment info and optional codes/links
    if (messagesToProcess.length > 0) {
      messagesToProcess.forEach((msg, idx) => {
        const appointmentResult = appointmentResults[idx];
        const appointmentInfo = appointmentResult?.success
          ? appointmentResult.value
          : { appointmentDate: null, appointmentTime: null, rawDateTime: null, custom: null };

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
              custom: appointmentInfo.custom || null,
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
 * Enrich recipients with appointment times using Claude
 * Call this AFTER posting the initial email list to get appointment times asynchronously
 *
 * @param subject - Email subject to search for (used for Claude context)
 * @param recipients - Recipients to enrich (from findRelatedRecipients with skipAppointmentExtraction)
 * @returns Recipients with appointment times filled in
 */
export async function enrichRecipientsWithAppointments(
  subject: string,
  recipients: RecipientWithAppointment[],
  instructions?: string
): Promise<RecipientWithAppointment[]> {
  if (recipients.length === 0) {
    return recipients;
  }

  const normalizedSubject = normalizeSubject(subject);
  console.log(`[Gmail] Enriching ${recipients.length} recipients with appointment times...`);

  // Re-fetch messages to get body text for appointment extraction
  // Build search query - last 14 days
  const fourteenDaysAgo = new Date();
  fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);
  const afterDate = fourteenDaysAgo.toISOString().split('T')[0].replace(/-/g, '/');

  const query = `subject:"${normalizedSubject}" after:${afterDate}`;

  try {
    const searchResponse = await gmailCircuit.execute(() =>
      coreApiGoogle.gmail.listMessages({
        maxResults: 200,
        q: query,
      })
    );

    const messages = (Array.isArray(searchResponse) ? searchResponse : []) as GmailMessageFull[];
    if (messages.length === 0) {
      return recipients;
    }

    // Fetch message details
    const validMessages = messages.filter((m: GmailMessageListItem) => m.id);
    const fetchResults = await batchWithConcurrency(
      validMessages,
      async (message: GmailMessageListItem) => {
        const msgResponse = await gmailCircuit.execute(() =>
          coreApiGoogle.gmail.getMessage(message.id!)
        );
        return msgResponse as GmailMessageFull;
      },
      5
    );

    // Build email -> body text mapping
    // IMPORTANT: Use same recipient extraction logic as findRelatedRecipients
    // to properly handle X-Forwarded-For headers from Gmail auto-forwarding
    const emailToBody = new Map<string, { bodyText: string; fromEmail: string }>();
    for (const result of fetchResults) {
      if (!result.success) continue;

      const msgData = result.value as GmailMessageFull;
      const headers = msgData.payload?.headers ?? [];
      const fromHeader = headers.find((h: GmailHeader) => h.name?.toLowerCase() === 'from');
      const fromEmail = fromHeader?.value || '';
      const bodyText = extractEmailBody(msgData.payload);

      // Use same recipient extraction logic as findRelatedRecipients
      let recipientEmails: string[] = [];

      // Try X-Forwarded-For header (Gmail auto-forward includes original recipient here)
      const xForwardedFor = headers.find((h: GmailHeader) => h.name?.toLowerCase() === 'x-forwarded-for');
      if (xForwardedFor?.value) {
        // Format: "original@email.com forwarding@inbox.com" - we want the first one
        const parts = xForwardedFor.value.split(/\s+/);
        if (parts.length > 0 && parts[0].includes('@')) {
          recipientEmails.push(parts[0]);
        }
      }

      // Try Delivered-To headers (there can be multiple - find one that's not the forwarding inbox)
      if (recipientEmails.length === 0) {
        const deliveredToHeaders = headers.filter((h: GmailHeader) => h.name?.toLowerCase() === 'delivered-to');
        for (const header of deliveredToHeaders) {
          if (header.value) {
            const email = header.value.trim().toLowerCase();
            // Skip the forwarding inbox itself and excluded domains
            if (email === config.google.forwardingEmail?.toLowerCase()) continue;
            if (shouldExcludeRecipient(email)) continue;
            recipientEmails.push(email);
            break; // Take the first valid one
          }
        }
      }

      // Try extracting from body (for manually forwarded emails with "To:" in body)
      if (recipientEmails.length === 0) {
        recipientEmails = extractOriginalToFromBody(bodyText);
      }

      // Fallback: try the header "To"
      if (recipientEmails.length === 0) {
        const toHeader = headers.find((h: GmailHeader) => h.name?.toLowerCase() === 'to');
        if (toHeader?.value) {
          recipientEmails.push(...extractEmailAddresses(toHeader.value));
        }
      }

      for (const email of recipientEmails) {
        const normalizedEmail = email.toLowerCase();
        if (!emailToBody.has(normalizedEmail)) {
          emailToBody.set(normalizedEmail, { bodyText, fromEmail });
        }
      }
    }

    // Debug: Log what we found in emailToBody map
    console.log(`[Gmail] Built emailToBody map with ${emailToBody.size} unique recipients`);
    if (emailToBody.size > 0 && emailToBody.size <= 10) {
      console.log(`[Gmail] Mapped emails: ${Array.from(emailToBody.keys()).join(', ')}`);
    }

    // Extract appointments for each recipient
    const recipientsToEnrich = recipients.filter(r => emailToBody.has(r.email));
    const unmatchedRecipients = recipients.filter(r => !emailToBody.has(r.email));

    console.log(`[Gmail] Extracting appointments from ${recipientsToEnrich.length} emails with concurrency=3...`);
    if (unmatchedRecipients.length > 0) {
      console.log(`[Gmail] WARNING: ${unmatchedRecipients.length} recipients not found in emailToBody map`);
      if (unmatchedRecipients.length <= 5) {
        console.log(`[Gmail] Unmatched: ${unmatchedRecipients.map(r => r.email).join(', ')}`);
      }
    }

    const appointmentResults = await batchWithConcurrency(
      recipientsToEnrich,
      async (recipient) => {
        const emailData = emailToBody.get(recipient.email);
        if (!emailData) {
          return { appointmentDate: null, appointmentTime: null, rawDateTime: null, custom: null };
        }
        return extractAppointmentTime(emailData.bodyText, normalizedSubject, emailData.fromEmail, instructions);
      },
      3
    );

    console.log(`[Gmail] Appointment extraction complete`);

    // Update recipients with appointment info
    const enrichedRecipients = recipients.map(recipient => {
      const idx = recipientsToEnrich.findIndex(r => r.email === recipient.email);
      if (idx === -1) return recipient;

      const result = appointmentResults[idx];
      if (!result.success) return recipient;

      return {
        ...recipient,
        appointmentDate: result.value.appointmentDate,
        appointmentTime: result.value.appointmentTime,
        rawDateTime: result.value.rawDateTime,
        custom: result.value.custom || null,
      };
    });

    // Sort by appointment date (nulls last)
    enrichedRecipients.sort((a, b) => {
      if (!a.rawDateTime && !b.rawDateTime) return 0;
      if (!a.rawDateTime) return 1;
      if (!b.rawDateTime) return -1;
      return a.rawDateTime.localeCompare(b.rawDateTime);
    });

    const withAppointments = enrichedRecipients.filter(r => r.appointmentDate || r.appointmentTime);
    console.log(`[Gmail] Found ${withAppointments.length} recipients with appointment times`);

    return enrichedRecipients;
  } catch (error) {
    console.error('[Gmail] Error enriching with appointments:', error);
    return recipients; // Return original recipients on error
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
 * Extract the original "To" recipient from a forwarded email body
 * Looks for patterns like:
 * - "To: customer@example.com"
 * - "To: John Doe <customer@example.com>"
 *
 * Returns the extracted email addresses, or empty array if not found
 */
function extractOriginalToFromBody(bodyText: string): string[] {
  if (!bodyText) return [];

  // Common patterns for forwarded email "To:" lines
  // Match "To:" at start of line, followed by email(s)
  const toPatterns = [
    // "To: email@example.com" or "To: Name <email@example.com>"
    /^To:\s*(.+?)$/gim,
    // Gmail forward format: "To: email@example.com"
    /(?:---------- Forwarded message ---------[\s\S]*?)To:\s*(.+?)$/m,
  ];

  const foundEmails: string[] = [];

  for (const pattern of toPatterns) {
    pattern.lastIndex = 0;
    const match = pattern.exec(bodyText);
    if (match && match[1]) {
      // Extract email addresses from the matched To: line
      const emails = extractEmailAddresses(match[1]);
      foundEmails.push(...emails);
      if (foundEmails.length > 0) break; // Found some, stop searching
    }
  }

  // Deduplicate
  return [...new Set(foundEmails)];
}

/**
 * Map timezone abbreviations to IANA timezone names for programmatic conversion.
 * Covers all US sports team timezones.
 */
const TZ_ABBREV_TO_IANA: Record<string, string> = {
  'CT': 'America/Chicago',
  'CST': 'America/Chicago',
  'CDT': 'America/Chicago',
  'MT': 'America/Denver',
  'MST': 'America/Phoenix',   // MST = no DST (Arizona); Denver teams say MDT in summer
  'MDT': 'America/Denver',
  'PT': 'America/Los_Angeles',
  'PST': 'America/Los_Angeles',
  'PDT': 'America/Los_Angeles',
  'ET': 'America/New_York',
  'EST': 'America/New_York',
  'EDT': 'America/New_York',
};

/**
 * Convert a naive ISO datetime from a source timezone to Eastern Time.
 * Uses Intl.DateTimeFormat for correct DST handling.
 *
 * @param isoDateTime - ISO 8601 without timezone offset, e.g. "2026-03-15T14:00:00"
 * @param sourceTzAbbrev - Timezone abbreviation, e.g. "CT", "PT", "MT"
 * @returns Converted date/time fields, or null if conversion fails
 */
function convertToET(
  isoDateTime: string,
  sourceTzAbbrev: string
): { rawDateTime: string; appointmentDate: string; appointmentTime: string } | null {
  const sourceIana = TZ_ABBREV_TO_IANA[sourceTzAbbrev];
  if (!sourceIana) return null;

  try {
    // Parse the naive ISO string as a date in the source timezone.
    // We do this by formatting the date parts in the source timezone to find the UTC offset,
    // then constructing the correct UTC instant.
    const [datePart, timePart] = isoDateTime.split('T');
    if (!datePart || !timePart) return null;

    const [year, month, day] = datePart.split('-').map(Number);
    const [hour, minute, secondStr] = timePart.split(':');
    const second = parseInt(secondStr || '0', 10);

    // Create a rough UTC date to start with, then find the actual UTC offset for the source tz
    const roughDate = new Date(Date.UTC(year, month - 1, day, parseInt(hour), parseInt(minute), second));

    // Get what the source timezone shows for this UTC instant
    const sourceFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: sourceIana,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
    const sourceParts = Object.fromEntries(
      sourceFormatter.formatToParts(roughDate).map(p => [p.type, p.value])
    );
    const sourceHour = parseInt(sourceParts.hour || '0', 10);

    // The difference between what we wanted (hour) and what the source tz shows (sourceHour)
    // tells us how to adjust to get the correct UTC instant
    let hourDiff = parseInt(hour) - sourceHour;
    // Handle day boundary wrapping
    if (hourDiff > 12) hourDiff -= 24;
    if (hourDiff < -12) hourDiff += 24;

    const correctUtc = new Date(roughDate.getTime() + hourDiff * 3600000);

    // Now format in ET
    const etFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
    const etParts = Object.fromEntries(
      etFormatter.formatToParts(correctUtc).map(p => [p.type, p.value])
    );

    const etYear = etParts.year;
    const etMonth = etParts.month;
    const etDay = etParts.day;
    const etHour = etParts.hour === '24' ? '00' : etParts.hour;
    const etMinute = etParts.minute;

    const rawDateTime = `${etYear}-${etMonth}-${etDay}T${etHour}:${etMinute}:00`;

    // Human-readable date
    const dateFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short', month: 'short', day: 'numeric',
    });
    const appointmentDate = dateFormatter.format(correctUtc);

    // Human-readable time
    const timeFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric', minute: '2-digit', hour12: true,
    });
    const appointmentTime = `${timeFormatter.format(correctUtc)} ET`;

    return { rawDateTime, appointmentDate, appointmentTime };
  } catch (error) {
    console.error(`[Gmail] Timezone conversion error:`, error);
    return null;
  }
}

/**
 * Use Claude via core-api to extract appointment date/time from email body
 * Times are extracted as-is, then converted to ET programmatically
 */
async function extractAppointmentTime(emailBody: string, subject?: string, fromEmail?: string, instructions?: string): Promise<{
  appointmentDate: string | null;
  appointmentTime: string | null;
  rawDateTime: string | null;
  custom: Record<string, string | null> | null;
}> {
  if (!emailBody || emailBody.length < 20) {
    console.log(`[Gmail] Skipping appointment extraction: body too short (${emailBody?.length || 0} chars)`);
    return { appointmentDate: null, appointmentTime: null, rawDateTime: null, custom: null };
  }

  // Debug: Log what we're about to analyze
  console.log(`[Gmail] Extracting appointment from email (${emailBody.length} chars), from: ${fromEmail || 'unknown'}, subject: ${subject || 'none'}`);

  try {
    // Use current year for date examples to avoid Claude defaulting to old years
    const currentYear = new Date().getFullYear();

    // Build email content with from address (most reliable for team detection via domain)
    const emailParts: string[] = [];
    if (fromEmail) {
      emailParts.push(`From: ${fromEmail}`);
    }
    if (subject) {
      emailParts.push(`Subject: ${subject}`);
    }
    emailParts.push('', emailBody);
    const emailContent = emailParts.join('\n');

    const systemPrompt = `Extract appointment/event date and time from emails. Look for:
- Presale appointments
- Relocation meetings
- Selection appointments
- Scheduled times for ticket-related events

IMPORTANT - TEAM DETECTION (in priority order):
1. FIRST: Look for the team name explicitly mentioned in the email BODY (most reliable)
2. SECOND: Check the From email domain (e.g., @astros.com = Astros, @buccaneers.com = Buccaneers)
3. THIRD: Fall back to the subject line if needed

IMPORTANT: Return the appointment time EXACTLY as stated in the email. Do NOT convert timezones.
If the email says "2:00 PM CT", return "2:00 PM CT". If it says "3:00 PM" with no timezone, return "3:00 PM".

Today's date is ${new Date().toISOString().split('T')[0]}. When dates don't specify a year, use ${currentYear} (or ${currentYear + 1} if the date has clearly passed this year).

Return ONLY a JSON object with:
- appointmentDate: Human readable DATE only like "Tue Dec 20" or "December 20, ${currentYear}" or null if not found
- appointmentTime: The time EXACTLY as stated in the email like "2:00 PM" or "2:00 PM CT" or null if not found
- rawDateTime: ISO 8601 format with the ORIGINAL time (no timezone conversion) like "${currentYear}-12-20T14:00:00" or null if not found
- detectedTeam: The team name detected, or null if none found
- originalTimezone: The timezone stated in the email (e.g., "PT", "CT", "MT", "ET"), or if not stated, infer from the detected team's home city. Return null if unknown.
${instructions ? `\nAdditionally, extract the following custom fields from the email body:\n${instructions}\n\nInclude any extracted values in a "custom" key in the response as an object with descriptive short key names and string values.\n` : ''}
If no appointment is mentioned, return null for all fields.`;

    // Use core-api Claude analyze endpoint wrapped in circuit breaker (TD-05)
    const response = await claudeCircuit.execute(() =>
      coreApiClaude.analyze({
        content: `Extract the appointment date/time from this email:\n\n${emailContent}`,
        systemPrompt,
        maxTokens: instructions ? 512 : 256,
      })
    );

    // core-api returns { text: "..." } — read .text (with .content fallback for safety)
    const claudeResponse = response as { ok?: boolean; text?: string; content?: string; error?: string; model?: string; usage?: unknown };
    const text = claudeResponse.text || claudeResponse.content || '';

    // Debug: Log full response if content is empty or ok=false
    if (!text || claudeResponse.ok === false) {
      console.log(`[Gmail] WARNING: Claude issue. ok=${claudeResponse.ok}, error=${claudeResponse.error}, model=${claudeResponse.model}, usage=${JSON.stringify(claudeResponse.usage)}`);
      console.log(`[Gmail] Full response:`, JSON.stringify(response).slice(0, 800));
    }

    // Strip markdown code fences if present (Claude sometimes wraps JSON in ```json ... ```)
    let cleanText = text.trim();
    if (cleanText.startsWith('```')) {
      cleanText = cleanText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    // Parse JSON from response
    const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);

        // Log what was extracted
        if (parsed.appointmentDate || parsed.appointmentTime) {
          console.log(`[Gmail] Extracted: date="${parsed.appointmentDate}", time="${parsed.appointmentTime}", raw="${parsed.rawDateTime}", team="${parsed.detectedTeam}", tz="${parsed.originalTimezone}"`);
        } else {
          console.log(`[Gmail] No appointment found in email body (first 100 chars): ${emailBody.slice(0, 100).replace(/\n/g, ' ')}`);
        }

        // Convert from source timezone to ET programmatically
        let rawDateTime = parsed.rawDateTime || null;
        let appointmentTime = parsed.appointmentTime || null;
        let appointmentDate = parsed.appointmentDate || null;
        const sourceTz = parsed.originalTimezone?.toUpperCase()?.replace(/[^A-Z]/g, '') || null;

        if (rawDateTime && sourceTz && sourceTz !== 'ET' && sourceTz !== 'EST' && sourceTz !== 'EDT') {
          const converted = convertToET(rawDateTime, sourceTz);
          if (converted) {
            console.log(`[Gmail] Timezone conversion: ${rawDateTime} (${sourceTz}) → ${converted.rawDateTime} (ET)`);
            rawDateTime = converted.rawDateTime;
            appointmentTime = converted.appointmentTime;
            appointmentDate = converted.appointmentDate;
          } else {
            console.log(`[Gmail] WARNING: Could not convert timezone ${sourceTz} → ET, using original time`);
          }
        }

        return {
          appointmentDate,
          appointmentTime,
          rawDateTime,
          custom: parsed.custom || null,
        };
      } catch (parseError) {
        console.warn('[Gmail] Failed to parse Claude response as JSON:', parseError);
        return { appointmentDate: null, appointmentTime: null, rawDateTime: null, custom: null };
      }
    }

    console.warn('[Gmail] No JSON found in Claude response. Raw response:', text.slice(0, 200));
    return { appointmentDate: null, appointmentTime: null, rawDateTime: null, custom: null };
  } catch (error) {
    console.error('Error extracting appointment time:', error);
    return { appointmentDate: null, appointmentTime: null, rawDateTime: null, custom: null };
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
 * Search Gmail for emails by subject via core-api
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
    // Wrapped in circuit breaker via core-api (TD-05)
    const searchResponse = await gmailCircuit.execute(() =>
      coreApiGoogle.gmail.listMessages({
        maxResults: 200,
        q: query,
      })
    );

    // core-api's listMessages returns the array directly, not wrapped in { messages: [...] }
    const messages = (Array.isArray(searchResponse) ? searchResponse : []) as GmailMessageFull[];
    console.log(`Gmail returned ${messages.length} messages`);

    if (messages.length === 0) {
      return [];
    }

    // Filter messages with valid IDs
    const validMessages = messages.filter((m: GmailMessageListItem) => m.id);
    const startTime = Date.now();

    // Batch fetch all messages with concurrency control (5 concurrent requests)
    // Each fetch wrapped in circuit breaker via core-api (TD-05)
    console.log(`[Gmail] Fetching ${validMessages.length} messages with concurrency=5...`);
    const fetchResults = await batchWithConcurrency(
      validMessages,
      async (message: GmailMessageListItem) => {
        const msgResponse = await gmailCircuit.execute(() =>
          coreApiGoogle.gmail.getMessage(message.id!)
        );
        return { id: message.id!, data: msgResponse as GmailMessageFull };
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

      const { id: messageId, data: msgData } = result.value as { id: string; data: GmailMessageFull };
      const headers = msgData.payload?.headers ?? [];
      const subjectHeader = headers.find((h: GmailHeader) => h.name?.toLowerCase() === 'subject');
      const fromHeader = headers.find((h: GmailHeader) => h.name?.toLowerCase() === 'from');
      const toHeader = headers.find((h: GmailHeader) => h.name?.toLowerCase() === 'to');
      const dateHeader = headers.find((h: GmailHeader) => h.name?.toLowerCase() === 'date');

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
