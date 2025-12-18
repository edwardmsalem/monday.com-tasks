/**
 * Gmail API Service
 *
 * Searches the forwarding inbox for related emails by subject
 * Used for the /scan feature to find all recipients of similar emails
 */

import { google } from 'googleapis';
import { config } from '../config/environment.js';

let gmailClient: ReturnType<typeof google.gmail> | null = null;

/**
 * Initialize Gmail API client with service account
 */
async function getClient() {
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

/**
 * Normalize subject by removing FWD:, Fwd:, RE:, Re:, etc.
 */
export function normalizeSubject(subject: string): string {
  return subject
    .replace(/^(fwd?|re|fw):\s*/gi, '') // Remove FWD:, Fwd:, RE:, Re:, FW:, Fw:
    .replace(/^(fwd?|re|fw):\s*/gi, '') // Do it twice for "RE: FWD:" cases
    .trim();
}

/**
 * Search for emails with the same subject within the last 48 hours
 * Returns all unique recipient email addresses
 */
export async function findRelatedRecipients(subject: string): Promise<string[]> {
  const gmail = await getClient();

  const normalizedSubject = normalizeSubject(subject);

  // Build search query
  // Search for emails with this subject in the last 48 hours
  const twoDaysAgo = new Date();
  twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
  const afterDate = twoDaysAgo.toISOString().split('T')[0].replace(/-/g, '/');

  // Gmail search query - subject match and date filter
  const query = `subject:"${normalizedSubject}" after:${afterDate}`;

  console.log(`Gmail search query: ${query}`);

  try {
    // Search for messages
    const searchResponse = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 50, // Limit to prevent too many API calls
    });

    const messages = searchResponse.data.messages ?? [];
    console.log(`Found ${messages.length} related emails`);

    if (messages.length === 0) {
      return [];
    }

    // Get full message details to extract recipients
    const recipients = new Set<string>();

    for (const message of messages) {
      if (!message.id) continue;

      const msgResponse = await gmail.users.messages.get({
        userId: 'me',
        id: message.id,
        format: 'metadata',
        metadataHeaders: ['To', 'Cc', 'Bcc'],
      });

      const headers = msgResponse.data.payload?.headers ?? [];

      for (const header of headers) {
        if (['To', 'Cc', 'Bcc'].includes(header.name ?? '')) {
          // Parse email addresses from header value
          // Format can be: "Name <email@example.com>, other@example.com"
          const emails = extractEmailAddresses(header.value ?? '');
          emails.forEach(email => recipients.add(email.toLowerCase()));
        }
      }
    }

    // Remove the forwarding inbox itself from results
    recipients.delete(config.google.forwardingEmail?.toLowerCase() ?? '');

    console.log(`Found ${recipients.size} unique recipients`);
    return Array.from(recipients);

  } catch (error) {
    console.error('Gmail search error:', error);
    throw error;
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
