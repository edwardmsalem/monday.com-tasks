import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ESCALATION_CONFIG } from '../src/services/digest.js';

const DAYNA = 'U05BRER83HT';
const ELIA = 'U08M6BP6X3N';

test('final issue-call escalations go to Dayna only (Eddie 2026-11-23)', () => {
  const { claiming, completion } = ESCALATION_CONFIG.issueCalls;
  assert.deepEqual(claiming.final.recipients, [DAYNA]);
  assert.deepEqual(completion.final.recipients, [DAYNA]);
  for (const r of [...claiming.final.recipients, ...completion.final.recipients]) assert.notEqual(r, ELIA);
});
