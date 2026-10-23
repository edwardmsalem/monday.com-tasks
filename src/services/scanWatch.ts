/**
 * Scan watcher.
 *
 * What it does: after a Triage scan with "Keep watching" on, every 10 minutes it
 * checks Gmail for NEW emails with the same subject, reads only those, and adds
 * their recipients (appointment time, code) to the same scan sheet, plus
 * calendar events when the original scan made them.
 * Data it reads: Gmail ids for a subject search (one list call per watch per
 * run, nothing downloaded), then the new messages only; the team account sheet
 * for account details of new recipients.
 * When it fires: every 10 minutes while a watch is active (default 7 days).
 * Who asked: Eddie, 2026-10-22 ("monitor for more incoming emails of the same
 * subject and to have the sheet updated as it comes in").
 * State: /data/scan-watches.json on the Railway volume.
 */
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { google as coreApiGoogle } from './coreApi.js';
import { normalizeSubject, findRelatedRecipients, enrichRecipientsWithAppointments } from './gmail.js';
import { batchLookupAccountsForScan, type Sport } from './sheets.js';
import { addRecipientsToScanSheet } from './scanSheetUpdate.js';
import { applyChecklist, type ScanChecklist } from './scanChecklist.js';
import * as calendar from './calendar.js';

const DATA_DIR = process.env['RAILWAY_VOLUME_MOUNT_PATH'] || (process.env['RAILWAY_ENVIRONMENT'] ? '/data' : process.cwd());
const STATE_FILE = path.join(DATA_DIR, 'scan-watches.json');
const INTERVAL_MS = 10 * 60 * 1000;
const MAX_DAYS = 30;
/** Hard cap on active watches so a runaway client can't pile up Gmail work. */
const MAX_ACTIVE = 50;

export interface ScanWatch {
  id: string;
  subjects: string[];
  teamName?: string;
  sport?: Sport;
  sheetIdOverride?: string;
  spreadsheetId: string;
  spreadsheetUrl: string;
  sheetGid: number;
  instructions?: string;
  extractCodesAndLinks: boolean;
  wantsCodes: boolean;
  /** What the scan was ticked to pull; absent for watches from older app builds. */
  checklist?: ScanChecklist;
  makeCalendar: boolean;
  eventName?: string;
  /** Gmail ids already scanned (original scan + earlier runs). */
  seenMessageIds: string[];
  /** email -> appointment time already on the sheet. */
  seenRecipients: Record<string, string | null>;
  createdAt: string;
  expiresAt: string;
  lastRunAt?: string;
  added: number;
}

function load(): ScanWatch[] {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as ScanWatch[]; } catch { return []; }
}

function save(watches: ScanWatch[]): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(watches, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

function subjectQuery(subject: string): string {
  // Gmail search ignores quotes inside, so drop them from the phrase.
  return `subject:"${normalizeSubject(subject).replace(/"/g, '')}" newer_than:3d`;
}

export function listWatches(): ScanWatch[] {
  const now = Date.now();
  return load().filter(w => new Date(w.expiresAt).getTime() > now);
}

export function stopWatch(id: string): boolean {
  const all = load();
  const next = all.filter(w => w.id !== id);
  if (next.length === all.length) return false;
  save(next);
  return true;
}

/** Called by POST /tasks/scan after the sheet is made. */
export async function createWatch(input: Omit<ScanWatch, 'id' | 'seenMessageIds' | 'createdAt' | 'expiresAt' | 'added'> & {
  days?: number;
  scannedMessageIds: string[];
}): Promise<ScanWatch> {
  if (listWatches().length >= MAX_ACTIVE) throw new Error(`already ${MAX_ACTIVE} active scan watches`);
  const requested = Number(input.days);
  const days = Number.isFinite(requested) ? Math.min(MAX_DAYS, Math.max(1, Math.round(requested))) : 7;
  // Everything the subject search already finds counts as seen, so the first
  // run only picks up mail that arrives after the scan.
  const seen = new Set(input.scannedMessageIds);
  for (const subject of input.subjects) {
    try {
      const ids = await coreApiGoogle.gmail.listMessageIds({ q: subjectQuery(subject), maxResults: 200 });
      for (const m of ids) seen.add(m.id);
    } catch (e) {
      console.warn('[ScanWatch] baseline search failed (first run may re-read a few emails):', e);
    }
  }
  const { days: _d, scannedMessageIds: _s, ...rest } = input;
  const watch: ScanWatch = {
    ...rest,
    id: randomUUID(),
    seenMessageIds: [...seen],
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + days * 86_400_000).toISOString(),
    added: 0,
  };
  save([...load(), watch]);
  console.log(`[ScanWatch] watching "${input.subjects[0]}" for ${days} days → ${input.spreadsheetUrl}`);
  return watch;
}

