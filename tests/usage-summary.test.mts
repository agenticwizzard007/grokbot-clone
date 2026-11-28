import assert from 'node:assert/strict';
import { after, beforeEach, test, mock } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { WebSocket } from 'ws';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/usage-summary.json', import.meta.url), 'utf8'));
const at = Date.parse(fixture.at);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-summary-'));
let onModelRequest = () => {};
const provider = http.createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  if (req.url === '/models') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'fixture/model', name: 'Fixture model', supported_parameters: ['tools'],
      pricing: { prompt: '0.000003', completion: '0.000015' }, context_length: 10000 }] }));
    return;
  }
  assert.equal(req.url, '/responses');
  onModelRequest();
  const response = { id: 'fixture-response', output: [], usage: { input_tokens: 1, output_tokens: 1, cost: 0.13, is_byok: true } };
  if (JSON.parse(body).stream) {
    res.setHeader('content-type', 'text/event-stream');
    res.end(`data: ${JSON.stringify({ type: 'response.completed', response })}\n\ndata: [DONE]\n\n`);
  } else {
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(response));
  }
});
provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
const base = `http://127.0.0.1:${(provider.address() as any).port}`;
Object.assign(process.env, { NODE_ENV: 'test', SWARM_ROLE: 'standalone', DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'),
  CLI_PROFILES_DIR: path.join(root, 'profiles'), SESSION_SECRET: 'fixture-summary', COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '',
  OPENROUTER_API_KEY: 'fixture-native', OPENROUTER_BASE_URL: base, DIRECT_API_KEY: 'fixture-direct', DIRECT_BASE_URL: base,
  LLM_PROVIDER: 'openrouter', INKBOX_TUNNEL: '0', SWARM_NO_SCHEDULER: '1', APP_URL: base, SERVER_URL: base });
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  assert.equal(url.origin, base, 'Only the seeded local provider may be called');
  return originalFetch(input, init);
};
const { db } = await import('../server/src/db.js');
const { createAccount } = await import('../server/src/accounts.js');
const { recordModelUsage, recordUnits, withUsage } = await import('../server/src/usage.js');
const { planUsageSummary, planUsageRange, displayUsagePercent, OWN_KEYS_LABEL } = await import('../server/src/plan-usage.js');
const { migrateUsageKeyKind } = await import('../server/src/usage-key-kind.js');
const { usageApi } = await import('../server/src/routes-usage.js');
const { resolveSource } = await import('../server/src/ui/sources/queries.js');
const { saveOpenRouterKey } = await import('../server/src/providers/openrouter.js');
const { selectCli } = await import('../server/src/cli/store.js');
const { hub } = await import('../server/src/lib/hub.js');
const { llmClient } = await import('../server/src/lib/llm.js');
const user = createAccount({ email: 'summary-a@example.test', name: 'Fixture A' }).id;
const other = createAccount({ email: 'summary-b@example.test', name: 'Fixture B' }).id;
db.prepare('UPDATE users SET timezone=? WHERE id=?').run(fixture.timezone, user);
db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(session_hash(?),?,?,?)')
  .run('fixture-summary-session', user, at - 1000, Date.parse('2099-01-01'));
const app = new Hono().route('/api/usage', usageApi);
const request = () => {
  db.prepare('UPDATE auth_sessions SET created_at=?,last_seen_at=?,expires_at=? WHERE user_id=?')
    .run(Date.now(), Date.now(), Date.now() + 3600000, user);
  return app.request('/api/usage/summary?scope=all&userId=foreign', { headers: { cookie: 'swarm_session=fixture-summary-session' } });
};
const seed = (event: any, time = at, account = user) => db.prepare(`INSERT INTO usage_events
  (user_id,kind,provider,model,cost_usd,cost_source,key_kind,request_id,created_at) VALUES (?,'chat','openrouter','fixture',?,?,?,?,?)`)
  .run(account, event.cost, event.source ?? null, event.keyKind, event.id ?? 'fixture', time);
const ledger = (start: number, end: number, keyKind?: string, observedAt = at) => (db.prepare(`SELECT cost_usd FROM usage_events
  WHERE user_id=? AND created_at>=? AND created_at<? AND created_at<=? ${keyKind ? 'AND key_kind=?' : ''}`)
  .all(user, start, end, observedAt, ...(keyKind ? [keyKind] : [])) as { cost_usd: number | null }[])
  .reduce((sum, row) => sum + (row.cost_usd === null ? 0 : Math.round(row.cost_usd * 100)), 0);

