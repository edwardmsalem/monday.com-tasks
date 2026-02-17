/**
 * Google Calendar Integration
 *
 * Creates calendar events for tasks with due dates.
 * Invites the assignee so it shows on their calendar.
 *
 * Setup options:
 * 1. Service Account (recommended for automation):
 *    - Create service account in Google Cloud Console
 *    - Enable domain-wide delegation
 *    - Share calendar with service account email
 *
 * 2. OAuth (for personal use):
 *    - Set up OAuth consent screen
 *    - Get refresh token via OAuth flow
 */

import { google, calendar_v3 } from 'googleapis';
import { config } from '../config/environment.js';
import * as monday from './monday.js';

let calendarClient: calendar_v3.Calendar | null = null;

/**
 * Initialize the Google Calendar client
 */
function getClient(): calendar_v3.Calendar | null {
  if (!config.google.enabled) {
    return null;
  }

  if (!calendarClient) {
    // Use service account credentials
    if (config.google.serviceAccountKey) {
      const credentials = JSON.parse(config.google.serviceAccountKey);

      const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/calendar'],
      });

      calendarClient = google.calendar({ version: 'v3', auth });
    }
    // Or use OAuth refresh token
    else if (config.google.clientId && config.google.clientSecret && config.google.refreshToken) {
      const oauth2Client = new google.auth.OAuth2(
        config.google.clientId,
        config.google.clientSecret
      );

      oauth2Client.setCredentials({
        refresh_token: config.google.refreshToken,
      });

      calendarClient = google.calendar({ version: 'v3', auth: oauth2Client });
    }
  }

  return calendarClient;
}

export interface CalendarEventInput {
  title: string;
  description: string;
  dueDate: string; // YYYY-MM-DD format
  assigneeEmail: string;
  mondayItemId: string;
}

export interface CalendarEventResult {
  eventId: string;
  htmlLink: string;
}

/**
 * Create a calendar event for a task
 */
export async function createTaskEvent(input: CalendarEventInput): Promise<CalendarEventResult | null> {
  const client = getClient();

  if (!client) {
    console.log('Google Calendar not configured, skipping event creation');
    return null;
  }

  const mondayUrl = monday.getItemUrl(input.mondayItemId);

  // Create all-day event on the due date
  const event: calendar_v3.Schema$Event = {
    summary: input.title,
    description: `${input.description}\n\n---\nMonday.com: ${mondayUrl}`,
    start: {
      date: input.dueDate, // All-day event
      timeZone: config.google.timeZone,
    },
    end: {
      date: input.dueDate,
      timeZone: config.google.timeZone,
    },
    attendees: [
      { email: input.assigneeEmail },
    ],
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 60 * 24 }, // 1 day before
        { method: 'popup', minutes: 60 * 2 },  // 2 hours before (9am if all-day)
      ],
    },
    // Add Monday.com link as a source
    source: {
      title: 'Monday.com Task',
      url: mondayUrl,
    },
  };

  try {
    const response = await client.events.insert({
      calendarId: config.google.calendarId,
      requestBody: event,
      sendUpdates: 'none', // Don't send email notifications
    });

    console.log('Calendar event created:', response.data.id);

    return {
      eventId: response.data.id!,
      htmlLink: response.data.htmlLink!,
    };
  } catch (error) {
    console.error('Failed to create calendar event:', error);
    return null;
  }
}

/**
 * Update an existing calendar event
 */
export async function updateTaskEvent(
  eventId: string,
  updates: Partial<CalendarEventInput>
): Promise<boolean> {
  const client = getClient();

  if (!client) {
    return false;
  }

  const patch: calendar_v3.Schema$Event = {};

  if (updates.title) {
    patch.summary = updates.title;
  }

  if (updates.dueDate) {
    patch.start = { date: updates.dueDate, timeZone: config.google.timeZone };
    patch.end = { date: updates.dueDate, timeZone: config.google.timeZone };
  }

  if (updates.description) {
    const mondayUrl = updates.mondayItemId
      ? monday.getItemUrl(updates.mondayItemId)
      : '';
    patch.description = `${updates.description}\n\n---\nMonday.com: ${mondayUrl}`;
  }

  try {
    await client.events.patch({
      calendarId: config.google.calendarId,
      eventId,
      requestBody: patch,
    });

    console.log('Calendar event updated:', eventId);
    return true;
  } catch (error) {
    console.error('Failed to update calendar event:', error);
    return false;
  }
}

/**
 * Delete a calendar event
 */
export async function deleteTaskEvent(eventId: string): Promise<boolean> {
  const client = getClient();

  if (!client) {
    return false;
  }

  try {
    await client.events.delete({
      calendarId: config.google.calendarId,
      eventId,
    });

    console.log('Calendar event deleted:', eventId);
    return true;
  } catch (error) {
    console.error('Failed to delete calendar event:', error);
    return false;
  }
}

/**
 * Check if Google Calendar is configured and available
 */
export function isCalendarEnabled(): boolean {
  return config.google.enabled && getClient() !== null;
}

// ============================================================================
// /scan Appointment Events
// ============================================================================

// Default invitees for scan appointment events
const SCAN_APPOINTMENT_INVITEES = [
  'edward@salemseats.com',
  'michael@salemseats.com',
  'operations@salemseats.com',
];

export interface ScanAppointmentResult {
  eventId: string;
  htmlLink: string;
  timeSlot: string;
  emailCount: number;
}

/**
 * Clean up team name - removes common prefixes if still present
 * Now expects the team name to be passed directly (e.g., "Buccaneers")
 */
function extractTeamFromTitle(title: string): string {
  // Remove any remaining email prefixes just in case
  return title
    .replace(/^(fwd:|fw:|re:)\s*/gi, '')
    .trim() || 'Team';
}

