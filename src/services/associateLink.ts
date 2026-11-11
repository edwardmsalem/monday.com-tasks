/**
 * Associate Linkage
 *
 * Replaces Bod's "#1 - Sim Number - Watch Associate Column" Make scenario.
 * When an operator links (or unlinks) a number on the Master Numbers board to
 * an associate via the "Associate" connect-boards column, this stamps the
 * number onto the associate's record and reflects the link state on the row.
 *
 * Deterministic webhook -> GraphQL glue. No AI. Driven by the existing
 * /webhook/monday route. All Monday calls go through core-api per repo rule.
 *
 * These boards are not the season-ticket board this service was built around,
 * so the IDs live here as named constants rather than in core-api config. Move
 * them to config if more cross-board automations land here.
 */

import { monday as coreApiMonday } from './coreApi.js';

// Boards
const MASTER_NUMBERS_BOARD_ID = '18414675114';
// 2026-11-09 cutover: people live on Accounts (NEW FLOW) 18391601434. SS email is assoc_ss_email (associates)
// or lead_ss_email (leads); SS mobile keeps the id ss_mobile.
const ASSOCIATES_BOARD_ID = '18391601434';

// Master Numbers columns
const MASTER_ASSOCIATE_LINK_COL = 'board_relation_mm4dm77t'; // "Associate" connect column (the trigger)
const MASTER_PHONE_COL = 'phone_mm3pv28f';
const MASTER_ASSOCIATE_STATUS_COL = 'color_mm3pwvz4'; // labels: Active ... Not Linked
const MASTER_ASSOCIATE_ID_COL = 'text_mm3p3w1z';
const MASTER_TM_EMAIL_COL = 'email_mm3ndwda'; // "Bound TM Account" email assigned to the SIM
const MASTER_SIM_STATUS_COL = 'color_mm3p4zqg'; // "Current Status": in-use, available, burned, unknown, empty, ready-to-recycle
const SIM_STATUS_NOT_IN_USE = ['burned', 'ready-to-recycle', 'empty'];

// Associates board columns
const ASSOCIATE_SS_MOBILE_COL = 'ss_mobile';
const ASSOCIATE_SS_EMAIL_COLS = ['assoc_ss_email', 'lead_ss_email'];
// "Other SS Numbers" (text, 2026-11-11): every other linked SIM's number, 10 digits, comma separated,
// sorted by SIM item id. Only on Accounts, so only written when the person lives there.
const ASSOCIATE_OTHER_SS_COL = 'other_ss_numbers';

export const ASSOCIATE_LINK_TRIGGER = {
  boardId: Number(MASTER_NUMBERS_BOARD_ID),
  columnId: MASTER_ASSOCIATE_LINK_COL,
};

interface LinkedPulse {
  linkedPulseId?: number;
}
interface BoardRelationValue {
  linkedPulseIds?: LinkedPulse[];
}
interface AssociateLinkEvent {
  pulseId?: number;
  columnId?: string;
  boardId?: number;
  value?: unknown;
  previousValue?: unknown;
}

function firstLinkedId(value: unknown): string | null {
  const v = value as BoardRelationValue | undefined;
  const id = v?.linkedPulseIds?.[0]?.linkedPulseId;
  return id ? String(id) : null;
}

async function readItemBoard(itemId: string): Promise<string> {
  const query = `query ($ids: [ID!]) { items(ids: $ids) { board { id } } }`;
  const result = (await coreApiMonday.query(query, { ids: [itemId] })) as { items?: Array<{ board?: { id: string } }> };
  return result.items?.[0]?.board?.id ?? '';
}

async function readColumnText(itemId: string, columnId: string): Promise<string> {
  const query = `
    query ReadColumn($ids: [ID!], $cols: [String!]) {
      items(ids: $ids) {
        column_values(ids: $cols) { id text }
      }
    }
  `;
  const result = (await coreApiMonday.query(query, { ids: [itemId], cols: [columnId] })) as {
    items?: Array<{ column_values?: Array<{ id: string; text: string | null }> }>;
  };
  return result.items?.[0]?.column_values?.[0]?.text ?? '';
}

