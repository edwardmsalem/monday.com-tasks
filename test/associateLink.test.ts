// Run with: npx tsx --test test/associateLink.test.ts   (node's built-in test runner through tsx)
// Monday is mocked: monday.query is swapped for an in-memory fake of the two boards.
import test from 'node:test';
import assert from 'node:assert';
import { monday } from '../src/services/coreApi.js';
import { handleAssociateLink } from '../src/services/associateLink.js';

const MASTER = '18414675114';
const ACCOUNTS = '18391601434';
const PERSON = '9001';

interface Item { board: string; cols: Record<string, string>; links?: string[] }
interface Write { board: string; item: string; values: Record<string, any> }

function fakeMonday(items: Record<string, Item>) {
  const writes: Write[] = [];
  const bulkReads: string[] = [];
  const orig = monday.query;
  (monday as { query: unknown }).query = async (q: string, v: Record<string, any> = {}) => {
    if (q.includes('change_multiple_column_values')) {
      writes.push({ board: String(v.boardId), item: String(v.itemId), values: JSON.parse(v.columnValues) });
      return { change_multiple_column_values: { id: v.itemId } };
    }
    if (q.includes('items_page_by_column_values')) {
      assert.strictEqual(String(v.b), MASTER);
      const want: string = v.vals[0];
      bulkReads.push(want);
      const hits = Object.entries(items)
        .filter(([, it]) => it.board === MASTER && it.cols.text_mm3p3w1z === want)
        .map(([id, it]) => ({
          id, phone: [{ text: it.cols.phone_mm3pv28f ?? '' }], link: [{ linked_item_ids: it.links ?? [] }],
          astatus: [{ text: it.cols.color_mm3pwvz4 ?? '' }], sstatus: [{ text: it.cols.color_mm3p4zqg ?? '' }],
        }));
      return { items_page_by_column_values: { items: hits } };
    }
    if (q.includes('board { id }')) {
      return { items: [{ board: { id: items[v.ids[0]]?.board ?? '' } }] };
    }
    if (q.includes('ReadColumn')) {
      const it = items[v.ids[0]];
      return { items: [{ column_values: [{ id: v.cols[0], text: it?.cols[v.cols[0]] ?? '' }] }] };
    }
    throw new Error('unexpected Monday query: ' + q);
  };
  return { writes, bulkReads, restore: () => { (monday as { query: unknown }).query = orig; } };
}

const link = (id: string) => ({ linkedPulseIds: [{ linkedPulseId: Number(id) }] });

function ssMobileWrites(writes: Write[]) {
  return writes.filter((w) => w.item === PERSON && 'ss_mobile' in w.values);
}
function simWrite(writes: Write[], simId: string) {
  return writes.find((w) => w.board === MASTER && w.item === simId)!.values;
}

test('first SIM fills a blank ss_mobile and gets the SS email', async () => {
  const m = fakeMonday({
    [PERSON]: { board: ACCOUNTS, cols: { ss_mobile: '', assoc_ss_email: 'a@x.com' } },
    '101': { board: MASTER, cols: { phone_mm3pv28f: '13318345000', email_mm3ndwda: '' } },
  });
  try {
    await handleAssociateLink({ pulseId: 101, value: link(PERSON), previousValue: null });
    const s = ssMobileWrites(m.writes);
    assert.strictEqual(s.length, 1);
    assert.strictEqual(s[0].values.ss_mobile.phone, '13318345000');
    assert.strictEqual(s[0].board, ACCOUNTS);
    const sim = simWrite(m.writes, '101');
    assert.deepStrictEqual(sim.email_mm3ndwda, { email: 'a@x.com', text: 'a@x.com' });
    assert.deepStrictEqual(sim.color_mm3pwvz4, { label: 'Active' });
    assert.strictEqual(sim.text_mm3p3w1z, PERSON);
  } finally { m.restore(); }
});

test('relinking the same number (formatted differently) still counts as primary', async () => {
  const m = fakeMonday({
    [PERSON]: { board: ACCOUNTS, cols: { ss_mobile: '+1 331 834 5000', assoc_ss_email: 'a@x.com' } },
    '101': { board: MASTER, cols: { phone_mm3pv28f: '13318345000', email_mm3ndwda: '' } },
  });
  try {
    await handleAssociateLink({ pulseId: 101, value: link(PERSON), previousValue: null });
    assert.strictEqual(ssMobileWrites(m.writes).length, 1);
    assert.ok(simWrite(m.writes, '101').email_mm3ndwda);
  } finally { m.restore(); }
});

test('second SIM leaves ss_mobile alone and gets no email copied', async () => {
  const m = fakeMonday({
    [PERSON]: { board: ACCOUNTS, cols: { ss_mobile: '13318345000', assoc_ss_email: 'a@x.com' } },
    '102': { board: MASTER, cols: { phone_mm3pv28f: '13318360655', email_mm3ndwda: '' } },
  });
  try {
    await handleAssociateLink({ pulseId: 102, value: link(PERSON), previousValue: null });
    assert.strictEqual(ssMobileWrites(m.writes).length, 0);
    const sim = simWrite(m.writes, '102');
    assert.strictEqual('email_mm3ndwda' in sim, false);
    assert.deepStrictEqual(sim.color_mm3pwvz4, { label: 'Active' });
    assert.strictEqual(sim.text_mm3p3w1z, PERSON);
  } finally { m.restore(); }
});

