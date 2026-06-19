/**
 * Associate Relink (cheap targeted poll)
 *
 * Keeps the SIM<->person link on Master Numbers intact across the lead->associate
 * changeover. The move is an automatic native Monday "move to board" recipe, and
 * Monday emits NO webhook when an item is moved into a board (verified). So we
 * cannot catch the move by event; instead we poll — but cheaply and targeted, not
 * an exhaustive board scan.
 *
 * Each tick:
 *   1) read the ~RECENT associates (ordered by Last updated; a move bumps it) —
 *      one page, no full scan,
 *   2) one batched lookup of Master Numbers rows by those phone numbers,
 *   3) link any whose SIM row isn't linked yet.
 * Steady state: 2 reads per tick, writes only for genuinely new arrivals. Setting
 * the Associate link cascades into the existing associate-link handler (Active +
 * Associate ID + SIM email). Idempotent, self-healing, no second column.
 *
 * For a full historical catch-up, the /admin/backfill-associates route still does
 * the exhaustive pass on demand.
 *
 * Gated by RELINK_SWEEP_ENABLED (default on). Interval via RELINK_INTERVAL_MS
 * (default 5 min). RELINK_RECENT_LIMIT caps the recent-associates window.
 */

import { monday as coreApiMonday } from './coreApi.js';

const ASSOCIATES_BOARD_ID = '7511353761';
const ASSOCIATE_SS_MOBILE_COL = 'ss_mobile';
const ASSOCIATE_LAST_UPDATED_COL = 'last_updated__1';

const MASTER_NUMBERS_BOARD_ID = '18414675114';
const MASTER_PHONE_COL = 'phone_mm3pv28f';
const MASTER_ASSOCIATE_LINK_COL = 'board_relation_mm4dm77t';

const ENABLED = (process.env.RELINK_SWEEP_ENABLED ?? 'true') === 'true';
const INTERVAL_MS = Number(process.env.RELINK_INTERVAL_MS ?? 5 * 60 * 1000);
const RECENT_LIMIT = Number(process.env.RELINK_RECENT_LIMIT ?? 100);

let interval: NodeJS.Timeout | null = null;
let running = false;
let lastRun = '';
let lastResult = '';

const last10 = (s: string | null | undefined): string => {
  const d = String(s ?? '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : '';
};

interface AssocItem { id: string; ss: string }
interface MasterItem { id: string; phone: string; linkedId: string | null }

/** The most-recently-updated associates (a board move bumps Last updated). */
async function recentAssociates(): Promise<AssocItem[]> {
  const query = `
    query ($b: [ID!]) {
      boards(ids: $b) {
        items_page(limit: ${RECENT_LIMIT}, query_params: {order_by: [{column_id: "${ASSOCIATE_LAST_UPDATED_COL}", direction: desc}]}) {
          items { id column_values(ids: ["${ASSOCIATE_SS_MOBILE_COL}"]) { text } }
        }
      }
    }`;
  const res = (await coreApiMonday.query(query, { b: [ASSOCIATES_BOARD_ID] })) as {
    boards?: Array<{ items_page?: { items?: Array<{ id: string; column_values?: Array<{ text: string | null }> }> } }>;
  };
  const items = res.boards?.[0]?.items_page?.items ?? [];
  return items
    .map(it => ({ id: it.id, ss: last10(it.column_values?.[0]?.text) }))
    .filter(a => a.ss);
}

/** One batched lookup of Master rows for a set of phone numbers. */
async function mastersByPhones(phones: string[]): Promise<Map<string, MasterItem[]>> {
  const query = `
    query ($b: ID!, $vals: [String]!) {
      items_page_by_column_values(limit: 500, board_id: $b, columns: [{column_id: "${MASTER_PHONE_COL}", column_values: $vals}]) {
        items {
          id
          phone: column_values(ids: ["${MASTER_PHONE_COL}"]) { text }
          link: column_values(ids: ["${MASTER_ASSOCIATE_LINK_COL}"]) { ... on BoardRelationValue { linked_item_ids } }
        }
      }
    }`;
  const res = (await coreApiMonday.query(query, { b: MASTER_NUMBERS_BOARD_ID, vals: phones })) as {
    items_page_by_column_values?: { items?: Array<{ id: string; phone?: Array<{ text: string | null }>; link?: Array<{ linked_item_ids?: string[] }> }> };
  };
  const byPhone = new Map<string, MasterItem[]>();
  for (const it of res.items_page_by_column_values?.items ?? []) {
    const key = last10(it.phone?.[0]?.text);
    if (!key) continue;
    const linkedId = it.link?.[0]?.linked_item_ids?.[0] ?? null;
    const m: MasterItem = { id: it.id, phone: key, linkedId: linkedId ? String(linkedId) : null };
    (byPhone.get(key) ?? byPhone.set(key, []).get(key)!).push(m);
  }
  return byPhone;
}

async function setAssociateLink(masterId: string, associateId: string): Promise<void> {
  const query = `mutation ($b: ID!, $i: ID!, $v: JSON!) { change_multiple_column_values(board_id: $b, item_id: $i, column_values: $v) { id } }`;
  await coreApiMonday.query(query, {
    b: MASTER_NUMBERS_BOARD_ID,
    i: masterId,
    v: JSON.stringify({ [MASTER_ASSOCIATE_LINK_COL]: { item_ids: [Number(associateId)] } }),
  });
}

async function sweep(): Promise<void> {
  if (running) { console.log('[Relink] previous tick still running, skipping'); return; }
  running = true;
  try {
    const assoc = await recentAssociates();
    if (assoc.length === 0) { lastResult = 'no recent associates with SS Mobile'; return; }
    const phones = [...new Set(assoc.map(a => a.ss))];
    const masters = await mastersByPhones(phones);

    let linked = 0, already = 0, conflict = 0, noMatch = 0, errors = 0;
    for (const a of assoc) {
      const rows = masters.get(a.ss);
      if (!rows || rows.length === 0) { noMatch++; continue; }
      if (rows.length > 1) { conflict++; continue; } // ambiguous phone -> leave for manual
      const m = rows[0];
      if (m.linkedId === a.id) { already++; continue; }
      if (m.linkedId) { conflict++; continue; } // linked to someone else -> leave
      try { await setAssociateLink(m.id, a.id); linked++; }
      catch (e) { errors++; console.error(`[Relink] link failed assoc ${a.id} -> SIM ${m.id}: ${e instanceof Error ? e.message : 'unknown'}`); }
    }
    lastResult = `recent=${assoc.length} linked=${linked} already=${already} conflict=${conflict} noMatch=${noMatch} errors=${errors}`;
    if (linked || errors) console.log(`[Relink] ${lastResult}`);
  } catch (e) {
    lastResult = `error: ${e instanceof Error ? e.message : 'unknown'}`;
    console.error(`[Relink] sweep failed: ${lastResult}`);
  } finally {
    running = false;
    lastRun = new Date().toISOString();
  }
}

export function startAssociateRelinkScheduler(): void {
  if (!ENABLED) { console.log('[Relink] disabled (RELINK_SWEEP_ENABLED!=true)'); return; }
  if (interval) { console.log('[Relink] already started'); return; }
  console.log(`[Relink] starting targeted poll; interval=${Math.round(INTERVAL_MS / 60000)}min recentLimit=${RECENT_LIMIT}`);
  setTimeout(() => { void sweep(); }, 20_000);
  interval = setInterval(() => { void sweep(); }, INTERVAL_MS);
}

export function getRelinkStatus(): { enabled: boolean; running: boolean; lastRun: string; lastResult: string } {
  return { enabled: ENABLED, running, lastRun, lastResult };
}