async function runWatch(w: ScanWatch): Promise<ScanWatch> {
  const seen = new Set(w.seenMessageIds);
  const fresh: Array<{ subject: string; ids: string[] }> = [];
  for (const subject of w.subjects) {
    const ids = (await coreApiGoogle.gmail.listMessageIds({ q: subjectQuery(subject), maxResults: 200 }))
      .map(m => m.id).filter(id => id && !seen.has(id));
    if (ids.length) fresh.push({ subject, ids });
  }
  w.lastRunAt = new Date().toISOString();
  if (fresh.length === 0) return w;

  const found = new Map<string, Awaited<ReturnType<typeof enrichRecipientsWithAppointments>>[number]>();
  for (const { subject, ids } of fresh) {
    const scanned = await findRelatedRecipients(subject, {
      extractCodesAndLinks: w.extractCodesAndLinks,
      instructions: w.instructions,
      onlyMessageIds: ids,
    });
    const enriched = await enrichRecipientsWithAppointments(subject, scanned, w.instructions, ids);
    if (w.checklist) applyChecklist(enriched, w.checklist);
    for (const r of enriched) found.set(r.email.toLowerCase(), r);
    ids.forEach(id => seen.add(id));
  }

  // Only recipients that are new, or whose appointment time changed.
  const toAdd = [...found.values()].filter(r => {
    const prev = w.seenRecipients[r.email.toLowerCase()];
    return prev === undefined || (r.rawDateTime && r.rawDateTime !== prev);
  });

  if (toAdd.length > 0) {
    let accountInfo: Awaited<ReturnType<typeof batchLookupAccountsForScan>>['matched'] | undefined;
    try {
      const lookup = await batchLookupAccountsForScan(w.teamName || w.subjects[0], toAdd.map(r => r.email), w.sheetIdOverride, w.sport);
      accountInfo = lookup.matched;
    } catch (e) {
      console.warn('[ScanWatch] account lookup failed (rows added without account details):', e);
    }
    const n = await addRecipientsToScanSheet(w.spreadsheetId, w.sheetGid, toAdd, accountInfo);
    w.added += n;

    const timed = toAdd.filter(r => r.rawDateTime);
    if (w.makeCalendar && calendar.isCalendarEnabled() && timed.length > 0) {
      try {
        if (w.eventName) {
          await calendar.createScanAppointmentEventsWithName(w.eventName, timed.map(r => ({ email: r.email, rawDateTime: r.rawDateTime! })), w.spreadsheetUrl);
        } else {
          await calendar.createScanAppointmentEvents(w.teamName || w.subjects[0], w.subjects[0], timed, '', w.spreadsheetUrl);
        }
      } catch (e) {
        console.warn('[ScanWatch] calendar events failed:', e);
      }
    }
    for (const r of toAdd) w.seenRecipients[r.email.toLowerCase()] = r.rawDateTime ?? null;
    console.log(`[ScanWatch] "${w.subjects[0]}": ${fresh.reduce((a, f) => a + f.ids.length, 0)} new email(s), ${n} recipient(s) added → ${w.spreadsheetUrl}`);
  }
  w.seenMessageIds = [...seen];
  return w;
}

let running = false;

export async function runScanWatches(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const now = Date.now();
    const all = load();
    const active = all.filter(w => new Date(w.expiresAt).getTime() > now);
    if (active.length !== all.length) console.log(`[ScanWatch] ${all.length - active.length} watch(es) expired`);
    const updated: ScanWatch[] = [];
    for (const w of active) {
      try {
        updated.push(await runWatch(w));
      } catch (e) {
        console.error(`[ScanWatch] run failed for "${w.subjects[0]}":`, e);
        updated.push(w);
      }
    }
    // Merge with anything created or stopped while this run was going.
    const latest = new Map(load().map(w => [w.id, w]));
    save([...latest.values()].filter(w => new Date(w.expiresAt).getTime() > now).map(w => updated.find(u => u.id === w.id) ?? w));
  } finally {
    running = false;
  }
}

export function startScanWatcher(): void {
  console.log(`[ScanWatch] watcher on: every ${INTERVAL_MS / 60000} min, state ${STATE_FILE}`);
  setTimeout(() => { void runScanWatches(); }, 60_000);
  setInterval(() => { void runScanWatches(); }, INTERVAL_MS);
}
