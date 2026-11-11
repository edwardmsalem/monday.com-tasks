// Run with: npx tsx --test test/twoNumbersStep6.test.ts   (node's built-in test runner through tsx)
// Two numbers per person, step 6: relink poll and backfill also relink numbers in other_ss_numbers,
// and the closer lookup falls back to the SIM's Bound TM Account email. Monday is mocked.
import test from 'node:test';
import assert from 'node:assert';
import { monday } from '../src/services/coreApi.js';
import { sweep, getRelinkStatus } from '../src/services/associateRelinkScheduler.js';
import { computeBackfillPlan } from '../src/services/backfillAssociates.js';
import { findCloserDetailsByEmail, findCloserByEmail } from '../src/services/monday.js';

const MASTER = '18414675114';
const ACCOUNTS = '18391601434';

interface Sim { phone: string; links: string[]; email?: string }
interface Person { ss: string; others?: string; closer?: string; closerId?: number; ssEmail?: string }

function fake(people: Record<string, Person>, sims: Record<string, Sim>) {
  const links: Array<{ sim: string; person: string }> = [];
  const orig = monday.query;
  (monday as { query: unknown }).query = async (q: string, v: Record<string, any> = {}) => {
    if (q.includes('change_multiple_column_values')) {
      const vals = JSON.parse(v.v);
      assert.strictEqual(String(v.b), MASTER);
      links.push({ sim: String(v.i), person: String(vals.board_relation_mm4dm77t.item_ids[0]) });
      return { change_multiple_column_values: { id: v.i } };
    }
    const simItem = (id: string, s: Sim) => ({
      id, name: id,
      phone: [{ text: s.phone }],
      link: [{ linked_item_ids: s.links }],
      column_values: [
        { id: 'phone_mm3pv28f', text: s.phone, value: null },
        { id: 'email_mm3ndwda', text: s.email ?? '', value: null },
        { id: 'board_relation_mm4dm77t', text: '', value: null, linked_item_ids: s.links },
      ],
    });
    const personItem = (id: string, p: Person) => ({
      id, name: `P${id}`,
      column_values: [
        { id: 'ss_mobile', text: p.ss, value: null },
        { id: 'other_ss_numbers', text: p.others ?? '', value: null },
        { id: 'assoc_ss_email', text: p.ssEmail ?? '', value: null },
        { id: 'lead_ss_email', text: '', value: null },
        { id: 'assoc_closer', text: p.closer ?? '', value: p.closerId ? JSON.stringify({ personsAndTeams: [{ id: p.closerId, kind: 'person' }] }) : null },
      ],
    });
    if (q.includes('items_page_by_column_values')) {
      // relink: Master by phone; closer: Accounts by SS email, then Master by TM email
      if (v.boardId === ACCOUNTS) {
        const hits = Object.entries(people).filter(([, p]) => v.columnId === 'assoc_ss_email' && p.ssEmail === v.value);
        return { items_page_by_column_values: { items: hits.map(([id, p]) => personItem(id, p)) } };
      }
      assert.strictEqual(String(v.b), MASTER);
      const col = q.includes('email_mm3ndwda", column_values') ? 'email' : 'phone';
      const hits = Object.entries(sims).filter(([, s]) => col === 'email'
        ? v.vals.includes(s.email)
        : v.vals.includes(s.phone.replace(/\D/g, '').slice(-10)));
      return { items_page_by_column_values: { items: hits.map(([id, s]) => simItem(id, s)) } };
    }
    if (q.includes('items_page(limit') && q.includes('order_by')) {
      return { boards: [{ items_page: { items: Object.entries(people).map(([id, p]) => personItem(id, p)) } }] };
    }
    if (q.includes('items_page(limit: 500)')) {
      const isMaster = q.includes(`boards(ids: ${MASTER})`);
      const items = isMaster ? Object.entries(sims).map(([id, s]) => simItem(id, s)) : Object.entries(people).map(([id, p]) => personItem(id, p));
      return { boards: [{ items_page: { cursor: null, items } }] };
    }
    if (q.includes('items(ids: $ids)')) {
      const id = String(v.ids[0]);
      return { items: people[id] ? [personItem(id, people[id])] : [] };
    }
    throw new Error('unexpected Monday query: ' + q);
  };
  return { links, restore: () => { (monday as { query: unknown }).query = orig; } };
}

test('relink poll fills a lost link for a secondary number and refuses one linked elsewhere', async () => {
  const f = fake(
    { '9001': { ss: '+1 331 834 5000', others: '3318360655, 3317770000' } },
    {
      '101': { phone: '13318345000', links: ['9001'] },       // primary, already linked
      '102': { phone: '13318360655', links: [] },             // secondary, link lost
      '103': { phone: '13317770000', links: ['9002'] },       // secondary, linked to someone else
    },
  );
  try {
    await sweep();
    assert.deepStrictEqual(f.links, [{ sim: '102', person: '9001' }]);
    assert.match(getRelinkStatus().lastResult, /linked=1 already=1 conflict=1/);
  } finally { f.restore(); }
});

test('backfill plans a relink for a secondary number (no email) and skips one linked elsewhere', async () => {
  const f = fake(
    { '9001': { ss: '13318345000', others: '3318360655,3317770000', ssEmail: 'a@x.com' } },
    {
      '101': { phone: '13318345000', links: ['9001'] },
      '102': { phone: '13318360655', links: [] },
      '103': { phone: '13317770000', links: ['9002'] },
    },
  );
  try {
    const plan = await computeBackfillPlan();
    assert.deepStrictEqual(plan.matched.map((r) => [r.masterId, r.associateId, r.setEmail]), [['102', '9001', false]]);
    assert.strictEqual(plan.summary.secondaryToLink, 1);
    assert.strictEqual(plan.summary.secondaryLinkedToOther, 1);
    assert.strictEqual(plan.summary.alreadyCorrect, 1);
  } finally { f.restore(); }
});

test('closer lookup by a second TM email goes through the SIM to its person', async () => {
  const f = fake(
    { '9001': { ss: '13318345000', ssEmail: 'first@x.com', closer: 'Nolan', closerId: 555 } },
    {
      '101': { phone: '13318345000', links: ['9001'], email: 'first@x.com' },
      '102': { phone: '13318360655', links: ['9001'], email: 'second@x.com' },
    },
  );
  try {
    assert.deepStrictEqual(await findCloserDetailsByEmail('second@x.com'), { name: 'Nolan', mondayUserId: 555 });
    assert.strictEqual(await findCloserByEmail('second@x.com'), 'Nolan');
    assert.deepStrictEqual(await findCloserDetailsByEmail('first@x.com'), { name: 'Nolan', mondayUserId: 555 });
    assert.strictEqual(await findCloserDetailsByEmail('nobody@x.com'), null);
  } finally { f.restore(); }
});

test('closer lookup does not guess when a TM email sits on SIMs of two people', async () => {
  const f = fake(
    { '9001': { ss: '1', closer: 'A' }, '9002': { ss: '2', closer: 'B' } },
    { '101': { phone: '1', links: ['9001'], email: 'x@x.com' }, '102': { phone: '2', links: ['9002'], email: 'x@x.com' } },
  );
  try {
    assert.strictEqual(await findCloserDetailsByEmail('x@x.com'), null);
  } finally { f.restore(); }
});
