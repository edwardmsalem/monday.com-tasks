/**
 * Clear junk Use Case values (one-off)
 *
 * "unassigned" and "empty" are not real use cases - they are inventory states
 * already captured by Current Status (empty/available/in-use) and Provider.
 * This blanks the Use Case column on every Master Numbers row currently set to
 * "unassigned" or "empty", leaving Use Case populated only with the real values
 * (season-ticket / buying). Verified safe: provider + state live in other cols.
 *
 * Read = dry run. execute clears, throttled, in the background.
 */

import { monday as coreApiMonday } from './coreApi.js';

const MASTER_NUMBERS_BOARD_ID = '18414675114';
const COL_USE_CASE = 'color_mm3pdbsd';
const JUNK = new Set(['unassigned', 'empty']);

interface ColVal { id: string; text: string | null }
interface PageItem { id: string; column_values: ColVal[] }

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

async function pageAll(): Promise<PageItem[]> {
  const sel = `id column_values(ids: ["${COL_USE_CASE}"]) { id text }`;
  const out: PageItem[] = [];
  let res = (await coreApiMonday.query(
    `query { boards(ids: ${MASTER_NUMBERS_BOARD_ID}) { items_page(limit: 500) { cursor items { ${sel} } } } }`
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

export async function computeClearPlan(): Promise<{ count: number; ids: string[]; byLabel: Record<string, number> }> {
  const items = await pageAll();
  const byLabel: Record<string, number> = {};
  const ids: string[] = [];
  for (const it of items) {
    const v = (it.column_values.find(c => c.id === COL_USE_CASE)?.text ?? '').trim();
    if (JUNK.has(v)) {
      ids.push(it.id);
      byLabel[v] = (byLabel[v] ?? 0) + 1;
    }
  }
  return { count: ids.length, ids, byLabel };
}

export async function executeClear(ids: string[]): Promise<{ cleared: number; errors: number }> {
  let cleared = 0, errors = 0;
  for (const id of ids) {
    try {
      await coreApiMonday.query(
        `mutation ($b: ID!, $i: ID!, $v: JSON!) { change_multiple_column_values(board_id: $b, item_id: $i, column_values: $v) { id } }`,
        { b: MASTER_NUMBERS_BOARD_ID, i: id, v: JSON.stringify({ [COL_USE_CASE]: null }) }
      );
      cleared++;
      await sleep(250);
    } catch (e) {
      errors++;
      console.error(`[ClearUseCase] failed for ${id}: ${e instanceof Error ? e.message : 'unknown'}`);
    }
  }
  return { cleared, errors };
}
