/**
 * Relocation / seat-selection detection (Eddie, 2026-10-07).
 *
 * Decides, from one email's subject and body, whether it is a team telling an
 * account holder their personal relocation or seat-selection appointment, and
 * what to do with it. Pure: no Gmail calls.
 *
 * The rules come from a sweep of every relocation-style email in
 * forwarding@salemseats.com since April 2025, checked against the scans Eddie
 * ran by hand, then tightened with his calls on the first test run:
 *   - a heads-up with no personal time ("save the date", "watch your inbox for
 *     your exact window") is not an appointment
 *   - in person + existing account: skip
 *   - in person + new account: send to the closer, not the calendar
 *   - online + new account: calendar, same as an existing account
 */

export type RelocationKind = 'Relocation' | 'Seat Selection';
export type RelocationAction = 'calendar' | 'closer' | 'skip';

export interface RelocationVerdict {
  kind: RelocationKind;
  inPerson: boolean;
  newAccount: boolean;
  action: RelocationAction;
  /** The sentence the appointment time was found in, for the Slack summary. */
  evidence: string;
}

const stripPrefixes = (s: string) => s.trim().replace(/^((re|fwd?|fw)\s*:\s*)+/i, '').trim();

// ---------------------------------------------------------------------------
// Subject stage
// ---------------------------------------------------------------------------

const S_RELOC = /\breloc\w*|\brelo\b/i;
const S_SELECT = /select[- ]?a[- ]?seat|\bseat (selection|improvement|upgrade|add)|\bselect(ing)? (your |new )?(\w+ ){0,2}seats\b|\bselection (time|window|date|appointment|timeslot|time ?slot)|\btime ?slot|\bappointment|\bassigned (seat )?(selection )?(time|window)|\b(seat|selection|upgrade|access) window|\bseat selection|\breseat|\bseat (and|&) parking selection|\bupgrade (your )?(\w+ )?seats|\bupgrade window|preview available seats|waitlist conversion time|season ticket selection|your turn to select/i;
const X_SUBJ = /\bconfirm(ation|ed)?\b|thank you for participating|\breceipt\b|password|welcome to my select|ticket purchase from|\bgift\b|\bperk|\breward|giveaway|merch|jersey|box office|\bpresale\b|\bpre-sale\b|\bon-?sale\b|broadway|open house|\bmedical|doctor|dental|\bvet\b|service appointment/i;
const GAME_MOVED = /\b(game|match|event|concert|show|tournament|graduation|ceremony)\b[^.]{0,40}\b(relocat\w+|moved)\b|\b(relocat\w+|moved)\b[^.]{0,30}\b(to|from)\b[^.]{0,30}\b(stadium|arena|field|park|center|centre|venue)\b|weather|rain/i;

/** Gmail search that over-collects candidates; subjectKind() does the real filtering. */
export const CANDIDATE_QUERY =
  'subject:(relocation OR relocate OR relocating OR relo OR "select-a-seat" OR "select a seat" OR "seat selection" OR "selection window" OR "selection time" OR "selection date" OR "time slot" OR timeslot OR appointment OR "select your" OR "your turn to select" OR "upgrade window" OR "access window" OR reseat OR "seat improvement" OR "season ticket selection") -from:salemseats.com -from:ticketassociates.com';

