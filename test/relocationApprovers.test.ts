import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mayDecide, openChannels, SEASON_TICKETS_ADMIN } from '../src/services/relocationApprovers.js';

const EDDIE = 'U0144K906KA';
const TEAMMATE = 'U0BKZG68FPG';
const OPS = 'C06BSL06WJK';
const APPROVERS = [EDDIE];

test('anyone may decide a card posted in #season-tickets-admin (Eddie 2026-11-23)', () => {
  const open = openChannels({});
  assert.deepEqual(open, [SEASON_TICKETS_ADMIN]);
  assert.equal(mayDecide(TEAMMATE, SEASON_TICKETS_ADMIN, APPROVERS, open), true);
  assert.equal(mayDecide(EDDIE, SEASON_TICKETS_ADMIN, APPROVERS, open), true);
});

test('a card still in #operations, a DM card or a card with no channel stays Eddie only', () => {
  const open = openChannels({});
  assert.equal(mayDecide(TEAMMATE, OPS, APPROVERS, open), false);
  assert.equal(mayDecide(EDDIE, OPS, APPROVERS, open), true);
  assert.equal(mayDecide(TEAMMATE, 'D0EDDIEDM', APPROVERS, open), false);
  assert.equal(mayDecide(TEAMMATE, undefined, APPROVERS, open), false);
  assert.equal(mayDecide('', SEASON_TICKETS_ADMIN, APPROVERS, open), false);
});

test('RELOCATION_OPEN_CHANNELS overrides the default, and empty turns the open channel off', () => {
  assert.deepEqual(openChannels({ RELOCATION_OPEN_CHANNELS: 'C1, C2' }), ['C1', 'C2']);
  assert.deepEqual(openChannels({ RELOCATION_OPEN_CHANNELS: '' }), []);
  assert.equal(mayDecide(TEAMMATE, SEASON_TICKETS_ADMIN, APPROVERS, openChannels({ RELOCATION_OPEN_CHANNELS: '' })), false);
});
