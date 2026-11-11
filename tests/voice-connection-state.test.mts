// node --import tsx --test --test-concurrency=1 tests/voice-connection-state.test.mts
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';
import { Hono } from 'hono';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-voice-connection-state-'));
let mintRequests = 0, modelRequests = 0;
let mintGate: Promise<void> | undefined, mintStarted: (() => void) | undefined;
const upstream = createServer(async (req, res) => {
  for await (const _chunk of req) { /* Drain the local fixture request. */ }
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/v1/realtime/client_secrets') {
    mintRequests++;
    mintStarted?.();
    await mintGate;
    return res.end(JSON.stringify({ value: 'ephemeral-test-only', expires_at: Math.floor(Date.now() / 1000) + 300 }));
  }
  modelRequests++;
  res.statusCode = 500;
  res.end(JSON.stringify({ error: 'Connection metadata must not dispatch model work.' }));
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
const address = upstream.address();
assert.ok(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}/v1`;
Object.assign(process.env, {
  DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'),
  SESSION_SECRET: 'voice-connection-state-test-only', SWARM_ROLE: 'standalone', NODE_ENV: 'test',
  APP_URL: base, SERVER_URL: base, COMPUTER_PROVIDER: 'local', INKBOX_TUNNEL: '0', SWARM_NO_SCHEDULER: '1',
  COMPOSIO_API_KEY: '', ADMIN_EMAILS: '', ADMIN_PHONES: '',
  XAI_API_KEY: 'private-voice-key', XAI_BASE_URL: base,
  DIRECT_API_KEY: 'private-text-key', DIRECT_BASE_URL: base, DIRECT_MODEL: 'text-model-test',
  OPENROUTER_API_KEY: '', OPENROUTER_BASE_URL: base, LLM_PROVIDER: 'direct',
});
const realFetch = globalThis.fetch;
const forbiddenRequests: string[] = [];
mock.method(globalThis, 'fetch', async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin === new URL(base).origin) return realFetch(input, init);
  // The SDK's background version/telemetry probes are also mocked, never sent.
  if (url.hostname === 'registry.npmjs.org') return Response.json({ version: '0.28.0' });
  if (url.hostname === 'telemetry.composio.dev') return Response.json({});
  forbiddenRequests.push(url.origin + url.pathname);
  throw new Error('Nonlocal network is forbidden in this fixture.');
});

const { db } = await import('../server/src/db.js');
await import('../server/src/db-config.js');
const { setEnvOverride } = await import('../server/src/env.js');
const { composio, connectionsDetail } = await import('../server/src/composio.js');
const { connectionState, CONNECTION_STATE_TIMEOUT_MS } = await import('../server/src/agent/connection-state.js');
const { platformState } = await import('../server/src/agent/platform-state.js');
const { withUsage } = await import('../server/src/usage-context.js');
const { initSubagents } = await import('../server/src/agent/subagents.js');
const { initRooms } = await import('../server/src/agent/rooms.js');
initSubagents(); initRooms();
const { createBot } = await import('../server/src/bots.js');
const { appendRow, appendHistory, clearConversation } = await import('../server/src/store.js');
const { TOOLS } = await import('../server/src/agent/tools.js');
const { voiceApi } = await import('../server/src/voice.js');
const { requireUser } = await import('../server/src/lib/auth.js');
const app = new Hono();
app.use('*', requireUser);
app.route('/voice', voiceApi);
for (const id of ['owner', 'other']) {
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(id, `${id}@example.test`, id, Date.now());
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(session_hash(?),?,?,?)').run(id, id, Date.now(), Date.now() + 3600_000);
}

const UNFINISHED = 'Authorization was started but not completed within 10 minutes';
const NOT_STARTED = 'Connection expired before authorization was started';
const RAW_REASON = 'RAW-REASON token=ACCOUNT-SECRET https://oauth.example.test/private';
const activeToolkits = ['github', 'gmail', 'googlecalendar', 'googlemeet', 'notion'];
const account = (id: string, toolkit = 'github', status = 'ACTIVE', extra: Record<string, unknown> = {}) => ({
  id, toolkit: { slug: toolkit }, status, ...extra,
  data: { access_token: 'ACCOUNT-SECRET' }, metadata: { client_secret: 'PROVIDER-SECRET' },
  authorizationUrl: 'https://oauth.example.test/private', email: 'provider-private@example.test',
});
function productionAccounts() {
  const expired = [['exa', 3], ['gmail', 4], ['notion', 1], ['slack', 6], ['telegram', 1]] as const;
  return [
    ...activeToolkits.map((toolkit, i) => account(`private-active-${i}`, toolkit)),
    ...expired.flatMap(([toolkit, count]) => Array.from({ length: count }, (_, i) =>
      account(`private-expired-${toolkit}-${i}`, toolkit, 'EXPIRED', { statusReason: i % 2 ? NOT_STARTED : `${UNFINISHED}.` }))),
  ];
}
type Query = { userIds: string[]; accountType: string; limit: number; cursor?: string };
type Options = { signal?: AbortSignal };
let bot: any, foreign: any, client: any, sequence = 0, accountPages: Record<string, any[]>;
let queries: { query: Query; options: Options }[] = [];
let listImpl: (query: Query, options: Options) => Promise<any>;
let forbiddenOperations: string[] = [];

beforeEach(() => {
  db.exec('DELETE FROM bots');
  bot = createBot('owner', { name: 'Connection coordinator', isPrimary: true });
  foreign = createBot('other', { name: 'Foreign coordinator', isPrimary: true });
  accountPages = { owner: productionAccounts(), other: [account('foreign-account', 'slack')] };
  queries = []; forbiddenOperations = []; mintRequests = 0; modelRequests = 0;
  mintGate = undefined; mintStarted = undefined;
  setEnvOverride('COMPOSIO_API_KEY', `private-sdk-key-${++sequence}`);
  client = composio();
  listImpl = async query => {
    const items = accountPages[query.userIds[0]] ?? [], offset = Number(query.cursor ?? 0);
    return { items: items.slice(offset, offset + query.limit), nextCursor: offset + query.limit < items.length ? String(offset + query.limit) : null };
  };
  mock.method(client.connectedAccounts, 'list', async (query: Query, options: Options = {}) => {
    queries.push({ query, options });
    assert.equal(query.accountType, 'PRIVATE');
    assert.equal(query.userIds.length, 1);
    assert.equal(query.limit, 100);
    return listImpl(query, options);
  });
  for (const [target, name] of [[client, 'create'], [client.connectedAccounts, 'delete'],
    [client.tools, 'execute'], [client.tools, 'getRawComposioTools'], [client.tools, 'getRawComposioToolBySlug']] as const) {
    mock.method(target, name, async () => {
      forbiddenOperations.push(name);
      throw new Error('Metadata must not authorize, mutate, discover or execute app tools.');
    });
  }
});
after(async () => {
  await new Promise<void>(resolve => upstream.close(() => resolve()));
  mock.restoreAll();
  db.close(); fs.rmSync(root, { recursive: true, force: true });
  assert.deepEqual(forbiddenRequests, [], 'No external requests escaped the SDK mocks');
});

const post = (endpoint: string, body: unknown, user = 'owner') => app.request(`/voice/${endpoint}`, {
  method: 'POST', headers: { cookie: `swarm_session=${user}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
});
async function session(botId = bot.id) {
  const response = await post('session', { botId });
  assert.equal(response.status, 200);
  return response.json() as Promise<any>;
}
async function end(call: any) {
  // Clear before closing so /end cannot launch unrelated background summaries.
  clearConversation(bot.id);
  assert.equal((await post('end', { botId: bot.id, callId: call.callId })).status, 200);
}
async function voiceState(call: any, args: Record<string, unknown> = {}, user = 'owner') {
  const response = await post('tool', { botId: bot.id, callId: call.callId, name: 'get_platform_state', args }, user);
  assert.equal(response.status, 200);
  return JSON.parse((await response.json()).output);
}
function promptState(call: any) {
  const lines = call.instructions.split('\n');
  const index = lines.findIndex((line: string) => line.startsWith('Current native connection status (checked at '));
  assert.ok(index >= 0, 'Session instructions contain an explicit current snapshot');
  return JSON.parse(lines[index + 1]);
}
function sanitized(value: unknown) {
  assert.doesNotMatch(JSON.stringify(value), /private-active|private-expired|foreign-account|ACCOUNT-SECRET|PROVIDER-SECRET|RAW-REASON|statusReason|access_token|client_secret|authorizationUrl|oauth\.example|provider-private|private-sdk-key|private-voice-key|private-text-key/);
}
function unknown(value: any, reason: string) {
  assert.equal(value.status, 'unknown'); assert.equal(value.reason, reason);
  assert.equal(value.scope, 'private_accounts');
  for (const field of ['connectedToolkits', 'activeToolkitCount', 'totalAccounts', 'services']) assert.equal(value[field], null, field);
  assert.equal(value.truncated, false);
  assert.equal(typeof value.checkedAt, 'number');
  sanitized(value);
}
function metadataOnly() {
  assert.deepEqual(forbiddenOperations, []);
  assert.equal(modelRequests, 0, 'Native metadata must not dispatch a chat turn');
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function hangingProvider() {
  let signal: AbortSignal | undefined, aborts = 0;
  listImpl = async (_query, options) => {
    signal = options.signal;
    assert.ok(signal instanceof AbortSignal, 'Deadline cancellation reaches the SDK options argument');
    assert.equal(signal.aborted, false);
    return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => {
      aborts++;
      reject(new Error(RAW_REASON));
    }, { once: true }));
  };
  return { get signal() { return signal; }, get aborts() { return aborts; } };
}

