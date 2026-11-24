/**
 * Account card lookup for the Salem Triage app (POST /tasks/account-card).
 *
 * Given an email, finds the person's card on Accounts (NEW FLOW) with the same search as
 * closer-lookup: the SS email on Accounts first, then the Master Numbers Bound TM Account
 * fallback. Returns the person, the card link, the closer (A/Exec) and which rule matched.
 *
 * Monday is capped at 25,000 API calls a day, so results are cached in memory: hits for
 * 6 hours, not-found for 1 hour, at most 2,000 emails (oldest dropped first). Errors are not
 * cached. The cache is per process and empties on redeploy.
 */

import * as monday from './monday.js';
import type { CloserItem, PersonMatch, PersonMatchedBy } from './monday.js';

export interface AccountCard {
  found: boolean;
  name: string | null;
  mondayItemId: string | null;
  mondayUrl: string | null;
  closer: string | null;
  matchedBy: PersonMatchedBy | null;
}

export const HIT_TTL_MS = 6 * 60 * 60 * 1000;
export const MISS_TTL_MS = 60 * 60 * 1000;
export const MAX_ENTRIES = 2000;

const EMAIL_SHAPE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[A-Za-z]{2,}$/;

/** The trimmed email when `raw` is one email address, else null. */
export function parseEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim();
  return EMAIL_SHAPE.test(email) ? email : null;
}

export interface AccountCardDeps {
  find: (email: string) => Promise<PersonMatch | null>;
  closerName: (item: CloserItem) => string | null;
  itemUrl: (itemId: string) => string;
  now?: () => number;
  maxEntries?: number;
}

export function toAccountCard(match: PersonMatch | null, deps: Pick<AccountCardDeps, 'closerName' | 'itemUrl'>): AccountCard {
  if (!match) {
    return { found: false, name: null, mondayItemId: null, mondayUrl: null, closer: null, matchedBy: null };
  }
  const { item, matchedBy } = match;
  return {
    found: true,
    name: item.name || null,
    mondayItemId: item.id,
    mondayUrl: deps.itemUrl(item.id),
    closer: deps.closerName(item),
    matchedBy,
  };
}

export function createAccountCardLookup(deps: AccountCardDeps) {
  const now = deps.now ?? Date.now;
  const max = deps.maxEntries ?? MAX_ENTRIES;
  const cache = new Map<string, { card: AccountCard; expires: number }>();

  async function lookup(email: string): Promise<{ card: AccountCard; cached: boolean }> {
    const key = email.trim().toLowerCase();
    const hit = cache.get(key);
    if (hit && hit.expires > now()) return { card: hit.card, cached: true };
    if (hit) cache.delete(key);

    // Errors propagate and are not cached.
    const card = toAccountCard(await deps.find(email.trim()), deps);
    cache.delete(key);
    cache.set(key, { card, expires: now() + (card.found ? HIT_TTL_MS : MISS_TTL_MS) });
    while (cache.size > max) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    return { card, cached: false };
  }

  return { lookup, size: () => cache.size, clear: () => cache.clear() };
}

export const accountCardLookup = createAccountCardLookup({
  find: monday.findPersonMatchByEmail,
  closerName: (item) => monday.closerOf(item).name,
  itemUrl: monday.getItemUrl,
});
