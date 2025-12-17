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
}

export interface ConvertedFile {
  filename: string;
  data: Buffer;
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
}
