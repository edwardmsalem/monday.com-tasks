/**
 * Associate Backfill (one-off)
 *
 * Retroactively links numbers already in use to their associates, so the Master
 * Numbers board becomes the single source of truth. Drives FROM the Associates
 * board: for each associate with an SS Mobile, find the matching Master row by
 * phone (last 10 digits) and, in one write, set the Associate link, Associate
 * Status = Active, Associate ID, and the SIM's assigned email (the associate's
 * SS email).
 *
 * Safety:
 *  - Email is filled only when the SIM's email is blank or already matches;
 *    a different existing email is flagged, never overwritten.
 *  - A SIM already linked to a DIFFERENT associate is flagged, never overwritten.
 *  - If two associates share one number (same SIM row), both are flagged and
 *    skipped rather than fighting over the row.
 *
 * All Monday calls go through core-api per repo rule. Read = dry run. The route
 * runs the full execute in the background so it can't hit the HTTP timeout.
 */

import { monday as coreApiMonday } from './coreApi.js';

const ASSOCIATES_BOARD_ID = '7511353761';
const ASSOCIATE_SS_MOBILE_COL = 'ss_mobile';
const ASSOCIATE_SS_EMAIL_COL = 'ss_email';

const MASTER_NUMBERS_BOARD_ID = '18414675114';
const MASTER_PHONE_COL = 'phone_mm3pv28f';
const MASTER_TM_EMAIL_COL = 'email_mm3ndwda';
const MASTER_ASSOCIATE_STATUS_COL = 'color_mm3pwvz4';
const MASTER_ASSOCIATE_ID_COL = 'text_mm3p3w1z';
const MASTER_ASSOCIATE_LINK_COL = 'board_relation_mm4dm77t';

interface ColVal { id: string; text: string | null; value: string | null; linked_item_ids?: string[] }
interface PageItem { id: string; name: string; column_values: ColVal[] }

export interface MatchRow {
  associateId: string;
  associateName: string;
  masterId: string;
  phone: string;
  assocEmail: string;
  setEmail: boolean; // write the SIM email (blank or same); false when conflict/none
}