test('production-shaped 5 ACTIVE + 15 EXPIRED inventory stays connected and sanitizes unfinished attempts', async () => {
  const before = JSON.stringify(accountPages.owner), started = Date.now();
  const state = await connectionState('owner', bot.id);
  assert.equal(state.status, 'available'); assert.equal(state.scope, 'private_accounts');
  assert.equal(state.totalAccounts, 20); assert.equal(state.activeToolkitCount, 5);
  assert.deepEqual(state.connectedToolkits, activeToolkits); assert.equal(state.truncated, false);
  assert.ok(state.checkedAt >= started && state.checkedAt <= Date.now());
  assert.equal(state.services!.length, 8);
  const expiredCounts: Record<string, number> = { exa: 3, gmail: 4, notion: 1, slack: 6, telegram: 1 };
  for (const service of state.services!) {
    const active = activeToolkits.includes(service.toolkit), expired = expiredCounts[service.toolkit] ?? 0;
    assert.deepEqual(service, {
      toolkit: service.toolkit, status: active ? 'connected' : 'authorization_required', activeAccounts: active ? 1 : 0,
      pendingAuthorizations: 0, expiredRecords: expired, unfinishedAuthorizations: expired, otherInactiveAccounts: 0,
    });
  }
  assert.equal(state.services!.reduce((total, service) => total + service.unfinishedAuthorizations, 0), 15);
  assert.equal(JSON.stringify(accountPages.owner), before, 'Provider objects remain untouched');
  sanitized(state); metadataOnly(); assert.equal(queries.length, 1);
});

