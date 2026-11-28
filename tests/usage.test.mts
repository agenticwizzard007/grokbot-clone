// AI usage monitor tests: recording (provider-reported cost, xAI ticks, estimates, unknown), attribution,
// a real agent turn against the mock model, reports, the free-plan allowance, the owner's views and CSV export.
//   node --import tsx --test --test-concurrency=1 tests/usage.test.mts
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, mock as testMock, test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-usage-'));
const free = () => new Promise<number>((r) => { const s = http.createServer().listen(0, () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });
const mockPort = await free();
const mock = spawn(process.execPath, [path.join(import.meta.dirname, 'mock-provider.mjs'), String(mockPort)], { stdio: 'ignore' });
for (let i = 0; i < 50; i++) { if (await fetch(`http://localhost:${mockPort}/_requests`).then(() => true, () => false)) break; await new Promise((r) => setTimeout(r, 100)); }

Object.assign(process.env, {
  DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'), SESSION_SECRET: 'test-only-secret', COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '',
  OPENROUTER_API_KEY: 'test', OPENROUTER_BASE_URL: `http://localhost:${mockPort}/api/v1`, DIRECT_API_KEY: 'test', DIRECT_BASE_URL: `http://localhost:${mockPort}/v1`,
  LLM_PROVIDER: 'openrouter', MESSAGING_DAILY_MESSAGES: '5', SERVER_URL: 'http://localhost:1', APP_URL: 'http://localhost:1', INKBOX_TUNNEL: '0',
});

const { db } = await import('../server/src/db.js');
const { initSubagents } = await import('../server/src/agent/subagents.js');
const { initRooms } = await import('../server/src/agent/rooms.js');
initSubagents(); initRooms();
const { enqueue } = await import('../server/src/agent/loop.js');
const { appendRow } = await import('../server/src/store.js');
const { createAccount } = await import('../server/src/accounts.js');
const usage = await import('../server/src/usage.js');
const { usageApi } = await import('../server/src/routes-usage.js');
const { Hono } = await import('hono');

after(() => { mock.kill(); });

const owner = createAccount({ email: 'owner@example.com', name: 'Owner' }).id;
db.prepare("INSERT INTO account_roles VALUES(?,'admin')").run(owner);
const member = createAccount({ email: 'member@example.com', name: 'Member' }).id;
const texter = createAccount({ phone: '15550001111', name: 'Texter', source: 'text' }).id;
const botOf = (userId: string) => (db.prepare('SELECT id FROM bots WHERE user_id=? ORDER BY created_at LIMIT 1').get(userId) as { id: string }).id;
const events = (userId: string) => db.prepare('SELECT * FROM usage_events WHERE user_id=? ORDER BY id').all(userId) as any[];
const clear = () => db.prepare('DELETE FROM usage_events').run();

const app = new Hono();
app.route('/api/usage', usageApi);
const session = (userId: string) => {
  const t = `t_${userId}`;
  db.prepare('INSERT OR REPLACE INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (session_hash(?),?,?,?)').run(t, userId, Date.now(), Date.now() + 3_600_000);
  return `swarm_session=${t}`;
};
const get = async (userId: string, url: string) => {
  const r = await app.request(url, { headers: { cookie: session(userId) } });
  return { status: r.status, type: r.headers.get('content-type') ?? '', body: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() };
};

test('OpenRouter: the provider-reported cost is recorded exactly, with cached and reasoning tokens', async () => {
  clear();
  await usage.recordModelUsage({
    userId: member, botId: botOf(member), kind: 'chat', model: 'anthropic/claude-sonnet-5.5', provider: 'openrouter',
    response: { id: 'gen-1', usage: { input_tokens: 1000, output_tokens: 200, cost: 0.0123, is_byok: false, input_tokens_details: { cached_tokens: 300 }, output_tokens_details: { reasoning_tokens: 50 } } },
  });
  const [e] = events(member);
  assert.equal(e.cost_usd, 0.0123);
  assert.equal(e.cost_source, 'provider');
  assert.deepEqual([e.input_tokens, e.cached_tokens, e.output_tokens, e.reasoning_tokens, e.byok], [1000, 300, 200, 50, 0]);
});

test('xAI: cost_in_usd_ticks (10^10 per dollar) and server-side tool calls are recorded', async () => {
  clear();
  await usage.recordModelUsage({ userId: member, kind: 'chat', model: 'grok-4.7', provider: 'direct', response: { usage: { input_tokens: 100, output_tokens: 10, cost_in_usd_ticks: 37756000, num_server_side_tools_used: 2 } } });
  const [e] = events(member);
  assert.ok(Math.abs(e.cost_usd - 0.0037756) < 1e-12);
  assert.equal(e.cost_source, 'provider');
  assert.equal(e.tool_calls, 2);
});

test('no reported cost: estimated from the OpenRouter price list, else left unknown', async () => {
  clear();
  // The mock catalog prices openai/gpt-4.1 at $3 in / $15 out per million tokens; "gpt-4.1" matches it as vendor/<model>.
  await usage.recordModelUsage({ userId: member, kind: 'chat', model: 'gpt-4.1', provider: 'direct', response: { usage: { input_tokens: 1000, output_tokens: 100 } } });
  await usage.recordModelUsage({ userId: member, kind: 'chat', model: 'some-unlisted-model', provider: 'direct', response: { usage: { input_tokens: 10, output_tokens: 10 } } });
  const [est, unknown] = events(member);
  assert.ok(Math.abs(est.cost_usd - 0.0045) < 1e-12, String(est.cost_usd));
  assert.equal(est.cost_source, 'estimate');
  assert.equal(unknown.cost_usd, null);
  const r = usage.usageReport(member, 'today');
  assert.equal(r.totals.unpricedRequests, 1);
  assert.ok(Math.abs(r.totals.estimatedUsd - 0.0045) < 1e-12);
});

test('attribution: a Bot context bills its owner; missing API usage remains a counted unknown request', async () => {
  clear();
  await usage.withUsage({ botId: botOf(owner), kind: 'memory' }, () => usage.recordModelUsage({ model: 'x-ai/grok-4.7', response: { usage: { input_tokens: 5, output_tokens: 5, cost: 0.001 } } }));
  await usage.recordModelUsage({ userId: owner, model: 'x', response: {} });
  const rows = events(owner);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].bot_id, botOf(owner));
  assert.equal(rows[0].kind, 'memory');
  assert.equal(rows[1].usage_status, 'unavailable');
  assert.deepEqual(JSON.parse(rows[1].token_fields), []);
  assert.equal(rows[1].cost_usd, null);
});

