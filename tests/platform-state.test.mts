// node --import tsx --test --test-concurrency=1 tests/platform-state.test.mts
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { WebSocket } from 'ws';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-platform-state-'));
Object.assign(process.env, {
  DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'), SESSION_SECRET: 'state-test-session-secret',
  COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '', INKBOX_TUNNEL: '0', SWARM_NO_SCHEDULER: '1',
  DIRECT_API_KEY: 'sk-direct-private-sentinel', DIRECT_BASE_URL: 'https://private-direct.invalid/internal', DIRECT_MODEL: 'direct-model',
  OPENROUTER_API_KEY: 'sk-openrouter-private-sentinel', OPENROUTER_BASE_URL: 'https://private-router.invalid/internal',
  OPENROUTER_MODEL: 'vendor/default-model', LLM_PROVIDER: 'direct',
  XAI_API_KEY: 'sk-voice-private-sentinel', XAI_BASE_URL: 'https://private-voice.invalid/internal',
});

const { db } = await import('../server/src/db.js');
const { platformState, platformContext } = await import('../server/src/agent/platform-state.js');
const { withUsage, usageReport } = await import('../server/src/usage.js');
const { currentUserId } = await import('../server/src/usage-context.js');
const { setEnvOverride } = await import('../server/src/env.js');
const { createCliPairing, selectCli, setCliRuntime } = await import('../server/src/cli/store.js');
const { attachCliSocket, cliStatus, refreshCli, disconnectCli } = await import('../server/src/cli/bridge.js');
const { clearCliCatalog } = await import('../server/src/cli/catalog.js');

const server = createServer((_req, res) => { res.writeHead(500); res.end(); });
attachCliSocket(server);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address !== 'string');
const base = `ws://127.0.0.1:${address.port}`;
const sockets = new Set<WebSocket>();
const originalFetch = globalThis.fetch;
const fetches: string[] = [];
globalThis.fetch = async input => {
  fetches.push(String(input));
  assert.equal(String(input), 'https://private-router.invalid/internal/models', 'no unrequested provider discovery');
  return Response.json({ data: [
    { id: 'vendor/public-model', name: 'Public model', supported_parameters: ['tools'], architecture: { input_modalities: ['text', 'image'] } },
    { id: 'https://private-remote.invalid/config', name: 'sk-private-sentinel', supported_parameters: ['tools'] },
  ] });
};
after(async () => {
  globalThis.fetch = originalFetch;
  for (const ws of sockets) ws.terminate();
  await new Promise<void>(resolve => server.close(() => resolve()));
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

let nextId = 0;
function account() {
  const userId = `state-user-${++nextId}`, botId = `state-bot-${nextId}`;
  const t = Date.now();
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(userId, `${userId}@example.test`, userId, t);
  db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run(botId, userId, botId, t, t);
  return { userId, botId };
}
function event(userId: string | null, botId: string | null, model: string, options: { kind?: string; provider?: string; at?: number; cost?: number } = {}) {
  db.prepare(`INSERT INTO usage_events(user_id,bot_id,kind,provider,model,input_tokens,output_tokens,cost_usd,created_at,request_id)
    VALUES (?,?,?,?,?,10,2,?,?,?)`).run(userId, botId, options.kind ?? 'chat', options.provider ?? 'direct', model, options.cost ?? 0.1, options.at ?? Date.now(), 'sk-private-request-id');
}
function promptJson(userId: string, botId: string) {
  const context = platformContext(userId, botId);
  assert.equal(typeof context, 'string');
  return JSON.parse(context.slice(context.lastIndexOf('\n') + 1));
}
function safeOutput(value: unknown) {
  assert.doesNotMatch(JSON.stringify(value), /sk-|https?:|wss?:|private-|encrypted_key|key_hint|request_id|baseUrl|websocketUrl|clientSecretProtocol|device|serverLoginAvailable/);
}
async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(check(), 'mock bridge completed its request');
}
async function bridge(userId: string, provider: 'claude' | 'codex', plan: string | null = null) {
  const secret = createCliPairing(userId);
  const ws = new WebSocket(`${base}/api/cli-bridge`);
  sockets.add(ws);
  const requests: { id: string; method: string; params: any }[] = [];
  const status = {
    codex: { installed: true, authenticated: true, subscription: true },
    claude: { installed: true, authenticated: true, subscription: true },
  };
  let catalog: any = {
    models: [{ id: `${provider}/max`, name: 'Account model', efforts: ['low', 'high'], defaultEffort: 'high', vision: true, key: 'sk-private-model-secret' }],
    defaultModel: `${provider}/max`, plan,
    usage: { available: true, checkedAt: Date.now(), windows: [{ label: 'Weekly', usedPercent: 37, resetsAt: null }] },
    key: 'sk-private-catalog-secret', url: 'https://private-remote.invalid/config',
  };
  let failure = false, hold = false;
  ws.on('message', raw => {
    const msg = JSON.parse(String(raw));
    if (msg.type === 'welcome') return;
    requests.push(msg);
    if (msg.method === 'cancel' || (msg.method === 'catalog' && hold)) return;
    ws.send(JSON.stringify({ id: msg.id, ...(failure && msg.method === 'catalog'
      ? { error: 'sk-private-error https://private-remote.invalid/config' }
      : { result: msg.method === 'status' ? status : catalog }) }));
  });
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'hello', version: 1, token: secret, device: 'private-device https://private-device.invalid' }));
  await until(() => cliStatus(userId).connected);
  await refreshCli(userId);
  selectCli(userId, provider);
  return { requests, status, setCatalog: (value: any) => { catalog = value; clearCliCatalog(userId); },
    fail: () => { failure = true; clearCliCatalog(userId); }, hold: () => { hold = true; clearCliCatalog(userId); } };
}

