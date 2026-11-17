// Run with: npx tsx --test test/issueCalls1117.test.ts   (node's built-in test runner through tsx)
// Covers the Nov 17 issue call fixes: claim reminders wired up, quiet 10 AM
// digest when nothing is open, display fixes (Related Thread null, repeated
// seats, card last 4 zeros) and Dayna in place of Ruzzell.
import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { cleanOptionalText } from '../src/utils/optionalText.js';
import { normalizeLast4, dedupeSeatStrings } from '../src/services/sheets.js';
import * as blockKit from '../src/services/blockKit.js';
import {
  issueCallOwnerNames,
  resolveIssueCallOwners,
  issueCallOwnerSlackIds,
} from '../src/services/issueCallOwners.js';
import type { UnifiedUser } from '../src/services/userResolver.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const DAYNA: UnifiedUser = { name: 'Dayna', email: 'dayna@example.com', mondayId: 11, slackId: 'U05BRER83HT', slackName: 'dayna' };
const findDaynaOnly = async (name: string) => (name.toLowerCase() === 'dayna' ? DAYNA : null);

function ic(id: string): blockKit.IssueCall {
  return {
    id, customerName: 'Jane Fan', issue: 'Tickets missing', dueDate: new Date(),
    assignee: null, assigneeSlackId: null, slackThreadTs: null, channelId: 'C1',
    isUnclaimed: true, createdAt: new Date(), lastUpdate: null,
  };
}

// ---------------------------------------------------------------------------
// Fix 1: claim reminders
// ---------------------------------------------------------------------------

