/**
 * SIM Relink at the Lead->Associate changeover (event-driven)
 *
 * Monday has NO "item moved to board" webhook (verified: the WebhookEventType
 * enum has no such event, and a native move does not fire create_item on the
 * destination). But the move is *triggered by* the lead's Status becoming
 * "Setup Complete", and status changes DO fire webhooks. So we hook there.
 *
 * On "Setup Complete": the item keeps the same ID across the move, so we match
 * its SS Mobile to the SIM row on Master Numbers, wait briefly for the item to
 * land on the Associates board, then set the "Associate" link — which cascades
 * into the existing associate-link handler (Active + Associate ID + SIM email).
 *
 * Cheap + event-driven (fires once per conversion): one read + one targeted
 * phone lookup + a short board-arrival wait + one write. No board scan, no
 * second column. All Monday calls go through core-api per repo rule.
 */

import { monday as coreApiMonday } from './coreApi.js';

const LEADS_BOARD_ID = '7511353720';
const ASSOCIATES_BOARD_ID = '7511353761';
const LEAD_STATUS_COL = 'lead_status';
const SETUP_COMPLETE_LABEL = 'Setup Complete';
const SS_MOBILE_COL = 'ss_mobile';

const MASTER_NUMBERS_BOARD_ID = '18414675114';
const MASTER_PHONE_COL = 'phone_mm3pv28f';
const MASTER_ASSOCIATE_LINK_COL = 'board_relation_mm4dm77t';

// Wait for the native move to land the item on the Associates board.
const ARRIVAL_WAITS_MS = [0, 5_000, 10_000, 15_000, 30_000, 30_000]; // ~90s total

export const SETUP_COMPLETE_TRIGGER = {
  boardId: Number(LEADS_BOARD_ID),
  columnId: LEAD_STATUS_COL,
};

interface StatusLabel { label?: { text?: string } }
interface RelinkEvent {
  pulseId?: number;
  columnId?: string;
  boardId?: number;
  value?: unknown;
  previousValue?: unknown;
}

const last10 = (s: string | null | undefined): string => {
  const d = String(s ?? '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : '';
};
const labelText = (v: unknown): string => (v as StatusLabel | undefined)?.label?.text?.trim() ?? '';
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

async function readItem(itemId: string): Promise<{ boardId: string; ssDigits: string } | null> {
  const query = `query ($ids: [ID!]) { items(ids: $ids) { board { id } column_values(ids: ["${SS_MOBILE_COL}"]) { text } } }`;
  const res = (await coreApiMonday.query(query, { ids: [itemId] })) as {
    items?: Array<{ board?: { id: string }; column_values?: Array<{ text: string | null }> }>;
  };
  const it = res.items?.[0];
  if (!it) return null;
  return { boardId: it.board?.id ?? '', ssDigits: last10(it.column_values?.[0]?.text) };
}

async function findMasterByPhone(digits: string): Promise<{ id: string; linkedId: string | null } | null | 'ambiguous'> {
  const query = `
    query ($b: ID!, $vals: [String!]) {
      items_page_by_column_values(limit: 5, board_id: $b, columns: [{column_id: "${MASTER_PHONE_COL}", column_values: $vals}]) {
        items { id column_values(ids: ["${MASTER_ASSOCIATE_LINK_COL}"]) { ... on BoardRelationValue { linked_item_ids } } }
      }
    }`;
  const res = (await coreApiMonday.query(query, { b: MASTER_NUMBERS_BOARD_ID, vals: [digits] })) as {
    items_page_by_column_values?: { items?: Array<{ id: string; column_values?: Array<{ linked_item_ids?: string[] }> }> };
  };
  const items = res.items_page_by_column_values?.items ?? [];
  if (items.length === 0) return null;
  if (items.length > 1) return 'ambiguous';
  const linkedId = items[0].column_values?.[0]?.linked_item_ids?.[0] ?? null;
  return { id: items[0].id, linkedId: linkedId ? String(linkedId) : null };
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
 * Handle a lead's Status changing to "Setup Complete": link its SIM on Master
 * Numbers once the item has moved onto the Associates board.
 */
export async function handleSetupCompleteRelink(event: RelinkEvent): Promise<void> {
  const itemId = event.pulseId ? String(event.pulseId) : null;
  if (!itemId) return;
  if (labelText(event.value) !== SETUP_COMPLETE_LABEL) return; // only on -> Setup Complete

  const first = await readItem(itemId);
  if (!first) { console.log(`[Relink] item ${itemId} not found`); return; }
  if (!first.ssDigits) {
    console.log(`[Relink] item ${itemId} has no SS Mobile — nothing to link`);
    return;
  }

  const master = await findMasterByPhone(first.ssDigits);
  if (master === null) { console.log(`[Relink] item ${itemId}: no Master SIM matches ***${first.ssDigits.slice(-4)}`); return; }
  if (master === 'ambiguous') { console.warn(`[Relink] item ${itemId}: multiple Master rows match ***${first.ssDigits.slice(-4)} — skipped`); return; }
  if (master.linkedId === itemId) { console.log(`[Relink] item ${itemId}: SIM ${master.id} already linked`); return; }
  if (master.linkedId) { console.warn(`[Relink] item ${itemId}: SIM ${master.id} already linked to ${master.linkedId} — left as-is`); return; }

  // Wait for the native move to land the item on the Associates board, then link.
  for (const wait of ARRIVAL_WAITS_MS) {
    if (wait) await sleep(wait);
    const cur = await readItem(itemId);
    if (cur?.boardId === ASSOCIATES_BOARD_ID) {
      await setAssociateLink(master.id, itemId);
      console.log(`[Relink] linked associate ${itemId} -> SIM ${master.id} (***${first.ssDigits.slice(-4)})`);
      return;
    }
  }
  console.warn(`[Relink] item ${itemId} not on Associates board within wait window; not linked (run /admin/backfill-associates to catch up)`);
}