test('authoritative routing and account usage work without ambient attribution or model discovery', async () => {
  const own = account(), foreign = account();
  event(own.userId, own.botId, 'observed-direct');
  event(foreign.userId, foreign.botId, 'foreign-model', { cost: 999 });
  event(null, null, 'server-wide-model', { cost: 999 });
  const before = fetches.length;
  const state = await platformState(own.userId, own.botId);
  assert.equal(state.llm.provider, 'direct');
  assert.equal(state.llm.model, 'direct-model');
  assert.equal(state.llm.configuredModel, null);
  assert.equal(state.llm.latestObserved?.model, 'observed-direct');
  assert.deepEqual(state.voice, { provider: 'xai', model: 'grok-voice' });
  assert.equal(state.usage.scope, 'account');
  assert.equal(state.usage.range.key, '30d');
  assert.deepEqual(state.usage.totals, usageReport(own.userId, '30d').totals);
  assert.equal(state.usage.totals.requests, 1);
  assert.equal(state.usage.totals.costUsd, 0.1);
  assert.equal(state.limits.remainingAllowance, null);
  assert.equal('models' in state, false);
  assert.equal(fetches.length, before);
  safeOutput(state);
  assert.doesNotMatch(JSON.stringify(state), /foreign|server-wide/);
});

test('personal OpenRouter and fast routing override a different inherited account context', async () => {
  const own = account(), inherited = account();
  db.prepare(`INSERT INTO provider_connections(user_id,provider,encrypted_key,key_hint,source,model,enabled,updated_at)
    VALUES (?,'openrouter','sk-private-encrypted-key','private-key-hint','manual','vendor/personal-model',1,?)`).run(own.userId, Date.now());
  db.prepare('UPDATE bots SET model=?,fast=1 WHERE id=?').run('wrong-direct-provider', own.botId);
  selectCli(inherited.userId, 'codex');
  await withUsage({ userId: inherited.userId, botId: inherited.botId }, async () => {
    const state = await platformState(own.userId, own.botId);
    assert.equal(state.llm.provider, 'openrouter');
    assert.equal(state.llm.model, 'vendor/personal-model:nitro');
    assert.equal(state.llm.fast, true);
    assert.equal(state.cli.selected, null);
    assert.equal(currentUserId(), inherited.userId, 'caller context is restored');
    assert.equal(promptJson(own.userId, own.botId).llm.model, state.llm.model);
    safeOutput(state);
  });
  db.prepare('UPDATE bots SET model=? WHERE id=?').run('vendor/explicit-model:variant', own.botId);
  assert.equal((await platformState(own.userId, own.botId)).llm.model, 'vendor/explicit-model:variant');
});

test('foreign, missing, and empty account/Bot pairs fail closed before any helper or report', async () => {
  const own = account(), foreign = account();
  const before = fetches.length;
  for (const [userId, botId] of [[own.userId, foreign.botId], [own.userId, 'absent'], ['', own.botId], [own.userId, '']]) {
    assert.throws(() => platformContext(userId, botId), /unavailable for this account/);
    await assert.rejects(platformState(userId, botId), /unavailable for this account/);
  }
  assert.equal(fetches.length, before);
});