// Two phone strings name the same number (ignores formatting and a leading US 1).
function sameNumber(a: string, b: string): boolean {
  const x = a.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  const y = b.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  return x !== '' && x === y;
}

interface LinkedSim { id: string; phone: string; assocStatus: string; simStatus: string }

// Other SIMs still linked to this person, in one bulk read of Master Numbers by the
// Associate ID column, each confirmed by its own link column. Oldest row first.
async function findOtherLinkedSims(personId: string, excludeItemId: string): Promise<LinkedSim[]> {
  const query = `
    query ($b: ID!, $vals: [String]!) {
      items_page_by_column_values(limit: 500, board_id: $b, columns: [{column_id: "${MASTER_ASSOCIATE_ID_COL}", column_values: $vals}]) {
        items {
          id
          phone: column_values(ids: ["${MASTER_PHONE_COL}"]) { text }
          link: column_values(ids: ["${MASTER_ASSOCIATE_LINK_COL}"]) { ... on BoardRelationValue { linked_item_ids } }
          astatus: column_values(ids: ["${MASTER_ASSOCIATE_STATUS_COL}"]) { text }
          sstatus: column_values(ids: ["${MASTER_SIM_STATUS_COL}"]) { text }
        }
      }
    }
  `;
  type Txt = Array<{ text: string | null }>;
  const res = (await coreApiMonday.query(query, { b: MASTER_NUMBERS_BOARD_ID, vals: [personId] })) as {
    items_page_by_column_values?: { items?: Array<{ id: string; phone?: Txt; link?: Array<{ linked_item_ids?: string[] }>; astatus?: Txt; sstatus?: Txt }> };
  };
  return (res.items_page_by_column_values?.items ?? [])
    .filter((it) => String(it.id) !== excludeItemId)
    .filter((it) => (it.link?.[0]?.linked_item_ids ?? []).map(String).includes(personId))
    .map((it) => ({
      id: String(it.id),
      phone: (it.phone?.[0]?.text ?? '').replace(/\D/g, ''),
      assocStatus: it.astatus?.[0]?.text ?? '',
      simStatus: it.sstatus?.[0]?.text ?? '',
    }))
    .filter((it) => it.phone !== '')
    .sort((a, b) => Number(a.id) - Number(b.id));
}

const tenDigits = (s: string): string => s.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');

// other_ss_numbers text: linked SIMs in use (not Not Linked, not burned/ready-to-recycle/empty),
// minus the primary number, deduped, sorted by SIM item id, comma separated.
function otherNumbersText(primary: string, sims: LinkedSim[]): string {
  const out: string[] = [];
  for (const s of [...sims].sort((a, b) => Number(a.id) - Number(b.id))) {
    if (s.assocStatus.trim().toLowerCase() === 'not linked') continue;
    if (SIM_STATUS_NOT_IN_USE.includes(s.simStatus.trim().toLowerCase())) continue;
    const n = tenDigits(s.phone);
    if (!n || (primary && sameNumber(primary, n)) || out.includes(n)) continue;
    out.push(n);
  }
  return out.join(', ');
}

async function setColumnValues(
  boardId: string,
  itemId: string,
  values: Record<string, unknown>
): Promise<void> {
  const query = `
    mutation SetColumns($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
      change_multiple_column_values(
        board_id: $boardId
        item_id: $itemId
        column_values: $columnValues
      ) {
        id
      }
    }
  `;
  await coreApiMonday.query(query, {
    boardId,
    itemId,
    columnValues: JSON.stringify(values),
  });
}