test('the SDK projection classifies only known unfinished reasons without exposing provider details', async () => {
  accountPages.owner = [
    account('private-expired-known', 'github', 'EXPIRED', { statusReason: `  ${UNFINISHED}.  ` }),
    account('private-expired-other', 'github', 'EXPIRED', { statusReason: RAW_REASON }),
    account('private-active-disabled', 'gmail', 'ACTIVE', { isDisabled: true }),
  ];
  const controller = new AbortController();
  const detail = await connectionsDetail('owner', { signal: controller.signal });
  assert.deepEqual(detail, [
    { id: 'private-expired-known', toolkit: 'github', status: 'EXPIRED', authorizationIncomplete: true },
    { id: 'private-expired-other', toolkit: 'github', status: 'EXPIRED' },
    { id: 'private-active-disabled', toolkit: 'gmail', status: 'ACTIVE', isDisabled: true },
  ]);
  assert.equal(queries[0].options.signal, controller.signal);
  metadataOnly();
});

test('disabled, pending, expired and revoked records never count as working accounts', async () => {
  accountPages.owner = [
    account('disabled', 'github', 'ACTIVE', { isDisabled: true }),
    account('pending', 'gmail', 'INITIATED'), account('initializing', 'gmail', 'INITIALIZING'),
    account('expired', 'gmail', 'EXPIRED', { statusReason: NOT_STARTED }),
    account('revoked', 'github', 'REVOKED'), account('failed', 'github', 'FAILED'),
    account('inactive', 'github', 'INACTIVE'),
  ];
  const state = await connectionState('owner', bot.id);
  assert.equal(state.status, 'available'); assert.equal(state.totalAccounts, 7);
  assert.equal(state.activeToolkitCount, 0); assert.deepEqual(state.connectedToolkits, []);
  assert.deepEqual(state.services, [
    { toolkit: 'github', status: 'authorization_required', activeAccounts: 0, pendingAuthorizations: 0, expiredRecords: 0, unfinishedAuthorizations: 0, otherInactiveAccounts: 4 },
    { toolkit: 'gmail', status: 'authorization_pending', activeAccounts: 0, pendingAuthorizations: 2, expiredRecords: 1, unfinishedAuthorizations: 1, otherInactiveAccounts: 0 },
  ]);
});