/**
 * Add minutes to an ISO datetime string, keeping it as local time (no Z suffix)
 * This ensures Google Calendar interprets the time in the specified timezone
 */
function addMinutesToIsoString(isoString: string, minutes: number): string {
  // Parse the ISO string and add minutes
  const date = new Date(isoString);
  date.setMinutes(date.getMinutes() + minutes);

  // Format back as local ISO string (no Z suffix)
  // This is important: Google Calendar will interpret this as local time in the specified timeZone
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Ensure an ISO datetime string has seconds for Google Calendar API
 * Input: "2026-01-15T14:00" or "2026-01-15T14:00:00"
 * Output: "2026-01-15T14:00:00" (always with seconds, never with Z suffix)
 */
function normalizeIsoString(isoString: string): string {
  // Remove any Z or timezone offset suffix
  const withoutZ = isoString.replace(/Z$/, '').replace(/[+-]\d{2}:\d{2}$/, '');

  // Add seconds if missing
  if (withoutZ.length === 16) {
    return withoutZ + ':00';
  }
  return withoutZ;
}

/**
 * Create calendar events for /scan appointments, grouped by time slot
 * - One event per unique time slot
 * - Lists all emails for that time slot in description
 * - Title: "{Team} Relocation"
 * - Invites the team (edward, michael, operations)
 * - 1 hour reminder, 30 minute duration
 */
export async function createScanAppointmentEvents(
  taskTitle: string,
  recipients: Array<{ email: string; rawDateTime: string | null }>,
  mondayItemId: string,
  sheetUrl?: string
): Promise<ScanAppointmentResult[]> {
  const client = getClient();

  if (!client) {
    console.log('[Calendar] Google Calendar not configured, skipping scan appointment events');
    return [];
  }

  // Filter to only recipients with valid datetime
  const recipientsWithTime = recipients.filter(r => r.rawDateTime);

  if (recipientsWithTime.length === 0) {
    console.log('[Calendar] No recipients with appointment times, skipping calendar events');
    return [];
  }

  // Sort by time ascending
  recipientsWithTime.sort((a, b) => {
    const timeA = new Date(a.rawDateTime!).getTime();
    const timeB = new Date(b.rawDateTime!).getTime();
    return timeA - timeB;
  });

  // Group recipients by time slot, merging times within 15 minutes of each other
  const MERGE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
  // Store both the Date (for sorting/merging) and the original ISO string (for timezone-correct API calls)
  const timeSlotGroups: Array<{ startTime: Date; rawDateTime: string; emails: string[] }> = [];

  for (const recipient of recipientsWithTime) {
    const recipientTime = new Date(recipient.rawDateTime!);

    // Check if this recipient fits into an existing group (within 15 min of group start)
    let addedToGroup = false;
    for (const group of timeSlotGroups) {
      const timeDiff = recipientTime.getTime() - group.startTime.getTime();
      if (timeDiff >= 0 && timeDiff <= MERGE_WINDOW_MS) {
        group.emails.push(recipient.email);
        addedToGroup = true;
        break;
      }
    }

    // If not added to existing group, create a new group
    if (!addedToGroup) {
      timeSlotGroups.push({
        startTime: recipientTime,
        rawDateTime: recipient.rawDateTime!,
        emails: [recipient.email],
      });
    }
  }

  console.log(`[Calendar] Creating ${timeSlotGroups.length} calendar events for ${recipientsWithTime.length} appointments (merged within 15min windows)...`);

  const results: ScanAppointmentResult[] = [];
  const mondayUrl = monday.getItemUrl(mondayItemId);
  const teamName = extractTeamFromTitle(taskTitle);
  const currentYear = new Date().getFullYear();

  for (const group of timeSlotGroups) {
    const { rawDateTime, emails } = group;

    // Normalize the rawDateTime to ensure proper format (with seconds, no Z suffix)
    // This ensures Google Calendar interprets the time in the specified timeZone
    const startTimeStr = normalizeIsoString(rawDateTime);
    const endTimeStr = addMinutesToIsoString(rawDateTime, 30);

    // Build description with sheet link and Monday link (accounts are in the sheet)
    const descriptionParts: string[] = [];
    if (sheetUrl) {
      descriptionParts.push(`Tracking Sheet: ${sheetUrl}`);
      descriptionParts.push('');
    }
    descriptionParts.push(
      `${emails.length} accounts scheduled for this time slot`,
      '',
      '---',
      `Monday.com: ${mondayUrl}`
    );

    const event: calendar_v3.Schema$Event = {
      summary: `${teamName} Relocation ${currentYear}`,
      description: descriptionParts.join('\n'),
      start: {
        dateTime: startTimeStr,
        timeZone: config.google.timeZone,
      },
      end: {
        dateTime: endTimeStr,
        timeZone: config.google.timeZone,
      },
      attendees: SCAN_APPOINTMENT_INVITEES.map(email => ({ email })),
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'popup', minutes: 60 }, // 1 hour before
        ],
      },
      source: {
        title: 'Monday.com Task',
        url: mondayUrl,
      },
    };

    try {
      const response = await client.events.insert({
        calendarId: config.google.calendarId,
        requestBody: event,
        sendUpdates: 'none', // Don't send email notifications
      });

      console.log(`[Calendar] Created event for ${emails.length} accounts at ${startTimeStr}:`, response.data.id);

      results.push({
        eventId: response.data.id!,
        htmlLink: response.data.htmlLink!,
        timeSlot: startTimeStr,
        emailCount: emails.length,
      });
    } catch (error) {
      console.error(`[Calendar] Failed to create event for time slot ${startTimeStr}:`, error);
    }
  }

  console.log(`[Calendar] Created ${results.length}/${timeSlotGroups.length} calendar events`);
  return results;
}