const last10 = (s: string | null | undefined): string => {
  const d = String(s ?? '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : '';
};
const norm = (s: string | null | undefined): string => String(s ?? '').trim().toLowerCase();
const mask = (digits: string): string => (digits ? `***${digits.slice(-4)}` : '');
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

const col = (item: PageItem, id: string): ColVal | undefined => item.column_values.find(c => c.id === id);

async function pageAll(boardId: string, colIds: string[]): Promise<PageItem[]> {
  const cols = JSON.stringify(colIds);
  const sel = `id name column_values(ids: ${cols}) { id text value ... on BoardRelationValue { linked_item_ids } }`;
  const out: PageItem[] = [];
  let res = (await coreApiMonday.query(
    `query { boards(ids: ${boardId}) { items_page(limit: 500) { cursor items { ${sel} } } } }`
  )) as { boards?: Array<{ items_page?: { cursor: string | null; items: PageItem[] } }> };
  let page = res.boards?.[0]?.items_page;
  while (page) {
    out.push(...(page.items ?? []));
    const cursor = page.cursor;
    if (!cursor) break;
    const nres = (await coreApiMonday.query(
      `query { next_items_page(limit: 500, cursor: "${cursor}") { cursor items { ${sel} } } }`
    )) as { next_items_page?: { cursor: string | null; items: PageItem[] } };
    page = nres.next_items_page;
  }
  return out;
}

export interface BackfillPlan {
  summary: Record<string, unknown>;
  matched: MatchRow[];
}

export async function computeBackfillPlan(opts: { reveal?: boolean } = {}): Promise<BackfillPlan> {
  const associates = await pageAll(ASSOCIATES_BOARD_ID, [ASSOCIATE_SS_MOBILE_COL, ASSOCIATE_SS_EMAIL_COL]);
  const masters = await pageAll(MASTER_NUMBERS_BOARD_ID, [MASTER_PHONE_COL, MASTER_TM_EMAIL_COL, MASTER_ASSOCIATE_LINK_COL]);

  const masterByPhone = new Map<string, PageItem[]>();
  for (const m of masters) {
    const key = last10(col(m, MASTER_PHONE_COL)?.text);
    if (!key) continue;
    (masterByPhone.get(key) ?? masterByPhone.set(key, []).get(key)!).push(m);
  }

  const matched: MatchRow[] = [];
  const notFound: Array<{ associate: string; associateId: string; phone: string }> = [];
  const collisions: Array<{ associate: string; phone: string; masterCount: number }> = [];
  const alreadyLinkedToOther: Array<{ associate: string; phone: string; masterId: string }> = [];
  let withSsMobile = 0, alreadyCorrect = 0, emailFill = 0, emailSame = 0;
  const emailConflicts: Array<{ associate: string; simEmail: string; ssEmail: string; masterId: string }> = [];

  for (const a of associates) {
    const ss = last10(col(a, ASSOCIATE_SS_MOBILE_COL)?.text);
    if (!ss) continue;
    withSsMobile++;
    const rows = masterByPhone.get(ss);
    if (!rows || rows.length === 0) { notFound.push({ associate: a.name, associateId: a.id, phone: ss }); continue; }
    if (rows.length > 1) { collisions.push({ associate: a.name, phone: ss, masterCount: rows.length }); continue; }
    const m = rows[0];

    const linkedId = col(m, MASTER_ASSOCIATE_LINK_COL)?.linked_item_ids?.[0];
    if (linkedId && String(linkedId) === String(a.id)) { alreadyCorrect++; continue; }
    if (linkedId) { alreadyLinkedToOther.push({ associate: a.name, phone: mask(ss), masterId: m.id }); continue; }

    const ssEmail = String(col(a, ASSOCIATE_SS_EMAIL_COL)?.text ?? '').trim();
    const simEmail = String(col(m, MASTER_TM_EMAIL_COL)?.text ?? '').trim();
    let setEmail = false;
    if (ssEmail && !simEmail) { setEmail = true; emailFill++; }
    else if (ssEmail && norm(simEmail) === norm(ssEmail)) { emailSame++; }
    else if (ssEmail && simEmail) { emailConflicts.push({ associate: a.name, simEmail, ssEmail, masterId: m.id }); }

    matched.push({ associateId: a.id, associateName: a.name, masterId: m.id, phone: ss, assocEmail: ssEmail, setEmail });
  }

  // Dedupe: if two associates resolved to the same Master row, flag and drop both.
  const byMaster = new Map<string, MatchRow[]>();
  for (const r of matched) (byMaster.get(r.masterId) ?? byMaster.set(r.masterId, []).get(r.masterId)!).push(r);
  const dupMasterRows: Array<{ masterId: string; associates: string[] }> = [];
  const clean: MatchRow[] = [];
  for (const [masterId, rs] of byMaster) {
    if (rs.length > 1) dupMasterRows.push({ masterId, associates: rs.map(r => r.associateName) });
    else clean.push(rs[0]);
  }

  const summary: Record<string, unknown> = {
    associatesTotal: associates.length,
    associatesWithSsMobile: withSsMobile,
    readyToLink: clean.length,
    alreadyCorrect,
    notFound: notFound.length,
    collisions: collisions.length,
    alreadyLinkedToOther: alreadyLinkedToOther.length,
    dupMasterRows: dupMasterRows.length,
    emailWillFill: emailFill,
    emailAlreadySame: emailSame,
    emailConflicts: emailConflicts.length,
    samples: {
      readyToLink: clean.slice(0, 5).map(r => ({ associate: r.associateName, phone: mask(r.phone), setEmail: r.setEmail })),
      emailConflicts: emailConflicts.slice(0, 5),
      dupMasterRows: dupMasterRows.slice(0, 5),
      collisions: collisions.slice(0, 5).map(c => ({ associate: c.associate, phone: mask(c.phone), masterCount: c.masterCount })),
    },
  };
  if (opts.reveal) {
    summary.notFoundList = notFound.map(n => ({ associate: n.associate, associateId: n.associateId, mdn: n.phone }));
    summary.emailConflictsList = emailConflicts;
    summary.dupMasterList = dupMasterRows;
  }
  return { summary, matched: clean };
}

export async function executeBackfillWrites(matched: MatchRow[], opts: { limit?: number } = {}): Promise<{ written: number; writeErrors: number; writtenList: Array<{ associate: string; masterId: string }> }> {
  const toWrite = opts.limit && opts.limit > 0 ? matched.slice(0, opts.limit) : matched;
  let written = 0, writeErrors = 0;
  const writtenList: Array<{ associate: string; masterId: string }> = [];
  for (const r of toWrite) {
    const vals: Record<string, unknown> = {
      [MASTER_ASSOCIATE_LINK_COL]: { item_ids: [Number(r.associateId)] },
      [MASTER_ASSOCIATE_STATUS_COL]: { label: 'Active' },
      [MASTER_ASSOCIATE_ID_COL]: r.associateId,
    };
    if (r.setEmail && r.assocEmail) vals[MASTER_TM_EMAIL_COL] = { email: r.assocEmail, text: r.assocEmail };
    try {
      await coreApiMonday.query(
        `mutation ($b: ID!, $i: ID!, $v: JSON!) { change_multiple_column_values(board_id: $b, item_id: $i, column_values: $v) { id } }`,
        { b: MASTER_NUMBERS_BOARD_ID, i: r.masterId, v: JSON.stringify(vals) }
      );
      written++;
      writtenList.push({ associate: r.associateName, masterId: r.masterId });
      await sleep(250);
    } catch (e) {
      writeErrors++;
      console.error(`[Backfill] write failed for master ${r.masterId}: ${e instanceof Error ? e.message : 'unknown'}`);
    }
  }
  return { written, writeErrors, writtenList: writtenList.slice(0, 10) };
}
