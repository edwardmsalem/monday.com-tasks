// Run with: npm run test:oldboards   (node's built-in test runner through tsx)
import test from 'node:test';
import assert from 'node:assert';
import { monday } from '../src/services/coreApi.js';
import { isOldBoardEvent } from '../src/services/oldBoards.js';
import { handleSsNumberRequest } from '../src/services/ssNumberRequest.js';
import { handleEndorsedMove } from '../src/services/endorsedMove.js';

const LEADS = 7511353720;
const ASSOCIATES = 7511353761;

function spyOnMonday(): { calls: number; restore: () => void } {
  const spy = { calls: 0, restore: () => {} };
  const orig = monday.query;
  (monday as { query: unknown }).query = async () => {
    spy.calls += 1;
    throw new Error('Monday must not be called for an old-board event');
  };
  spy.restore = () => {
    (monday as { query: unknown }).query = orig;
  };
  return spy;
}

test('isOldBoardEvent knows both old boards (number or string) and nothing else', () => {
  assert.strictEqual(isOldBoardEvent(LEADS), true);
  assert.strictEqual(isOldBoardEvent(String(ASSOCIATES)), true);
  assert.strictEqual(isOldBoardEvent(18391601434), false);
  assert.strictEqual(isOldBoardEvent(undefined), false);
});

for (const boardId of [LEADS, ASSOCIATES]) {
  test(`ssNumberRequest ignores a fresh Request Setup from board ${boardId}`, async () => {
    const spy = spyOnMonday();
    try {
      await handleSsNumberRequest({
        pulseId: 1, boardId, columnId: 'lead_status',
        value: { label: { text: 'Request Setup' } }, previousValue: { label: { text: 'New' } },
      });
      assert.strictEqual(spy.calls, 0);
    } finally { spy.restore(); }
  });

  test(`endorsedMove ignores an Endorsed stage from board ${boardId}`, async () => {
    const spy = spyOnMonday();
    try {
      await handleEndorsedMove({
        pulseId: 2, boardId, columnId: 'lead_stage',
        value: { label: { text: 'Endorsed' } }, previousValue: { label: { text: 'New' } },
      });
      assert.strictEqual(spy.calls, 0);
    } finally { spy.restore(); }
  });
}

test('a non old-board event is not short-circuited by the guard', async () => {
  const spy = spyOnMonday();
  try {
    // Reaches Monday (the spy throws). ssNumberRequest reads the row first, so the call count goes up.
    await assert.rejects(handleSsNumberRequest({
      pulseId: 3, boardId: 18391601434, columnId: 'x',
      value: { label: { text: 'Request Setup' } }, previousValue: { label: { text: 'New' } },
    }));
    assert.ok(spy.calls >= 1);
  } finally { spy.restore(); }
});