async function reconciles(observedAt = at) {
  const clock = mock.method(Date, 'now', () => observedAt);
  try {
    const response = await request(); assert.equal(response.status, 200);
    const summary = await response.json();
    assert.deepEqual(summary, planUsageSummary(user, observedAt));
    for (const [kind, cents] of [['native', summary.plan.usedCents], ['personal', summary.ownKeys.usedCents], ['unknown', summary.uncategorized.usedCents]] as const) {
      assert.equal(cents, ledger(summary.plan.periodStart, summary.plan.periodEnd, kind, observedAt));
    }
    assert.equal(summary.week.planUsedCents, ledger(summary.week.start, summary.week.end, 'native', observedAt));
    assert.equal(summary.week.ownKeysUsedCents, ledger(summary.week.start, summary.week.end, 'personal', observedAt));
    assert.equal(summary.week.uncategorizedCents, ledger(summary.week.start, summary.week.end, 'unknown', observedAt));
    return summary;
  } finally { clock.mock.restore(); }
}

beforeEach(() => {
  mock.restoreAll();
  mock.method(Date, 'now', () => at);
  db.exec('DELETE FROM usage_events; DELETE FROM provider_connections; DELETE FROM cli_preferences;');
  db.prepare('UPDATE users SET timezone=? WHERE id=?').run(fixture.timezone, user);
  delete process.env.SWARM_PLAN_LIMIT_USD; delete process.env.SWARM_PLAN_NAME;
  onModelRequest = () => {};
});
after(async () => {
  mock.restoreAll(); globalThis.fetch = originalFetch;
  provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
  db.close(); fs.rmSync(root, { recursive: true, force: true });
});

test('API, helper, dashboard and ledger reconcile mixed usage per event to the cent', async () => {
  for (const event of fixture.events) seed(event);
  seed({ cost: 999, keyKind: 'native', source: 'provider' }, at, other);
  process.env.SWARM_PLAN_LIMIT_USD = '0.20'; process.env.SWARM_PLAN_NAME = 'Fixture plan';
  const response = await request(); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const summary = await response.json();
  assert.deepEqual(summary, planUsageSummary(user, at));
  assert.equal(summary.computedAt, at); assert.equal(summary.plan.name, 'Fixture plan');
  assert.equal(summary.plan.usedCents, 5); assert.equal(summary.plan.estimatedCents, 3); assert.equal(summary.plan.unpricedRequests, 1);
  assert.equal(summary.plan.limitCents, 20); assert.equal(summary.plan.percentUsed, 25);
  assert.equal(summary.ownKeys.usedCents, 237); assert.equal(summary.ownKeys.requests, 3);
  assert.equal(summary.ownKeys.estimatedCents, 2); assert.equal(summary.ownKeys.unpricedRequests, 1); assert.equal(summary.ownKeys.label, OWN_KEYS_LABEL);
  assert.equal(summary.uncategorized.usedCents, 444); assert.equal(summary.uncategorized.requests, 2);
  assert.equal(summary.uncategorized.unpricedRequests, 1);
  for (const [kind, cents] of [['native', summary.plan.usedCents], ['personal', summary.ownKeys.usedCents], ['unknown', summary.uncategorized.usedCents]] as const) {
    assert.equal(cents, ledger(summary.plan.periodStart, summary.plan.periodEnd, kind));
  }
  assert.equal(summary.plan.usedCents + summary.ownKeys.usedCents + summary.uncategorized.usedCents, ledger(summary.plan.periodStart, summary.plan.periodEnd));
  assert.equal(summary.week.planUsedCents, ledger(summary.week.start, summary.week.end, 'native'));
  assert.equal(summary.week.days.length, 7); assert.equal(summary.week.days.reduce((sum: number, day: any) => sum + day.planUsedCents, 0), 5);
  assert.equal(summary.week.days.reduce((sum: number, day: any) => sum + day.ownKeysUsedCents, 0), 237);
  const widget = resolveSource('usage.summary', user, { range: '7d' });
  assert.equal(widget.value!.costUsd, summary.week.planUsedCents / 100);
  const series = resolveSource('usage.series', user, { range: '7d', metric: 'cost' });
  assert.deepEqual(series.rows!.map(day => day.value), summary.week.days.map((day: any) => day.planUsedCents / 100));
  fs.mkdirSync(path.join(import.meta.dirname, '../.context'), { recursive: true });
  fs.writeFileSync(path.join(import.meta.dirname, '../.context/usage-summary.fixture.json'), JSON.stringify(summary, null, 2) + '\n');
});