test('unlink of a secondary SIM leaves ss_mobile', async () => {
  const m = fakeMonday({
    [PERSON]: { board: ACCOUNTS, cols: { ss_mobile: '13318345000' } },
    '102': { board: MASTER, cols: { phone_mm3pv28f: '13318360655', text_mm3p3w1z: PERSON } },
  });
  try {
    await handleAssociateLink({ pulseId: 102, value: null, previousValue: link(PERSON) });
    assert.strictEqual(ssMobileWrites(m.writes).length, 0);
    // Step 9: one bulk read to recompute other_ss_numbers (no ss_mobile change).
    assert.strictEqual(m.bulkReads.length, 1);
    const sim = simWrite(m.writes, '102');
    assert.deepStrictEqual(sim.color_mm3pwvz4, { label: 'Not Linked' });
    assert.strictEqual(sim.text_mm3p3w1z, '');
  } finally { m.restore(); }
});

test('unlink of the primary with another SIM linked promotes it (one bulk read)', async () => {
  const m = fakeMonday({
    [PERSON]: { board: ACCOUNTS, cols: { ss_mobile: '13318345000' } },
    '101': { board: MASTER, cols: { phone_mm3pv28f: '13318345000', text_mm3p3w1z: PERSON }, links: [] },
    '102': { board: MASTER, cols: { phone_mm3pv28f: '13318360655', text_mm3p3w1z: PERSON }, links: [PERSON] },
    // Stale Associate ID text but no longer linked: must not be promoted.
    '099': { board: MASTER, cols: { phone_mm3pv28f: '13310000000', text_mm3p3w1z: PERSON }, links: [] },
  });
  try {
    await handleAssociateLink({ pulseId: 101, value: null, previousValue: link(PERSON) });
    assert.deepStrictEqual(m.bulkReads, [PERSON]);
    const s = ssMobileWrites(m.writes);
    assert.strictEqual(s.length, 1);
    assert.deepStrictEqual(s[0].values.ss_mobile, { phone: '13318360655', countryShortName: 'US' });
    assert.deepStrictEqual(simWrite(m.writes, '101').color_mm3pwvz4, { label: 'Not Linked' });
  } finally { m.restore(); }
});

test('unlink of the primary never promotes a burned SIM; it promotes the next in-use one', async () => {
  const m = fakeMonday({
    [PERSON]: { board: ACCOUNTS, cols: { ss_mobile: '13318345000' } },
    '101': { board: MASTER, cols: { phone_mm3pv28f: '13318345000', text_mm3p3w1z: PERSON }, links: [] },
    '100': { board: MASTER, cols: { phone_mm3pv28f: '13311111111', text_mm3p3w1z: PERSON, color_mm3p4zqg: 'burned' }, links: [PERSON] },
    '102': { board: MASTER, cols: { phone_mm3pv28f: '13318360655', text_mm3p3w1z: PERSON }, links: [PERSON] },
  });
  try {
    await handleAssociateLink({ pulseId: 101, value: null, previousValue: link(PERSON) });
    const s = ssMobileWrites(m.writes);
    assert.strictEqual(s.length, 1);
    assert.deepStrictEqual(s[0].values.ss_mobile, { phone: '13318360655', countryShortName: 'US' });
  } finally { m.restore(); }
});

test('unlink of the primary with no other SIM clears ss_mobile', async () => {
  const m = fakeMonday({
    [PERSON]: { board: ACCOUNTS, cols: { ss_mobile: '13318345000' } },
    '101': { board: MASTER, cols: { phone_mm3pv28f: '13318345000', text_mm3p3w1z: PERSON }, links: [] },
  });
  try {
    await handleAssociateLink({ pulseId: 101, value: null, previousValue: link(PERSON) });
    assert.strictEqual(m.bulkReads.length, 1);
    const s = ssMobileWrites(m.writes);
    assert.strictEqual(s.length, 1);
    assert.deepStrictEqual(s[0].values.ss_mobile, { phone: '', countryShortName: '' });
  } finally { m.restore(); }
});

test('no-change event makes no Monday calls', async () => {
  const m = fakeMonday({});
  try {
    await handleAssociateLink({ pulseId: 101, value: link(PERSON), previousValue: link(PERSON) });
    assert.strictEqual(m.writes.length + m.bulkReads.length, 0);
  } finally { m.restore(); }
});

// ---- Step 9: other_ss_numbers ----

function otherWrites(writes: Write[], person = PERSON) {
  return writes.filter((w) => w.item === person && 'other_ss_numbers' in w.values);
}

