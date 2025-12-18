/**
 * Gmail API Service
 *
 * Searches the forwarding inbox for related emails by subject
 * Used for the /scan feature to find all recipients with their appointment times
 */

import { google } from 'googleapis';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config/environment.js';

let gmailClient: ReturnType<typeof google.gmail> | null = null;
let anthropicClient: Anthropic | null = null;

/**
 * Initialize Gmail API client with service account
 */
async function getGmailClient() {
  if (gmailClient) return gmailClient;

  const serviceAccountKey = config.google.serviceAccountKey;
  if (!serviceAccountKey) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY not configured');
  }

  const credentials = JSON.parse(serviceAccountKey);

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    // Impersonate the forwarding inbox
    clientOptions: {
      subject: config.google.forwardingEmail,
    },
  });

  const authClient = await auth.getClient();
  gmailClient = google.gmail({ version: 'v1', auth: authClient as any });

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

/**
 * Check if text contains appointment-related keywords
 */
function hasAppointmentKeywords(text: string): boolean {
  const lowerText = text.toLowerCase();
  return APPOINTMENT_KEYWORDS.some(keyword => lowerText.includes(keyword));
}

/**
 * Recipient with their appointment information
 */
export interface RecipientWithAppointment {
  email: string;
  appointmentDate: string | null;  // e.g., "Tue Dec 20, 2:00 PM"
  rawDateTime: string | null;      // ISO format for sorting
}

/**
 * Search for emails with the same subject within the last 48 hours
 * Returns recipients with their appointment times extracted from email bodies
 */
export async function findRelatedRecipients(subject: string): Promise<RecipientWithAppointment[]> {
  const gmail = await getGmailClient();

  const normalizedSubject = normalizeSubject(subject);

  // Check if subject contains appointment-related keywords
  const shouldExtractAppointments = hasAppointmentKeywords(normalizedSubject);
  console.log(`Subject "${normalizedSubject}" - extract appointments: ${shouldExtractAppointments}`);

  // Build search query - last 48 hours
  const twoDaysAgo = new Date();
  twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
  const afterDate = twoDaysAgo.toISOString().split('T')[0].replace(/-/g, '/');

  const query = `subject:"${normalizedSubject}" after:${afterDate}`;
  console.log(`Gmail search query: ${query}`);

  try {
    // Search for messages
    const searchResponse = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 50,
    });

    const messages = searchResponse.data.messages ?? [];
    console.log(`Found ${messages.length} related emails`);

    if (messages.length === 0) {
      return [];
    }

    // Map to track unique recipients (by email) with their appointment info
    const recipientMap = new Map<string, RecipientWithAppointment>();

    for (const message of messages) {
      if (!message.id) continue;

      // Get full message with body
      const msgResponse = await gmail.users.messages.get({
        userId: 'me',
        id: message.id,
        format: 'full',
      });

      const headers = msgResponse.data.payload?.headers ?? [];
      const toHeader = headers.find(h => h.name === 'To');

      if (!toHeader?.value) continue;

      // Get recipient email(s)
      const recipientEmails = extractEmailAddresses(toHeader.value);

      // Only extract appointment times if keywords detected in subject
      let appointmentInfo = { appointmentDate: null as string | null, rawDateTime: null as string | null };

      if (shouldExtractAppointments) {
        // Get email body text
        const bodyText = extractEmailBody(msgResponse.data.payload);
        // Extract appointment time using Claude
        appointmentInfo = await extractAppointmentTime(bodyText);
      }

      // Add each recipient with their appointment info
      for (const email of recipientEmails) {
        const normalizedEmail = email.toLowerCase();

        // Skip the forwarding inbox itself
        if (normalizedEmail === config.google.forwardingEmail?.toLowerCase()) continue;

        // Only add if we don't have this recipient yet, or if this one has appointment info
        if (!recipientMap.has(normalizedEmail) || appointmentInfo.appointmentDate) {
          recipientMap.set(normalizedEmail, {
            email: normalizedEmail,
            appointmentDate: appointmentInfo.appointmentDate,
            rawDateTime: appointmentInfo.rawDateTime,
          });
        }
      }
    }

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
  rawDateTime: string | null;
}> {
  if (!emailBody || emailBody.length < 20) {
    return { appointmentDate: null, rawDateTime: null };
  }

  try {
    const client = getAnthropicClient();

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 256,
      system: `Extract appointment/event date and time from emails. Look for:
- Presale appointments
- Relocation meetings
- Selection appointments
- Scheduled times for ticket-related events

Return ONLY a JSON object with:
- appointmentDate: Human readable format like "Tue Dec 20, 2:00 PM" or null if not found
- rawDateTime: ISO 8601 format like "2025-12-20T14:00:00" or null if not found

If no appointment time is mentioned, return null for both fields.`,
      messages: [
        {
          role: 'user',
          content: `Extract the appointment date/time from this email:\n\n${emailBody.slice(0, 2000)}`,
        },
      ],
    });

    const textContent = response.content.find(c => c.type === 'text');
    if (!textContent || textContent.type !== 'text') {
      return { appointmentDate: null, rawDateTime: null };
    }

    // Parse JSON from response
    const jsonMatch = textContent.text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        appointmentDate: parsed.appointmentDate || null,
        rawDateTime: parsed.rawDateTime || null,
      };
    }

    return { appointmentDate: null, rawDateTime: null };
  } catch (error) {
    console.error('Error extracting appointment time:', error);
    return { appointmentDate: null, rawDateTime: null };
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
 */
export function shouldScanForRecipients(emailBody: string): boolean {
  return /\/scan\b/i.test(emailBody);
}

/**
 * Format recipient with appointment for subtask name
 */
export function formatRecipientSubtaskName(recipient: RecipientWithAppointment): string {
  if (recipient.appointmentDate) {
    return `${recipient.email} - ${recipient.appointmentDate}`;
  }
  return recipient.email;
}
