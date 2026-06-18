/**
 * Associate Backfill (one-off)
 *
 * Retroactively links numbers that are already in use to their associates.
 * Drives FROM the Associates board: for each associate that already has an
 * SS Mobile, find the matching Master Numbers row by phone (last 10 digits)
 * and set that row's "Associate" connect column. The Master board has
 * thousands of numbers not tied to associates; those are simply never matched.
 *
 * Read-only by default (dry run). execute=true performs the writes, throttled.
 * All Monday calls go through core-api per repo rule. Safe to re-run: rows
 * already linked to the same associate are skipped, and rows linked to a
 * different associate are flagged, never overwritten.
 */

import { monday as coreApiMonday } from './coreApi.js';

const ASSOCIATES_BOARD_ID = '7511353761';
const ASSOCIATE_SS_MOBILE_COL = 'ss_mobile';
const MASTER_NUMBERS_BOARD_ID = '18414675114';
const MASTER_PHONE_COL = 'phone_mm3pv28f';
const MASTER_ICCID_COL = 'text_mm3ns0j';
const MASTER_ASSOCIATE_LINK_COL = 'board_relation_mm4dm77t';

interface PageItem {
  id: string;
  name: string;
  column_values: Array<{ id: string; text: string | null; value: string | null }>;
}

const last10 = (s: string | null | undefined): string => {
  const d = String(s ?? '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : '';
};
const mask = (digits: string): string => (digits ? `***${digits.slice(-4)}` : '');
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

function colText(item: PageItem, colId: string): string | null {
  return item.column_values.find(c => c.id === colId)?.text ?? null;
}
function colValue(item: PageItem, colId: string): string | null {
  return item.column_values.find(c => c.id === colId)?.value ?? null;
}

/** Page an entire board, pulling only the requested columns. */
async function pageAll(boardId: string, colIds: string[]): Promise<PageItem[]> {
  const cols = JSON.stringify(colIds);
  const out: PageItem[] = [];
  const firstQ = `query { boards(ids: ${boardId}) { items_page(limit: 500) { cursor items { id name column_values(ids: ${cols}) { id text value } } } } }`;
  let res = (await coreApiMonday.query(firstQ)) as {
    boards?: Array<{ items_page?: { cursor: string | null; items: PageItem[] } }>;
  };
  let page = res.boards?.[0]?.items_page;
  while (page) {
    out.push(...(page.items ?? []));
    const cursor = page.cursor;
    if (!cursor) break;
    const nextQ = `query { next_items_page(limit: 500, cursor: "${cursor}") { cursor items { id name column_values(ids: ${cols}) { id text value } } } }`;
    const nres = (await coreApiMonday.query(nextQ)) as {
      next_items_page?: { cursor: string | null; items: PageItem[] };
    };
    page = nres.next_items_page;
  }
  return out;
}

export async function runAssociateBackfill(opts: { execute: boolean; reveal?: boolean }): Promise<Record<string, unknown>> {
  const associates = await pageAll(ASSOCIATES_BOARD_ID, [ASSOCIATE_SS_MOBILE_COL]);
  const masters = await pageAll(MASTER_NUMBERS_BOARD_ID, [MASTER_PHONE_COL, MASTER_ICCID_COL, MASTER_ASSOCIATE_LINK_COL]);

  // Index Master rows by last-10-digit phone.
  const masterByPhone = new Map<string, PageItem[]>();
  for (const m of masters) {
    const key = last10(colText(m, MASTER_PHONE_COL));
    if (!key) continue;
    const arr = masterByPhone.get(key) ?? [];
    arr.push(m);
    masterByPhone.set(key, arr);
  }

  const matched: Array<{ associateId: string; associateName: string; masterId: string; phone: string }> = [];
  const collisions: Array<{ associate: string; phone: string; masterCount: number }> = [];
  const notFound: Array<{ associate: string; associateId: string; phone: string }> = [];
  const alreadyLinkedToOther: Array<{ associate: string; phone: string; masterId: string }> = [];
  let withSsMobile = 0;
  let alreadyCorrect = 0;

  for (const a of associates) {
    const ss = last10(colText(a, ASSOCIATE_SS_MOBILE_COL));
    if (!ss) continue;
    withSsMobile++;

    const rows = masterByPhone.get(ss);
    if (!rows || rows.length === 0) {
      notFound.push({ associate: a.name, associateId: a.id, phone: ss });
      continue;
    }
    if (rows.length > 1) {
      collisions.push({ associate: a.name, phone: ss, masterCount: rows.length });
      continue;
    }
    const m = rows[0];

    let existingId: string | number | undefined;
    try {
      const raw = colValue(m, MASTER_ASSOCIATE_LINK_COL);
      const parsed = raw ? (JSON.parse(raw) as { linkedPulseIds?: Array<{ linkedPulseId: number }> }) : null;
      existingId = parsed?.linkedPulseIds?.[0]?.linkedPulseId;
    } catch {
      existingId = undefined;
    }
    if (existingId && String(existingId) === String(a.id)) {
      alreadyCorrect++;
      continue;
    }
    if (existingId) {
      alreadyLinkedToOther.push({ associate: a.name, phone: mask(ss), masterId: m.id });
      continue;
    }
    matched.push({ associateId: a.id, associateName: a.name, masterId: m.id, phone: ss });
  }

  let written = 0;
  const writeErrors: Array<{ masterId: string; error: string }> = [];
  if (opts.execute) {
    for (const item of matched) {
      try {
        await coreApiMonday.query(
          `mutation ($b: ID!, $i: ID!, $v: JSON!) { change_multiple_column_values(board_id: $b, item_id: $i, column_values: $v) { id } }`,
          {
            b: MASTER_NUMBERS_BOARD_ID,
            i: item.masterId,
            v: JSON.stringify({ [MASTER_ASSOCIATE_LINK_COL]: { item_ids: [Number(item.associateId)] } }),
          }
        );
        written++;
        await sleep(250); // throttle for the complexity budget
      } catch (e) {
        writeErrors.push({ masterId: item.masterId, error: e instanceof Error ? e.message : 'unknown' });
      }
    }
  }

  const result: Record<string, unknown> = {
    mode: opts.execute ? 'execute' : 'dry-run',
    associatesTotal: associates.length,
    associatesWithSsMobile: withSsMobile,
    matched: matched.length,
    alreadyCorrect,
    notFound: notFound.length,
    collisions: collisions.length,
    alreadyLinkedToOther: alreadyLinkedToOther.length,
    written,
    writeErrors: writeErrors.length,
    samples: {
      matched: matched.slice(0, 5).map(m => ({ associate: m.associateName, phone: mask(m.phone) })),
      notFound: notFound.slice(0, 5).map(n => ({ associate: n.associate, phone: mask(n.phone) })),
      collisions: collisions.slice(0, 5).map(c => ({ associate: c.associate, phone: mask(c.phone), masterCount: c.masterCount })),
      alreadyLinkedToOther: alreadyLinkedToOther.slice(0, 5),
      writeErrors: writeErrors.slice(0, 5),
    },
  };

  // Full unmasked lists for export, gated behind the reveal token.
  if (opts.reveal) {
    result.notFoundList = notFound.map(n => ({ associate: n.associate, associateId: n.associateId, mdn: n.phone }));
    result.collisionsList = collisions;
    // Normalized ICCIDs across all Master rows (digits only; drops trailing F).
    const iccids: string[] = [];
    for (const m of masters) {
      const ic = String(colText(m, MASTER_ICCID_COL) ?? '').replace(/\D/g, '');
      if (ic) iccids.push(ic);
    }
    result.masterIccids = iccids;
  }

  return result;
}