export function subjectKind(subject: string, from: string): RelocationKind | null {
  const s = stripPrefixes(subject);
  if (/@salemseats\.com|@ticketassociates\.com/i.test(from)) return null;
  if (/^\s*re\s*:/i.test(subject)) return null;
  if (X_SUBJ.test(s)) {
    // "Time slot confirmation" still carries the appointment.
    if (/confirm/i.test(s) && /time ?slot|appointment/i.test(s) && (S_RELOC.test(s) || S_SELECT.test(s))) return 'Seat Selection';
    return null;
  }
  if (/\bparking\b/i.test(s) && !/\bseat(s|ing)?\b/i.test(s)) return null;
  if (/\brsvp\b|open house|town hall|you'?re invited|\binvite\b|invitation|join us/i.test(s) && !/reloc|time ?slot|timeslot|appointment|\byour\b/i.test(s)) return null;
  if (/clos(ing|es)\b|\bends?\b|last day|final day|last chance|final chance|final call|missed|clock'?s ticking|deadline/i.test(s) && !/\b(opens?|begins?|starts?)\b/i.test(s)) return null;
  if (GAME_MOVED.test(s)) return null;
  if (S_RELOC.test(s)) return 'Relocation';
  if (S_SELECT.test(s)) return 'Seat Selection';
  return null;
}

// ---------------------------------------------------------------------------
// Body stage
// ---------------------------------------------------------------------------

const CONTEXT = /relocat|select[- ]?a[- ]?seat|seat selection|select(ing)? (your )?(new )?seats|upgrade (or relocate )?your seats|seat improvement|move (your )?(current )?seats|change your seat|seat upgrade|reseat|add[- ]on|your turn to select|season ticket selection|selection window/i;
const NEG_BODY = /(game|match|event)[^.]{0,60}(has been|will be|is being) (relocated|moved)|new (game )?(date|venue|location) (is|will be)|due to (inclement )?weather/i;
const TIME = /(?<![\d/])(1[0-2]|0?[1-9])(:[0-5]\d)?(:00)?\s*([ap]\.?\s?m\.?)(?![a-z])|(?<![\d:])(1[0-2]|0?[1-9]):[0-5]\d(:00)?\s*[AP]M\b|\b\d{1,2}\/\d{1,2}\/\d{2,4},?\s+\d{1,2}:\d{2}|\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}|\bnoon\b|(?<=@)\s?(1[0-2]|0?[1-9])(:[0-5]\d)?\b|(?<=\bat )(1[0-2]|0?[1-9]):[0-5]\d\b/gi;
const DEADLINE_PRE = /(clos(e|es|ed|ing)|until|through|thru|deadline|\bends?\b|end( date| time)?:|expires?|no later than|\bby\b|before|last chance|remain(s)? open)[^.!?]{0,60}$/i;
const EVENT_PRE = /(doors|tip-?off|puck drop|first pitch|kick-?off|game time|concert|draft|happy hour|watch party|rsvp|reception|town hall|virtual event|pre-?match|party)[^.!?]{0,50}$/i;
const ANCHOR = /(appointment|time ?slot|timeslot|window|access|begin|open|start|scheduled|assigned|designated|dedicated|selection|relocat|select-a-seat|your time|time:|date (and|&) time|log ?in|@|is today|is tomorrow|wave|when:|date:)[\s\S]{0,130}$/i;
const PERSONAL = /date (and|&) time|(selection|select-a-seat|appointment|relocation|access|start) (date|time)|time ?slot|timeslot|appointment|your [\w\-' ]{0,40}(window|time|date)\b|your (\w+ ){0,4}(appointment|time ?slot|timeslot|window|time|date|access|start time|selection|wave)|assigned|designated|dedicated|scheduled (for|time)|personali[sz]ed|based on (your )?(tenure|seniority|priority)/i;

// The time given is the general opening, the personal one comes later
// (Sounders "Watch your inbox for a reminder with your exact window date and
// time", Atlanta United "details about your specific 36-hour timeframe").
const HEADS_UP = /(reminder|details|email|information|notification|next [\w ]{0,20}report)[^.]{0,60}\byour (exact|specific|individual|personal|assigned)(?![a-z])[^.]{0,30}(time|window|date|timeframe|appointment|slot)|(will|to) (receive|be sent|follow)[^.]{0,60}\byour (exact|specific|individual|assigned)(?![a-z]) ?(\S+ )?(time|window|date|timeframe|appointment|slot)/i;

// In person: the account holder has to show up somewhere.
// "Visit us in person or call" is an alternative, not an appointment (Fever).
const IN_PERSON = /in-person (event|appointment|select|seat|relocation)|\bin person\b(?! or\b)|meeting location|parking address|check-?in at|bring (a )?photo id|bring (your )?(photo )?identification|arrive no earlier|once you park|tour (typically )?lasts|showing you around|at the select-a-seat event|attend (the )?select-a-seat|grand casino arena|you and a guest to attend/i;

// New account: not a member yet (waitlist, deposit, prospect tour).
const NEW_ACCOUNT = /become (a|an) [\w ]{0,30}(season ticket )?(member|holder|stm)|almost time to become|new (season ticket )?member(s)? (selection|window|seat)|waitlist (conversion|member)|wait list|deposit holder|priority list|ticket plan options|pricing maps?\b|first-time|join (the )?(club|family) as a/i;

function clean(body: string): string {
  return body
    .replace(/<https?:\/\/[^>]+>|https?:\/\/\S+/g, ' ')
    .replace(/[͏­‌‍]/g, '')
    .replace(/[  -​﻿ ‎‏]/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&ndash;/g, '-').replace(/&rsquo;/g, "'")
    .replace(/\s+/g, ' ');
}

/** The appointment sentence, or null with the reason it is not one. */
export function findAppointment(body: string, subject = ''): { evidence: string } | { reason: 'no_context' | 'game_moved' | 'heads_up' | 'time_not_personal' | 'deadline_only' | 'no_time' } {
  let b = clean(body);
  if (!CONTEXT.test(b)) {
    if (/seat selection|your turn to select|select your seats/i.test(subject)) b += ' seat selection';
    else return { reason: 'no_context' };
  }
  if (NEG_BODY.test(b)) return { reason: 'game_moved' };
  if (HEADS_UP.test(b)) return { reason: 'heads_up' };
  const personal = PERSONAL.test(b);

  let start: string | null = null;
  let deadline = false;
  for (const t of b.matchAll(TIME)) {
    const i = t.index!;
    const pre = b.slice(Math.max(0, i - 160), i);
    const post = b.slice(i + t[0].length, i + t[0].length + 25);
    if (/^\s*(-|–|—|to|until)\s*(\d|noon|midnight)/i.test(post) || /(from|between)\s*$/i.test(pre) || /\d\s*(-|–|—|to)\s*$/.test(pre)) {
      if (/your [\w\-' ]{0,30}(time ?slot|timeslot|window|appointment|time)( is| will be|:)[^.]{0,40}$/i.test(pre)) { start = b.slice(Math.max(0, i - 110), i + t[0].length + 40); break; }
      continue;
    }
    if (EVENT_PRE.test(pre.slice(-70))) continue;
    if (DEADLINE_PRE.test(pre.slice(-75))) { deadline = true; continue; }
    if (ANCHOR.test(pre)) { start = b.slice(Math.max(0, i - 110), i + t[0].length + 40); break; }
  }
  if (start && personal) return { evidence: start.trim() };
  if (start) return { reason: 'time_not_personal' };
  // A time carried only in the subject ("SEAT SELECTION IS FRIDAY @3PM").
  const subj = stripPrefixes(subject);
  if (new RegExp(TIME.source, 'i').test(subj)) return { evidence: `[subject] ${subj}` };
  return { reason: deadline ? 'deadline_only' : 'no_time' };
}

export function judgeRelocationEmail(subject: string, from: string, body: string): RelocationVerdict | { skip: string } {
  const kind = subjectKind(subject, from);
  if (!kind) return { skip: 'subject' };
  const found = findAppointment(body, subject);
  if ('reason' in found) return { skip: found.reason };
  const b = clean(body);
  const inPerson = IN_PERSON.test(b);
  const newAccount = NEW_ACCOUNT.test(b);
  const action: RelocationAction = inPerson ? (newAccount ? 'closer' : 'skip') : 'calendar';
  return { kind, inPerson, newAccount, action, evidence: found.evidence };
}

/**
 * One campaign per team and kind: every Royals relocation email of a season
 * lands on one sheet (Eddie: "One sheet per team, keep adding").
 */
export function campaignKey(team: string, kind: RelocationKind): string {
  return `${team.toLowerCase().replace(/[^a-z0-9]+/g, '-')}|${kind === 'Relocation' ? 'relocation' : 'seat-selection'}`;
}
