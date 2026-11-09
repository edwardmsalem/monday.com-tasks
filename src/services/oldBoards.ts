/**
 * Old-flow boards that no longer take part in any workflow (2026-11-09 cutover).
 *
 * People now live on Accounts (NEW FLOW) 18391601434 and the SS-number poller's Accounts lane is
 * the only SS path. Leads* and Associates* are read-only history, but their Monday webhooks are still
 * armed (the website form still writes Leads*). Handlers that were built for those boards call
 * isOldBoardEvent() first and log and return, so an old-board event cannot start a SIM swap or move a card.
 */

export const OLD_LEADS_BOARD_ID = '7511353720';
export const OLD_ASSOCIATES_BOARD_ID = '7511353761';

const OLD_BOARD_IDS = new Set([OLD_LEADS_BOARD_ID, OLD_ASSOCIATES_BOARD_ID]);

export function isOldBoardEvent(boardId: unknown): boolean {
  if (boardId === undefined || boardId === null) return false;
  return OLD_BOARD_IDS.has(String(boardId));
}