test('available empty inventory is distinct from unconfigured and failed lookups', async () => {
  accountPages.owner = [];
  const empty = await connectionState('owner', bot.id);
  assert.equal(empty.status, 'available'); assert.equal(empty.totalAccounts, 0);
  assert.equal(empty.activeToolkitCount, 0); assert.deepEqual(empty.connectedToolkits, []); assert.deepEqual(empty.services, []);
  listImpl = async () => { throw new Error(RAW_REASON); };
  unknown(await connectionState('owner', bot.id), 'provider_unavailable');
  setEnvOverride('COMPOSIO_API_KEY', '');
  const calls = queries.length;
  unknown(await connectionState('owner', bot.id), 'not_configured');
  assert.equal(queries.length, calls, 'Disabled provider is never contacted');
});

test('foreign or missing ownership fails before SDK access, even when the provider is disabled', async () => {
  for (const enabled of [true, false]) {
    if (!enabled) setEnvOverride('COMPOSIO_API_KEY', '');
    for (const [userId, botId] of [['owner', foreign.id], ['owner', 'missing'], ['', bot.id], ['owner', '']]) {
      await assert.rejects(connectionState(userId, botId), /unavailable for this account and Bot/);
    }
  }
  assert.equal(queries.length, 0); metadataOnly();
});

test('owned refresh overrides inherited user context and never mixes private inventories', async () => {
  const state = await withUsage({ userId: 'other', botId: foreign.id }, () => connectionState('owner', bot.id));
  assert.deepEqual(state.connectedToolkits, activeToolkits);
  const other = await connectionState('other', foreign.id);
  assert.deepEqual(other.connectedToolkits, ['slack']); assert.equal(other.totalAccounts, 1);
  assert.deepEqual(queries.map(call => call.query.userIds), [['owner'], ['other']]);
  sanitized(state); sanitized(other);
});

test('complete pagination aggregates all owned records and forwards one signal through every SDK page', async () => {
  accountPages.owner = Array.from({ length: 205 }, (_, i) => account(`private-active-${i}`, i % 2 ? 'gmail' : 'github'));
  const state = await connectionState('owner', bot.id);
  assert.equal(state.totalAccounts, 205); assert.equal(state.activeToolkitCount, 2);
  assert.deepEqual(queries.map(call => call.query.cursor), [undefined, '100', '200']);
  const signal = queries[0].options.signal;
  assert.ok(signal instanceof AbortSignal);
  assert.ok(queries.every(call => call.options.signal === signal && call.query.userIds[0] === 'owner'));
  assert.deepEqual(state.services!.map(service => service.activeAccounts).sort((a, b) => a - b), [102, 103]);
  sanitized(state); metadataOnly();
});

