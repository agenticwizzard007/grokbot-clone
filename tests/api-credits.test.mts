import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'api-credits-'));
Object.assign(process.env, { NODE_ENV: 'test', SWARM_ROLE: 'standalone', DEV_LOGIN: '1', SWARM_NO_SCHEDULER: '1',
  DB_PATH: path.join(temp, 'app.db'), FILES_DIR: path.join(temp, 'files'), SESSION_SECRET: 'api-credits-fixture',
  COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: 'fixture', DIRECT_API_KEY: 'fixture', OPENROUTER_API_KEY: '',
  LLM_PROVIDER: 'direct', DIRECT_BASE_URL: 'http://127.0.0.1:1', INKBOX_TUNNEL: '0', SWARM_ACCOUNT_CONCURRENCY: '1',
});
await import('./fixtures/stop-voice-backends.mjs');
const { db } = await import('../server/src/db.js');
(await import('../server/src/agent/subagents.js')).initSubagents();
(await import('../server/src/agent/rooms.js')).initRooms();
const { env } = await import('../server/src/env.js');
const { creditsProvider } = await import('./fixtures/credits-provider.mjs');
const { once } = await import('node:events');
const { server, runs } = creditsProvider(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as any).port}/v1`;
Object.assign(env, { directBaseUrl: base, openrouterBaseUrl: base });
const { api } = await import('../server/src/routes.js');
const { createBot } = await import('../server/src/bots.js');
const { listRows, appendHistory, loadHistory } = await import('../server/src/store.js');
const { enqueue, interrupt, settleAgentJobs } = await import('../server/src/agent/loop.js');
const app = new Hono().route('/api', api);
const login = await app.request('/api/auth/dev', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'credits@example.test', name: 'QA account' }) });
const cookie = login.headers.get('set-cookie')!.split(';')[0];
const { user } = await (await app.request('/api/auth/me', { headers: { cookie } })).json() as any;
after(async () => { await settleAgentJobs(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });
function bot(active = true) {
  const b = createBot(user.id, { name: 'Credits fixture' });
  if (active) db.prepare("UPDATE bot_setups SET onboarding_status='active',confirmed_at=? WHERE bot_id=?").run(Date.now(), b.id);
  return b.id;
}
async function until(check: () => boolean, label = 'condition') {
  const deadline = Date.now() + 3000;
  while (!check()) { assert.ok(Date.now() < deadline, `Timed out: ${label}`); await new Promise(r => setTimeout(r, 5)); }
}

for (const provider of ['direct', 'openrouter'] as const) {
  test(`${provider}: chat recovers from 402 and uses the model output cap`, async t => {
    t.mock.getter(env, 'llmProvider', () => provider);
    t.mock.getter(env, 'openrouterKey', () => 'fixture');
    const id = bot(), before = runs.length;
    enqueue(id, { type: 'user', text: `recover-${provider}` });
    await settleAgentJobs();
    assert.deepEqual(runs.slice(before).map(r => r.cap), [provider === 'direct' ? 8192 : 4096, 1800]);
    assert.ok(listRows(id).some(row => row.body.type === 'message' && row.body.text === 'Normal reply after credit recovery.'));
    assert.equal(listRows(id).filter(row => row.body.type === 'notice' && row.body.tone === 'error').length, 0);
  });
  test(`${provider}: exhausted chat persists an Out of API credits notice and never reports user Stop`, async t => {
    t.mock.getter(env, 'llmProvider', () => provider);
    t.mock.getter(env, 'openrouterKey', () => 'fixture');
    const id = bot(), before = runs.length;
    const job = enqueue(id, { type: 'user', text: `exhausted-${provider}` });
    await settleAgentJobs();
    assert.equal(runs.length - before, 1);
    const notice = listRows(id).find(row => row.body.type === 'notice' && row.body.credits)?.body as any;
    assert.equal(notice.text, 'Out of API credits');
    assert.equal(notice.terminal, true);
    if (provider === 'openrouter') assert.equal(notice.credits.billingUrl, 'https://openrouter.ai/settings/credits');
    assert.match(notice.credits.details, /in-flight requests/);
    assert.equal(db.prepare('SELECT state FROM agent_jobs WHERE id=?').get(job)?.state, 'uncertain');
    assert.doesNotMatch(JSON.stringify(listRows(id)), /You stopped this request/);
  });
  test(`${provider}: Stop closes the real HTTP credit retry`, async t => {
    t.mock.getter(env, 'llmProvider', () => provider);
    t.mock.getter(env, 'openrouterKey', () => 'fixture');
    const id = bot(), before = runs.length;
    enqueue(id, { type: 'user', text: `stop-retry-${provider}` });
    await until(() => runs.length === before + 2);
    interrupt(id, undefined, 'user');
    await until(() => runs.at(-1)!.closed, 'retry HTTP connection closes');
    await settleAgentJobs();
    assert.equal(runs.length - before, 2);
    assert.ok(listRows(id).some(row => row.body.type === 'notice' && row.body.text === 'You stopped this request.'));
  });
}

for (const provider of ['direct', 'openrouter'] as const) test(`${provider}: tool-loop model calls keep the output cap`, async t => {
  t.mock.getter(env, 'llmProvider', () => provider);
  t.mock.getter(env, 'openrouterKey', () => 'fixture');
  const id = bot(), before = runs.length;
  enqueue(id, { type: 'user', text: `tool-loop-${provider}` });
  await settleAgentJobs();
  const cap = provider === 'direct' ? 8192 : 4096;
  assert.deepEqual(runs.slice(before).map(r => r.cap), [cap, 1800, cap]);
  assert.ok(listRows(id).some(row => row.body.type === 'message' && row.body.text === 'Normal reply after credit recovery.'));
});

for (const provider of ['direct', 'openrouter'] as const) for (const stopped of [false, true]) test(`${provider}: compaction summary ${stopped ? 'Stop aborts the HTTP retry' : 'has a capped affordable retry'}`, async t => {
  const { maybeCompact, memoryConfig } = await import('../server/src/agent/memory.js');
  const { withUsage } = await import('../server/src/usage-context.js');
  t.mock.getter(env, 'llmProvider', () => provider);
  t.mock.getter(env, 'openrouterKey', () => 'fixture');
  const saved = { ...memoryConfig }; Object.assign(memoryConfig, { compactChars: 1000, keepTurns: 1, compactMethod: 'summary' });
  t.after(() => Object.assign(memoryConfig, saved));
  const id = bot(), before = runs.length, controller = new AbortController();
  const items = Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `${stopped ? 'stop-retry' : 'summary'}-${provider} `.repeat(200) }));
  appendHistory(id, items);
  const pending = withUsage({ userId: user.id, botId: id }, () => maybeCompact(id, items, { force: true, signal: controller.signal }));
  if (stopped) {
    const rejected = assert.rejects(pending);
    await until(() => runs.length === before + 2);
    controller.abort(new Error('Stop summary'));
    await rejected; await until(() => runs.at(-1)!.closed);
    assert.deepEqual(loadHistory(id), items);
  } else {
    const compacted = await pending;
    assert.ok(compacted.length < items.length);
  }
  assert.deepEqual(runs.slice(before).map(r => r.cap), [provider === 'direct' ? 8192 : 4096, 1800]);
});

for (const scenario of ['recover', 'exhausted', 'stop'] as const) test(`direct compact endpoint: ${scenario} keeps a single capped fallback and HTTP cancellation`, async t => {
  const { maybeCompact, memoryConfig } = await import('../server/src/agent/memory.js');
  const { withUsage } = await import('../server/src/usage-context.js');
  t.mock.getter(env, 'llmProvider', () => 'direct');
  const saved = { ...memoryConfig }; Object.assign(memoryConfig, { compactChars: 1000, keepTurns: 1, compactMethod: 'auto' });
  t.after(() => Object.assign(memoryConfig, saved));
  const id = bot(), before = runs.length, controller = new AbortController();
  const marker = scenario === 'stop' ? 'stop-compact' : `compact-credit-${scenario}`;
  const items = Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `${marker} `.repeat(200) }));
  appendHistory(id, items);
  const pending = withUsage({ userId: user.id, botId: id }, () => maybeCompact(id, items, { force: true, signal: controller.signal }));
  if (scenario === 'stop') {
    const rejected = assert.rejects(pending);
    await until(() => runs.length === before + 1); controller.abort(new Error('Stop direct compaction'));
    await rejected; await until(() => runs.at(-1)!.closed);
    assert.deepEqual(loadHistory(id), items);
    assert.deepEqual(runs.slice(before).map(r => r.cap), [undefined]);
  } else {
    if (scenario === 'recover') assert.ok((await pending).length < items.length);
    else await assert.rejects(pending, /Out of API credits/);
    assert.deepEqual(runs.slice(before).map(r => r.cap), [undefined, 1800]);
  }
});
