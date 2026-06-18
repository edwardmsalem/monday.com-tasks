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
const ASSOCIATES_BOARD_ID = '7511353761';

// Master Numbers columns
const MASTER_ASSOCIATE_LINK_COL = 'board_relation_mm4dm77t'; // "Associate" connect column (the trigger)
const MASTER_PHONE_COL = 'phone_mm3pv28f';
const MASTER_ASSOCIATE_STATUS_COL = 'color_mm3pwvz4'; // labels: Active ... Not Linked
const MASTER_ASSOCIATE_ID_COL = 'text_mm3p3w1z';
const MASTER_TM_EMAIL_COL = 'email_mm3ndwda'; // "Bound TM Account" email assigned to the SIM

// Associates board columns
const ASSOCIATE_SS_MOBILE_COL = 'ss_mobile';
const ASSOCIATE_SS_EMAIL_COL = 'ss_email';

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

/**
 * Handle a change to the "Associate" column on a Master Numbers row.
 * On link: stamp the number onto the associate, mark the row Active.
 * On unlink: clear the number off the previous associate (if it still
 * matches), reset the row to Not Linked.
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
    // Stamp the SIM's number onto the associate.
    await setColumnValues(ASSOCIATES_BOARD_ID, newId, {
      [ASSOCIATE_SS_MOBILE_COL]: { phone: phoneDigits, countryShortName: 'US' },
    });

    // Reflect link state on the SIM row, and assign the associate's SS email to
    // the SIM (fill if blank or already matching; never clobber a different one).
    const masterEmail = (await readColumnText(masterItemId, MASTER_TM_EMAIL_COL)).trim();
    const assocEmail = (await readColumnText(newId, ASSOCIATE_SS_EMAIL_COL)).trim();
    const masterVals: Record<string, unknown> = {
      [MASTER_ASSOCIATE_STATUS_COL]: { label: 'Active' },
      [MASTER_ASSOCIATE_ID_COL]: newId,
    };
    if (assocEmail && (!masterEmail || masterEmail.toLowerCase() === assocEmail.toLowerCase())) {
      masterVals[MASTER_TM_EMAIL_COL] = { email: assocEmail, text: assocEmail };
    } else if (assocEmail && masterEmail) {
      console.warn(`[AssociateLink] email conflict on ${masterItemId}: SIM has ${masterEmail}, associate SS email ${assocEmail} — left SIM email unchanged`);
    }
    await setColumnValues(MASTER_NUMBERS_BOARD_ID, masterItemId, masterVals);
    console.log(`[AssociateLink] Linked item ${masterItemId} -> associate ${newId}, stamped ${phoneDigits}`);
    return;
  }

  // UNLINK
  if (prevId) {
    if (phoneDigits) {
      const prevMobile = (await readColumnText(prevId, ASSOCIATE_SS_MOBILE_COL)).replace(/\D/g, '');
      if (prevMobile && prevMobile === phoneDigits) {
        await setColumnValues(ASSOCIATES_BOARD_ID, prevId, {
          [ASSOCIATE_SS_MOBILE_COL]: { phone: '', countryShortName: '' },
        });
      }
    }
    await setColumnValues(MASTER_NUMBERS_BOARD_ID, masterItemId, {
      [MASTER_ASSOCIATE_STATUS_COL]: { label: 'Not Linked' },
      [MASTER_ASSOCIATE_ID_COL]: '',
    });
    console.log(`[AssociateLink] Unlinked item ${masterItemId} from associate ${prevId}`);
  }
}