test('a later page failure reports unknown instead of a partial successful inventory', async () => {
  listImpl = async query => {
    if (query.cursor) throw new Error(RAW_REASON);
    return { items: [account('private-active-first')], nextCursor: 'next-page' };
  };
  unknown(await connectionState('owner', bot.id), 'provider_unavailable');
  assert.equal(queries.length, 2);
});

test('repeated pagination cursors fail closed without exposing the first page', async () => {
  listImpl = async () => ({ items: [account('private-active-repeated')], nextCursor: 'same-cursor' });
  unknown(await connectionState('owner', bot.id), 'provider_unavailable');
  assert.equal(queries.length, 2);
});

test('malformed and duplicate SDK records are unknown, never silently omitted or treated as empty', async () => {
  for (const items of [
    [account('one'), account('one')], [{ ...account('one'), id: '' }],
    [{ ...account('one'), toolkit: undefined }], [{ ...account('one'), toolkit: { slug: undefined } }],
    [account('one', 'https://oauth.example.test/private')], [account('one', 'github', 'UNRECOGNIZED')],
    [null],
  ]) {
    listImpl = async () => ({ items, nextCursor: null });
    unknown(await connectionState('owner', bot.id), 'provider_unavailable');
  }
  for (const page of [{}, { items: null }, { items: 'malformed' }]) {
    listImpl = async () => page;
    unknown(await connectionState('owner', bot.id), 'provider_unavailable');
  }
});

test('bounded service output explicitly reports truncation while preserving aggregate totals', async () => {
  accountPages.owner = Array.from({ length: 105 }, (_, i) => account(`private-active-${i}`, `service${String(i).padStart(3, '0')}`));
  const state = await connectionState('owner', bot.id);
  assert.equal(state.status, 'available'); assert.equal(state.totalAccounts, 105); assert.equal(state.activeToolkitCount, 105);
  assert.equal(state.services!.length, 100); assert.equal(state.connectedToolkits!.length, 100); assert.equal(state.truncated, true);
});

test('every refresh re-reads the provider and returns independent objects without DB side effects', async () => {
  const tableNames = ['bots', 'rows', 'llm_items', 'agent_jobs', 'approvals', 'policies', 'composio_sessions', 'usage_events'];
  const database = () => JSON.stringify(tableNames.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  const before = database();
  const first = await connectionState('owner', bot.id);
  first.connectedToolkits!.push('injected'); first.services![0].activeAccounts = 999;
  const second = await connectionState('owner', bot.id);
  assert.deepEqual(second.connectedToolkits, activeToolkits); assert.equal(second.services![0].activeAccounts, 1);
  accountPages.owner = [account('private-active-new', 'slack')];
  const third = await connectionState('owner', bot.id);
  assert.deepEqual(third.connectedToolkits, ['slack']); assert.equal(third.totalAccounts, 1);
  assert.equal(queries.length, 3); assert.equal(database(), before); metadataOnly();
});

test('the real 1500ms deadline aborts the SDK request and returns sanitized unknown counts', { timeout: 7000 }, async () => {
  assert.equal(CONNECTION_STATE_TIMEOUT_MS, 1500);
  const hung = hangingProvider(), started = performance.now();
  const state = await connectionState('owner', bot.id);
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 1450 && elapsed < 5000, `Expected the real 1500ms deadline, observed ${elapsed}ms`);
  unknown(state, 'timeout'); assert.equal(hung.signal?.aborted, true); assert.equal(hung.aborts, 1);
  metadataOnly();
});

test('an SDK ignoring cancellation cannot replace a timed-out snapshot after its late response', { timeout: 7000 }, async () => {
  const release = deferred(), completed = deferred();
  let signal: AbortSignal | undefined;
  listImpl = async (_query, options) => {
    signal = options.signal;
    await release.promise;
    completed.resolve();
    return { items: productionAccounts(), nextCursor: null };
  };
  try {
    const started = performance.now();
    const state = await connectionState('owner', bot.id);
    assert.ok(performance.now() - started >= 1450);
    unknown(state, 'timeout'); assert.equal(signal?.aborted, true);
    const beforeLateResponse = structuredClone(state);
    release.resolve(); await completed.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(state, beforeLateResponse, 'Late ACTIVE records cannot rewrite the published unknown snapshot');
    assert.equal(queries.length, 1, 'An uncertain metadata lookup must not dispatch another SDK request');
    metadataOnly();
  } finally { release.resolve(); }
});