test('fix 1: registered issue call is pending until claimed, handled stops reminders', async () => {
  const prevCwd = process.cwd();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'issuecall-test-'));
  process.chdir(tmp); // tracker persists to <cwd>/.issue-calls.json
  try {
    const tracker = await import('../src/services/issueCallTracker.js');
    tracker.registerIssueCall({
      mondayItemId: '123', slackThreadTs: '1700000000.000100', channelId: 'C1',
      createdAt: Date.now(), ownerSlackIds: ['U05BRER83HT'], suggestedSupporterSlackId: 'USUP',
    });
    assert.strictEqual(tracker.isPendingIssueCall('1700000000.000100'), true);
    const stored = tracker.getIssueCall('1700000000.000100')!;
    assert.deepStrictEqual(stored.ownerSlackIds, ['U05BRER83HT']);
    assert.strictEqual(stored.suggestedSupporterSlackId, 'USUP');
    assert.strictEqual(stored.pingCount, 0);
    assert.ok(tracker.getAllPendingIssueCalls().some(c => c.slackThreadTs === '1700000000.000100'));

    assert.strictEqual(tracker.markIssueCallHandled('1700000000.000100', 'UWORKER'), true);
    assert.strictEqual(tracker.isPendingIssueCall('1700000000.000100'), false);
    assert.strictEqual(tracker.getIssueCall('1700000000.000100')!.claimedBy, 'UWORKER');
    // Second press is a no-op and keeps the first claimer
    assert.strictEqual(tracker.markIssueCallHandled('1700000000.000100', 'UOTHER'), false);
    assert.strictEqual(tracker.getIssueCall('1700000000.000100')!.claimedBy, 'UWORKER');
    assert.ok(fs.existsSync(path.join(tmp, '.issue-calls.json')));
  } finally {
    process.chdir(prevCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('fix 1: /issuecall registers the call for reminders after posting, buttons stop them', () => {
  const server = src('src/server.ts');
  const handler = server.slice(server.indexOf("app.post('/webhook/slack/issuecall'"));
  const postAt = handler.indexOf('chat.postMessage');
  const registerAt = handler.indexOf('registerIssueCall({');
  assert.ok(postAt > 0 && registerAt > postAt, 'registerIssueCall runs after the Slack post');
  assert.match(handler.slice(registerAt, registerAt + 600), /slackThreadTs: slackMessage\.ts/);
  assert.match(handler.slice(registerAt, registerAt + 600), /ownerSlackIds: owners\.map/);

  const interactivity = src('src/routes/interactivity.ts');
  assert.strictEqual((interactivity.match(/markIssueCallHandled\(threadTs, userId\)/g) || []).length, 2);
});

// ---------------------------------------------------------------------------
// Fix 2: quiet 10 AM digest
// ---------------------------------------------------------------------------

test('fix 2: hasOpenIssueCalls is false only when every section is empty', () => {
  const empty = { overdue: [], dueToday: [], thisWeek: [], unclaimed: [] };
  assert.strictEqual(blockKit.hasOpenIssueCalls(empty), false);
  assert.strictEqual(blockKit.hasOpenIssueCalls({ ...empty, overdue: [ic('1')] }), true);
  assert.strictEqual(blockKit.hasOpenIssueCalls({ ...empty, dueToday: [ic('1')] }), true);
  assert.strictEqual(blockKit.hasOpenIssueCalls({ ...empty, thisWeek: [ic('1')] }), true);
  assert.strictEqual(blockKit.hasOpenIssueCalls({ ...empty, unclaimed: [ic('1')] }), true);
});

test('fix 2: sendIssueCallDigest returns before posting when nothing is open', () => {
  const digest = src('src/services/digest.ts');
  const fn = digest.slice(digest.indexOf('export async function sendIssueCallDigest'));
  const guardAt = fn.indexOf('if (!blockKit.hasOpenIssueCalls(categorized))');
  const sendAt = fn.indexOf('sendToChannel(');
  assert.ok(guardAt > 0 && sendAt > guardAt, 'empty check comes before the channel post');
});

// ---------------------------------------------------------------------------
// Fix 3: display bugs
// ---------------------------------------------------------------------------

test('fix 3a: placeholder words from the parser become null (no "Related Thread: null")', () => {
  for (const v of [null, undefined, '', '  ', 'null', 'NULL', 'None', 'n/a', 'undefined']) {
    assert.strictEqual(cleanOptionalText(v), null, String(v));
  }
  const link = 'https://salemseatsllc.slack.com/archives/C123/p1700000000000100';
  assert.strictEqual(cleanOptionalText(` ${link} `), link);
  assert.strictEqual(cleanOptionalText('Call the box office'), 'Call the box office');
});

test('fix 3b: repeated seat lines from half-season plan rows are listed once', () => {
  assert.deepStrictEqual(
    dedupeSeatStrings(['Sec 34 Row 5 Seats 1-2', 'Sec 34 Row 5 Seats 1-2', 'Sec 34  row 5 seats 1-2']),
    ['Sec 34 Row 5 Seats 1-2'],
  );
  assert.deepStrictEqual(
    dedupeSeatStrings(['Sec 34 Row 5 Seats 1-2', 'Sec 40 Row 1 Seats 3-4', 'Sec 34 Row 5 Seats 1-2', '']),
    ['Sec 34 Row 5 Seats 1-2', 'Sec 40 Row 1 Seats 3-4'],
  );
});

test('fix 3c: card last 4 keeps its leading zeros as a 4 character string', () => {
  assert.strictEqual(normalizeLast4('8'), '0008');
  assert.strictEqual(normalizeLast4('757'), '0757');
  assert.strictEqual(normalizeLast4(757), '0757');
  assert.strictEqual(normalizeLast4('0757'), '0757');
  assert.strictEqual(normalizeLast4('4321'), '4321');
  assert.strictEqual(normalizeLast4('4111111111114321'), '4321');
  assert.strictEqual(normalizeLast4(''), '');
  assert.strictEqual(normalizeLast4(undefined), '');
  assert.strictEqual(normalizeLast4('x123'), 'x123');
});

// ---------------------------------------------------------------------------
// Fix 4: Dayna in place of Ruzzell
// ---------------------------------------------------------------------------

test('fix 4: owner names default to Dayna and follow ISSUE_CALL_OWNERS', () => {
  assert.deepStrictEqual(issueCallOwnerNames(undefined), ['Dayna']);
  assert.deepStrictEqual(issueCallOwnerNames(''), ['Dayna']);
  assert.deepStrictEqual(issueCallOwnerNames(' , '), ['Dayna']);
  assert.deepStrictEqual(issueCallOwnerNames('Dayna, Sam'), ['Dayna', 'Sam']);
});

test('fix 4: owners resolve through the directory and skip people who left', async () => {
  const { owners } = await resolveIssueCallOwners(findDaynaOnly, ['Ruzzell', 'Dayna']);
  assert.deepStrictEqual(owners.map(o => o.name), ['Dayna']);
  assert.deepStrictEqual(await issueCallOwnerSlackIds(findDaynaOnly, ['UFALLBACK'], ['Dayna']), ['U05BRER83HT']);
  assert.deepStrictEqual(await issueCallOwnerSlackIds(async () => null, ['UFALLBACK'], ['Dayna']), ['UFALLBACK']);
  const throwing = async () => { throw new Error('directory down'); };
  assert.deepStrictEqual(await issueCallOwnerSlackIds(throwing, ['UFALLBACK'], ['Dayna']), ['UFALLBACK']);
});

test('fix 4: escalation text names the owners, not Ruzzell', () => {
  // The escalation builders need the remote Monday config for their links, so
  // check the text template here and the owner names it reads above.
  const code = src('src/services/blockKit.ts');
  assert.ok(!/ruzzell/i.test(code), 'no Ruzzell in blockKit');
  const template = "contextBlock(`First escalation sent to ${issueCallOwnerNames().join(' + ')} earlier.`)";
  assert.strictEqual(code.split(template).length - 1, 2, 'both escalation builders use the owner names');
  assert.strictEqual(`First escalation sent to ${issueCallOwnerNames(undefined).join(' + ')} earlier.`,
    'First escalation sent to Dayna earlier.');
});

test('fix 4: no Ruzzell ids or name lookups remain in the code', () => {
  for (const rel of ['src/services/digest.ts', 'src/services/blockKit.ts', 'src/routes/triageApi.ts', 'src/services/issueCallTracker.ts']) {
    const code = src(rel);
    assert.ok(!code.includes('U072TG6N57A'), `${rel} still has Ruzzell's Slack id`);
    assert.ok(!code.includes("findUserByName('Ruzzell')"), `${rel} still looks up Ruzzell`);
  }
});
