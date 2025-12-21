import { simpleParser, type ParsedMail, type AddressObject } from 'mailparser';
import type {
  ParsedEmail,
  EmailAttachment,
  TaskDetails,
  EmlHeaders,
} from '../types/index.js';

/**
 * Get text from AddressObject which can be single or array
 */
function getAddressText(address: AddressObject | AddressObject[] | undefined): string {
  if (!address) return '';
  if (Array.isArray(address)) {
    return address.map(a => a.text).join(', ');
  }
  return address.text || '';
}

/**
 * Parse an incoming email (the trigger email with .eml attachment)
 */
export async function parseIncomingEmail(
  rawEmail: Buffer | string
): Promise<ParsedEmail> {
  const parsed = await simpleParser(rawEmail);

  return {
    subject: parsed.subject ?? '',
    text: parsed.text ?? '',
    fromEmail: extractEmail(getAddressText(parsed.from)),
    toEmail: extractEmail(getAddressText(parsed.to)),
    attachments: parseAttachments(parsed),
  };
}

/**
 * Parse the body of the trigger email to extract task details
 * Expected format (each on its own line):
 * Line 1: @owner (e.g., @dayna)
 * Line 2: due date (e.g., +3, 12/25, 12/25/24)
 * Line 3: task type (e.g., pp, refund, general)
 * Line 4+: notes
 */
export function parseTaskDetails(emailText: string): TaskDetails {
  const lines = emailText.split(/\r?\n/).filter(line => line.trim() !== '');

  // Extract owner from line 1 (remove @ symbol)
  const ownerLine = lines[0] ?? '';
  const owner = ownerLine.replace(/@/g, '').trim().toLowerCase();

  // Extract due date from line 2
  const dueDate = (lines[1] ?? '').trim();

  // Extract task type from line 3
  const taskType = (lines[2] ?? '').trim().toLowerCase();

  // Everything from line 4 onwards is notes
  const notes = lines.slice(3).join('\n').trim();

  return {
    owner,
    dueDate,
    taskType,
    notes,
  };
}

/**
 * Parse an .eml file attachment to extract headers and body
 */
export async function parseEmlAttachment(
  emlContent: Buffer | string
): Promise<EmlHeaders> {
  const parsed = await simpleParser(emlContent);

  // Extract BCC from headers if available
  // Check multiple header sources: Bcc, X-Original-To, Delivered-To, Envelope-To
  const bccEmails: string[] = [];

  // Standard Bcc header
  if (parsed.bcc) {
    const bccText = getAddressText(parsed.bcc);
    const emails = extractAllEmails(bccText);
    bccEmails.push(...emails);
  }

  // Check raw headers for additional BCC-like fields
  if (parsed.headers) {
    const bccHeaders = ['x-original-to', 'delivered-to', 'envelope-to'];
    for (const headerName of bccHeaders) {
      const headerValue = parsed.headers.get(headerName);
      if (headerValue && typeof headerValue === 'string') {
        const email = extractEmail(headerValue);
        if (email && !bccEmails.includes(email)) {
          bccEmails.push(email);
        }
      }
    }
  }

  // BCC Fallback: If no BCC found in headers, try parsing from forwarding body
  if (bccEmails.length === 0 && parsed.text) {
    const fallbackBcc = extractBccFromForwardingBody(parsed.text);
    if (fallbackBcc.length > 0) {
      console.log(`BCC fallback: found ${fallbackBcc.length} recipient(s) from forwarding body`);
      bccEmails.push(...fallbackBcc);
    }
  }

  return {
    subject: parsed.subject ?? null,
    from: extractEmail(getAddressText(parsed.from)),
    to: extractEmail(getAddressText(parsed.to)),
    bcc: bccEmails.length > 0 ? bccEmails : null,
    body: parsed.text ?? null,  // Extract the email body text
  };
}

/**
 * Extract all email addresses from a string
 */
function extractAllEmails(text: string): string[] {
  if (!text) return [];
  const emails: string[] = [];
  const regex = /([^\s<>,'"]+@[^\s<>,'"]+)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    emails.push(match[1].trim());
  }
  return emails;
}

/**
 * BCC Fallback: Parse recipients from forwarding body when headers are incomplete
 *
 * Patterns matched:
 * - "Bcc: email@example.com" in forwarded message header block
 * - Recipients listed after "Recipients:" or "To:" in body
 * - Comma or newline separated email lists
 *
 * Only used when BCC headers are empty.
 */
function extractBccFromForwardingBody(body: string | null): string[] {
  if (!body) return [];

  const bccEmails: string[] = [];

  // Pattern 1: Forwarded message header style "Bcc: email@example.com"
  const bccHeaderMatch = body.match(/\bBcc:\s*([^\n]+)/i);
  if (bccHeaderMatch) {
    const emails = extractAllEmails(bccHeaderMatch[1]);
    bccEmails.push(...emails);
  }

  // Pattern 2: "Recipients:" followed by email list
  const recipientsMatch = body.match(/\bRecipients?:\s*([^\n]+(?:\n[^\n]*@[^\n]*)*)/i);
  if (recipientsMatch) {
    const emails = extractAllEmails(recipientsMatch[1]);
    for (const email of emails) {
      if (!bccEmails.includes(email)) {
        bccEmails.push(email);
      }
    }
  }

  // Pattern 3: Look for "Sent to:" or "Distributed to:" patterns
  const sentToMatch = body.match(/\b(?:Sent to|Distributed to|Sending to):\s*([^\n]+(?:\n[^\n]*@[^\n]*)*)/i);
  if (sentToMatch) {
    const emails = extractAllEmails(sentToMatch[1]);
    for (const email of emails) {
      if (!bccEmails.includes(email)) {
        bccEmails.push(email);
      }
    }
  }

  return bccEmails;
}

/**
 * Extract email address from various formats:
 * - "Name <email@example.com>"
 * - "<email@example.com>"
 * - "email@example.com"
 */
function extractEmail(text: string): string | null {
  if (!text) return null;

  // Try to match email in angle brackets first
  const bracketMatch = text.match(/<([^<>]+@[^<>]+)>/);
  if (bracketMatch) {
    return bracketMatch[1].trim();
  }

  // Try to match a plain email address
  const emailMatch = text.match(/([^\s<>,'"]+@[^\s<>,'"]+)/);
  if (emailMatch) {
    return emailMatch[1].trim();
  }

  return null;
}

/**
 * Parse attachments from parsed email
 */
function parseAttachments(parsed: ParsedMail): EmailAttachment[] {
  if (!parsed.attachments || parsed.attachments.length === 0) {
    return [];
  }

  return parsed.attachments.map(att => ({
    filename: att.filename ?? 'attachment',
    content: att.content,
    contentType: att.contentType,
  }));
}

/**
 * Find the .eml attachment from the email
 */
export function findEmlAttachment(
  attachments: EmailAttachment[]
): EmailAttachment | null {
  return (
    attachments.find(
      att =>
        att.filename.endsWith('.eml') ||
        att.contentType === 'message/rfc822'
    ) ?? null
  );
}
