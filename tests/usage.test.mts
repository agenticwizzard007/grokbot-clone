// AI usage monitor tests: recording (provider-reported cost, xAI ticks, estimates, unknown), attribution,
// a real agent turn against the mock model, reports, the free-plan allowance, the owner's views and CSV export.
//   node --import tsx --test --test-concurrency=1 tests/usage.test.mts
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

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
const member = createAccount({ email: 'member@example.com', name: 'Member' }).id;
const texter = createAccount({ phone: '15550001111', name: 'Texter', source: 'text' }).id;
const botOf = (userId: string) => (db.prepare('SELECT id FROM bots WHERE user_id=? ORDER BY created_at LIMIT 1').get(userId) as { id: string }).id;
const events = (userId: string) => db.prepare('SELECT * FROM usage_events WHERE user_id=? ORDER BY id').all(userId) as any[];
const clear = () => db.prepare('DELETE FROM usage_events').run();

const app = new Hono();
app.route('/api/usage', usageApi);
const session = (userId: string) => {
  const t = `t_${userId}`;
  db.prepare('INSERT OR REPLACE INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (?,?,?,?)').run(t, userId, Date.now(), Date.now() + 3_600_000);
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

test('attribution: a Bot context bills its owner; a request without usage is ignored', async () => {
  clear();
  await usage.withUsage({ botId: botOf(owner), kind: 'memory' }, () => usage.recordModelUsage({ model: 'x-ai/grok-4.7', response: { usage: { input_tokens: 5, output_tokens: 5, cost: 0.001 } } }));
  await usage.recordModelUsage({ userId: owner, model: 'x', response: {} });
  const rows = events(owner);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].bot_id, botOf(owner));
  assert.equal(rows[0].kind, 'memory');
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
