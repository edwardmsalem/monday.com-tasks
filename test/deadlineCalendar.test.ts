// Run with: npx tsx --test test/deadlineCalendar.test.ts
// Google is never called: createEvent is injected.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateDeadline, buildDeadlineEvent, createDeadlineCalendar, nextDay, DEDUPE_TTL_MS, TRIAGE_OPEN_BASE,
} from '../src/services/deadlineCalendar.js';
import { SCAN_APPOINTMENT_INVITEES } from '../src/services/calendar.js';

function harness(fail = false) {
  let clock = 5_000_000;
  const made: Array<Parameters<Parameters<typeof createDeadlineCalendar>[0]['createEvent']>[0]> = [];
  const cal = createDeadlineCalendar({
    createEvent: async (p) => {
      made.push(p);
      if (fail) throw new Error('core-api 502');
      return { eventId: `evt${made.length}`, htmlLink: `https://calendar.google.com/e/${made.length}` };
    },
    now: () => clock,
  });
  return { cal, made, tick: (ms: number) => { clock += ms; } };
}

test('validation: title required, dueDate must be a real YYYY-MM-DD date', () => {
  assert.deepEqual(validateDeadline({ dueDate: '2026-12-01' }), { ok: false, error: 'title is required' });
  assert.equal(validateDeadline({ title: '   ', dueDate: '2026-12-01' }).ok, false);
  assert.equal(validateDeadline(undefined).ok, false);
  for (const dueDate of [undefined, '', '12/01/2026', '2026-02-30', '2026-13-01', '2026-12-1', 20261201]) {
    const r = validateDeadline({ title: 'Renewal due', dueDate });
    assert.equal(r.ok, false, `dueDate ${dueDate}`);
  }
  assert.equal(validateDeadline({ title: 'x', dueDate: '2028-02-29' }).ok, true);
  assert.equal(validateDeadline({ title: 'x', dueDate: '2026-12-01', description: 5 }).ok, false);
});

test('validation trims the title to 200 characters and drops a malformed messageId', () => {
  const r = validateDeadline({ title: `  ${'a'.repeat(300)}  `, dueDate: '2026-12-01', messageId: 'bad id!' });
  assert.ok(r.ok);
  assert.equal(r.value.title.length, 200);
  assert.equal(r.value.messageId, undefined);
  const ok = validateDeadline({ title: 'x', dueDate: '2026-12-01', messageId: '19a2b3c4d5e6f7' });
  assert.ok(ok.ok);
  assert.equal(ok.value.messageId, '19a2b3c4d5e6f7');
});

test('nextDay rolls months and years', () => {
  assert.equal(nextDay('2026-12-31'), '2027-01-01');
  assert.equal(nextDay('2027-02-28'), '2027-03-01');
  assert.equal(nextDay('2027-02-29'), null);
});

test('the event is all-day on the due date, invites the scan list, no invite emails, 9 AM popups', () => {
  const p = buildDeadlineEvent({ title: 'Renewal due', dueDate: '2026-12-01', description: 'Pay by Dec 1', messageId: '19a2b3c4d5e6f7' });
  assert.deepEqual(p.start, { date: '2026-12-01', timeZone: 'America/New_York' });
  assert.deepEqual(p.end, { date: '2026-12-02', timeZone: 'America/New_York' });
  assert.deepEqual(p.attendees, SCAN_APPOINTMENT_INVITEES.map(email => ({ email })));
  assert.equal(p.sendUpdates, 'none');
  assert.deepEqual(p.reminders, { useDefault: false, overrides: [{ method: 'popup', minutes: 900 }, { method: 'popup', minutes: 3780 }] });
  assert.equal(p.summary, 'Renewal due');
  assert.equal(p.description, `Pay by Dec 1\n\nOpen in Triage: ${TRIAGE_OPEN_BASE}19a2b3c4d5e6f7`);
  assert.equal(buildDeadlineEvent({ title: 't', dueDate: '2026-12-01' }).description, '');
});

test('a repeat for the same message and date within 24 hours creates nothing and says duplicate', async () => {
  const h = harness();
  const input = { title: 'Renewal due', dueDate: '2026-12-01', messageId: '19a2b3c4d5e6f7' };
  const first = await h.cal.create(input);
  assert.deepEqual(first, { success: true, eventId: 'evt1', htmlLink: 'https://calendar.google.com/e/1' });
  const again = await h.cal.create(input);
  assert.deepEqual(again, { ...first, duplicate: true });
  assert.equal(h.made.length, 1);
  await h.cal.create({ ...input, dueDate: '2026-12-02' });
  assert.equal(h.made.length, 2);
  h.tick(DEDUPE_TTL_MS + 1);
  const later = await h.cal.create(input);
  assert.equal(later.duplicate, undefined);
  assert.equal(h.made.length, 3);
});

test('a double tap while the first create is still running makes one event', async () => {
  const h = harness();
  const input = { title: 'Renewal due', dueDate: '2026-12-01', messageId: '19a2b3c4d5e6f7' };
  const [a, b] = await Promise.all([h.cal.create(input), h.cal.create(input)]);
  assert.equal(h.made.length, 1);
  assert.equal(a.eventId, b.eventId);
  assert.equal([a.duplicate, b.duplicate].filter(Boolean).length, 1);
});

test('without a messageId every request creates its own event', async () => {
  const h = harness();
  await h.cal.create({ title: 'a', dueDate: '2026-12-01' });
  await h.cal.create({ title: 'a', dueDate: '2026-12-01' });
  assert.equal(h.made.length, 2);
});

test('a failed create is not remembered, so a retry creates', async () => {
  const h = harness(true);
  const input = { title: 'a', dueDate: '2026-12-01', messageId: '19a2b3c4d5e6f7' };
  await assert.rejects(h.cal.create(input), /core-api 502/);
  assert.equal(h.cal.size(), 0);
});
