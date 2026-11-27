import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-server-'));
Object.assign(process.env, { DB_PATH: path.join(temp, 'app.db'), FILES_DIR: path.join(temp, 'files'), SWARM_ROLE: 'standalone', NODE_ENV: 'test', SESSION_SECRET: 'flow-fixture', COMPUTER_PROVIDER: 'local', SWARM_NO_SCHEDULER: '1', INKBOX_TUNNEL: '0' });
for (const key of ['DIRECT_API_KEY','OPENROUTER_API_KEY','COMPOSIO_API_KEY','XAI_API_KEY']) delete process.env[key];
const { db } = await import('../../server/src/db.js');
const { seedFlow } = await import('./seed.mjs');
const { userId } = seedFlow();
const { getFlow, touchFlow, recordFlowConnections } = await import('../../server/src/flow/cache.js');
const { flowStore, configureFlowRefresh, requestFlowRefresh } = await import('../../server/src/flow/summary.js');
const { flowApi } = await import('../../server/src/flow/routes.js');
const { hub } = await import('../../server/src/lib/hub.js');
const { Hono } = await import('hono');
const app = new Hono().route('/api', flowApi);
const request = (id: string, method = 'GET', body?: unknown, headers: Record<string,string> = {}) => app.request(`http://localhost/api/bots/${id}/flow${method === 'POST' ? '/refresh' : ''}`, { method, headers: { cookie: 'swarm_session=flow-test-token', 'Content-Type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const previousFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('Flow attempted a network request'); };
after(() => { globalThis.fetch = previousFetch; db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

test('authenticated GET is byte stable with ETag and private caching', async () => {
  const first = await request('flow-rich'), second = await request('flow-rich');
  assert.equal(first.status, 200); assert.equal(await first.text(), await second.text());
  assert.equal(first.headers.get('cache-control'), 'private, no-cache');
  const unchanged = await request('flow-rich', 'GET', undefined, { 'If-None-Match': first.headers.get('etag')! }); assert.equal(unchanged.status, 304);
});
test('auth, tenancy, hidden agents and rooms are uniformly refused', async () => {
  assert.equal((await app.request('http://localhost/api/bots/flow-rich/flow')).status, 401);
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run('other', 'other@example.test', 'Another test account', 1);
  db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run('foreign', 'other', 'Other agent', 1, 1);
  db.prepare('INSERT INTO bots(id,user_id,name,kind,hidden,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('room', userId, 'Test room', 'room', 0, 1, 1);
  db.prepare('INSERT INTO bots(id,user_id,name,hidden,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('hidden', userId, 'Hidden helper', 1, 1, 1);
  const responses = await Promise.all(['foreign','missing','room','hidden'].map(async id => { const r = await request(id); assert.equal(r.status, 404); return r.text(); })); assert.equal(new Set(responses).size, 1);
});
test('warm under 15 ms and cold under 150 ms, 30 routines and 40 apps, offline', () => {
  const start = performance.now(); const model = getFlow(userId, 'flow-many'); const cold = performance.now() - start;
  const times = Array.from({ length: 30 }, () => { const t = performance.now(); assert.equal(getFlow(userId, 'flow-many').version, model.version); return performance.now() - t; });
  const warm = Math.max(...times); assert.ok(cold < 150, `${cold}ms`); assert.ok(warm < 15, `${warm}ms`);
  fs.mkdirSync('.context/flow', { recursive: true }); fs.writeFileSync('.context/flow/performance.json', JSON.stringify({ coldMs: cold, warmMaxMs: warm, samples: times }, null, 2));
  console.log(`FLOW PERF cold=${cold.toFixed(2)}ms warm_max=${warm.toFixed(2)}ms samples=30`);
});
test('cache rebuilds and emits one committed event for changes to each input class', () => {
  let current = getFlow(userId, 'flow-rich'); const events: unknown[] = []; const stop = hub.subscribe(userId, e => { if (e.type === 'flow') events.push(e); });
  const changes = [() => db.prepare('UPDATE bots SET instructions=instructions || ? WHERE id=?').run('\n4. Send report', 'flow-rich'), () => db.prepare('UPDATE skills SET body=body || ? WHERE bot_id=?').run(' Updated', 'flow-rich'), () => db.prepare('UPDATE routines SET schedule=? WHERE bot_id=?').run('Tuesdays 10:00', 'flow-rich'), () => db.prepare('UPDATE handoff_links SET mode=? WHERE id=?').run('auto', 'send'), () => recordFlowConnections(userId, [{ id: 'calendar', name: 'Calendar' }]), () => db.prepare('DELETE FROM mcp_servers WHERE user_id=?').run(userId), () => db.prepare('UPDATE bots SET suggestions_snapshot=NULL WHERE id=?').run('flow-rich'), () => db.prepare('UPDATE loops SET status=? WHERE id=?').run('succeeded', 'lp_fixture')];
  for (const change of changes) { change(); const next = getFlow(userId, 'flow-rich'); assert.notEqual(next.inputsHash, current.inputsHash); assert.equal(next.version, current.version + 1); current = next; }
  assert.equal(events.length, changes.length); getFlow(userId, 'flow-rich'); assert.equal(events.length, changes.length); stop();
});
test('summary tool store uses context ownership, strict validation, current hash and Auto fallback', async () => {
  const ctx = { userId, botId: 'flow-rich', jobId: 'fixture-job', toolCallId: 'fixture-call' };
  await flowStore.writeFlowSummary(ctx, { steps: [{ label: 'Review the sources' }] });
  assert.equal(getFlow(userId, 'flow-rich').source, 'agent+auto');
  await assert.rejects(flowStore.writeFlowSummary({ ...ctx, userId: 'other' }, { steps: [{ label: 'Other' }] }));
  await assert.rejects(flowStore.writeFlowSummary(ctx, { steps: [{ label: 'x'.repeat(41) }] }));
  await assert.rejects(flowStore.writeFlowSummary(ctx, { steps: [{ label: 'Valid' }], userId: 'other' } as never));
  db.prepare('UPDATE bots SET instructions=? WHERE id=?').run('Draft a shorter report.', 'flow-rich');
  assert.equal(getFlow(userId, 'flow-rich').source, 'auto');
});
test('refresh enqueues exactly once per ten minutes; failed enqueue does not consume the slot', async () => {
  let calls = 0; configureFlowRefresh(() => { calls++; });
  const results = await Promise.all(Array.from({ length: 8 }, () => request('flow-empty', 'POST', {}).then(r => r.json())));
  assert.equal(results.filter(r => r.accepted).length, 1); assert.equal(calls, 1);
  configureFlowRefresh(() => { throw new Error('Queue unavailable'); }); assert.throws(() => requestFlowRefresh(userId, 'flow-suggestions'));
  configureFlowRefresh((_id, text, options) => { calls++; assert.match(text, /write_flow_summary once/); assert.equal(options.reply, false); });
  assert.equal(requestFlowRefresh(userId, 'flow-suggestions').accepted, true);
  assert.equal((await request('flow-empty', 'POST', { botId: 'foreign' })).status, 400);
});
test('touch emits a debounced per-user SSE invalidation', async () => {
  await new Promise(r => setTimeout(r, 550));
  const events: unknown[] = [], other: unknown[] = []; const stop = hub.subscribe(userId, e => events.push(e)), stopOther = hub.subscribe('other', e => other.push(e));
  touchFlow('flow-rich'); touchFlow('flow-rich'); touchFlow('flow-rich'); await new Promise(r => setTimeout(r, 550));
  assert.equal(events.length, 1); assert.equal(other.length, 0); stop(); stopOther();
});
test('kill switch and per-user flag disable reads and refresh', async () => {
  process.env.HANDOFFS_DISABLED = '1'; assert.equal((await request('flow-rich')).status, 503); assert.equal((await request('flow-rich', 'POST', {})).status, 503); delete process.env.HANDOFFS_DISABLED;
  db.prepare('INSERT INTO handoff_user_settings(user_id,enabled,updated_at) VALUES(?,0,?)').run(userId, 1);
  assert.equal((await request('flow-rich')).status, 503);
});
