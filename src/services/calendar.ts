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
      sendUpdates: 'all', // Send email invites to attendees
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