test('month boundaries are exclusive in the account timezone, including the next month', async () => {
  const start = Date.parse('2026-10-31T20:00:00Z'), end = Date.parse('2026-11-30T20:00:00Z');
  for (const [time, cost] of [[start - 1, 8], [start, 1], [end - 1, 2], [end, 4]]) seed({ cost, keyKind: 'native' }, time);
  const november = await reconciles(end - 1), december = await reconciles(end);
  assert.deepEqual([november.plan.periodStart, november.plan.periodEnd, november.plan.usedCents], [start, end, 300]);
  assert.equal(december.plan.periodStart, end); assert.equal(december.plan.usedCents, 400);
  assert.equal((await reconciles(start)).plan.usedCents, 100);
});

test('rolling week uses seven local calendar days across a DST boundary and month boundary', async () => {
  db.prepare('UPDATE users SET timezone=? WHERE id=?').run('America/New_York', user);
  const clock = Date.parse('2026-11-03T12:00:00Z'), start = Date.parse('2026-10-28T04:00:00Z');
  for (const time of [start - 1, start, Date.parse('2026-11-01T04:00:00Z'), Date.parse('2026-11-02T05:00:00Z'), clock, clock + 1]) seed({ cost: 0.01, keyKind: 'native' }, time);
  const summary = await reconciles(clock);
  assert.equal(summary.week.start, start); assert.equal(summary.week.end, Date.parse('2026-11-04T05:00:00Z'));
  assert.equal(summary.week.planUsedCents, 4); assert.equal(summary.plan.usedCents, 3);
  assert.deepEqual(summary.week.days.map(day => day.planUsedCents), [1, 0, 0, 0, 1, 1, 1]);
});

test('sub-cent rounding is per event, including exact half cents', async () => {
  for (const cost of [0.004, 0.004, 0.005, 0.005, 0.014, 0.014]) seed({ cost, keyKind: 'native' });
  const summary = await reconciles();
  assert.equal(summary.plan.usedCents, 4); assert.equal(summary.week.planUsedCents, 4);
  assert.equal(summary.plan.usedCents, ledger(summary.plan.periodStart, summary.plan.periodEnd, 'native'));
});

test('over-limit keeps raw percent while display is capped; no limit never invents percent', async () => {
  seed({ cost: 12.51, keyKind: 'native' });
  process.env.SWARM_PLAN_LIMIT_USD = '10.00';
  const over = await reconciles();
  assert.equal(over.plan.usedCents, 1251); assert.equal(over.plan.percentUsed, 125.1);
  assert.equal(displayUsagePercent(over.plan.percentUsed), 100);
  for (const config of ['', '0', '-1', 'not-a-number', 'Infinity', '1e99', '0.001']) {
    process.env.SWARM_PLAN_LIMIT_USD = config;
    const summary = await reconciles();
    assert.equal(summary.plan.limitCents, null); assert.equal(summary.plan.percentUsed, null);
    assert.equal(summary.plan.usedCents, 1251);
  }
  for (const value of [null, undefined, NaN, Infinity, -Infinity, -100, -0.1, 0, 0.1, 80, 100, 200, Number.MAX_VALUE]) {
    const displayed = displayUsagePercent(value);
    assert.ok(displayed === null || Number.isFinite(displayed) && displayed >= 0 && displayed <= 100);
  }
});

test('estimates and unpriced recording remain explicit, subscription rows cost zero', async () => {
  await recordModelUsage({ userId: user, model: 'fixture/model', provider: 'openrouter', response: { usage: { input_tokens: 10000, output_tokens: 1000 } } });
  await recordModelUsage({ userId: user, model: 'unpriced', provider: 'openrouter', response: {} });
  await recordModelUsage({ userId: user, model: 'fixture', response: { billing: 'subscription', provider: 'claude-cli', usage: { cost: 999 } } });
  const summary = await reconciles();
  assert.equal(summary.plan.usedCents, 5); assert.equal(summary.plan.estimatedCents, 5); assert.equal(summary.plan.unpricedRequests, 1);
  const rows = db.prepare('SELECT key_kind,cost_usd FROM usage_events ORDER BY id').all() as any[];
  assert.deepEqual(rows.map(row => row.key_kind), ['native', 'native', 'subscription']); assert.equal(rows[2].cost_usd, 0);
});