test('latest model is an observed chat for this Bot, separately from voice and configured selection', async () => {
  const own = account(), foreign = account();
  const t = Date.now();
  db.prepare('UPDATE bots SET model=? WHERE id=?').run('configured-direct', own.botId);
  event(own.userId, own.botId, 'actual-chat', { at: t - 500 });
  event(own.userId, own.botId, 'voice-model', { at: t - 400, kind: 'voice' });
  event(own.userId, own.botId, 'summary-model', { at: t - 300, kind: 'voice_summary' });
  event(own.userId, foreign.botId, 'different-bot', { at: t - 200 });
  event(foreign.userId, own.botId, 'foreign-attribution', { at: t - 100 });
  const state = await platformState(own.userId, own.botId);
  assert.equal(state.llm.model, 'configured-direct');
  assert.deepEqual(state.llm.latestObserved, { provider: 'direct', model: 'actual-chat', at: t - 500 });
  const bounded = account();
  event(bounded.userId, bounded.botId, 'too-old-chat', { at: t - 100 });
  for (let i = 0; i < 64; i++) event(bounded.userId, bounded.botId, 'audio', { kind: 'voice', at: t + i });
  assert.equal(promptJson(bounded.userId, bounded.botId).llm.latestObserved, null, 'no unbounded history search');
});

test('usage honors each requested UTC range and rejects unsupported ranges', async () => {
  const own = account();
  event(own.userId, own.botId, 'old-model', { at: Date.now() - 8 * 86400_000 });
  event(own.userId, own.botId, 'current-model');
  for (const range of ['today', '7d', '30d', 'month'] as const) {
    const state = await platformState(own.userId, own.botId, { range });
    assert.equal(state.usage.range.key, range);
    assert.deepEqual(state.usage.totals, usageReport(own.userId, range).totals);
  }
  await assert.rejects(platformState(own.userId, own.botId, { range: 'all' as any }), /Invalid platform usage range/);
});

test('CLI default, observed model, recorded plan and quota are distinct; prompt uses only local observations', async () => {
  const own = account();
  const fake = await bridge(own.userId, 'claude', 'max');
  db.prepare('UPDATE bots SET fast=1 WHERE id=?').run(own.botId);
  event(own.userId, own.botId, 'claude/observed-opus', { provider: 'claude-cli' });
  const before = fake.requests.length;
  assert.equal(promptJson(own.userId, own.botId).cli.catalog, null);
  assert.equal(fake.requests.length, before, 'prompt does not query the runtime');
  const state = await platformState(own.userId, own.botId);
  assert.equal(state.llm.provider, 'claude-cli');
  assert.equal(state.llm.model, 'claude/default', 'routing alias remains authoritative');
  assert.equal(state.llm.latestObserved?.model, 'claude/observed-opus');
  assert.equal(state.cli.catalog?.defaultModel, 'claude/max');
  assert.equal(state.cli.catalog?.plan, 'max');
  assert.equal(state.cli.catalog?.usage.windows[0].usedPercent, 37);
  assert.equal(state.limits.remainingAllowance, null);
  assert.equal('models' in state, false);
  assert.equal(fake.requests.filter(r => r.method === 'generate').length, 0);
  const count = fake.requests.length;
  assert.equal(promptJson(own.userId, own.botId).cli.catalog.plan, 'max');
  assert.equal(fake.requests.length, count);
  assert.ok(platformContext(own.userId, own.botId).length < 4000);
  safeOutput(state);
  state.cli.catalog!.plan = 'mutated';
  assert.equal(promptJson(own.userId, own.botId).cli.catalog.plan, 'max', 'returned state cannot poison cached facts');
  const explicit = await platformState(own.userId, own.botId, { includeModels: true });
  assert.deepEqual(explicit.models?.items.map(m => m.id), ['claude/max']);
  safeOutput(explicit);
  const foreign = account();
  assert.equal(promptJson(foreign.userId, foreign.botId).cli.catalog, null);
  assert.doesNotMatch(platformContext(foreign.userId, foreign.botId), /claude\/max|observed-opus/);
  await refreshCli(own.userId);
  assert.equal(promptJson(own.userId, own.botId).cli.catalog, null, 'new auth observation invalidates old catalog');
  await platformState(own.userId, own.botId);
  setCliRuntime(own.userId, 'server');
  assert.equal(promptJson(own.userId, own.botId).cli.catalog, null, 'runtime change invalidates old catalog');
});

test('CLI aliases never imply a plan or allowance, and unreported quota never becomes zero', async () => {
  const own = account();
  const fake = await bridge(own.userId, 'codex');
  fake.setCatalog({ models: [{ id: 'codex/pro', name: 'Pro alias', efforts: [], defaultEffort: null, vision: false }],
    defaultModel: 'codex/pro', plan: null, usage: { available: false, checkedAt: Date.now(), windows: [] } });
  const state = await platformState(own.userId, own.botId, { includeModels: true });
  assert.equal(state.cli.catalog?.plan, null);
  assert.equal(state.cli.catalog?.usage.available, false);
  assert.deepEqual(state.cli.catalog?.usage.windows, []);
  assert.equal(state.limits.remainingAllowance, null);
  assert.equal(state.models?.available, true);
  fake.fail();
  const failed = await platformState(own.userId, own.botId, { includeModels: true });
  assert.equal(failed.cli.catalog, null);
  assert.equal(failed.models?.available, false);
  safeOutput(failed);
  disconnectCli(own.userId);
  const offline = await platformState(own.userId, own.botId);
  assert.equal(offline.llm.provider, 'codex-cli', 'offline subscription does not imply API fallback');
  assert.equal(offline.cli.connected, false);
  assert.equal(offline.cli.auth, null);
  assert.equal(offline.cli.catalog, null);
});

