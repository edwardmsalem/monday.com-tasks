/**
 * Relocation scanner (Eddie, 2026-10-07).
 *
 * What it checks: forwarding@salemseats.com mail where a team gives an account
 * holder a personal relocation or seat-selection appointment (rules in
 * relocationDetect.ts). It does by itself what Eddie did by hand from the
 * triage app: find every account that got the email, read their appointment
 * times, build the tracking sheet and the calendar events.
 *
 * When it fires: every 15 minutes over the last two days of mail.
 *
 * What it does with a hit, grouped into one campaign per team and kind:
 *   - online (existing or new account): a Slack DM to Eddie with a sample PDF
 *     and Approve / Ignore buttons. Approve builds the sheet and calendar with
 *     the same code as the app's Scan button. Later emails of an approved
 *     campaign go onto the same sheet and calendar on their own. Appointments
 *     already in the past get nothing.
 *   - in person, new account: a DM to send it to the closer. Nothing created.
 *   - in person, existing account: skipped.
 *
 * Who asked: Eddie, "At first ask me first ... sending me a pdf copy of one of
 * the emails", "One sheet per team, keep adding", "Slack DM to me".
 *
 * Enabled by RELOCATION_SCANNER_ENABLED=true.
 */

import * as fs from 'fs';
import * as path from 'path';
import { google as coreApiGoogle, slack as coreApiSlack } from './coreApi.js';
import { CANDIDATE_QUERY, judgeRelocationEmail, campaignKey, type RelocationKind, type RelocationVerdict } from './relocationDetect.js';
import { findRelatedRecipients, enrichRecipientsWithAppointments, type RecipientWithAppointment } from './gmail.js';
import { batchLookupAccountsForScan, createScanSheet, detectContentType, getSportFromTeam, type Sport } from './sheets.js';
import * as calendar from './calendar.js';
import { convertHtmlToPdf } from './convertApi.js';
import { addAppointmentsToScanSheet } from './relocationSheet.js';

const EDDIE_SLACK_ID = process.env['RELOCATION_SCANNER_DM_USER'] || 'U0144K906KA';
const INTERVAL_MS = Number(process.env['RELOCATION_SCANNER_INTERVAL_MS']) || 15 * 60 * 1000;
const LOOKBACK = process.env['RELOCATION_SCANNER_LOOKBACK'] || 'newer_than:2d';
// A campaign quiet this long is over; the team's next email starts a new one.
const CAMPAIGN_IDLE_MS = 60 * 24 * 60 * 60 * 1000;

const DATA_DIR = process.env['RAILWAY_VOLUME_MOUNT_PATH'] || (process.env['RAILWAY_ENVIRONMENT'] ? '/data' : process.cwd());
const STATE_FILE = path.join(DATA_DIR, 'relocation-scanner-state.json');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type CampaignStatus = 'pending' | 'approved' | 'ignored' | 'building';

interface Campaign {
  key: string;
  team: string;
  sport?: Sport;
  kind: RelocationKind;
  status: CampaignStatus;
  messageIds: string[];
  /** Message ids already turned into sheet rows and calendar events. */
  processedIds: string[];
  /** email|ISO time pairs already on the sheet/calendar. */
  scheduled: string[];
  firstSeen: number;
  lastSeen: number;
  sampleSubject: string;
  sampleEvidence: string;
  newAccount: boolean;
  dm?: { channel: string; ts: string };
  sheetId?: string;
  sheetUrl?: string;
}

interface ScannerState {
  seen: Record<string, number>;   // message id -> when judged
  campaigns: Record<string, Campaign>;
  closerAlerts: Record<string, number>; // message id -> when DMed
}

let state: ScannerState = loadState();

function loadState(): ScannerState {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as ScannerState;
  } catch {
    return { seen: {}, campaigns: {}, closerAlerts: {} };
  }
}

