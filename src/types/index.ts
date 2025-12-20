export interface TaskTypeMapping {
  aliases: string[];
  displayName: string;
}

export interface ParsedEmail {
  subject: string;
  text: string;
  fromEmail: string | null;
  toEmail: string | null;
  attachments: EmailAttachment[];
}

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface TaskDetails {
  owner: string;
  dueDate: string;
  taskType: string;
  notes: string;
}

export interface EmlHeaders {
  subject: string | null;
  from: string | null;
  to: string | null;
  bcc: string[] | null;  // BCC recipients (from headers if available)
  body: string | null;   // The actual email content
}

export interface ConvertedFile {
  filename: string;
  data: Buffer;
  /** Durable URL from ConvertAPI - can be used for retry without reconversion */
  url?: string;
}

export interface MondayItem {
  id: string;
  name: string;
}

export interface MondayUser {
  id: number;
  name: string;
  email: string;
}

export interface SlackMessage {
  ts: string;
  channel: string;
}

export interface WorkflowInput {
  triggerEmail: ParsedEmail;
  emlAttachment: EmailAttachment;
}

export interface WorkflowResult {
  mondayItemId: string;
  slackThreadTs: string;
  success: boolean;
  error?: string;
  /** Unique identifier for this workflow run - for debugging and tracing */
  runId: string;
  /** Attachment upload status - workflow can succeed even if attachments fail */
  attachmentStatus?: {
    slackUploaded: boolean;
    mondayUploaded: boolean;
    mondayRetryScheduled?: boolean;
    pdfUrl?: string;
    state: AttachmentState;
  };
}

export type Priority = 'high' | 'medium' | 'low';

export type AttachmentState = 'Queued' | 'Uploaded' | 'Retrying' | 'Failed' | 'Skipped';

/**
 * Task debug info for /taskdebug command
 * Note: Errors are in Updates/Slack, not columns (keeping board lean)
 */
export interface TaskDebugInfo {
  mondayItemId: string;
  mondayUrl: string;
  slackThreadTs: string | null;
  slackThreadUrl: string | null;
  taskType: string | null;
  workflowStatus: string | null;
  urgency: string | null;
  pdfUrl: string | null;
  attachmentState: string | null;
  runId: string | null;
  dueDate: string | null;
  owner: string | null;
}
