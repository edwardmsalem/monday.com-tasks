// Run with: npx tsx --test test/triageAccountDeadlineRoutes.test.ts
// HTTP checks for POST /tasks/account-card and POST /tasks/deadline/calendar that stop before
// Monday or Google: auth and input validation only.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';

// triageApi.ts and autoFollowUp.ts start module-level setInterval cleanups on import, which
// would keep this test process alive. Fake setInterval for the import so the file can exit.
mock.timers.enable({ apis: ['setInterval'] });
process.env.CORE_API_KEY = process.env.CORE_API_KEY || 'test-key-1124';
const KEY = process.env.CORE_API_KEY;
const { default: router } = await import('../src/routes/triageApi.js');

const app = express();
app.use(router);
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.closeAllConnections(); server.close(); mock.timers.reset(); });

async function post(path: string, body: unknown, auth = true) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${KEY}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

test('account-card needs the API key', async () => {
  assert.equal((await post('/tasks/account-card', { email: 'a@x.com' }, false)).status, 401);
});

test('account-card refuses a missing or non-email address with 400', async () => {
  for (const body of [{}, { email: '' }, { email: 'nope' }, { email: 'a@x.com, b@y.com' }, { email: 7 }]) {
    const r = await post('/tasks/account-card', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.ok(typeof r.json.error === 'string');
  }
});

test('deadline/calendar needs the API key', async () => {
  assert.equal((await post('/tasks/deadline/calendar', { title: 't', dueDate: '2026-12-01' }, false)).status, 401);
});

test('deadline/calendar refuses a missing title or a bad date with 400 and success false', async () => {
  for (const body of [{ dueDate: '2026-12-01' }, { title: 't' }, { title: 't', dueDate: '2026-02-30' }, { title: 't', dueDate: 'tomorrow' }]) {
    const r = await post('/tasks/deadline/calendar', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.success, false);
    assert.ok(typeof r.json.error === 'string');
  }
});