test('API missing or malformed usage persists unavailable accounting without consulting prices', async () => {
  clear();
  let priceReads = 0;
  const fetch = testMock.method(globalThis, 'fetch', async () => { priceReads++; throw new Error('Unknown token counts cannot be priced'); });
  try {
    for (const [index, response] of [{}, { usage: null }, { usage: [] }, { usage: {} }].entries()) {
      await usage.recordModelUsage({ userId: member, botId: botOf(member), model: 'gpt-4.1', response: { id: `api-unavailable-${index}`, ...response } });
    }
  } finally { fetch.mock.restore(); }
  const rows = events(member);
  assert.equal(rows.length, 4); assert.equal(priceReads, 0);
  for (const row of rows) {
    assert.equal(row.usage_status, 'unavailable'); assert.deepEqual(JSON.parse(row.token_fields), []);
    assert.equal(row.cost_usd, null); assert.equal(row.cost_source, null);
  }
  const report = usage.usageReport(member, 'today');
  assert.equal(report.totals.requests, 4); assert.equal(report.totals.unavailableUsageRequests, 4);
  assert.equal(report.totals.knownTokenRequests, 0); assert.equal(report.totals.unpricedRequests, 4);
});

test('API partial counters retain observed fields and provider cost, without fabricating an estimate', async () => {
  clear();
  let priceReads = 0;
  const fetch = testMock.method(globalThis, 'fetch', async () => { priceReads++; throw new Error('Incomplete token counts cannot be priced'); });
  try {
    for (const [id, supplied] of [
      ['input-only', { input_tokens: 7, input_tokens_details: { cached_tokens: 2 } }],
      ['output-only', { completion_tokens: 3, completion_tokens_details: { reasoning_tokens: 1 }, cost: 0.02 }],
      ['invalid-output', { input_tokens: 0, output_tokens: '12', input_tokens_details: { cached_tokens: Infinity } }],
      ['cost-only', { cost_in_usd_ticks: 100000000 }],
    ] as const) await usage.recordModelUsage({ userId: member, botId: botOf(member), model: 'gpt-4.1', response: { id, usage: supplied } });
  } finally { fetch.mock.restore(); }
  const rows = events(member);
  assert.equal(priceReads, 0);
  assert.deepEqual(rows.map(row => row.usage_status), ['partial', 'partial', 'partial', 'unavailable']);
  assert.deepEqual(rows.map(row => JSON.parse(row.token_fields)), [['input_tokens', 'cached_tokens'], ['output_tokens', 'reasoning_tokens'], ['input_tokens'], []]);
  assert.deepEqual(rows.map(row => row.cost_usd), [null, 0.02, null, 0.01]);
  assert.deepEqual(rows.map(row => row.cost_source), [null, 'provider', null, 'provider']);
  // A stale placeholder must never turn into a measured output count.
  db.prepare("UPDATE usage_events SET output_tokens=999 WHERE request_id='input-only'").run();
  const report = usage.usageReport(member, 'today');
  assert.equal(report.totals.inputTokens, 7); assert.equal(report.totals.outputTokens, 3);
  assert.equal(report.totals.partialUsageRequests, 3); assert.equal(report.totals.unavailableUsageRequests, 1);
  assert.equal(report.totals.knownInputRequests, 2); assert.equal(report.totals.knownOutputRequests, 1);
  const [header, ...csv] = usage.usageCsv(member, 'today').trim().split('\n').map(line => line.split(','));
  const cell = (row: string[], key: string) => row[header.indexOf(key)];
  assert.equal(cell(csv[0], 'input_tokens'), '7'); assert.equal(cell(csv[0], 'output_tokens'), '');
  assert.equal(cell(csv[1], 'input_tokens'), ''); assert.equal(cell(csv[1], 'output_tokens'), '3');
  assert.equal(cell(csv[2], 'input_tokens'), '0'); assert.equal(cell(csv[2], 'output_tokens'), '');
});

