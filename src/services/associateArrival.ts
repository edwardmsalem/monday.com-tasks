/**
 * Associate Arrival Relink (event-driven)
 *
 * Fires when an item lands on the Associates board (a lead moved over at the
 * "Setup Complete" changeover, via the native Monday move recipe). For that one
 * associate, it matches their SS Mobile number to the SIM row on Master Numbers
 * and sets the "Associate" link — which cascades into the existing associate-link
 * handler (Active + Associate ID + SIM email). This is the relink "at the
 * changeover", done per-item (no exhaustive board scan).
 *
 * Cheap: one read of the new associate + one targeted phone lookup on Master
 * Numbers + one write. Monday's phone column matches on digits (full or last-10).
 *
 * No second column: the link is re-derived from the SS Mobile number that rides
 * along on the move. All Monday calls go through core-api per repo rule.
 */

import { monday as coreApiMonday } from './coreApi.js';

const ASSOCIATES_BOARD_ID = '7511353761';
const ASSOCIATE_SS_MOBILE_COL = 'ss_mobile';

const MASTER_NUMBERS_BOARD_ID = '18414675114';
const MASTER_PHONE_COL = 'phone_mm3pv28f';
const MASTER_ASSOCIATE_LINK_COL = 'board_relation_mm4dm77t';

export const ASSOCIATE_ARRIVAL_TRIGGER = {
  boardId: Number(ASSOCIATES_BOARD_ID),
};

interface ArrivalEvent {
  type?: string;
  pulseId?: number;
  boardId?: number;
}

const last10 = (s: string | null | undefined): string => {
  const d = String(s ?? '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : '';
};

async function readColumnText(boardId: string, itemId: string, columnId: string): Promise<string> {
  const query = `query ($ids: [ID!], $cols: [String!]) { items(ids: $ids) { column_values(ids: $cols) { id text } } }`;
  const res = (await coreApiMonday.query(query, { ids: [itemId], cols: [columnId] })) as {
    items?: Array<{ column_values?: Array<{ id: string; text: string | null }> }>;
  };
  return res.items?.[0]?.column_values?.[0]?.text ?? '';
}

/** Find the single Master Numbers SIM row whose phone matches these digits. */
async function findMasterByPhone(digits: string): Promise<{ id: string; linkedId: string | null } | null | 'ambiguous'> {
  const query = `
    query ($b: ID!, $vals: [String!]) {
      items_page_by_column_values(limit: 5, board_id: $b, columns: [{column_id: "${MASTER_PHONE_COL}", column_values: $vals}]) {
        items { id column_values(ids: ["${MASTER_ASSOCIATE_LINK_COL}"]) { id ... on BoardRelationValue { linked_item_ids } } }
      }
    }`;
  const res = (await coreApiMonday.query(query, { b: MASTER_NUMBERS_BOARD_ID, vals: [digits] })) as {
    items_page_by_column_values?: { items?: Array<{ id: string; column_values?: Array<{ linked_item_ids?: string[] }> }> };
  };
  const items = res.items_page_by_column_values?.items ?? [];
  if (items.length === 0) return null;
  if (items.length > 1) return 'ambiguous';
  const it = items[0];
  const linkedId = it.column_values?.[0]?.linked_item_ids?.[0] ?? null;
  return { id: it.id, linkedId: linkedId ? String(linkedId) : null };
}

async function setAssociateLink(masterId: string, associateId: string): Promise<void> {
  const query = `mutation ($b: ID!, $i: ID!, $v: JSON!) { change_multiple_column_values(board_id: $b, item_id: $i, column_values: $v) { id } }`;
  await coreApiMonday.query(query, {
    b: MASTER_NUMBERS_BOARD_ID,
    i: masterId,
    v: JSON.stringify({ [MASTER_ASSOCIATE_LINK_COL]: { item_ids: [Number(associateId)] } }),
  });
}

/**
 * Handle a new item on the Associates board: link its SIM on Master Numbers.
 * No-ops cleanly when there is no SS number, no phone match, or it's already linked.
 */
export async function handleAssociateArrival(event: ArrivalEvent): Promise<void> {
  const assocId = event.pulseId ? String(event.pulseId) : null;
  if (!assocId) return;

  const ssDigits = last10(await readColumnText(ASSOCIATES_BOARD_ID, assocId, ASSOCIATE_SS_MOBILE_COL));
  if (!ssDigits) {
    console.log(`[AssocArrival] associate ${assocId} has no SS Mobile — nothing to link`);
    return;
  }

  const master = await findMasterByPhone(ssDigits);
  if (master === null) {
    console.log(`[AssocArrival] associate ${assocId}: no Master Numbers SIM matches ***${ssDigits.slice(-4)}`);
    return;
  }
  if (master === 'ambiguous') {
    console.warn(`[AssocArrival] associate ${assocId}: multiple Master rows match ***${ssDigits.slice(-4)} — skipped`);
    return;
  }
  if (master.linkedId === assocId) {
    console.log(`[AssocArrival] associate ${assocId}: already linked to SIM ${master.id}`);
    return;
  }
  if (master.linkedId) {
    console.warn(`[AssocArrival] associate ${assocId}: SIM ${master.id} already linked to ${master.linkedId} — left as-is`);
    return;
  }

  await setAssociateLink(master.id, assocId);
  console.log(`[AssocArrival] linked associate ${assocId} -> SIM ${master.id} (***${ssDigits.slice(-4)})`);
}