// Recompute and write other_ss_numbers for a person from one bulk read (ss_mobile untouched).
async function refreshOtherNumbers(personId: string, excludeItemId: string, knownMobile?: string): Promise<void> {
  const board = (await readItemBoard(personId)) || ASSOCIATES_BOARD_ID;
  if (board !== ASSOCIATES_BOARD_ID) return;
  const primary = knownMobile ?? (await readColumnText(personId, ASSOCIATE_SS_MOBILE_COL)).replace(/\D/g, '');
  const text = otherNumbersText(primary, await findOtherLinkedSims(personId, excludeItemId));
  await setColumnValues(board, personId, { [ASSOCIATE_OTHER_SS_COL]: text });
  console.log(`[AssociateLink] ${personId} other_ss_numbers = "${text}"`);
}

/**
 * Handle a change to the "Associate" column on a Master Numbers row.
 * On link: stamp the number onto the associate when ss_mobile is blank or
 * already this number (else this SIM is a secondary number), mark the row Active.
 * On unlink: if ss_mobile is this number, promote another linked SIM or clear
 * it, reset the row to Not Linked.
 */
export async function handleAssociateLink(event: AssociateLinkEvent): Promise<void> {
  const masterItemId = event.pulseId ? String(event.pulseId) : null;
  if (!masterItemId) {
    console.log('[AssociateLink] No pulseId on event, skipping');
    return;
  }

  const newId = firstLinkedId(event.value);
  const prevId = firstLinkedId(event.previousValue);
  if (newId === prevId) {
    console.log(`[AssociateLink] No change for item ${masterItemId}`);
    return;
  }

  const phoneDigits = (await readColumnText(masterItemId, MASTER_PHONE_COL)).replace(/\D/g, '');

  // LINK
  if (newId) {
    // The "Associate" column accepts items on the Leads OR Associates board (the
    // link is set at the lead stage and rides the move to Associates). Stamp the
    // SIM's number onto whichever board the linked person currently lives on.
    // Two numbers per person (2026-11-10): ss_mobile is the primary number. Fill it only
    // when blank or already this SIM's number; a different number there makes this SIM
    // a secondary number and ss_mobile is left alone.
    const personBoard = (await readItemBoard(newId)) || ASSOCIATES_BOARD_ID;
    const currentMobile = (await readColumnText(newId, ASSOCIATE_SS_MOBILE_COL)).replace(/\D/g, '');
    const isPrimary = !currentMobile || sameNumber(currentMobile, phoneDigits);
    // Step 9: other_ss_numbers from one bulk read of the person's other linked SIMs, plus this SIM
    // (its Associate ID may not be stamped yet). Written with ss_mobile in one call.
    const personVals: Record<string, unknown> = {};
    if (personBoard === ASSOCIATES_BOARD_ID) {
      const sims = await findOtherLinkedSims(newId, masterItemId);
      if (!isPrimary) {
        const simStatus = await readColumnText(masterItemId, MASTER_SIM_STATUS_COL);
        sims.push({ id: masterItemId, phone: phoneDigits, assocStatus: 'Active', simStatus });
      }
      personVals[ASSOCIATE_OTHER_SS_COL] = otherNumbersText(isPrimary ? phoneDigits : currentMobile, sims);
    }
    if (isPrimary) {
      personVals[ASSOCIATE_SS_MOBILE_COL] = { phone: phoneDigits, countryShortName: 'US' };
    } else {
      console.log(`[AssociateLink] ${newId} already has primary ${currentMobile}; item ${masterItemId} (${phoneDigits}) is a secondary number, ss_mobile left unchanged`);
    }
    if (Object.keys(personVals).length) {
      await setColumnValues(personBoard, newId, personVals);
      if (ASSOCIATE_OTHER_SS_COL in personVals) console.log(`[AssociateLink] ${newId} other_ss_numbers = "${personVals[ASSOCIATE_OTHER_SS_COL]}"`);
    }

    // Reflect link state on the SIM row, and assign the associate's SS email to
    // the SIM (fill if blank or already matching; never clobber a different one).
    // Only the primary SIM gets the SS email; a secondary SIM keeps its own.
    const masterEmail = (await readColumnText(masterItemId, MASTER_TM_EMAIL_COL)).trim();
    let assocEmail = '';
    for (const col of ASSOCIATE_SS_EMAIL_COLS) {
      assocEmail = (await readColumnText(newId, col)).trim();
      if (assocEmail) break;
    }
    const masterVals: Record<string, unknown> = {
      [MASTER_ASSOCIATE_STATUS_COL]: { label: 'Active' },
      [MASTER_ASSOCIATE_ID_COL]: newId,
    };
    if (assocEmail && !isPrimary) {
      console.log(`[AssociateLink] secondary SIM ${masterItemId}: SS email not copied`);
    } else if (assocEmail && (!masterEmail || masterEmail.toLowerCase() === assocEmail.toLowerCase())) {
      masterVals[MASTER_TM_EMAIL_COL] = { email: assocEmail, text: assocEmail };
    } else if (assocEmail && masterEmail) {
      console.warn(`[AssociateLink] email conflict on ${masterItemId}: SIM has ${masterEmail}, associate SS email ${assocEmail} — left SIM email unchanged`);
    }
    await setColumnValues(MASTER_NUMBERS_BOARD_ID, masterItemId, masterVals);
    console.log(`[AssociateLink] Linked item ${masterItemId} -> associate ${newId}, ${isPrimary ? `stamped ${phoneDigits}` : 'secondary'}`);
    // SIM moved straight from another person: refresh that person's other_ss_numbers too.
    if (prevId && prevId !== newId) await refreshOtherNumbers(prevId, masterItemId);
    return;
  }

  // UNLINK
  if (prevId) {
    const prevMobile = (await readColumnText(prevId, ASSOCIATE_SS_MOBILE_COL)).replace(/\D/g, '');
    if (phoneDigits && prevMobile && sameNumber(prevMobile, phoneDigits)) {
      const prevBoard = (await readItemBoard(prevId)) || ASSOCIATES_BOARD_ID;
      // Promote another SIM still linked to this person, if any; else clear.
      // The same bulk read also gives the new other_ss_numbers (step 9), written in the same call.
      const others = await findOtherLinkedSims(prevId, masterItemId);
      // Promote only a SIM that is still in use (never a burned, recycling, empty or Not Linked row).
      const promotable = others.find((s) => s.assocStatus.trim().toLowerCase() !== 'not linked'
        && !SIM_STATUS_NOT_IN_USE.includes(s.simStatus.trim().toLowerCase()));
      const promoted = promotable?.phone ?? '';
      const prevVals: Record<string, unknown> = {
        [ASSOCIATE_SS_MOBILE_COL]: promoted
          ? { phone: promoted, countryShortName: 'US' }
          : { phone: '', countryShortName: '' },
      };
      if (prevBoard === ASSOCIATES_BOARD_ID) prevVals[ASSOCIATE_OTHER_SS_COL] = otherNumbersText(promoted, others);
      await setColumnValues(prevBoard, prevId, prevVals);
      console.log(promoted
        ? `[AssociateLink] ${prevId} primary ${phoneDigits} unlinked; promoted ${promoted} (item ${promotable?.id})`
        : `[AssociateLink] ${prevId} primary ${phoneDigits} unlinked; no other SIM linked, ss_mobile cleared`);
    } else {
      // A secondary number left: ss_mobile stays, other_ss_numbers is recomputed.
      await refreshOtherNumbers(prevId, masterItemId, prevMobile);
    }
    await setColumnValues(MASTER_NUMBERS_BOARD_ID, masterItemId, {
      [MASTER_ASSOCIATE_STATUS_COL]: { label: 'Not Linked' },
      [MASTER_ASSOCIATE_ID_COL]: '',
    });
    console.log(`[AssociateLink] Unlinked item ${masterItemId} from associate ${prevId}`);
  }
}
