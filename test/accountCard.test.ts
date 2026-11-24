// Run with: npx tsx --test test/accountCard.test.ts
// Monday is never called: the person search is injected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountCardLookup, parseEmail, HIT_TTL_MS, MISS_TTL_MS } from '../src/services/accountCard.js';
import type { PersonMatch } from '../src/services/monday.js';

const PERSON = { id: '9001', name: 'Will Neighbors', column_values: [] };

function harness(results: Record<string, PersonMatch | null | Error>, maxEntries?: number) {
  let clock = 1_000_000;
  const calls: string[] = [];
  const lookup = createAccountCardLookup({
    find: async (email) => {
      calls.push(email);
      const r = results[email.toLowerCase()];
      if (r instanceof Error) throw r;
      return r ?? null;
    },
    closerName: () => 'Tristan Oliver',
    itemUrl: (id) => `https://salemseats.monday.com/boards/1/pulses/${id}`,
    now: () => clock,
    maxEntries,
  });
  return { lookup, calls, tick: (ms: number) => { clock += ms; } };
}

test('parseEmail accepts one email and refuses missing or non-email input', () => {
  assert.equal(parseEmail('  KenBertram80@Gmail.com '), 'KenBertram80@Gmail.com');
  assert.equal(parseEmail(undefined), null);
  assert.equal(parseEmail(''), null);
  assert.equal(parseEmail('   '), null);
  assert.equal(parseEmail('not-an-email'), null);
  assert.equal(parseEmail('a@b'), null);
  assert.equal(parseEmail('a@x.com, b@y.com'), null);
  assert.equal(parseEmail(42), null);
});

test('an SS email hit says matchedBy ss_email with name, link and closer', async () => {
  const h = harness({ 'a@x.com': { item: PERSON, matchedBy: 'ss_email' } });
  const { card } = await h.lookup.lookup('a@x.com');
  assert.deepEqual(card, {
    found: true,
    name: 'Will Neighbors',
    mondayItemId: '9001',
    mondayUrl: 'https://salemseats.monday.com/boards/1/pulses/9001',
    closer: 'Tristan Oliver',
    matchedBy: 'ss_email',
  });
});

test('a Bound TM Account fallback hit says matchedBy tm_email', async () => {
  const h = harness({ 'tm@x.com': { item: PERSON, matchedBy: 'tm_email' } });
  assert.equal((await h.lookup.lookup('tm@x.com')).card.matchedBy, 'tm_email');
});

test('not found returns every field null and matchedBy null', async () => {
  const h = harness({});
  assert.deepEqual((await h.lookup.lookup('nobody@example.com')).card, {
    found: false, name: null, mondayItemId: null, mondayUrl: null, closer: null, matchedBy: null,
  });
});

test('hits are cached 6 hours, keyed by lowercased trimmed email', async () => {
  const h = harness({ 'a@x.com': { item: PERSON, matchedBy: 'ss_email' } });
  await h.lookup.lookup('a@x.com');
  const again = await h.lookup.lookup('  A@X.com ');
  assert.equal(again.cached, true);
  assert.equal(h.calls.length, 1);
  h.tick(HIT_TTL_MS - 1);
  assert.equal((await h.lookup.lookup('a@x.com')).cached, true);
  h.tick(2);
  assert.equal((await h.lookup.lookup('a@x.com')).cached, false);
  assert.equal(h.calls.length, 2);
});

test('not-found is cached 1 hour only', async () => {
  const h = harness({});
  await h.lookup.lookup('nobody@example.com');
  h.tick(MISS_TTL_MS - 1);
  assert.equal((await h.lookup.lookup('nobody@example.com')).cached, true);
  h.tick(2);
  assert.equal((await h.lookup.lookup('nobody@example.com')).cached, false);
  assert.equal(h.calls.length, 2);
});

test('errors propagate and are not cached', async () => {
  const results: Record<string, PersonMatch | null | Error> = { 'a@x.com': new Error('Monday 500') };
  const h = harness(results);
  await assert.rejects(h.lookup.lookup('a@x.com'), /Monday 500/);
  assert.equal(h.lookup.size(), 0);
  results['a@x.com'] = { item: PERSON, matchedBy: 'ss_email' };
  assert.equal((await h.lookup.lookup('a@x.com')).card.found, true);
  assert.equal(h.calls.length, 2);
});

test('the cache holds at most maxEntries and drops the oldest', async () => {
  const h = harness({}, 3);
  for (const e of ['1@x.com', '2@x.com', '3@x.com', '4@x.com']) await h.lookup.lookup(e);
  assert.equal(h.lookup.size(), 3);
  assert.equal((await h.lookup.lookup('4@x.com')).cached, true);
  assert.equal((await h.lookup.lookup('1@x.com')).cached, false);
});
