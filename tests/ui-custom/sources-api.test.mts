import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test, mock } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { seedDashboard, dashboardParams } from '../fixtures/dashboard.seed.mts';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-sources-'));
Object.assign(process.env, { NODE_ENV: 'test', DB_PATH: path.join(temp, 'test.db'), FILES_DIR: path.join(temp, 'files'), CLI_PROFILES_DIR: path.join(temp, 'profiles'),
  SWARM_ROLE: 'standalone', SWARM_NO_SCHEDULER: '1', SESSION_SECRET: 'fixture-session', COMPUTER_PROVIDER: 'local', INKBOX_TUNNEL: '0',
  DIRECT_API_KEY: '', OPENROUTER_API_KEY: '', COMPOSIO_API_KEY: '', APP_URL: 'http://localhost:1', SERVER_URL: 'http://localhost:1' });
const fetchOriginal = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Sources must not use provider network calls'); };
const fixture = await seedDashboard();
const { db } = await import('../../server/src/db.js');
const { SOURCES } = await import('../../server/src/ui/sources/catalog.js');
const { DataExecutor } = await import('../../server/src/ui/sources/executor.js');
const { createDataApi } = await import('../../server/src/ui/data-routes.js');
const { Hono } = await import('hono');
const [a, b] = fixture.users;
const executors: InstanceType<typeof DataExecutor>[] = [];
const executor = () => { const instance = new DataExecutor(); executors.push(instance); return instance; };
const data = executor();
const read = (userId: string, source: string, params: unknown = {}) => data.execute(userId, { key: source, source,
  params: params && typeof params === 'object' && !Array.isArray(params) ? { ...dashboardParams(source), ...params } : params });
