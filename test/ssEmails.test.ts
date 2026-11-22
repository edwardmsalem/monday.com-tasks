// Run with: npx tsx --test test/ssEmails.test.ts   (node's built-in test runner through tsx)
import test from 'node:test';
import assert from 'node:assert';
import { extractEmails, cellHasEmail } from '../src/utils/ssEmails.js';

test('extractEmails pulls every address from a mixed cell, drops duplicates', () => {
  assert.deepStrictEqual(extractEmails('a@x.com, B.c+1@y.co.uk; a@X.com\nold: d_e@z.io.'), ['a@x.com', 'B.c+1@y.co.uk', 'd_e@z.io']);
  assert.deepStrictEqual(extractEmails(''), []);
  assert.deepStrictEqual(extractEmails(null), []);
  assert.deepStrictEqual(extractEmails('no email here'), []);
});

test('cellHasEmail is exact per address and ignores case', () => {
  assert.strictEqual(cellHasEmail('ba@x.com, c@y.com', 'a@x.com'), false);
  assert.strictEqual(cellHasEmail('ba@x.com, A@x.com', 'a@X.com'), true);
  assert.strictEqual(cellHasEmail('a@x.com', ''), false);
});