test('text platform metadata only refreshes connections when explicitly requested', async () => {
  const tool = TOOLS.find(tool => tool.name === 'get_platform_state')!;
  assert.equal((tool.parameters as any).properties.include_connections.type, 'boolean');
  const ctx: any = { botId: bot.id, userId: 'owner', depth: 0, enqueueBotMessage: () => assert.fail('Must not enqueue') };
  for (const args of [{}, { include_connections: false }]) {
    const state = JSON.parse((await tool.impl(args, ctx)).output as string);
    assert.equal(Object.hasOwn(state, 'connections'), false);
  }
  assert.equal(queries.length, 0);
  const included = JSON.parse((await tool.impl({ include_connections: true }, ctx)).output as string);
  assert.deepEqual(included.connections.connectedToolkits, activeToolkits);
  assert.equal(queries.length, 1); sanitized(included); metadataOnly();
  assert.equal(Object.hasOwn(await platformState('owner', bot.id), 'connections'), false);
});

test('session embeds fresh sanitized JSON despite stale Notion-only prompt and chat history', async () => {
  const stale = 'Earlier connection check: only Notion is connected; no other apps are available.';
  db.prepare('UPDATE bots SET instructions=? WHERE id=?').run(stale, bot.id);
  appendRow(bot.id, 'message', { type: 'message', role: 'assistant', text: stale });
  appendHistory(bot.id, [{ role: 'assistant', content: stale }]);
  const call = await session();
  try {
    assert.match(call.instructions, /only Notion is connected/);
    const state = promptState(call);
    assert.equal(state.totalAccounts, 20); assert.equal(state.activeToolkitCount, 5);
    assert.deepEqual(state.connectedToolkits, activeToolkits); sanitized(state);
    assert.match(call.instructions, /Never infer current status from old chat/);
    assert.match(call.instructions, /If status is unknown/);
    assert.match(call.instructions, /Active accounts take precedence over expired records/);
    assert.equal(call.session.instructions, call.instructions);
    const names = call.tools.map((tool: any) => tool.name);
    assert.ok(names.includes('get_platform_state')); assert.ok(names.includes('send_task'));
    assert.ok(!names.some((name: string) => /^(SWARM_APPS_|COMPOSIO_|mcp_)/.test(name) || ['list_app_connections', 'search_apps', 'request_app_connection'].includes(name)));
    assert.equal(queries.length, 1); assert.equal(mintRequests, 1); metadataOnly();
  } finally { await end(call); }
});

test('voice platform metadata refreshes by default on every call and false skips the provider', async () => {
  const call = await session();
  try {
    accountPages.owner = [account('private-active-recent', 'slack')];
    const state = await voiceState(call);
    assert.deepEqual(state.connections.connectedToolkits, ['slack']); assert.equal(queries.length, 2);
    accountPages.owner = [];
    const refreshed = await voiceState(call);
    assert.equal(refreshed.connections.status, 'available'); assert.equal(refreshed.connections.totalAccounts, 0);
    assert.equal(queries.length, 3);
    const skipped = await voiceState(call, { include_connections: false });
    assert.equal(Object.hasOwn(skipped, 'connections'), false); assert.equal(queries.length, 3);
    sanitized(state); metadataOnly();
  } finally { await end(call); }
});

test('session provider failure embeds unknown instead of trusting an earlier Notion-only answer', async () => {
  appendRow(bot.id, 'message', { type: 'message', role: 'assistant', text: 'Only Notion is connected.' });
  listImpl = async () => { throw new Error(RAW_REASON); };
  const call = await session();
  try {
    unknown(promptState(call), 'provider_unavailable');
    assert.match(call.instructions, /Only Notion is connected/);
    unknown((await voiceState(call)).connections, 'provider_unavailable');
    assert.equal(queries.length, 2); metadataOnly();
  } finally { await end(call); }
});

