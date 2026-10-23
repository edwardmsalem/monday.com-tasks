// Proof for the Forwarding Triage thread index: real src/services/monday.ts against a fake core-api.
// Run: npx tsx scripts/thread-index-proof.ts (from the repo root). Uses no real Monday or core-api.
import http from 'node:http';
import assert from 'node:assert/strict';

const TASK_CH = 'C0TASKS001', BUSY_CH = 'C0BUSY0001', COL = 'text_mkxxn3hz';
const now = Date.now() / 1000;
const items = Array.from({ length: 640 }, (_, i) => ({ id: String(9000 + i), v: i < 548 ? `${TASK_CH}:${(now - 86400 - i).toFixed(6)}` : '' }));
let calls: string[] = [];
let failBoardRead = false;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/config') {
      return res.end(JSON.stringify({ slack: { channels: { seasonTicketAdmin: TASK_CH, issueCall: TASK_CH, control: TASK_CH, presales: TASK_CH } }, monday: { boards: { seasonTicketTasks: '18383923820' } }, google: { sheets: {} }, claude: { models: { default: 'x', fast: 'x', thinking: 'x', opus: 'x' } } }));
    }
    const { query, variables } = JSON.parse(body || '{}');
    calls.push(query.includes('next_items_page') ? 'page2' : query.includes('items_page(limit: 500)') ? 'page1' : query.includes('items_page_by_column_values') ? 'live' : query.includes('mutation') ? 'write' : 'other');
    if (query.includes('items_page(limit: 500)')) {
      if (failBoardRead) { res.statusCode = 500; return res.end(JSON.stringify({ error: { message: 'boom' } })); }
      return res.end(JSON.stringify({ boards: [{ items_page: { cursor: 'c2', items: items.slice(0, 500).map((it) => ({ id: it.id, column_values: [{ text: it.v }] })) } }] }));
    }
    if (query.includes('next_items_page')) return res.end(JSON.stringify({ next_items_page: { cursor: null, items: items.slice(500).map((it) => ({ id: it.id, column_values: [{ text: it.v }] })) } }));
    if (query.includes('items_page_by_column_values')) {
      const hit = items.find((it) => it.v && it.v === variables.value);
      return res.end(JSON.stringify({ items_page_by_column_values: { items: hit ? [{ id: hit.id }] : [] } }));
    }
    return res.end(JSON.stringify({ change_multiple_column_values: { id: '1' } }));
  });
});
await new Promise<void>((r) => server.listen(0, r));
process.env.CORE_API_URL = `http://127.0.0.1:${(server.address() as any).port}`;
process.env.CORE_API_KEY = 'test';

const env = await import(process.cwd() + '/src/config/environment.ts');
await env.initRemoteConfig();
const monday = await import(process.cwd() + '/src/services/monday.ts');
const take = () => { const c = calls; calls = []; return c; };

// 1. First lookup builds the index: 2 calls, finds a task thread.
const taskTs = items[3].v.split(':')[1];
assert.equal(await monday.findItemBySlackThread(taskTs, TASK_CH), items[3].id);
assert.deepEqual(take(), ['page1', 'page2']);
console.log('1 ok: index built in 2 calls, task thread found');

// 2. Another task thread: answered from the index, 0 calls.
assert.equal(await monday.findItemBySlackThread(items[200].v.split(':')[1], TASK_CH), items[200].id);
assert.deepEqual(take(), []);
console.log('2 ok: task thread found with 0 calls');

// 3. A reaction on a busy non-task channel, old and new threads: 0 calls (was 3 each).
assert.equal(await monday.findItemBySlackThread((now - 5000).toFixed(6), BUSY_CH), null);
assert.equal(await monday.findItemBySlackThread((now + 1).toFixed(6), BUSY_CH), null);
assert.deepEqual(take(), []);
console.log('3 ok: non-task reactions cost 0 calls');

// 4. The app links a new task thread: known at once, only the write itself.
const newTs = (now + 2).toFixed(6);
await monday.updateSlackThreadId('7777', newTs, TASK_CH);
assert.equal(await monday.findItemBySlackThread(newTs, TASK_CH), '7777');
assert.deepEqual(take(), ['write']);
console.log('4 ok: newly linked thread found immediately, no extra reads');

// 5. Unlinking removes it.
await monday.clearSlackThreadId('7777');
take();
assert.equal(await monday.findItemBySlackThread(newTs, TASK_CH), null);
console.log('5 ok: unlinked thread no longer matches');

// 6. A brand-new thread in the task channel right after a rebuild: no early rebuild inside 2 minutes.
assert.equal(await monday.findItemBySlackThread((now + 3).toFixed(6), TASK_CH), null);
assert.deepEqual(take(), []);
console.log('6 ok: no rebuild storm within 2 minutes');

// 7. Legacy (ts only) and no-channel lookups still match.
assert.equal(await monday.findItemBySlackThread(items[10].v.split(':')[1]), items[10].id);
take();
console.log('7 ok: lookup without channel matches the task channel format');

console.log('stats', JSON.stringify({ ...monday.threadIndexStats(), builtAt: undefined }));
server.close();