function saveState(): void {
  const cutoff = Date.now() - 45 * 24 * 60 * 60 * 1000;
  for (const [id, t] of Object.entries(state.seen)) if (t < cutoff) delete state.seen[id];
  for (const [id, t] of Object.entries(state.closerAlerts)) if (t < cutoff) delete state.closerAlerts[id];
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

// ---------------------------------------------------------------------------
// Gmail helpers
// ---------------------------------------------------------------------------

interface MailPart { mimeType?: string; body?: { data?: string }; parts?: MailPart[] }

function decode(data?: string): string {
  return data ? Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8') : '';
}

function bodies(payload: MailPart | undefined): { text: string; html: string } {
  let text = '', html = '';
  const walk = (p?: MailPart) => {
    if (!p) return;
    if (p.mimeType === 'text/plain' && p.body?.data) text += decode(p.body.data);
    else if (p.mimeType === 'text/html' && p.body?.data) html += decode(p.body.data);
    for (const c of p.parts ?? []) walk(c);
  };
  walk(payload);
  return { text, html };
}

const header = (msg: any, name: string): string =>
  (msg.payload?.headers ?? []).find((h: any) => h.name?.toLowerCase() === name)?.value ?? '';

let labelNames: Map<string, string> | null = null;
let labelsAt = 0;

/** The team: its Gmail team label (kept accurate for sister teams by core-api), else the sender's name. */
async function teamOf(msg: any): Promise<{ team: string; sport?: Sport }> {
  if (!labelNames || Date.now() - labelsAt > 6 * 60 * 60 * 1000) {
    const labels = await coreApiGoogle.gmail.listLabels();
    labelNames = new Map(labels.map((l: any) => [l.id, l.name]));
    labelsAt = Date.now();
  }
  for (const id of msg.labelIds ?? []) {
    const m = (labelNames.get(id) ?? '').match(/^(NBA|MLB|NFL|NHL|WNBA|MLS|NCAA)\/(.+)$/);
    if (m) return { team: m[2].trim(), sport: m[1].toLowerCase() as Sport };
  }
  const name = header(msg, 'from').replace(/<.*$/, '').replace(/"/g, '').trim();
  return { team: name || 'Unknown team', sport: getSportFromTeam(name) };
}

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

async function samplePdf(msg: any): Promise<string | null> {
  const { text, html } = bodies(msg.payload);
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const top = `<div style="font-family:Arial;font-size:12px;border-bottom:1px solid #ccc;margin-bottom:12px;padding-bottom:8px">` +
    `<b>From:</b> ${esc(header(msg, 'from'))}<br><b>To:</b> ${esc(header(msg, 'to'))}<br>` +
    `<b>Date:</b> ${esc(header(msg, 'date'))}<br><b>Subject:</b> ${esc(header(msg, 'subject'))}</div>`;
  const content = html || `<pre style="white-space:pre-wrap;font-family:Arial">${esc(text)}</pre>`;
  try {
    const pdf = await convertHtmlToPdf(top + content, 'relocation-sample');
    return pdf.data.toString('base64');
  } catch (e) {
    console.error('[Relocation] PDF failed:', e);
    return null;
  }
}

function campaignBlocks(c: Campaign): unknown[] {
  const statusLine = c.status === 'pending'
    ? '_Nothing is created until you approve._'
    : c.status === 'ignored' ? '_Ignored. Later emails for this campaign stay quiet._'
    : c.status === 'building' ? '_Approved. Building the sheet and calendar..._'
    : `_Approved.${c.sheetUrl ? ` <${c.sheetUrl}|Tracking sheet>` : ''} Later emails are added automatically._`;
  const blocks: unknown[] = [
    { type: 'section', text: { type: 'mrkdwn', text:
      `*${c.kind} campaign: ${c.team}*${c.newAccount ? ' (new accounts)' : ''}\n` +
      `${c.messageIds.length} email${c.messageIds.length === 1 ? '' : 's'} so far · online\n` +
      `Subject: _${c.sampleSubject}_\n` +
      `> ${c.sampleEvidence.slice(0, 280)}\n${statusLine}` } },
  ];
  if (c.status === 'pending') {
    blocks.push({ type: 'actions', elements: [
      { type: 'button', text: { type: 'plain_text', text: 'Approve: build sheet + calendar' }, style: 'primary', action_id: 'reloc_approve', value: c.key },
      { type: 'button', text: { type: 'plain_text', text: 'Ignore' }, action_id: 'reloc_ignore', value: c.key },
    ] });
  }
  return blocks;
}

async function postCampaignDm(c: Campaign, msg: any): Promise<void> {
  const r = await coreApiSlack.sendDm({ user: EDDIE_SLACK_ID, text: `${c.kind} campaign: ${c.team}`, blocks: campaignBlocks(c) });
  c.dm = { channel: r.channel, ts: r.ts };
  const pdf = await samplePdf(msg);
  if (pdf) {
    await coreApiSlack.uploadFile({ channel: r.channel, threadTs: r.ts, filename: `${c.team.replace(/[^a-z0-9]+/gi, '-')}-sample.pdf`, fileData: pdf, title: `${c.team} sample email` });
  }
}

async function refreshCampaignDm(c: Campaign): Promise<void> {
  if (!c.dm) return;
  await coreApiSlack.updateMessage({ channel: c.dm.channel, ts: c.dm.ts, text: `${c.kind} campaign: ${c.team}`, blocks: campaignBlocks(c) });
}

async function threadNote(c: Campaign, text: string): Promise<void> {
  if (c.dm) await coreApiSlack.postMessage({ channel: c.dm.channel, threadTs: c.dm.ts, text });
  else await coreApiSlack.sendDm({ user: EDDIE_SLACK_ID, text: `${c.team} ${c.kind}: ${text}` });
}

async function closerDm(msg: any, team: string, v: RelocationVerdict): Promise<void> {
  const text = `*In-person ${v.kind.toLowerCase()}, new account: ${team}*\n` +
    `To: ${header(msg, 'to')}\nSubject: _${header(msg, 'subject')}_\n> ${v.evidence.slice(0, 280)}\n` +
    `_In person on a new account, so it goes to the closer, not the calendar. Nothing was created._`;
  const r = await coreApiSlack.sendDm({ user: EDDIE_SLACK_ID, text });
  const pdf = await samplePdf(msg);
  if (pdf) await coreApiSlack.uploadFile({ channel: r.channel, threadTs: r.ts, filename: `${team.replace(/[^a-z0-9]+/gi, '-')}-in-person.pdf`, fileData: pdf, title: `${team} email` });
}

// ---------------------------------------------------------------------------
// Building the sheet and calendar
// ---------------------------------------------------------------------------

/** Every account the campaign's emails went to, with appointment times. */
async function recipientsFor(c: Campaign, messageIds: string[]): Promise<RecipientWithAppointment[]> {
  const subjects = new Map<string, string[]>();
  for (const id of messageIds) {
    const m = await coreApiGoogle.gmail.getMessage(id, 'metadata');
    const s = header(m, 'subject');
    subjects.set(s, [...(subjects.get(s) ?? []), id]);
  }
  const byEmail = new Map<string, RecipientWithAppointment>();
  for (const [subject, ids] of subjects) {
    const found = await findRelatedRecipients(subject, { includeMessageIds: ids });
    const enriched = await enrichRecipientsWithAppointments(subject, found);
    for (const r of enriched) {
      const prev = byEmail.get(r.email.toLowerCase());
      // A later email can move the time; the newest one with a time wins.
      if (!prev || (r.rawDateTime && r.rawDateTime !== prev.rawDateTime)) byEmail.set(r.email.toLowerCase(), r);
    }
  }
  return [...byEmail.values()];
}

const isFuture = (r: RecipientWithAppointment) => !!r.rawDateTime && new Date(r.rawDateTime).getTime() > Date.now();

async function buildCampaign(c: Campaign): Promise<void> {
  const ids = c.messageIds.filter(id => !c.processedIds.includes(id));
  const all = await recipientsFor(c, ids);
  const future = all.filter(isFuture);
  const passed = all.filter(r => r.rawDateTime && !isFuture(r)).length;
  const noTime = all.filter(r => !r.rawDateTime).length;
  const fresh = future.filter(r => !c.scheduled.includes(`${r.email.toLowerCase()}|${r.rawDateTime}`));

  if (fresh.length === 0) {
    c.processedIds.push(...ids);
    if (!c.sheetId) await threadNote(c, `Nothing to create: ${passed} appointment${passed === 1 ? '' : 's'} already passed${noTime ? `, ${noTime} with no time found` : ''}.`);
    return;
  }

  let added = 0;
  if (!c.sheetId) {
    let accountInfo, allAccounts;
    try {
      const lookup = await batchLookupAccountsForScan(c.team, fresh.map(r => r.email), undefined, c.sport);
      accountInfo = lookup.matched; allAccounts = lookup.allAccounts;
    } catch (e) {
      console.error('[Relocation] Account lookup failed (non-fatal):', e);
    }
    const sheet = await createScanSheet({ title: c.sampleSubject, recipients: fresh, contentType: detectContentType(c.sampleSubject), accountInfo, allAccounts, teamName: c.team });
    c.sheetId = sheet.spreadsheetId; c.sheetUrl = sheet.spreadsheetUrl;
    added = fresh.length;
  } else {
    added = await addAppointmentsToScanSheet(c.sheetId, fresh.map(r => ({ email: r.email, rawDateTime: r.rawDateTime! })));
  }

  let events = 0;
  if (calendar.isCalendarEnabled()) {
    const made = await calendar.createScanAppointmentEvents(c.team, c.sampleSubject, fresh, '', c.sheetUrl ?? '');
    events = made.length;
  }
  c.scheduled.push(...fresh.map(r => `${r.email.toLowerCase()}|${r.rawDateTime}`));
  c.processedIds.push(...ids);
  await threadNote(c,
    `${c.processedIds.length === ids.length ? 'Built' : 'Added'}: ${fresh.length} appointment${fresh.length === 1 ? '' : 's'} ` +
    `(${added} sheet row${added === 1 ? '' : 's'}, ${events} calendar event${events === 1 ? '' : 's'}).` +
    `${passed ? ` Skipped ${passed} already passed.` : ''}${noTime ? ` ${noTime} had no time found.` : ''}` +
    `${c.sheetUrl ? ` <${c.sheetUrl}|Tracking sheet>` : ''}`);
}

// ---------------------------------------------------------------------------
// Scan loop
// ---------------------------------------------------------------------------

let running = false;

export async function runRelocationScan(): Promise<{ judged: number; hits: number }> {
  if (running) return { judged: 0, hits: 0 };
  running = true;
  let judged = 0, hits = 0;
  try {
    const list = await coreApiGoogle.gmail.listMessages({ maxResults: 200, q: `${CANDIDATE_QUERY} ${LOOKBACK}` });
    const ids = (Array.isArray(list) ? list : []).map((m: any) => m.id as string).filter(id => id && !state.seen[id]);
    const touched = new Set<Campaign>();

    for (const id of ids) {
      const msg: any = await coreApiGoogle.gmail.getMessage(id);
      state.seen[id] = Date.now();
      judged++;
      const { text, html } = bodies(msg.payload);
      const body = text || html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
      const v = judgeRelocationEmail(header(msg, 'subject'), header(msg, 'from'), body);
      if ('skip' in v || v.action === 'skip') continue;
      hits++;
      const { team, sport } = await teamOf(msg);

      if (v.action === 'closer') {
        if (!state.closerAlerts[id]) { await closerDm(msg, team, v); state.closerAlerts[id] = Date.now(); }
        continue;
      }

      const key = campaignKey(team, v.kind);
      let c = state.campaigns[key];
      if (c && Date.now() - c.lastSeen > CAMPAIGN_IDLE_MS) {
        state.campaigns[`${key}|${c.firstSeen}`] = c;   // keep the old one on record
        c = undefined as unknown as Campaign;
      }
      if (!c) {
        c = state.campaigns[key] = {
          key, team, sport, kind: v.kind, status: 'pending', messageIds: [], processedIds: [], scheduled: [],
          firstSeen: Date.now(), lastSeen: Date.now(), sampleSubject: header(msg, 'subject'), sampleEvidence: v.evidence,
          newAccount: v.newAccount,
        };
        c.messageIds.push(id);
        await postCampaignDm(c, msg);
      } else {
        c.messageIds.push(id);
        c.lastSeen = Date.now();
        touched.add(c);
      }
      saveState();
    }

    for (const c of touched) {
      if (c.status === 'approved') await buildCampaign(c).catch(e => threadNote(c, `Adding new emails failed: ${e instanceof Error ? e.message : e}`));
      else if (c.status === 'pending') await refreshCampaignDm(c);
    }
    saveState();
    if (judged) console.log(`[Relocation] judged ${judged}, ${hits} appointment emails`);
  } catch (e) {
    console.error('[Relocation] scan failed:', e);
  } finally {
    running = false;
  }
  return { judged, hits };
}

/** Slack button handlers (routed from interactivity.ts). */
export async function handleRelocationAction(actionId: string, key: string, userId: string): Promise<void> {
  const c = state.campaigns[key];
  if (!c) return;
  if (userId !== EDDIE_SLACK_ID) return;
  if (actionId === 'reloc_ignore') {
    c.status = 'ignored';
    saveState();
    await refreshCampaignDm(c);
    return;
  }
  if (actionId === 'reloc_approve' && c.status === 'pending') {
    c.status = 'building';
    saveState();
    await refreshCampaignDm(c);
    try {
      await buildCampaign(c);
      c.status = 'approved';
    } catch (e) {
      c.status = 'pending';
      await threadNote(c, `Building failed: ${e instanceof Error ? e.message : e}. Press Approve again to retry.`);
    }
    saveState();
    await refreshCampaignDm(c);
  }
}

export function startRelocationScanner(): void {
  console.log(`[Relocation] scanner enabled: every ${INTERVAL_MS / 60000}min over ${LOOKBACK}, DMs to ${EDDIE_SLACK_ID}, state ${STATE_FILE}`);
  setTimeout(() => { void runRelocationScan(); }, 30_000);
  setInterval(() => { void runRelocationScan(); }, INTERVAL_MS);
}