test('session starts after the real connection timeout with unknown metadata and an aborted SDK signal', { timeout: 7000 }, async () => {
  const hung = hangingProvider(), started = performance.now();
  const call = await session();
  try {
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= 1450 && elapsed < 5000, `Session lookup deadline observed at ${elapsed}ms`);
    unknown(promptState(call), 'timeout'); assert.equal(hung.signal?.aborted, true); assert.equal(hung.aborts, 1);
    assert.equal(mintRequests, 1); assert.equal(queries.length, 1); metadataOnly();
  } finally { await end(call); }
});

test('voice metadata tools preserve the real timeout and provider cancellation', { timeout: 7000 }, async () => {
  const call = await session();
  try {
    const hung = hangingProvider(), started = performance.now();
    unknown((await voiceState(call)).connections, 'timeout');
    assert.ok(performance.now() - started >= 1450);
    assert.equal(hung.signal?.aborted, true); assert.equal(hung.aborts, 1); metadataOnly();
  } finally { await end(call); }
});

test('foreign session and tool targets are rejected before any private SDK request', async () => {
  const rejected = await post('session', { botId: foreign.id });
  assert.equal(rejected.status, 404); assert.equal(queries.length, 0); assert.equal(mintRequests, 0);
  const call = await session();
  try {
    const before = queries.length;
    const denied = await post('tool', { botId: bot.id, callId: call.callId, name: 'get_platform_state', args: { bot_id: foreign.id } });
    assert.equal(denied.status, 200);
    const body = await denied.json();
    assert.match(body.output, /could not be completed/);
    assert.doesNotMatch(body.output, /Foreign coordinator|foreign-account|connections/);
    assert.equal(queries.length, before);
  } finally { await end(call); }
});

test('stale direct adapter calls remain refused without discovery, auth, model dispatch or metadata refresh', async () => {
  const call = await session();
  try {
    const before = queries.length;
    for (const name of ['list_app_connections', 'search_apps', 'request_app_connection', 'SWARM_APPS_SEARCH', 'SWARM_APPS_EXECUTE', 'COMPOSIO_MULTI_EXECUTE_TOOL', 'mcp_private_read']) {
      const response = await post('tool', { botId: bot.id, callId: call.callId, name, args: {} });
      assert.equal(response.status, 200); assert.match((await response.json()).output, /No action was dispatched/);
    }
    assert.equal(queries.length, before); metadataOnly();
  } finally { await end(call); }
});

for (const change of ['clear', 'delete'] as const) {
  test(`session rejects a ${change} racing with secret mint before starting the SDK lookup`, { timeout: 6000 }, async () => {
    const entered = deferred(), release = deferred();
    mintStarted = entered.resolve; mintGate = release.promise;
    const pending = post('session', { botId: bot.id });
    try {
      await entered.promise;
      if (change === 'clear') clearConversation(bot.id);
      else db.prepare('DELETE FROM bots WHERE id=?').run(bot.id);
    } finally { release.resolve(); }
    const response = await pending;
    assert.equal(response.status, 409); assert.match((await response.json()).error, /Conversation changed/);
    assert.equal(queries.length, 0); metadataOnly();
    assert.equal((db.prepare('SELECT COUNT(*) n FROM rows WHERE bot_id=?').get(bot.id) as any).n, 0);
  });

  test(`session rejects a ${change} racing with the SDK lookup without publishing a call`, { timeout: 6000 }, async () => {
    const entered = deferred(), release = deferred();
    listImpl = async () => { entered.resolve(); await release.promise; return { items: productionAccounts(), nextCursor: null }; };
    const pending = post('session', { botId: bot.id });
    try {
      await entered.promise;
      if (change === 'clear') clearConversation(bot.id);
      else db.prepare('DELETE FROM bots WHERE id=?').run(bot.id);
    } finally { release.resolve(); }
    const response = await pending;
    assert.equal(response.status, 409); assert.match((await response.json()).error, /Conversation changed/);
    assert.equal(queries.length, 1); assert.equal(mintRequests, 1); metadataOnly();
    assert.equal((db.prepare('SELECT COUNT(*) n FROM rows WHERE bot_id=?').get(bot.id) as any).n, 0);
  });
}