test('API Chat Completions aliases normalize counters and preserve measured zero', async () => {
  clear();
  await usage.recordModelUsage({ userId: member, model: 'gpt-4.1', response: { usage: {
    prompt_tokens: 10, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 0 }, cost: 0,
  } } });
  const [row] = events(member);
  assert.equal(row.usage_status, 'complete');
  assert.deepEqual(JSON.parse(row.token_fields), ['input_tokens', 'cached_tokens', 'output_tokens', 'reasoning_tokens']);
  assert.deepEqual([row.input_tokens, row.cached_tokens, row.output_tokens, row.reasoning_tokens, row.cost_usd], [10, 3, 0, 0, 0]);
});

test('unavailable subscription requests remain counted with an empty mask and never consult API prices', async () => {
  clear();
  let priceReads = 0;
  const fetch = testMock.method(globalThis, 'fetch', async () => { priceReads++; throw new Error('API pricing must not run'); });
  try {
    for (const provider of ['codex-cli', 'claude-cli']) {
      await usage.recordModelUsage({ userId: member, botId: botOf(member), model: 'gpt-4.1', response: {
        id: `unavailable-${provider}`, provider, model: `${provider}/actual`, billing: 'subscription', usage_status: 'unavailable',
      } });
    }
  } finally { fetch.mock.restore(); }
  assert.equal(priceReads, 0);
  const rows = events(member);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.usage_status, 'unavailable');
    assert.deepEqual(JSON.parse(row.token_fields), []);
    assert.equal(row.cost_source, 'subscription');
    assert.equal(row.cost_usd, 0);
    assert.equal(row.bot_id, botOf(member));
  }
  const report = usage.usageReport(member, 'today');
  assert.equal(report.totals.requests, 2);
  assert.equal(report.totals.unavailableUsageRequests, 2);
  assert.equal(report.totals.knownTokenRequests, 0);
  assert.equal(report.totals.estimatedUsd, 0);
  assert.equal(report.totals.unpricedRequests, 0, 'unknown counters are independent of known zero model API charges');
  assert.deepEqual(report.accounting, { unavailableUsage: 'counted', tokenTotals: 'observed' });
});

test('partial/unavailable masks exclude unknown counters from every report and leave CSV cells blank', async () => {
  clear();
  const bot = botOf(member);
  const record = (response: any) => usage.recordModelUsage({ userId: member, botId: bot, kind: 'chat', model: 'gpt-4.1', response: { provider: 'codex-cli', billing: 'subscription', ...response } });
  await record({ id: 'complete', usage_status: 'complete', usage: { input_tokens: 100, output_tokens: 50, cost: 99 } });
  await record({ id: 'partial', usage_status: 'partial', usage: { input_tokens: 7, input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: -10 } } });
  await record({ id: 'unavailable', usage_status: 'unavailable' });
  const rows = events(member);
  assert.deepEqual(rows.map(row => row.usage_status), ['complete', 'partial', 'unavailable']);
  assert.deepEqual(JSON.parse(rows[1].token_fields), ['input_tokens', 'cached_tokens']);
  // Reports must consult the mask, even if a zero-compatible storage field has a stale value.
  db.prepare('UPDATE usage_events SET output_tokens=999,reasoning_tokens=999 WHERE request_id=?').run('partial');
  db.prepare('UPDATE usage_events SET input_tokens=999,output_tokens=999,cached_tokens=999,reasoning_tokens=999 WHERE request_id=?').run('unavailable');
  const report = usage.usageReport(member, 'today');
  assert.deepEqual([report.totals.requests, report.totals.inputTokens, report.totals.outputTokens, report.totals.cachedTokens, report.totals.reasoningTokens], [3, 107, 50, 2, 0]);
  assert.deepEqual([report.totals.partialUsageRequests, report.totals.unavailableUsageRequests, report.totals.knownTokenRequests], [1, 1, 2]);
  assert.equal(report.totals.costUsd, 0);
  assert.equal(report.totals.estimatedUsd, 0);
  for (const group of [report.days, report.byBot, report.byModel, report.byKind, usage.usageReport(null, 'today').byUser!.filter(row => row.key === member)]) {
    assert.equal(group.length, 1);
    assert.equal(group[0].tokens, 157);
    assert.equal(group[0].requests, 3);
    assert.equal(group[0].partialUsageRequests, 1);
    assert.equal(group[0].unavailableUsageRequests, 1);
  }
  const [header, ...csvRows] = usage.usageCsv(member, 'today').trim().split('\n').map(line => line.split(','));
  const cell = (row: string[], key: string) => row[header.indexOf(key)];
  assert.deepEqual(csvRows.map(row => cell(row, 'usage_status')), ['complete', 'partial', 'unavailable']);
  assert.equal(cell(csvRows[1], 'input_tokens'), '7');
  assert.equal(cell(csvRows[1], 'cached_tokens'), '2');
  assert.equal(cell(csvRows[1], 'output_tokens'), '');
  for (const key of ['input_tokens', 'cached_tokens', 'output_tokens', 'reasoning_tokens']) assert.equal(cell(csvRows[2], key), '');
  assert.equal(cell(csvRows[2], 'cost_usd'), '0');
  assert.equal(cell(csvRows[2], 'cost_source'), 'subscription');
});

