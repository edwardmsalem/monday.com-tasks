/**
 * Who may approve or ignore a relocation card (Eddie, 2026-11-23, decision
 * page: cards move to #season-tickets-admin and "Anyone in the channel" may
 * approve). A card Luna posted in an open channel can be decided by anyone who
 * can see it there (the channel is private, so that is its members). Any other
 * card, including those still in #operations from before the move and the old
 * DM cards, stays with RELOCATION_APPROVERS (default Eddie).
 *
 * The channel is the one Luna acked for the card (campaign.dm.channel), never a
 * channel named in the tap request.
 */
export const SEASON_TICKETS_ADMIN = 'C08QCFC4Y0H';

export function openChannels(env: Record<string, string | undefined> = process.env): string[] {
  const raw = env['RELOCATION_OPEN_CHANNELS'];
  return (raw === undefined ? SEASON_TICKETS_ADMIN : raw).split(',').map(s => s.trim()).filter(Boolean);
}

export function mayDecide(userId: string, cardChannel: string | undefined, approvers: string[], open: string[]): boolean {
  if (!userId) return false;
  if (approvers.includes(userId)) return true;
  return !!cardChannel && open.includes(cardChannel);
}