test('OpenRouter model discovery is explicit and public fields are projected; direct catalog remains unknown', async () => {
  const own = account();
  const direct = await platformState(own.userId, own.botId, { includeModels: true });
  assert.deepEqual(direct.models, { available: false, items: [] });
  setEnvOverride('LLM_PROVIDER', 'openrouter');
  try {
    const before = fetches.length;
    platformContext(own.userId, own.botId);
    await platformState(own.userId, own.botId);
    assert.equal(fetches.length, before);
    const explicit = await platformState(own.userId, own.botId, { includeModels: true });
    assert.equal(fetches.length, before + 1);
    assert.deepEqual(explicit.models, { available: true, items: [{ id: 'vendor/public-model', name: 'Public model', efforts: [], vision: true }] });
    safeOutput(explicit);
  } finally { setEnvOverride('LLM_PROVIDER', null); }
});

test('unsafe config and provider label strings never appear in the public state', async () => {
  const own = account();
  db.prepare('UPDATE bots SET model=? WHERE id=?').run('https://private-remote.invalid/config', own.botId);
  event(own.userId, own.botId, 'sk-private-model-secret');
  const state = await platformState(own.userId, own.botId);
  assert.equal(state.llm.configuredModel, null);
  assert.equal(state.llm.latestObserved, null);
  safeOutput(state);
  const fake = await bridge(own.userId, 'claude');
  fake.setCatalog({ models: [{ id: 'claude/default', name: 'https://private-remote.invalid/config', efforts: [], defaultEffort: null, vision: true }],
    defaultModel: 'claude/default', plan: 'sk-private-plan-secret',
    usage: { available: true, checkedAt: Date.now(), windows: [{ label: 'private@example.test', usedPercent: 0, resetsAt: null }] } });
  const catalog = await platformState(own.userId, own.botId, { includeModels: true });
  assert.equal(catalog.cli.catalog?.plan, null);
  assert.equal(catalog.models?.items[0].name, null);
  assert.equal(catalog.cli.catalog?.usage.windows[0].label, null);
  assert.equal(catalog.cli.catalog?.usage.windows[0].usedPercent, 0, 'observed zero is preserved');
  safeOutput(catalog);
});

test('live state CLI catalog requests abort within about eight seconds with no raw error or fallback', async () => {
  const own = account();
  const fake = await bridge(own.userId, 'codex');
  fake.hold();
  const started = Date.now(), before = fetches.length;
  const state = await platformState(own.userId, own.botId, { includeModels: true });
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 7500 && elapsed < 10_000, `catalog wait was ${elapsed}ms`);
  await until(() => fake.requests.some(r => r.method === 'cancel'));
  assert.equal(state.cli.catalog, null);
  assert.equal(state.models?.available, false);
  assert.equal(state.llm.provider, 'codex-cli');
  assert.equal(fetches.length, before);
  safeOutput(state);
});

test('text agent prompt includes native state and directs delegated configuration requests to the native tool', async () => {
  const { initSubagents } = await import('../server/src/agent/subagents.js');
  const { initRooms } = await import('../server/src/agent/rooms.js');
  initSubagents(); initRooms();
  const { systemPrompt } = await import('../server/src/agent/prompt.js');
  const { briefSchema } = await import('../server/src/bot-setup.js');
  const own = account();
  const before = fetches.length;
  const prompt = await systemPrompt(own.userId, own.botId);
  assert.match(prompt, /Native Swarm account state/);
  assert.match(prompt, /including delegated requests/);
  assert.match(prompt, /Do not browse Swarm/);
  assert.match(prompt, /use get_platform_state/);
  assert.match(prompt, /"provider":"direct"/);
  assert.doesNotMatch(prompt, /sk-|private-direct|private-router|private-voice/);
  const brief = briefSchema.parse({ purpose: 'Test purpose', responsibilities: ['Test responsibility'], out_of_scope: [],
    success_criteria: ['Test success'], context_summary: 'Test context', handoff_notes: [], open_questions: [] });
  db.prepare(`INSERT INTO bot_setups(bot_id,brief,source,updated_at,onboarding_status) VALUES (?,?,?,?,'interviewing')`)
    .run(own.botId, JSON.stringify(brief), JSON.stringify({ messages: [] }), Date.now());
  assert.match(await systemPrompt(own.userId, own.botId), /Native Swarm account state/);
  assert.equal(fetches.length, before, 'prompt construction does not discover model catalogs');
});