test('second link writes other_ss_numbers (excluding burned and Not Linked rows), no ss_mobile change', async () => {
  const m = fakeMonday({
    [PERSON]: { board: ACCOUNTS, cols: { ss_mobile: '13318345000', assoc_ss_email: 'a@x.com' } },
    '101': { board: MASTER, cols: { phone_mm3pv28f: '13318345000', text_mm3p3w1z: PERSON, color_mm3pwvz4: 'Active', color_mm3p4zqg: 'in-use' }, links: [PERSON] },
    '103': { board: MASTER, cols: { phone_mm3pv28f: '13317770000', text_mm3p3w1z: PERSON, color_mm3pwvz4: 'Active', color_mm3p4zqg: 'burned' }, links: [PERSON] },
    '104': { board: MASTER, cols: { phone_mm3pv28f: '13317771111', text_mm3p3w1z: PERSON, color_mm3pwvz4: 'Not Linked', color_mm3p4zqg: 'in-use' }, links: [PERSON] },
    '105': { board: MASTER, cols: { phone_mm3pv28f: '13317772222', text_mm3p3w1z: PERSON, color_mm3pwvz4: 'Active', color_mm3p4zqg: 'ready-to-recycle' }, links: [PERSON] },
    '102': { board: MASTER, cols: { phone_mm3pv28f: '13318360655', email_mm3ndwda: '', color_mm3p4zqg: 'in-use' } },
  });
  try {
    await handleAssociateLink({ pulseId: 102, value: link(PERSON), previousValue: null });
    assert.strictEqual(ssMobileWrites(m.writes).length, 0);
    const o = otherWrites(m.writes);
    assert.strictEqual(o.length, 1);
    assert.strictEqual(o[0].board, ACCOUNTS);
    assert.strictEqual(o[0].values.other_ss_numbers, '3318360655');
    assert.deepStrictEqual(m.bulkReads, [PERSON]);
  } finally { m.restore(); }
});

test('primary link writes ss_mobile and other_ss_numbers in one call, sorted by SIM id', async () => {
  const m = fakeMonday({
    [PERSON]: { board: ACCOUNTS, cols: { ss_mobile: '', assoc_ss_email: 'a@x.com' } },
    '120': { board: MASTER, cols: { phone_mm3pv28f: '13319990000', text_mm3p3w1z: PERSON, color_mm3pwvz4: 'Active', color_mm3p4zqg: 'in-use' }, links: [PERSON] },
    '110': { board: MASTER, cols: { phone_mm3pv28f: '13318880000', text_mm3p3w1z: PERSON, color_mm3pwvz4: 'Active', color_mm3p4zqg: 'in-use' }, links: [PERSON] },
    '101': { board: MASTER, cols: { phone_mm3pv28f: '13318345000', email_mm3ndwda: '' } },
  });
  try {
    await handleAssociateLink({ pulseId: 101, value: link(PERSON), previousValue: null });
    const personWrites = m.writes.filter((w) => w.item === PERSON);
    assert.strictEqual(personWrites.length, 1);
    assert.strictEqual(personWrites[0].values.ss_mobile.phone, '13318345000');
    assert.strictEqual(personWrites[0].values.other_ss_numbers, '3318880000, 3319990000');
  } finally { m.restore(); }
});

test('unlink of the only secondary SIM clears other_ss_numbers', async () => {
  const m = fakeMonday({
    [PERSON]: { board: ACCOUNTS, cols: { ss_mobile: '13318345000', other_ss_numbers: '3318360655' } },
    '101': { board: MASTER, cols: { phone_mm3pv28f: '13318345000', text_mm3p3w1z: PERSON, color_mm3pwvz4: 'Active', color_mm3p4zqg: 'in-use' }, links: [PERSON] },
    '102': { board: MASTER, cols: { phone_mm3pv28f: '13318360655', text_mm3p3w1z: PERSON }, links: [] },
  });
  try {
    await handleAssociateLink({ pulseId: 102, value: null, previousValue: link(PERSON) });
    assert.strictEqual(ssMobileWrites(m.writes).length, 0);
    const o = otherWrites(m.writes);
    assert.strictEqual(o.length, 1);
    assert.strictEqual(o[0].values.other_ss_numbers, '');
  } finally { m.restore(); }
});

test('unlink of the primary promotes and clears other_ss_numbers in the same write', async () => {
  const m = fakeMonday({
    [PERSON]: { board: ACCOUNTS, cols: { ss_mobile: '13318345000', other_ss_numbers: '3318360655' } },
    '101': { board: MASTER, cols: { phone_mm3pv28f: '13318345000', text_mm3p3w1z: PERSON }, links: [] },
    '102': { board: MASTER, cols: { phone_mm3pv28f: '13318360655', text_mm3p3w1z: PERSON, color_mm3pwvz4: 'Active', color_mm3p4zqg: 'in-use' }, links: [PERSON] },
  });
  try {
    await handleAssociateLink({ pulseId: 101, value: null, previousValue: link(PERSON) });
    const personWrites = m.writes.filter((w) => w.item === PERSON);
    assert.strictEqual(personWrites.length, 1);
    assert.strictEqual(personWrites[0].values.ss_mobile.phone, '13318360655');
    assert.strictEqual(personWrites[0].values.other_ss_numbers, '');
    assert.strictEqual(m.bulkReads.length, 1);
  } finally { m.restore(); }
});