test('legacy subscription availability is inferred while valid zero counters remain measured', async () => {
  clear();
  for (const response of [
    { usage: { input_tokens: 0, output_tokens: 0 } },
    { usage: { input_tokens: 0, output_tokens: '12', input_tokens_details: { cached_tokens: Infinity } } },
    {},
  ]) await usage.recordModelUsage({ userId: member, model: 'gpt-4.1', response: { billing: 'subscription', provider: 'claude-cli', ...response } });
  const rows = events(member);
  assert.deepEqual(rows.map(row => row.usage_status), ['complete', 'partial', 'unavailable']);
  assert.deepEqual(rows.map(row => JSON.parse(row.token_fields)), [['input_tokens', 'output_tokens'], ['input_tokens'], []]);
  const report = usage.usageReport(member, 'today');
  assert.equal(report.totals.requests, 3);
  assert.equal(report.totals.knownTokenRequests, 2);
  assert.equal(report.totals.knownInputRequests, 2);
  assert.equal(report.totals.knownOutputRequests, 1);
});

for (const scenario of ['mixed', 'CLI only', 'API only', 'empty'] as const) {
  test(`billing sources: ${scenario} period uses recorded billing and providers`, async () => {
    clear();
    const { selectCli } = await import('../server/src/cli/store.js');
    selectCli(member, 'codex');
    try {
      const plan = scenario === 'mixed' || scenario === 'CLI only';
      const api = scenario === 'mixed' || scenario === 'API only';
      if (plan) for (const provider of ['codex-cli', 'claude-cli']) {
        await usage.recordModelUsage({ userId: member, model: 'fixture', provider,
          response: { billing: 'subscription', usage_status: 'unavailable' } });
      }
      if (api) await usage.recordModelUsage({ userId: member, model: 'fixture', provider: 'openrouter',
        response: { usage: { input_tokens: 10, output_tokens: 2, cost: 42.99 } } });
      // Another account and an older request must not affect this period's billing.
      await usage.recordModelUsage({ userId: owner, model: 'fixture', provider: 'direct', response: { usage: { cost: 9 } } });
      await usage.recordModelUsage({ userId: member, model: 'old', provider: 'direct', response: { id: 'old-billing', usage: { cost: 7 } } });
      db.prepare("UPDATE usage_events SET created_at=0 WHERE request_id='old-billing'").run();
      const { body: report } = await get(member, '/api/usage?range=today&scope=all');
      assert.equal(report.scope, 'me');
      const sources = report.billing.sources;
      assert.deepEqual(sources.filter((row: any) => row.source === 'api'), api ? [{
        source: 'api', provider: 'openrouter', requests: 1, costUsd: 42.99, estimatedUsd: 0, unpricedRequests: 0,
      }] : []);
      assert.deepEqual(sources.filter((row: any) => row.source === 'subscription').map((row: any) => [row.provider, row.requests, row.costUsd]),
        plan ? [['claude-cli', 1, 0], ['codex-cli', 1, 0]] : []);
      assert.equal(sources.reduce((sum: number, row: any) => sum + row.requests, 0), report.totals.requests);
      near(sources.reduce((sum: number, row: any) => sum + row.costUsd, 0), report.totals.costUsd);
      assert.equal(report.billing.note.includes('CLI requests use'), plan);
      assert.equal(report.billing.note.includes('API requests are billed per request'), api);
      assert.equal(report.billing.note.includes('no Swarm API charge'), plan);
      assert.equal(report.billing.note.includes('No API or CLI plan requests'), !plan && !api);
      assert.match(report.billing.note, /computer time is estimated/);
      const { body: provider } = await get(member, '/api/usage/provider');
      assert.match(provider.note, /current connection uses your ChatGPT subscription/);
      assert.doesNotMatch(provider.note, /zero API charges|all.*requests use/);
    } finally { selectCli(member, null); }
  });
}

