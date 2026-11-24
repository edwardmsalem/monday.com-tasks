/**
 * Deadline calendar events for the Salem Triage app (POST /tasks/deadline/calendar).
 *
 * One all-day event on the due date, through core-api's calendar wrapper, inviting the same
 * people as the /scan appointment events, with no invite emails (sendUpdates 'none'). Popups at
 * 9 AM the day before and 9 AM three days before. A repeat for the same message and date within
 * 24 hours returns the first result with duplicate: true and creates nothing. The dedupe memory
 * is per process and empties on redeploy.
 */

import { google as coreApiGoogle } from './coreApi.js';
import { SCAN_APPOINTMENT_INVITEES } from './calendar.js';

export const DEADLINE_TIMEZONE = 'America/New_York';
export const TRIAGE_OPEN_BASE = 'https://core-api-production-6554.up.railway.app/open/triage/';
export const DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_TITLE = 200;
// All-day popups count back from midnight starting the day: 900 min = 9 AM the day before,
// 3780 min (2 days + 900) = 9 AM three days before.
export const REMINDER_MINUTES = [900, 3780];
const MESSAGE_ID = /^[A-Za-z0-9]{6,64}$/;

export interface DeadlineInput {
  title: string;
  dueDate: string;
  description?: string;
  messageId?: string;
}

export interface DeadlineResult {
  success: true;
  eventId: string;
  htmlLink: string;
}

type CreateEvent = typeof coreApiGoogle.calendar.createEvent;
type EventParams = Parameters<CreateEvent>[0];

/** The day after a YYYY-MM-DD date, or null when the string is not a real calendar date. */
export function nextDay(date: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return new Date(t + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function validateDeadline(body: unknown): { ok: true; value: DeadlineInput } | { ok: false; error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const title = typeof b.title === 'string' ? b.title.trim().slice(0, MAX_TITLE).trim() : '';
  if (!title) return { ok: false, error: 'title is required' };
  if (typeof b.dueDate !== 'string' || !nextDay(b.dueDate)) {
    return { ok: false, error: 'dueDate must be a real date as YYYY-MM-DD' };
  }
  if (b.description != null && typeof b.description !== 'string') {
    return { ok: false, error: 'description must be text' };
  }
  const value: DeadlineInput = { title, dueDate: b.dueDate };
  if (typeof b.description === 'string' && b.description.trim()) value.description = b.description.trim();
  if (typeof b.messageId === 'string' && MESSAGE_ID.test(b.messageId)) value.messageId = b.messageId;
  return { ok: true, value };
}

export function buildDeadlineEvent(input: DeadlineInput): EventParams {
  const lines: string[] = [];
  if (input.description) lines.push(input.description);
  if (input.messageId) lines.push(`Open in Triage: ${TRIAGE_OPEN_BASE}${input.messageId}`);
  // Google all-day events end on the next day (the end date is exclusive).
  const end = nextDay(input.dueDate) as string;
  return {
    summary: input.title,
    description: lines.join('\n\n'),
    start: { date: input.dueDate, timeZone: DEADLINE_TIMEZONE },
    end: { date: end, timeZone: DEADLINE_TIMEZONE },
    attendees: SCAN_APPOINTMENT_INVITEES.map(email => ({ email })),
    reminders: {
      useDefault: false,
      overrides: REMINDER_MINUTES.map(minutes => ({ method: 'popup', minutes })),
    },
    sendUpdates: 'none',
  };
}

export function createDeadlineCalendar(deps: { createEvent: (p: EventParams) => Promise<{ eventId: string; htmlLink: string }>; now?: () => number }) {
  const now = deps.now ?? Date.now;
  const seen = new Map<string, { expires: number; result: Promise<DeadlineResult> }>();

  async function create(input: DeadlineInput): Promise<DeadlineResult & { duplicate?: true }> {
    const t = now();
    for (const [k, v] of seen) if (v.expires <= t) seen.delete(k);

    // Only a message id makes two requests the same deadline. Without one, each request creates.
    const key = input.messageId ? `${input.messageId}|${input.dueDate}` : null;
    const prior = key ? seen.get(key) : undefined;
    if (prior) return { ...(await prior.result), duplicate: true };

    const result = deps.createEvent(buildDeadlineEvent(input)).then(r => {
      if (!r?.eventId) throw new Error('Calendar returned no event id');
      return { success: true as const, eventId: r.eventId, htmlLink: r.htmlLink };
    });
    // Held while in flight too, so a double tap creates one event. Failures are forgotten.
    if (key) seen.set(key, { expires: t + DEDUPE_TTL_MS, result });
    try {
      return await result;
    } catch (error) {
      if (key && seen.get(key)?.result === result) seen.delete(key);
      throw error;
    }
  }

  return { create, size: () => seen.size };
}

export const deadlineCalendar = createDeadlineCalendar({
  createEvent: (p) => coreApiGoogle.calendar.createEvent(p),
});