const app = (options: Parameters<typeof createDataApi>[0] = {}) => new Hono().route('/api/ui', createDataApi({ executor: executor(), enabled: () => true, ...options }));
const request = (target: ReturnType<typeof app>, body: unknown, user = a, headers: Record<string, string> = {}) => target.request('/api/ui/data', {
  method: 'POST', headers: { 'Content-Type': 'application/json', cookie: `swarm_session=${user.token}`, ...headers }, body: JSON.stringify(body),
});
const batch = (count = 1) => ({ requests: Array.from({ length: count }, (_, n) => ({ key: `k${n}`, source: 'tasks.counts', params: {} })) });
after(() => { for (const data of executors) data.close(); globalThis.fetch = fetchOriginal; db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const expectedCounts: Record<string, number> = { 'handoffs.list': 0, 'loops.list': 0, 'outputs.recent': 0, 'connectors.status': 0, 'email.recent': 0, 'calendar.upcoming': 0, 'crm.deals': 0, 'tasks.counts': 33, 'tasks.list': 33, 'tasks.series': 33, 'bots.list': 30, 'bots.status': 30,
  'needsYou.list': 28, 'usage.summary': 7, 'usage.series': 7, 'usage.windows': 1, 'routines.list': 28, 'routines.upcoming': 196,
  'runs.recent': 33, 'runs.counts': 33, 'runs.series': 33 };
for (const source of SOURCES) test(`${source.id}: allowlisted fields, caps and disjoint accounts`, async () => {
  const own = await read(a.id, source.id), foreign = await read(b.id, source.id);
  assert.equal(own.ok, true, JSON.stringify(own)); assert.equal(foreign.ok, true, JSON.stringify(foreign));
  if (!own.ok || !foreign.ok) return;
  assert.equal(own.count, expectedCounts[source.id]);
  assert.ok(own.fetchedAt > 0);
  for (const result of [own, foreign]) {
    assert.ok((result.rows?.length ?? 0) <= (source.series ? 31 : 25));
    for (const row of [...result.rows ?? [], ...result.value ? [result.value] : []]) for (const key of Object.keys(row)) assert.ok(source.fields.includes(key), `${source.id}.${key}`);
    assert.doesNotMatch(JSON.stringify(result), /FORBIDDEN_|"(?:prompt|instructions|note|text|key|memory|trigger|error|seq|user_id)":/);
  }
  assert.doesNotMatch(JSON.stringify(own), /Fixture B|qa-temp-dashboard-b/);
  assert.doesNotMatch(JSON.stringify(foreign), /Fixture A|qa-temp-dashboard-a/);
  if (expectedCounts[source.id] > 0 && !source.id.startsWith('usage.')) assert.notEqual(own.count, foreign.count);
  if (source.id === 'usage.summary') {
    assert.equal(own.value!.costUsd, 1.75); assert.equal(foreign.value!.costUsd, 693);
    assert.equal(own.value!.tokens, 840); assert.equal(foreign.value!.tokens, 70000);
  }
  if (source.id === 'usage.series') assert.ok(own.rows!.every(row => row.value === 0.25));
  if (source.id === 'tasks.series') assert.equal(own.rows!.reduce((n, row) => n + Number(row.done), 0), 11);
  if (source.id === 'runs.series') {
    assert.equal(own.rows!.reduce((n, row) => n + Number(row.value), 0), 33);
    assert.equal(foreign.rows!.reduce((n, row) => n + Number(row.value), 0), 6);
  }
  if (source.id === 'runs.counts') assert.deepEqual(own.value, { completed: 8, failed: 9, running: 8, queued: 8 });
  if (source.id === 'usage.windows') {
    const { planUsageSummary } = await import('../../server/src/plan-usage.js');
    assert.deepEqual(own.value, (({ plan, ownKeys }) => ({ plan, ownKeys }))(planUsageSummary(a.id)));
    assert.equal(own.available, true);
  }
});

test('limited Bot status aggregates and filtered task pages retain exact counts and ordering', async () => {
  const status = await read(a.id, 'bots.status', { limit: 3 }); assert.ok(status.ok);
  if (status.ok) { assert.equal(status.count, 30); assert.deepEqual(status.rows!.map(row => [row.id, row.openTasks]), [[`${a.id}-bot-0`, 2], [`${a.id}-bot-1`, 2], [`${a.id}-bot-2`, 0]]); }
  const page = await read(a.id, 'tasks.list', { botId: `${a.id}-bot-0`, state: 'working', limit: 1 }); assert.ok(page.ok);
  if (page.ok) { assert.equal(page.count, 2); assert.equal(page.rows!.length, 1); assert.equal(page.rows![0].id, `${a.id}-task-0`); assert.equal(page.rows![0].botName, 'Fixture A Bot 0'); }
  const counts = await read(a.id, 'tasks.counts', { botId: `${a.id}-bot-2` }); assert.ok(counts.ok);
  if (counts.ok) assert.deepEqual(counts.value, { working: 0, needs_input: 0, done: 2, total: 2 });
  const series = await read(a.id, 'tasks.series', { botId: `${a.id}-bot-2` }); assert.ok(series.ok);
  if (series.ok) { assert.equal(series.count, 2); assert.equal(series.rows!.reduce((n, row) => n + Number(row.done), 0), 2); }
});

test('all 21 sources reject unknown params and never accept a user id', async () => {
  assert.equal(SOURCES.length, 21);
  for (const source of SOURCES) for (const params of [{ userId: b.id }, { sql: 'SELECT * FROM users' }, { url: 'https://example.test' }, [], null]) {
    const result = await read(a.id, source.id, params); assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'invalid_value');
  }
});
test('foreign and missing bot ids return identical not_found results for every scoped source', async () => {
  for (const source of ['tasks.counts', 'tasks.list', 'tasks.series', 'routines.list', 'runs.recent', 'runs.counts']) {
    for (const botId of [`${b.id}-bot-0`, 'missing-bot']) {
      const result = await read(a.id, source, { botId });
      assert.equal(result.ok, false); if (!result.ok) assert.equal(result.code, 'not_found');
    }
    assert.equal((await read(a.id, source, { botId: `${a.id}-bot-0` })).ok, true);
  }
});
test('source parameter bounds reject oversized, fractional, negative and unknown values', async () => {
  for (const limit of [0, -1, 26, 1.5, '10']) assert.equal((await read(a.id, 'tasks.list', { limit })).ok, false);
  for (const days of [0, 15, 1.5]) assert.equal((await read(a.id, 'routines.upcoming', { days })).ok, false);
  for (const range of ['forever', '', 31]) assert.equal((await read(a.id, 'usage.summary', { range })).ok, false);
  assert.equal((await read(a.id, 'tasks.list', { state: 'cancelled' })).ok, false);
  assert.equal((await read(a.id, 'usage.series', { metric: 'secrets' })).ok, false);
  assert.equal((await read(a.id, 'runs.series', { group: 'user' })).ok, false);
  const capped = await read(a.id, 'tasks.list', { limit: 25 }); assert.ok(capped.ok && capped.rows!.length === 25 && capped.count === 33);
  const state = await read(a.id, 'runs.series', { group: 'state' }); assert.ok(state.ok); if (state.ok) assert.deepEqual(state.rows!.map(row => row.value), [8, 9, 8, 8]);
});
test('runtime source ids, validation and fields match the frozen shared registry', async () => {
  const { SOURCES: shared } = await import('../../server/src/ui-config/registry-sources.js');
  assert.deepEqual(SOURCES.map(source => source.id), shared.map(source => source.id));
  for (const [n, source] of SOURCES.entries()) {
    assert.deepEqual(source.fields, shared[n].fields);
    for (const params of [{}, dashboardParams(source.id), { range: 'forever' }, { botId: '../foreign' }, { limit: 26 }]) {
      assert.equal(source.paramsSchema.safeParse(params).success, shared[n].paramsSchema.safeParse(params).success);
    }
    const direct = source.resolve(a.id, source.paramsSchema.parse(dashboardParams(source.id)) as any);
    for (const row of direct.rows ?? []) assert.ok(Object.keys(row).every(key => source.fields.includes(key)));
  }
});
test('empty accounts return zero counts, zero-filled series and a no-limit plan', async () => {
  const emptyId = 'qa-temp-dashboard-empty';
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(emptyId, 'empty@example.test', 'QA-Temp-Empty', Date.now());
  for (const source of SOURCES) {
    const result = await read(emptyId, source.id); assert.ok(result.ok, JSON.stringify(result));
    if (!result.ok) continue;
    if (source.id === 'usage.windows') {
      assert.equal(result.count, 1);
      assert.equal((result.value!.plan as any).usedCents, 0);
      assert.equal((result.value!.plan as any).limitCents, null);
      assert.equal((result.value!.plan as any).percentUsed, null);
      continue;
    }
    assert.equal(result.count, 0);
    if (source.series) assert.ok(result.rows!.every(row => Object.entries(row).every(([key, value]) => key === 'day' || key === 'state' || value === 0)));
    else assert.equal(result.rows?.length ?? 0, 0);
  }
});
test('Bot status incorporates live state without exposing activity or pending input details', async () => {
  const { setLive } = await import('../../server/src/store.js');
  const botId = `${a.id}-bot-1`;
  setLive(botId, { isRunning: true });
  const fresh = executor();
  const result = await fresh.execute(a.id, { key: 'live', source: 'bots.status', params: {} });
  assert.ok(result.ok); if (result.ok) assert.equal(result.rows!.find(row => row.id === botId)?.status, 'working');
  setLive(botId, { isRunning: false });
});
test('usage windows read only cached platform observations and never probe a connected provider', async () => {
  const { platformState } = await import('../../server/src/agent/platform-state.js');
  const { createCliPairing, selectCli } = await import('../../server/src/cli/store.js');
  const { attachCliSocket, cliStatus, refreshCli } = await import('../../server/src/cli/bridge.js');
  const server = createServer(); attachCliSocket(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as any).port}/api/cli-bridge`);
  let probes = 0;
  socket.on('message', raw => {
    const message = JSON.parse(String(raw)); if (message.type === 'welcome' || message.method === 'cancel') return;
    if (message.method === 'catalog') probes++;
    socket.send(JSON.stringify({ id: message.id, result: message.method === 'status'
      ? { claude: { installed: true, authenticated: true, subscription: true }, codex: { installed: false, authenticated: false, subscription: false } }
      : { models: [], defaultModel: null, plan: null, usage: { available: true, checkedAt: Date.now(), windows: [{ label: 'Weekly', usedPercent: 37, resetsAt: null }] } } }));
  });
  try {
    await once(socket, 'open'); socket.send(JSON.stringify({ type: 'hello', version: 1, codexExecOnly: true, token: createCliPairing(a.id), device: 'QA-Temp-Bridge' }));
    for (let n = 0; n < 100 && !cliStatus(a.id).connected; n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(cliStatus(a.id).connected, true); await refreshCli(a.id); selectCli(a.id, 'claude');
    // The platform owns discovery. The source consumes only its recorded public facts.
    await platformState(a.id, `${a.id}-bot-0`);
    assert.equal(probes, 1);
    const fresh = executor();
    const result = await fresh.execute(a.id, { key: 'windows', source: 'usage.windows', params: {} });
    assert.ok(result.ok); if (result.ok) assert.deepEqual({ rows: result.rows, available: result.available, count: result.count }, {
      rows: [{ label: 'Claude plan', usedPercent: 37, resetsAt: null }], available: true, count: 1,
    });
    assert.equal(probes, 1, 'the dashboard did not discover a catalog');
    const foreign = await fresh.execute(b.id, { key: 'windows', source: 'usage.windows', params: {} });
    assert.ok(foreign.ok && foreign.available === true && foreign.count === 1);
    if (foreign.ok) assert.equal((foreign.value!.plan as any).percentUsed, null);
  } finally { selectCli(a.id, null); socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('cache canonicalizes defaults and parameter order, expires at 10 seconds, isolates users and clones replies', async () => {
  let clock = Date.now(); const cached = new DataExecutor(() => clock); executors.push(cached);
  const params = { botId: `${a.id}-bot-0`, limit: 10 };
  const first = await cached.execute(a.id, { key: 'first', source: 'tasks.list', params }); assert.ok(first.ok);
  db.prepare('UPDATE tasks SET title=? WHERE id=?').run('Fixture A changed', `${a.id}-task-0`);
  const same = await cached.execute(a.id, { key: 'other-key', source: 'tasks.list', params: { limit: 10, botId: params.botId } });
  assert.deepEqual(same, first);
  if (same.ok) same.rows![0].title = 'Caller mutation';
  clock += 9999;
  assert.deepEqual(await cached.execute(a.id, { key: 'same-default', source: 'tasks.list', params: { botId: params.botId } }), first);
  clock++;
  const expired = await cached.execute(a.id, { key: 'expired', source: 'tasks.list', params });
  assert.ok(expired.ok && expired.rows!.some(row => row.title === 'Fixture A changed'));
  const foreign = await cached.execute(b.id, { key: 'foreign', source: 'tasks.list', params: {} });
  assert.ok(foreign.ok); assert.doesNotMatch(JSON.stringify(foreign), /Fixture A/);
  // An old cache key is not authorization after a Bot is reassigned.
  db.prepare('UPDATE bots SET user_id=? WHERE id=?').run(b.id, params.botId);
  const revoked = await cached.execute(a.id, { key: 'revoked', source: 'tasks.list', params });
  assert.ok(!revoked.ok && revoked.code === 'not_found');
  db.prepare('UPDATE bots SET user_id=? WHERE id=?').run(a.id, params.botId);
});
test('signed-in API accepts 24 keys and returns per-key errors without failing healthy data', async () => {
  const target = app(), body = batch(24);
  body.requests[1].source = 'unknown'; body.requests[2].params = { userId: b.id } as any;
  const response = await request(target, body); assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const { results } = await response.json(); assert.equal(Object.keys(results).length, 24);
  assert.equal(results.k0.ok, true); assert.equal(results.k1.code, 'not_found'); assert.equal(results.k2.code, 'invalid_value'); assert.equal(results.k23.ok, true);
  for (const bad of [batch(0), batch(25), { ...batch(), userId: b.id }, { requests: [batch().requests[0], batch().requests[0]] }]) assert.equal((await request(target, bad)).status, 422);
});
test('SSE-driven no-cache refresh returns current data before the normal cache TTL', async () => {
  const target = app();
  const first = await (await request(target, batch())).json(); assert.equal(first.results.k0.value.working, 11);
  db.prepare("UPDATE tasks SET state='done' WHERE id=?").run(`${a.id}-task-0`);
  try {
    const cached = await (await request(target, batch())).json(); assert.equal(cached.results.k0.value.working, 11);
    const refreshed = await (await request(target, batch(), a, { 'cache-control': 'no-cache' })).json();
    assert.equal(refreshed.results.k0.value.working, 10); assert.equal(refreshed.results.k0.value.done, 12);
  } finally { db.prepare("UPDATE tasks SET state='working' WHERE id=?").run(`${a.id}-task-0`); }
});
test('API uses session authentication, feature gates, JSON and origin boundaries', async () => {
  const target = app();
  assert.equal((await request(target, batch(), a, { cookie: '' })).status, 401);
  assert.equal((await request(target, batch(), a, { origin: 'https://foreign.example.test' })).status, 403);
  assert.equal((await request(target, batch(), a, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await request(app({ enabled: () => false }), batch())).status, 404);
  assert.equal((await request(target, { requests: [], padding: 'x'.repeat(256 * 1024) })).status, 413);
  assert.equal((await request(target, { requests: [], padding: 'x'.repeat(256 * 1024) }, a, { 'content-length': '1' })).status, 413);
  assert.equal((await target.request('/api/ui/data', { method: 'POST', headers: { cookie: `swarm_session=${a.token}`, 'content-type': 'application/json' }, body: '{' })).status, 400);
});
test('real feature flags honor account overrides and never expose disabled data', async () => {
  const { initUiDatabase } = await import('../../server/src/ui/db.js'); initUiDatabase(db);
  const original = process.env.UI_CUSTOMIZATION;
  const target = new Hono().route('/api/ui', createDataApi({ executor: executor() }));
  try {
    process.env.UI_CUSTOMIZATION = 'off'; assert.equal((await request(target, batch())).status, 404);
    db.prepare('INSERT INTO account_preferences(user_id,ui_custom_enabled,updated_at) VALUES(?,1,?) ON CONFLICT(user_id) DO UPDATE SET ui_custom_enabled=1').run(a.id, Date.now());
    assert.equal((await request(target, batch())).status, 200);
    assert.equal((await request(target, batch(), b)).status, 404);
    process.env.UI_CUSTOMIZATION = 'on';
    db.prepare('UPDATE account_preferences SET ui_custom_enabled=0 WHERE user_id=?').run(a.id);
    assert.equal((await request(target, batch())).status, 404);
    assert.equal((await request(target, batch(), b)).status, 200);
  } finally {
    if (original === undefined) delete process.env.UI_CUSTOMIZATION; else process.env.UI_CUSTOMIZATION = original;
    db.prepare('UPDATE account_preferences SET ui_custom_enabled=NULL WHERE user_id=?').run(a.id);
  }
});
test('task day boundaries honor account timezone across daylight saving changes', () => {
  const userId = 'qa-temp-dashboard-timezone', botId = `${userId}-bot`;
  db.prepare('INSERT INTO users(id,email,name,created_at,timezone) VALUES(?,?,?,?,?)').run(userId, 'timezone@example.test', 'QA-Temp-Timezone', Date.now(), 'America/New_York');
  db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(botId, userId, 'Fixture timezone Bot', Date.now(), Date.now());
  for (const [index, timestamp] of ['2026-03-08T04:30:00Z', '2026-03-09T03:30:00Z'].entries()) {
    const at = Date.parse(timestamp);
    db.prepare('INSERT INTO tasks(id,bot_id,title,state,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(`${botId}-${index}`, botId, 'Fixture boundary', 'done', at, at);
  }
  const clock = mock.method(Date, 'now', () => Date.parse('2026-03-09T04:30:00Z'));
  try {
    const source = SOURCES.find(source => source.id === 'tasks.series')!;
    const result = source.resolve(userId, { range: '7d' });
    assert.deepEqual(result.rows!.filter(row => row.created), [
      { day: '2026-03-07', created: 1, done: 1 }, { day: '2026-03-08', created: 1, done: 1 },
    ]);
  } finally { clock.mock.restore(); }
});
test('API rate limits 30 batches, not widgets, with an independent rolling window per user', async () => {
  let at = Date.now(); const target = app({ clock: () => at });
  for (let n = 0; n < 30; n++) assert.equal((await request(target, batch(24))).status, 200);
  let limited = await request(target, batch()); assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '60');
  assert.equal((await request(target, batch(), b)).status, 200);
  at += 59_999; assert.equal((await request(target, batch())).status, 429);
  at++; assert.equal((await request(target, batch())).status, 200);
});
test('200 ms deadline interrupts a real CPU-bound SQLite query and subsequent requests recover', async () => {
  const bounded = executor();
  assert.equal((await bounded.execute(a.id, { key: 'warm', source: 'bots.list', params: {} })).ok, true);
  db.exec(`ALTER TABLE tasks RENAME TO dashboard_original_tasks;
    CREATE VIEW tasks AS WITH RECURSIVE work(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM work WHERE n<1000000000)
    SELECT t.* FROM dashboard_original_tasks t CROSS JOIN work;`);
  try {
    const start = performance.now();
    const slowRead = bounded.execute(a.id, { key: 'slow', source: 'tasks.counts', params: {} });
    const healthyRead = bounded.execute(a.id, { key: 'healthy', source: 'bots.list', params: { limit: 1 } });
    const slow = await slowRead;
    const elapsed = performance.now() - start;
    assert.ok(!slow.ok && slow.code === 'timeout', JSON.stringify(slow));
    assert.ok(elapsed >= 180 && elapsed < 600, `deadline took ${elapsed} ms`);
    assert.equal((await healthyRead).ok, true, 'another source in the batch survives a query timeout');
  } finally { db.exec('DROP VIEW tasks; ALTER TABLE dashboard_original_tasks RENAME TO tasks;'); }
  const recovered = await bounded.execute(a.id, { key: 'recovered', source: 'tasks.counts', params: {} });
  assert.ok(recovered.ok && recovered.count === 33, JSON.stringify(recovered));
});