test('billing sources preserve estimated and missing API prices without claiming zero charges', async () => {
  clear();
  await usage.recordModelUsage({ userId: member, model: 'gpt-4.1', provider: 'openrouter', response: { usage: { input_tokens: 1000, output_tokens: 100 } } });
  await usage.recordModelUsage({ userId: member, model: 'unknown', provider: 'openrouter', response: {} });
  const report = usage.usageReport(member, 'today');
  assert.equal(report.billing.sources.length, 1);
  const source = report.billing.sources[0];
  assert.equal(source.source, 'api'); assert.equal(source.requests, 2);
  near(source.costUsd, 0.0045); near(source.estimatedUsd, source.costUsd);
  assert.equal(source.unpricedRequests, 1);
  assert.doesNotMatch(report.billing.note, /no Swarm API charge|zero/);
});

test('a real Bot turn records its model call against the user and Bot, with OpenRouter cost', async () => {
  clear();
  const bot = botOf(member);
  appendRow(bot, 'message', { type: 'message', role: 'user', text: 'mock: say hello' } as any);
  enqueue(bot, { type: 'user', text: 'mock: say hello' } as any);
  for (let i = 0; i < 100 && !events(member).length; i++) await new Promise((r) => setTimeout(r, 50));
  const [e] = events(member);
  assert.ok(e, 'no usage recorded for the turn');
  assert.equal(e.bot_id, bot);
  assert.equal(e.kind, 'chat');
  assert.equal(e.provider, 'openrouter');
  assert.equal(e.cost_usd, 0.00042);
  assert.deepEqual([e.input_tokens, e.output_tokens], [100, 20]);
});

test('reports: totals, every day in the range, and breakdowns by Bot, model and activity', async () => {
  clear();
  const bot = botOf(member);
  await usage.recordModelUsage({ userId: member, botId: bot, kind: 'chat', model: 'm/a', provider: 'openrouter', response: { usage: { input_tokens: 100, output_tokens: 50, cost: 0.02 } } });
  await usage.recordModelUsage({ userId: member, botId: bot, kind: 'compaction', model: 'm/b', provider: 'openrouter', response: { usage: { input_tokens: 10, output_tokens: 5, cost: 0.01 } } });
  usage.recordUnits({ userId: member, botId: bot, kind: 'voice', model: 'voice', provider: 'direct', units: 2.5, unit: 'minutes' });
  const r = usage.usageReport(member, '7d');
  assert.equal(r.days.length, 7);
  assert.equal(r.days.at(-1)!.day, new Date().toISOString().slice(0, 10));
  assert.ok(Math.abs(r.totals.costUsd - 0.03) < 1e-12);
  assert.equal(r.totals.requests, 3);
  assert.equal(r.totals.voiceMinutes, 2.5);
  assert.equal(r.totals.inputTokens + r.totals.outputTokens, 165);
  assert.equal(r.byModel[0].key, 'm/a');
  assert.deepEqual(r.byKind.map((k) => k.key).sort(), ['chat', 'compaction', 'voice']);
  assert.equal(r.byBot.length, 1);
  assert.equal(r.byUser, undefined);
  const month = usage.rangeBounds('month', Date.UTC(2026, 10, 10, 12));
  assert.equal(month.from, Date.UTC(2026, 10, 1));
  assert.equal(month.days, 10);
});

test('API: members see only their own usage; the owner can see everyone and the provider account', async () => {
  clear();
  await usage.recordModelUsage({ userId: member, kind: 'chat', model: 'm/a', provider: 'openrouter', response: { usage: { input_tokens: 1, output_tokens: 1, cost: 0.5 } } });
  await usage.recordModelUsage({ userId: owner, kind: 'chat', model: 'm/a', provider: 'openrouter', response: { usage: { input_tokens: 1, output_tokens: 1, cost: 0.25 } } });

  const mine = await get(member, '/api/usage?range=today&scope=all');
  assert.equal(mine.status, 200);
  assert.equal(mine.body.scope, 'me');
  assert.equal(mine.body.canSeeAll, false);
  assert.equal(mine.body.totals.costUsd, 0.5);
  assert.equal(mine.body.byUser, undefined);
  assert.equal((await get(member, '/api/usage/provider')).status, 403);

  const all = await get(owner, '/api/usage?range=today&scope=all');
  assert.equal(all.body.scope, 'all');
  assert.equal(all.body.totals.costUsd, 0.75);
  assert.deepEqual(all.body.byUser.map((u: any) => u.label), ['Member', 'Owner']);

  const prov = await get(owner, '/api/usage/provider');
  assert.equal(prov.status, 200);
  assert.deepEqual(prov.body.openrouter.usage, { today: 0.25, week: 1.75, month: 6.4, allTime: 12.5 });
  assert.equal(prov.body.openrouter.limitRemaining, 7.5);
});

