import { simpleParser, type ParsedMail } from 'mailparser';
import type {
  ParsedEmail,
  EmailAttachment,
  TaskDetails,
  EmlHeaders,
} from '../types/index.js';

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
    fromEmail: extractEmail(parsed.from?.text ?? ''),
    toEmail: extractEmail(parsed.to?.text ?? ''),
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

  return {
    subject: parsed.subject ?? null,
    from: extractEmail(parsed.from?.text ?? ''),
    to: extractEmail(parsed.to?.text ?? ''),
    body: parsed.text ?? null,  // Extract the email body text
  };
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
