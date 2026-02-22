/**
 * Google Calendar Integration (via core-api)
 *
 * Creates calendar events for tasks with due dates.
 * Invites the assignee so it shows on their calendar.
 *
 * All Google API calls go through core-api (centralized credentials).
 * Business logic (time slot grouping, invitees, etc.) stays here.
 */

import { google as coreApiGoogle } from './coreApi.js';
import * as monday from './monday.js';

// Default timezone for calendar events
const CALENDAR_TIMEZONE = 'America/New_York';

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
 * Create a calendar event for a task (all-day event on due date)
 */
export async function createTaskEvent(input: CalendarEventInput): Promise<CalendarEventResult | null> {
  const mondayUrl = monday.getItemUrl(input.mondayItemId);

  try {
    const result = await coreApiGoogle.calendar.createEvent({
      summary: input.title,
      description: `${input.description}\n\n---\nMonday.com: ${mondayUrl}`,
      start: {
        date: input.dueDate,
        timeZone: CALENDAR_TIMEZONE,
      },
      end: {
        date: input.dueDate,
        timeZone: CALENDAR_TIMEZONE,
      },
      attendees: [
        { email: input.assigneeEmail },
      ],
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'popup', minutes: 60 * 24 }, // 1 day before
          { method: 'popup', minutes: 60 * 2 },  // 2 hours before
        ],
      },
      source: {
        title: 'Monday.com Task',
        url: mondayUrl,
      },
      sendUpdates: 'none',
    });

    console.log('Calendar event created:', result.eventId);

    return {
      eventId: result.eventId,
      htmlLink: result.htmlLink,
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
  const patch: Record<string, unknown> = {};

  if (updates.title) {
    patch.summary = updates.title;
  }

  if (updates.dueDate) {
    patch.start = { date: updates.dueDate, timeZone: CALENDAR_TIMEZONE };
    patch.end = { date: updates.dueDate, timeZone: CALENDAR_TIMEZONE };
  }

  if (updates.description) {
    const mondayUrl = updates.mondayItemId
      ? monday.getItemUrl(updates.mondayItemId)
      : '';
    patch.description = `${updates.description}\n\n---\nMonday.com: ${mondayUrl}`;
  }

  try {
    await coreApiGoogle.calendar.updateEvent(eventId, patch as any);
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
  try {
    await coreApiGoogle.calendar.deleteEvent(eventId);
    console.log('Calendar event deleted:', eventId);
    return true;
  } catch (error) {
    console.error('Failed to delete calendar event:', error);
    return false;
  }
}

/**
 * Check if Google Calendar is available via core-api
 * Calendar is always enabled when core-api is configured (core-api has the credentials)
 */
export function isCalendarEnabled(): boolean {
  return true; // core-api handles auth — if it's not configured, the API call will fail gracefully
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
 */
function extractTeamFromTitle(title: string): string {
  return title
    .replace(/^(fwd:|fw:|re:)\s*/gi, '')
    .trim() || 'Team';
}

/**
 * Add minutes to an ISO datetime string, keeping it as local time (no Z suffix)
 */
function addMinutesToIsoString(isoString: string, minutes: number): string {
  const date = new Date(isoString);
  date.setMinutes(date.getMinutes() + minutes);

  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Ensure an ISO datetime string has seconds for Google Calendar API
 */
function normalizeIsoString(isoString: string): string {
  const withoutZ = isoString.replace(/Z$/, '').replace(/[+-]\d{2}:\d{2}$/, '');
  if (withoutZ.length === 16) {
    return withoutZ + ':00';
  }
  return withoutZ;
}

/**
 * Create calendar events for /scan appointments, grouped by time slot
 * - One event per unique time slot
 * - Lists all emails for that time slot in description
 * - Title: "{Team} Relocation {Year}"
 * - Invites the team (edward, michael, operations)
 * - 1 hour reminder, 30 minute duration
 */
export async function createScanAppointmentEvents(
  taskTitle: string,
  recipients: Array<{ email: string; rawDateTime: string | null }>,
  mondayItemId: string,
  sheetUrl?: string
): Promise<ScanAppointmentResult[]> {
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
  const MERGE_WINDOW_MS = 15 * 60 * 1000;
  const timeSlotGroups: Array<{ startTime: Date; rawDateTime: string; emails: string[] }> = [];

  for (const recipient of recipientsWithTime) {
    const recipientTime = new Date(recipient.rawDateTime!);

    let addedToGroup = false;
    for (const group of timeSlotGroups) {
      const timeDiff = recipientTime.getTime() - group.startTime.getTime();
      if (timeDiff >= 0 && timeDiff <= MERGE_WINDOW_MS) {
        group.emails.push(recipient.email);
        addedToGroup = true;
        break;
      }
    }

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

    const startTimeStr = normalizeIsoString(rawDateTime);
    const endTimeStr = addMinutesToIsoString(rawDateTime, 30);

    // Build description with sheet link and Monday link
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

    try {
      const result = await coreApiGoogle.calendar.createEvent({
        summary: `${teamName} Relocation ${currentYear}`,
        description: descriptionParts.join('\n'),
        start: {
          dateTime: startTimeStr,
          timeZone: CALENDAR_TIMEZONE,
        },
        end: {
          dateTime: endTimeStr,
          timeZone: CALENDAR_TIMEZONE,
        },
        attendees: SCAN_APPOINTMENT_INVITEES.map(email => ({ email })),
        reminders: {
          useDefault: false,
          overrides: [
            { method: 'popup', minutes: 60 * 24 }, // 1 business day before
            { method: 'popup', minutes: 60 },       // 1 hour before
          ],
        },
        source: {
          title: 'Monday.com Task',
          url: mondayUrl,
        },
        sendUpdates: 'none',
      });

      console.log(`[Calendar] Created event for ${emails.length} accounts at ${startTimeStr}:`, result.eventId);

      results.push({
        eventId: result.eventId,
        htmlLink: result.htmlLink,
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