test('free plan: text sign-ups see their daily message allowance; others have none', async () => {
  const bot = botOf(texter);
  appendRow(bot, 'message', { type: 'message', role: 'user', text: 'hi', from: { kind: 'sms' } } as any);
  appendRow(bot, 'message', { type: 'message', role: 'user', text: 'again', from: { kind: 'sms' } } as any);
  const t = await get(texter, '/api/usage?range=today');
  assert.equal(t.body.limits.dailyMessages.limit, 5);
  assert.equal(t.body.limits.dailyMessages.used, 2);
  assert.ok(t.body.limits.dailyMessages.resetsAt > Date.now());
  const m = await get(member, '/api/usage?range=today');
  assert.equal(m.body.limits.dailyMessages, null);
});

test('CSV export: one row per event, and spreadsheet formulas are neutralised', async () => {
  clear();
  await usage.recordModelUsage({ userId: member, kind: 'chat', model: '=HYPERLINK("http://evil")', provider: 'openrouter', response: { usage: { input_tokens: 1, output_tokens: 1, cost: 0.1 } } });
  const r = await get(member, '/api/usage/export.csv?range=today');
  assert.equal(r.status, 200);
  assert.match(r.type, /text\/csv/);
  const lines = String(r.body).trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^time_utc,account,bot,activity/);
  assert.ok(lines[1].includes(`"'=HYPERLINK(""http://evil"")"`), lines[1]);
});

// ---------- computers (VMs) ----------

const vm = await import('../server/src/usage-vm.js');
db.exec(`CREATE TABLE IF NOT EXISTS vms (vm_id TEXT PRIMARY KEY, user_id TEXT UNIQUE, driver TEXT NOT NULL, ext_id TEXT, status TEXT NOT NULL DEFAULT 'creating',
  error TEXT, image TEXT, memory_mb INTEGER, cpus INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, volume_id TEXT)`);
const setVm = (status: string) => db.prepare('UPDATE vms SET status=? WHERE vm_id=?').run(status, 'vm_member');
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
// Fly iad: 2 shared vCPUs × $2.19 + (2.75 GB − 0.5 GB) × $6 + 10 GB volume × $0.15 = $19.38 a month; 730 h a month.
const RUN_HOUR = 19.38 / 730;
const ASLEEP_HOUR = (3 * 0.15 + 10 * 0.15) / 730; // root disk while asleep + the volume
const ARCHIVED_HOUR = (10 * 0.15) / 730; // only the kept volume

