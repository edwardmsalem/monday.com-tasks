/**
 * Mark Call Forwards (one-off + reusable)
 *
 * SIMs in bank-isolated banks (50024, 50032) have no call forwarding, so they
 * cannot serve season tickets. This sets the "Call Forwards?" column to "No" on
 * every Master Numbers row in those banks, and reports which of them are ALREADY
 * in season-ticket use (the cleanup list).
 *
 * Read = dry run. execute writes "No", throttled, in the background.
 * All Monday calls go through core-api per repo rule.
 */

import { monday as coreApiMonday } from './coreApi.js';

const MASTER_NUMBERS_BOARD_ID = '18414675114';
const COL_BANK = 'text_mm3pgf58';
const COL_CALL_FORWARDS = 'color_mm4fkbhq'; // status: Yes / No
const COL_USE_CASE = 'color_mm3pdbsd';
const COL_ASSOCIATE_LINK = 'board_relation_mm4dm77t';
const BAD_BANKS = new Set(['50024', '50032']);

interface ColVal { id: string; text: string | null; linked_item_ids?: string[] }
interface PageItem { id: string; name: string; column_values: ColVal[] }

const col = (it: PageItem, id: string): ColVal | undefined => it.column_values.find(c => c.id === id);
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

async function pageAll(colIds: string[]): Promise<PageItem[]> {
  const cols = JSON.stringify(colIds);
  const sel = `id name column_values(ids: ${cols}) { id text ... on BoardRelationValue { linked_item_ids } }`;
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

export interface CallFwdPlan {
  summary: Record<string, unknown>;
  toSet: string[];
}

export async function computeCallFwdPlan(reveal = false): Promise<CallFwdPlan> {
  const items = await pageAll([COL_BANK, COL_CALL_FORWARDS, COL_USE_CASE, COL_ASSOCIATE_LINK]);
  const inBadBanks = items.filter(it => BAD_BANKS.has((col(it, COL_BANK)?.text ?? '').trim()));

  const toSet = inBadBanks.filter(it => (col(it, COL_CALL_FORWARDS)?.text ?? '').trim() !== 'No').map(it => it.id);
  const alreadyNo = inBadBanks.length - toSet.length;

  const alreadyInUse = inBadBanks.filter(it => {
    const uc = (col(it, COL_USE_CASE)?.text ?? '').trim();
    const linked = (col(it, COL_ASSOCIATE_LINK)?.linked_item_ids ?? []).length > 0;
    return uc === 'season-ticket' || linked;
  });

  const summary: Record<string, unknown> = {
    badBankRows: inBadBanks.length,
    willSetNo: toSet.length,
    alreadyNo,
    alreadyInSeasonTicketUse: alreadyInUse.length,
    note: 'alreadyInSeasonTicketUse = bad-bank SIMs already serving season tickets despite no call forwarding (cleanup candidates)',
  };
  if (reveal) {
    summary.alreadyInUseList = alreadyInUse.map(it => ({
      name: it.name,
      useCase: col(it, COL_USE_CASE)?.text ?? '',
      associateLinked: (col(it, COL_ASSOCIATE_LINK)?.linked_item_ids ?? []).length > 0,
      masterId: it.id,
    }));
  }
  return { summary, toSet };
}

export async function executeCallFwdNo(ids: string[]): Promise<{ written: number; writeErrors: number }> {
  let written = 0, writeErrors = 0;
  for (const id of ids) {
    try {
      await coreApiMonday.query(
        `mutation ($b: ID!, $i: ID!, $v: JSON!) { change_multiple_column_values(board_id: $b, item_id: $i, column_values: $v) { id } }`,
        { b: MASTER_NUMBERS_BOARD_ID, i: id, v: JSON.stringify({ [COL_CALL_FORWARDS]: { label: 'No' } }) }
      );
      written++;
      await sleep(250);
    } catch (e) {
      writeErrors++;
      console.error(`[CallFwd] write failed for ${id}: ${e instanceof Error ? e.message : 'unknown'}`);
    }
  }
  return { written, writeErrors };
}