test('legacy migration includes disconnected-key history, is idempotent, and leaves unknown history separate', () => {
  const old = new Database(':memory:');
  try {
    old.exec(`CREATE TABLE users(id TEXT); CREATE TABLE provider_connections(user_id TEXT,provider TEXT,enabled INTEGER,encrypted_key TEXT);
      CREATE TABLE usage_events(user_id TEXT,cost_source TEXT);
      INSERT INTO users VALUES ('native'),('connected'),('disabled'),('removed');
      INSERT INTO provider_connections VALUES ('connected','openrouter',1,'fixture'),('disabled','openrouter',0,'fixture'),('removed','openrouter',1,NULL);
      INSERT INTO usage_events VALUES ('native','provider'),('connected','provider'),('disabled','estimate'),('removed',NULL),('removed','subscription'),(NULL,'provider'),('deleted','provider');`);
    migrateUsageKeyKind(old);
    const kinds = () => (old.prepare('SELECT key_kind FROM usage_events ORDER BY rowid').all() as any[]).map(row => row.key_kind);
    assert.deepEqual(kinds(), ['native', 'unknown', 'unknown', 'unknown', 'subscription', 'unknown', 'unknown']);
    old.exec("INSERT INTO provider_connections VALUES ('native','openrouter',1,'fixture')");
    migrateUsageKeyKind(old);
    assert.equal(kinds()[0], 'native', 'later key changes must not rewrite already migrated history');
  } finally { old.close(); }
});

test('recording separates OpenRouter personal keys from routing byok and platform voice', async () => {
  const events: unknown[] = [], foreign: unknown[] = [];
  const stop = hub.subscribe(user, event => { events.push(event); assert.ok(db.prepare('SELECT 1 FROM usage_events WHERE user_id=?').get(user)); });
  const stopForeign = hub.subscribe(other, event => foreign.push(event));
  try {
    await recordModelUsage({ userId: user, model: 'fixture', provider: 'openrouter', response: { usage: { cost: 1, is_byok: true } } });
    saveOpenRouterKey(user, 'fixture-personal-key', 'manual');
    await recordModelUsage({ userId: user, model: 'fixture', provider: 'openrouter', response: { usage: { cost: 2, is_byok: false } } });
    recordUnits({ userId: user, model: 'fixture-voice', provider: 'xai', units: 1, unit: 'minutes', costUsd: 3 });
    recordUnits({ userId: user, model: 'fixture-speech', provider: 'openrouter', units: 1, unit: 'characters', costUsd: 4 });
    await recordModelUsage({ userId: user, model: 'fixture', response: { billing: 'subscription', usage: { cost: 99 } } });
    const rows = db.prepare('SELECT key_kind FROM usage_events ORDER BY id').all() as any[];
    assert.deepEqual(rows.map(row => row.key_kind), ['native', 'personal', 'native', 'personal', 'subscription']);
    assert.deepEqual(events, Array.from({ length: 5 }, () => ({ type: 'usage' }))); assert.deepEqual(foreign, []);
    assert.equal(planUsageSummary(user).plan.usedCents, 400); assert.equal(planUsageSummary(user).ownKeys.usedCents, 600);
  } finally { stop(); stopForeign(); }
});

test('recorded charges emit usage after run cancellation and only after an admission commit', async () => {
  const { withRun } = await import('../server/src/agent/run-scope.js');
  const { transactionWithEffects } = await import('../server/src/lib/commit-effects.js');
  const controller = new AbortController(); controller.abort();
  const events: unknown[] = [];
  const stop = hub.subscribe(user, event => events.push(event));
  try {
    withRun({ id: 'fixture-stopped', botId: 'fixture-bot', signal: controller.signal, closed: true }, () => {
      transactionWithEffects(() => {
        recordUnits({ userId: user, model: 'fixture', provider: 'xai', units: 1, unit: 'minutes', costUsd: 0.01 });
        assert.equal(events.length, 0);
      });
    });
    assert.deepEqual(events, [{ type: 'usage' }]);
    assert.throws(() => transactionWithEffects(() => {
      recordUnits({ userId: user, model: 'fixture', provider: 'xai', units: 1, unit: 'minutes', costUsd: 99 });
      throw new Error('fixture rollback');
    }), /fixture rollback/);
    assert.equal(events.length, 1); assert.equal((await reconciles()).plan.usedCents, 1);
  } finally { stop(); }
});