test('computers: an hour running, asleep and archived is billed at Fly rates per state', () => {
  db.prepare('DELETE FROM vm_usage').run();
  db.prepare('DELETE FROM vms').run();
  db.prepare('INSERT INTO vms(vm_id,user_id,driver,status,memory_mb,cpus,volume_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run('vm_member', member, 'fly', 'running', 2816, 2, 'vol_1', Date.now(), Date.now());
  vm.recordVmSeconds(3600);
  setVm('suspended'); vm.recordVmSeconds(3600);
  setVm('archived'); vm.recordVmSeconds(1800);
  const c = vm.computerTotals(member, '2000-01-01', '2999-12-31');
  near(c.runningHours, 1); near(c.asleepHours, 1); near(c.archivedHours, 0.5);
  near(c.costUsd, RUN_HOUR + ASLEEP_HOUR + ARCHIVED_HOUR / 2);
  assert.equal(c.now?.state, 'archived');
  near(c.now!.perHourUsd, ARCHIVED_HOUR);
  const r = usage.usageReport(member, 'today');
  near(r.days.at(-1)!.computerUsd, c.costUsd);
  near(r.computer.costUsd, c.costUsd);
});

test('computers: dev/test VMs are free, Orgo boxes use its hourly rate, rates can be overridden', () => {
  db.prepare('DELETE FROM vm_usage').run();
  db.prepare("UPDATE vms SET driver='fake', status='running' WHERE vm_id='vm_member'").run();
  db.prepare("INSERT OR REPLACE INTO computers(user_id,orgo_id,status,updated_at) VALUES (?,?,?,?)").run(owner, 'orgo_1', 'running', Date.now());
  vm.recordVmSeconds(3600);
  near(vm.computerTotals(member, '2000-01-01', '2999-12-31').costUsd, 0);
  near(vm.computerTotals(owner, '2000-01-01', '2999-12-31').costUsd, 0.055);
  db.prepare("UPDATE vms SET driver='fly' WHERE vm_id='vm_member'").run();
  process.env.VM_PRICE_RAM_GB_MONTH = '0';
  try {
    db.prepare('DELETE FROM vm_usage').run();
    vm.recordVmSeconds(3600);
    near(vm.computerTotals(member, '2000-01-01', '2999-12-31').costUsd, (2 * 2.19 + 10 * 0.15) / 730);
  } finally { delete process.env.VM_PRICE_RAM_GB_MONTH; }
  db.prepare('DELETE FROM computers WHERE user_id=?').run(owner);
});

test('computers: the owner sees computer cost per account (even with no AI use); CSV lists computer hours', async () => {
  clear();
  db.prepare('DELETE FROM vm_usage').run();
  db.prepare("UPDATE vms SET status='running', driver='fly' WHERE vm_id='vm_member'").run();
  vm.recordVmSeconds(7200);
  const all = await get(owner, '/api/usage?range=today&scope=all');
  const m = all.body.byUser.find((u: any) => u.label === 'Member');
  assert.ok(m, 'member missing from the owner view');
  near(m.computerUsd, 2 * RUN_HOUR);
  near(m.computerHours, 2);
  assert.equal(m.requests, 0);
  const mine = await get(member, '/api/usage?range=today');
  near(mine.body.computer.runningHours, 2);
  assert.equal(mine.body.computer.now.state, 'running');
  const csv = String((await get(member, '/api/usage/export.csv?range=today')).body);
  assert.match(csv, /computer_running,cloudvm-fly,2 vCPU \/ 2816 MB \/ 10 GB disk,0,0,0,0,0,2,hours,/);
});


test('computer on time includes idle wake time without any Bot screen and survives sleep', async () => {
  clear();
  db.prepare('DELETE FROM vm_usage').run();
  db.prepare('DELETE FROM vms').run();
  db.prepare('INSERT INTO vms(vm_id,user_id,driver,status,memory_mb,cpus,volume_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run('vm_member', member, 'fly', 'running', 2816, 2, 'vol_1', Date.now(), Date.now());
  const { computers } = await import('../server/src/computers/index.js');
  assert.deepEqual(computers.screens(member), []);
  vm.recordVmSeconds(5.4 * 3600);
  setVm('suspended'); vm.recordVmSeconds(140 * 3600);
  const report = usage.usageReport(member, '7d');
  near(report.computer.runningHours, 5.4); near(report.computer.asleepHours, 140);
  assert.equal(report.computer.now?.state, 'asleep');
  assert.equal(report.totals.requests, 0);
  assert.deepEqual(computers.screens(member), []);
});

test('account time zone buckets Usage, Analytics and CSV on the same days', async () => {
  clear();
  db.prepare('DELETE FROM vm_usage').run();
  const { botAnalytics } = await import('../server/src/analytics.js');
  const bot = botOf(member);
  db.prepare('DELETE FROM rows WHERE bot_id=?').run(bot);
  const at = Date.parse('2026-11-25T21:00:00Z');
  db.prepare('UPDATE users SET timezone=? WHERE id=?').run('Asia/Dubai', member);
  try {
    for (const [index, time] of ['2026-11-19T19:59:59Z', '2026-11-19T20:00:00Z', '2026-11-22T19:59:59Z', '2026-11-22T20:00:00Z'].entries()) {
      await usage.recordModelUsage({ userId: member, botId: bot, model: 'fixture', provider: 'openrouter', response: { id: `zone-${index}`, usage: { cost: 1, input_tokens: 1, output_tokens: 1 } } });
      db.prepare('UPDATE usage_events SET created_at=? WHERE request_id=?').run(Date.parse(time), `zone-${index}`);
      const row = appendRow(bot, 'message', { type: 'message', role: 'user', text: 'Local fixture' } as any);
      db.prepare('UPDATE rows SET created_at=? WHERE bot_id=? AND generation=? AND seq=?').run(Date.parse(time), bot, row.generation, row.seq);
    }
    const report = usage.usageReport(member, '7d', undefined, at);
    const analytics = botAnalytics(bot, '7d', at);
    assert.equal(report.timezone, 'Asia/Dubai');
    assert.deepEqual(report.days.map(day => day.day), analytics.days.map(day => day.day));
    assert.equal(report.days[0].day, '2026-11-20');
    assert.equal(report.totals.requests, 3, 'exclude the event just before the local period start');
    assert.deepEqual(report.days.filter(day => day.requests).map(day => [day.day, day.requests]), [['2026-11-20', 1], ['2026-11-22', 1], ['2026-11-23', 1]]);
    assert.deepEqual(report.days.map(day => day.requests), analytics.days.map(day => day.messages));
    const [header, ...rows] = usage.usageCsv(member, '7d', undefined, at).trim().split('\n').map(line => line.split(','));
    assert.deepEqual(rows.map(row => row[header.indexOf('day')]), ['2026-11-20', '2026-11-22', '2026-11-23']);
    assert.ok(rows.every(row => row[header.indexOf('timezone')] === 'Asia/Dubai'));
    assert.equal(rows[0][0], '2026-11-19T20:00:00.000Z', 'raw UTC timestamps stay available');
    const bounds = usage.rangeBounds('today', at, 'Asia/Dubai');
    assert.equal(bounds.from, Date.parse('2026-11-25T20:00:00Z'));
    assert.equal(usage.rangeBounds('month', Date.parse('2026-11-30T21:00:00Z'), 'Asia/Dubai').days, 1);
    const response = await get(member, '/api/usage?range=7d');
    assert.equal(response.body.timezone, 'Asia/Dubai');
    db.prepare('UPDATE users SET timezone=? WHERE id=?').run('Asia/Dubai', owner);
    assert.equal((await get(owner, '/api/usage?range=7d&scope=all')).body.timezone, 'Asia/Dubai', 'Everyone uses the viewing account time zone');
  } finally { db.prepare('UPDATE users SET timezone=NULL WHERE id IN (?,?)').run(member, owner); }
  assert.equal(usage.usageReport(member, '7d', undefined, at).timezone, 'UTC');
});

test('computer daily estimates use one allocation for local chart, totals and CSV', () => {
  db.prepare('DELETE FROM vm_usage').run();
  db.prepare("UPDATE vms SET status='running', driver='fly' WHERE vm_id='vm_member'").run();
  vm.recordVmSeconds(24 * 3600, Date.parse('2026-11-22T23:59:59Z'));
  const at = Date.parse('2026-11-25T12:00:00Z');
  const report = usage.usageReport(member, '7d', 'Asia/Dubai', at);
  near(report.computer.runningHours, 24);
  const daily = report.days.filter(day => day.computerUsd);
  assert.deepEqual(daily.map(day => day.day), ['2026-11-22', '2026-11-23']);
  near(daily[0].computerUsd, 20 * RUN_HOUR); near(daily[1].computerUsd, 4 * RUN_HOUR);
  near(daily.reduce((sum, day) => sum + day.computerUsd, 0), report.computer.costUsd);
  const [header, ...rows] = usage.usageCsv(member, '7d', 'Asia/Dubai', at).trim().split('\n').map(line => line.split(','));
  const computer = rows.filter(row => row[header.indexOf('activity')] === 'computer_running');
  assert.deepEqual(computer.map(row => row[header.indexOf('day')]), daily.map(day => day.day));
  assert.deepEqual(computer.map(row => Number(row[header.indexOf('units')])), [20, 4]);
  near(computer.reduce((sum, row) => sum + Number(row[header.indexOf('cost_usd')]), 0), report.computer.costUsd);
  vm.recordVmSeconds(3600, Date.parse('2026-11-23T12:00:00Z'));
  near(vm.computerTotals(member, '2026-11-22', '2026-11-22', 'UTC', at).runningHours, 24);
});

test('tenant meter claims aggregate only this account in UTC without exporting tokens or identities',async()=>{
  clear();db.prepare('DELETE FROM vm_usage').run();
  await usage.recordModelUsage({userId:member,model:'fixture',response:{id:'meter-utc',usage:{cost:2.5,input_tokens:20,output_tokens:10}}});
  await usage.recordModelUsage({userId:owner,model:'private',response:{usage:{cost:99}}});
  usage.recordUnits({userId:member,kind:'voice',model:'voice',provider:'direct',units:3.5,unit:'minutes'});
  const at=Date.parse('2026-11-28T00:01:00Z');
  db.prepare("UPDATE usage_events SET created_at=? WHERE user_id=?").run(at-30000,member);
  db.prepare("UPDATE users SET timezone='America/Los_Angeles' WHERE id=?").run(member);
  db.prepare('INSERT INTO vm_usage(day,user_id,vm_key,provider,state,seconds,updated_at) VALUES(?,?,?,?,?,?,?)').run('2026-11-28',member,'meter','fake','running',120,at);
  try{
    const days=usage.dailyMeterClaims(member,at),today=days.at(-1)!;
    assert.equal(days.length,32);assert.deepEqual(today,{day:'2026-11-28',modelSpendUsd:2.5,computerMinutes:2,voiceMinutes:3.5});
    assert.equal(days.slice(0,-1).reduce((n,d)=>n+d.modelSpendUsd+d.computerMinutes+d.voiceMinutes,0),0);
    assert.doesNotMatch(JSON.stringify(days),/tokens|private|user_id|model_id|provider/);
  }finally{db.prepare('UPDATE users SET timezone=NULL WHERE id=?').run(member);}
});

test('standalone usage summary ignores tenant meter flag and keeps the existing allowance',async()=>{
  const original=process.env.TENANT_METERING;
  try{
    delete process.env.TENANT_METERING;const before=(await get(member,'/api/usage/summary')).body;
    process.env.TENANT_METERING='1';const after=await get(member,'/api/usage/summary');
    assert.equal(after.status,200);assert.equal(after.body.plan.name,before.plan.name);assert.equal(after.body.plan.limitCents,before.plan.limitCents);
    assert.equal(after.body.plan.softLimit,undefined);assert.equal(after.body.plan.source,undefined);
  }finally{if(original===undefined)delete process.env.TENANT_METERING;else process.env.TENANT_METERING=original;}
});
