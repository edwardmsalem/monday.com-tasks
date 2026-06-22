/**
 * Endorsed -> Associates move bridge
 *
 * Replaces the native Monday recipe "When Stage changes to Endorsed and if Team
 * is not empty -> move item to Associates", which silently fails: the Stage is
 * set to "Endorsed" by ANOTHER automation (Monday engine, user -4), and native
 * Monday automations don't reliably fire off another automation's change. A
 * Monday *webhook* DOES fire on automation-driven changes (that's how Bod's old
 * Make scenario worked), so we drive the move from here.
 *
 * On Leads Stage -> "Endorsed" with Team not empty:
 *   1. move the item to the Associates board,
 *   2. set its Stage to "Assigning Closer" (via a real change event, since a bare
 *      board move is a no-op for the downstream AI closer-assigner Make scenario
 *      #3209172, which needs an actual associate_status change).
 * The existing ON Make scenario then assigns the closer.
 *
 * Gated by ENDORSED_MOVE_ENABLED (default on). Deterministic webhook glue, no AI.
 * All Monday calls go through core-api per repo rule.
 */

import { monday as coreApiMonday } from './coreApi.js';

const LEADS_BOARD_ID = '7511353720';
const ASSOCIATES_BOARD_ID = '7511353761';
const ASSOCIATES_GROUP_ID = 'topics';

const LEAD_STAGE_COL = 'lead_stage';
const LEAD_TEAM_COL = 'main_team';
const ASSOC_STAGE_COL = 'associate_status';

const ENDORSED_LABEL = 'Endorsed';
const STAGE_NEWLY_ENDORSED = 'Newly Endorsed';
const STAGE_ASSIGNING_CLOSER = 'Assigning Closer';

const ENABLED = (process.env.ENDORSED_MOVE_ENABLED ?? 'true') === 'true';

export const ENDORSED_MOVE_TRIGGER = {
  boardId: Number(LEADS_BOARD_ID),
  columnId: LEAD_STAGE_COL,
};

interface StatusLabel { label?: { text?: string } }
interface EndorsedMoveEvent {
  pulseId?: number;
  columnId?: string;
  boardId?: number;
  value?: unknown;
  previousValue?: unknown;
}

const labelText = (v: unknown): string => (v as StatusLabel | undefined)?.label?.text?.trim() ?? '';
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

async function teamNotEmpty(itemId: string): Promise<boolean> {
  const q = `query ($ids: [ID!]) { items(ids: $ids) { column_values(ids: ["${LEAD_TEAM_COL}"]) { ... on BoardRelationValue { linked_item_ids } } } }`;
  const r = (await coreApiMonday.query(q, { ids: [itemId] })) as {
    items?: Array<{ column_values?: Array<{ linked_item_ids?: string[] }> }>;
  };
  return (r.items?.[0]?.column_values?.[0]?.linked_item_ids ?? []).length > 0;
}

async function moveToAssociates(itemId: string): Promise<string> {
  const q = `mutation ($i: ID!) { move_item_to_board(board_id: ${ASSOCIATES_BOARD_ID}, group_id: "${ASSOCIATES_GROUP_ID}", item_id: $i) { id board { id } } }`;
  const r = (await coreApiMonday.query(q, { i: itemId })) as { move_item_to_board?: { board?: { id: string } } };
  return r.move_item_to_board?.board?.id ?? '';
}

async function setStage(itemId: string, label: string): Promise<void> {
  const q = `mutation ($i: ID!, $v: JSON!) { change_multiple_column_values(board_id: ${ASSOCIATES_BOARD_ID}, item_id: $i, column_values: $v) { id } }`;
  await coreApiMonday.query(q, { i: itemId, v: JSON.stringify({ [ASSOC_STAGE_COL]: { label } }) });
}

/**
 * Handle a Leads "Stage" change. Fires the move only when it becomes "Endorsed"
 * and the lead has a Team (mirrors the native automation's condition).
 */
export async function handleEndorsedMove(event: EndorsedMoveEvent): Promise<void> {
  if (!ENABLED) return;
  const itemId = event.pulseId ? String(event.pulseId) : null;
  if (!itemId) return;

  if (labelText(event.value) !== ENDORSED_LABEL) {
    console.log(`[EndorsedMove] item ${itemId}: Stage now "${labelText(event.value)}", not Endorsed — skip`);
    return;
  }

  try {
    if (!(await teamNotEmpty(itemId))) {
      console.log(`[EndorsedMove] item ${itemId}: Team empty — not moving (matches native condition)`);
      return;
    }

    const landedBoard = await moveToAssociates(itemId);
    if (landedBoard !== ASSOCIATES_BOARD_ID) {
      console.warn(`[EndorsedMove] item ${itemId}: move did not land on Associates (got "${landedBoard}") — skip`);
      return;
    }

    // Force a real Stage change so the AI closer-assigner (Make #3209172) fires;
    // a bare board move only gives it a 1-op no-op. Item is now on Associates, so
    // these writes don't re-hit this Leads-board webhook (no loop).
    await setStage(itemId, STAGE_NEWLY_ENDORSED);
    await sleep(1500);
    await setStage(itemId, STAGE_ASSIGNING_CLOSER);

    console.log(`[EndorsedMove] item ${itemId}: moved to Associates + set "Assigning Closer" (closer auto-assign will fire)`);
  } catch (e) {
    console.error(`[EndorsedMove] item ${itemId} failed: ${e instanceof Error ? e.message : 'unknown'}`);
  }
}