for (const stream of [false, true]) test(`request credential survives a connection change before ${stream ? 'streaming' : 'non-streaming'} completion`, async () => {
  onModelRequest = () => saveOpenRouterKey(user, 'fixture-personal-key', 'manual');
  await withUsage({ userId: user }, async () => {
    let response: any = await llmClient(5000).responses.create({ model: 'fixture/model', input: [], stream } as any);
    if (stream) { for await (const event of response) if (event.response) response = event.response; }
    await recordModelUsage({ userId: user, model: 'fixture/model', response });
  });
  assert.equal((db.prepare('SELECT key_kind FROM usage_events').get() as any).key_kind, 'native');
  assert.equal(planUsageSummary(user).plan.usedCents, 13); assert.equal(planUsageSummary(user).ownKeys.usedCents, 0);
  db.exec('DELETE FROM usage_events');
  onModelRequest = () => db.prepare('UPDATE provider_connections SET enabled=0 WHERE user_id=?').run(user);
  await withUsage({ userId: user }, async () => {
    const response = await llmClient(5000).responses.create({ model: 'fixture/model', input: [] });
    await recordModelUsage({ userId: user, model: 'fixture/model', response });
  });
  assert.equal((db.prepare('SELECT key_kind FROM usage_events').get() as any).key_kind, 'personal');
  assert.equal(planUsageSummary(user).plan.usedCents, 0); assert.equal(planUsageSummary(user).ownKeys.usedCents, 13);
});

test('summary requires authentication and cannot select another account', async () => {
  assert.equal((await app.request('/api/usage/summary')).status, 401);
  seed({ cost: 99, keyKind: 'native' }, at, other);
  const summary = await reconciles();
  assert.equal(summary.plan.usedCents, 0); assert.equal(summary.ownKeys.usedCents, 0); assert.equal(summary.week.planUsedCents, 0);
});

test('all dashboard ranges use plan cents without changing legacy non-cost fields', () => {
  for (const event of fixture.events) seed(event);
  for (const range of ['today', '7d', '30d', 'month'] as const) {
    const counted = planUsageRange(user, range);
    assert.equal(resolveSource('usage.summary', user, { range }).value!.costUsd, counted.planUsedCents / 100);
    assert.equal(resolveSource('usage.summary', user, { range }).value!.requests, fixture.events.length);
    assert.equal(resolveSource('usage.series', user, { range, metric: 'requests' }).rows!.reduce((sum, row) => sum + Number(row.value), 0), fixture.events.length);
    assert.equal(resolveSource('usage.series', user, { range, metric: 'cost' }).rows!.reduce((sum, row) => sum + Math.round(Number(row.value) * 100), 0), counted.planUsedCents);
  }
});

test('CLI summary reads only fresh local quota observations and never invents a dollar cap', async () => {
  process.env.SWARM_PLAN_LIMIT_USD = '20';
  selectCli(user, 'claude');
  let summary = planUsageSummary(user);
  assert.equal(summary.plan.billing, 'plan'); assert.equal(summary.plan.unit, 'percent');
  assert.equal(summary.plan.name, 'Claude plan'); assert.equal(summary.plan.limitCents, null); assert.equal(summary.plan.percentUsed, null);
  const { createCliPairing } = await import('../server/src/cli/store.js');
  const { attachCliSocket, cliStatus, refreshCli } = await import('../server/src/cli/bridge.js');
  const { cliCatalog, clearCliCatalog } = await import('../server/src/cli/catalog.js');
  const server = http.createServer(); attachCliSocket(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as any).port}/api/cli-bridge`);
  let probes = 0;
  socket.on('message', raw => {
    const message = JSON.parse(String(raw)); if (message.type === 'welcome' || message.method === 'cancel') return;
    if (message.method === 'catalog') probes++;
    socket.send(JSON.stringify({ id: message.id, result: message.method === 'status'
      ? { claude: { installed: true, authenticated: true, subscription: true }, codex: { installed: false, authenticated: false, subscription: false } }
      : { models: [], defaultModel: null, plan: 'max', usage: { available: true, checkedAt: at, windows: [{ label: 'Weekly', usedPercent: 125, resetsAt: at + 60000 }] } } }));
  });
  try {
    await once(socket, 'open'); socket.send(JSON.stringify({ type: 'hello', version: 1, codexExecOnly: true, token: createCliPairing(user), device: 'Fixture bridge' }));
    for (let n = 0; n < 100 && !cliStatus(user).connected; n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(cliStatus(user).connected, true); await refreshCli(user); await cliCatalog(user, 'claude');
    const calls = probes;
    summary = planUsageSummary(user);
    assert.equal(summary.plan.name, 'Claude Max plan'); assert.equal(summary.plan.percentUsed, 125); assert.equal(summary.plan.limitCents, null);
    assert.equal(summary.plan.resetsAt, at + 60000); assert.equal(probes, calls);
    assert.equal(planUsageSummary(user, at + 30000).plan.percentUsed, null);
    assert.equal(displayUsagePercent(summary.plan.percentUsed), 100);
    selectCli(other, 'claude');
    assert.equal(planUsageSummary(other).plan.percentUsed, null);
  } finally { clearCliCatalog(user); socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
