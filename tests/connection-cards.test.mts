import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';
import { Hono } from 'hono';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-connection-cards-'));
Object.assign(process.env, {
  DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'), SESSION_SECRET: 'connection-cards-test-only',
  SWARM_ROLE: 'standalone', NODE_ENV: 'test', COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '',
  COMPOSIO_ORG_ID: '', COMPOSIO_PROJECT_ID: '', ADMIN_EMAILS: '', ADMIN_PHONES: '', INKBOX_TUNNEL: '0',
  APP_URL: 'https://app.example.test', SERVER_URL: 'https://app.example.test',
  LLM_PROVIDER: 'direct', DIRECT_API_KEY: 'mock-model-key', DIRECT_BASE_URL: 'https://model.example.test/v1',
  DIRECT_MODEL: 'mock-card-model', OPENROUTER_API_KEY: '',
});
mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === 'registry.npmjs.org') return Response.json({ version: '0.28.0' });
  if (url.hostname === 'telemetry.composio.dev') return Response.json({});
  if (url.hostname === 'backend.composio.dev' && url.pathname.endsWith('/toolkits')) {
    return Response.json({ items: ['gmail', 'slack'].map(slug => ({ slug, name: slug, meta: { categories: [] } })) });
  }
  throw new Error(`No live provider or model calls are permitted: ${url.hostname}`);
});
const { db } = await import('../server/src/db.js');
await import('../server/src/db-config.js');
const { initSubagents } = await import('../server/src/agent/subagents.js');
const { initRooms } = await import('../server/src/agent/rooms.js');
initSubagents(); initRooms();
const { createBot } = await import('../server/src/bots.js');
const { appendRow, clearConversation, getRow, listRows, updateRow } = await import('../server/src/store.js');
const { setEnvOverride } = await import('../server/src/env.js');
const { composio } = await import('../server/src/composio.js');
const { startCardConnect, pendingConnectionCards, reconcileConnectionCards, refreshConnectionCards, ConnectionCardChanged } = await import('../server/src/agent/connection-cards.js');
const { enqueue, settleAgentJobs } = await import('../server/src/agent/loop.js');
const { llmClient } = await import('../server/src/lib/llm.js');
const { hub } = await import('../server/src/lib/hub.js');
const { api } = await import('../server/src/routes.js');
const app = new Hono().route('/api', api);
for (const id of ['owner', 'other']) {
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(id, `${id}@example.test`, id, Date.now());
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(session_hash(?),?,?,?)').run(id, id, Date.now(), Date.now() + 3600_000);
}
let modelCalls = 0;
mock.method(llmClient(360_000).responses, 'create', async () => {
  modelCalls++;
  return (async function* () { yield { type: 'response.completed', response: { id: 'mock-card-response', output: [], status: 'completed' } }; })();
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
let bot: any, foreign: any, sequence = 0, authorizationCount = 0;
let client: ReturnType<typeof composio>, authorizations: { userId: string; toolkit: string; callback: URL }[];
let accounts: Record<string, any[]>, listCalls: any[], deleted: string[];
let authorizeHook: ((toolkit: string, options: any) => Promise<any>) | undefined;
let listHook: ((query: any) => Promise<any>) | undefined;
let deleteHook: (() => Promise<any>) | undefined;
beforeEach(async () => {
  await settleAgentJobs();
  db.exec('DELETE FROM bots; DELETE FROM composio_sessions');
  bot = createBot('owner', { name: 'Connection worker', isPrimary: true });
  foreign = createBot('other', { name: 'Foreign worker', isPrimary: true });
  accounts = {}; listCalls = []; deleted = []; authorizations = []; modelCalls = 0; authorizationCount = 0;
  authorizeHook = undefined; listHook = undefined; deleteHook = undefined;
  setEnvOverride('COMPOSIO_API_KEY', `card-project-${++sequence}`);
  client = composio();
  mock.method(client, 'create', async (userId: string) => ({ sessionId: `card-session-${sequence}-${userId}`, authorize: async (toolkit: string, options: any) => {
    authorizations.push({ userId, toolkit, callback: new URL(options.callbackUrl) });
    if (authorizeHook) return authorizeHook(toolkit, options);
    return { id: `authorized-${++authorizationCount}`, redirectUrl: 'https://connect.example.test/SECRET-OAUTH-URL' };
  } }));
  mock.method(client.connectedAccounts, 'list', async (query: any) => {
    listCalls.push(query);
    assert.equal(query.accountType, 'PRIVATE');
    assert.equal(query.userIds.length, 1);
    const response = await listHook?.(query);
    if (response !== undefined) return response;
    return { items: structuredClone(accounts[query.userIds[0]] ?? []), nextCursor: null };
  });
  mock.method(client.connectedAccounts, 'delete', async (id: string) => {
    deleted.push(id);
    if (deleteHook) return deleteHook();
    accounts.owner = (accounts.owner ?? []).filter(account => account.id !== id);
    return { success: true };
  });
});
after(async () => { await settleAgentJobs(); mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

const card = (body: Record<string, any> = {}, botId = bot.id) => appendRow(botId, 'card', {
  type: 'card', card: 'connect', toolkit: 'gmail', toolkitName: 'Gmail', reason: 'Verify mailbox access', status: 'pending', ...body,
} as any);
const bodyAt = (seq: number, botId = bot.id): any => getRow(botId, seq)?.body;
const sdkAccount = (id: string, status = 'ACTIVE', toolkit = 'gmail') => ({ id, status, toolkit: { slug: toolkit } });
const ownAccount = (id: string, status = 'ACTIVE', toolkit = 'gmail') => ({ id, status, toolkit });
const jobs = () => db.prepare('SELECT * FROM agent_jobs ORDER BY rowid').all() as any[];
const callbackFor = (row: any) => new URL(`https://app.example.test/api/apps/callback?slug=gmail&bot=${row.botId}&seq=${row.seq}`);
const begin = (row: any) => startCardConnect('owner', 'gmail', callbackFor(row), row.botId, row.seq);
const request = (url: string | URL, options: RequestInit = {}, user = 'owner') => app.request(
  url instanceof URL ? url.pathname + url.search : url,
  { ...options, headers: { cookie: `swarm_session=${user}`, 'content-type': 'application/json', ...options.headers } },
);
const postConnect = (row: any, user = 'owner') => request('/api/apps/gmail/connect', {
  method: 'POST', body: JSON.stringify({ botId: row.botId, seq: row.seq }),
}, user);

test('authorization binds the exact card and attempt without storing an OAuth URL in rows', async () => {
  const row = card({ jobId: 'original-assignment' });
  const result = await begin(row);
  const callback = authorizations[0].callback;
  const bound = bodyAt(row.seq);
  assert.equal(authorizations[0].userId, 'owner');
  assert.equal(callback.searchParams.get('bot'), bot.id);
  assert.equal(callback.searchParams.get('seq'), String(row.seq));
  assert.equal(callback.searchParams.get('generation'), String(row.generation));
  assert.equal(callback.searchParams.get('attempt'), bound.connectionAttempt);
  assert.ok(bound.connectionAttempt);
  assert.equal(bound.connectedAccountId, result.connectedAccountId);
  assert.equal(bound.jobId, 'original-assignment');
  assert.equal(bound.status, 'pending');
  assert.doesNotMatch(JSON.stringify(listRows(bot.id)), /SECRET-OAUTH-URL|connect\.example/);
  assert.equal(jobs().length, 0);
});

test('simultaneous starts for one card share one authorization and binding', async () => {
  const row = card(), started = deferred(), held = deferred();
  authorizeHook = async () => { started.resolve(); await held.promise; return { id: 'shared-account', redirectUrl: 'https://connect.example.test/shared' }; };
  const results = Promise.all(Array.from({ length: 6 }, () => begin(row)));
  try { await started.promise; assert.equal(authorizations.length, 1); }
  finally { held.resolve(); }
  assert.ok((await results).every(result => result.connectedAccountId === 'shared-account'));
  assert.equal(bodyAt(row.seq).connectedAccountId, 'shared-account');
  assert.equal(authorizations.length, 1);
});

test('a retry creates a new attempt, clears the old account binding, and cannot be overwritten by old authorization', async () => {
  const row = card({ connectedAccountId: 'old-account', connectionAttempt: 'old-attempt' });
  const started = deferred(), held = deferred();
  authorizeHook = async () => { started.resolve(); await held.promise; return { id: 'stale-result', redirectUrl: 'https://connect.example.test/stale' }; };
  const refused = assert.rejects(begin(row), ConnectionCardChanged);
  await started.promise;
  const current = bodyAt(row.seq);
  assert.equal(current.connectedAccountId, undefined);
  assert.notEqual(current.connectionAttempt, 'old-attempt');
  updateRow(bot.id, row.seq, { ...current, connectionAttempt: 'newer-attempt', connectedAccountId: 'newer-account' });
  held.resolve(); await refused;
  assert.equal(bodyAt(row.seq).connectionAttempt, 'newer-attempt');
  assert.equal(bodyAt(row.seq).connectedAccountId, 'newer-account');
});

test('a failed authorization can be retried with a distinct attempt', async () => {
  const row = card();
  authorizeHook = async () => { throw new Error('Mock authorization unavailable'); };
  await assert.rejects(begin(row), /Mock authorization unavailable/);
  const oldAttempt = bodyAt(row.seq).connectionAttempt;
  authorizeHook = undefined;
  await begin(row);
  assert.notEqual(bodyAt(row.seq).connectionAttempt, oldAttempt);
  assert.equal(bodyAt(row.seq).connectedAccountId, 'authorized-1');
  assert.equal(authorizations.length, 2);
});

for (const change of ['generation', 'dismissal'] as const) {
  test(`${change} during authorization prevents the returned account from overwriting the card`, async () => {
    const row = card(), started = deferred(), held = deferred();
    authorizeHook = async () => { started.resolve(); await held.promise; return { id: 'stale-account', redirectUrl: 'https://connect.example.test/stale' }; };
    const refused = assert.rejects(begin(row), ConnectionCardChanged);
    await started.promise;
    if (change === 'generation') { clearConversation(bot.id); card({ reason: 'New generation card' }); }
    else updateRow(bot.id, row.seq, { ...bodyAt(row.seq), status: 'skipped' });
    const expected = structuredClone(bodyAt(row.seq));
    held.resolve(); await refused;
    assert.deepEqual(bodyAt(row.seq), expected);
    assert.notEqual(bodyAt(row.seq).connectedAccountId, 'stale-account');
  });
}

test('foreign cards, wrong toolkits, partial bindings and resolved cards cannot start authorization', async () => {
  const foreignRow = card({}, foreign.id), wrongToolkit = card({ toolkit: 'slack' }), resolved = card({ status: 'connected' });
  for (const args of [
    ['owner', 'gmail', callbackFor(foreignRow), foreign.id, foreignRow.seq],
    ['owner', 'gmail', callbackFor(wrongToolkit), bot.id, wrongToolkit.seq],
    ['owner', 'gmail', callbackFor(resolved), bot.id, resolved.seq],
    ['owner', 'gmail', new URL('https://app.example.test/api/apps/callback'), bot.id],
    ['owner', 'gmail', new URL('https://app.example.test/api/apps/callback'), undefined, 1],
  ] as any[]) await assert.rejects(startCardConnect(...args as [string, string, URL, string?, number?]), ConnectionCardChanged);
  assert.equal(authorizations.length, 0);
});

test('pending card snapshots include only this user and current generation', () => {
  card(); clearConversation(bot.id);
  const current = card(), connected = card({ status: 'connected' });
  card({}, foreign.id);
  const pending = pendingConnectionCards('owner');
  assert.deepEqual(pending.map(row => [row.botId, row.generation, row.seq]), [[bot.id, current.generation, current.seq]]);
  assert.notEqual(pending[0].seq, connected.seq);
  assert.equal(jobs().length, 0);
});

test('reconciliation uses exact account ID and toolkit and preserves missing, unknown, disabled and legacy cards', () => {
  const active = card({ connectedAccountId: 'active' }), expired = card({ connectedAccountId: 'expired' });
  const untouched = [card(), card({ connectedAccountId: 'missing' }), card({ connectedAccountId: 'wrong-toolkit' }),
    card({ connectedAccountId: 'initiated' }), card({ connectedAccountId: 'initializing' }), card({ connectedAccountId: 'unknown' }),
    card({ connectedAccountId: 'disabled' }), card({ connectedAccountId: 'duplicate' })];
  const before = untouched.map(row => structuredClone(bodyAt(row.seq)));
  reconcileConnectionCards('owner', pendingConnectionCards('owner'), [
    ownAccount('active'), ownAccount('expired', 'EXPIRED'), ownAccount('wrong-toolkit', 'ACTIVE', 'slack'),
    ownAccount('initiated', 'INITIATED'), ownAccount('initializing', 'INITIALIZING'), ownAccount('unknown', 'NEW_STATE'),
    { ...ownAccount('disabled'), isDisabled: true }, ownAccount('duplicate'), ownAccount('duplicate'),
  ]);
  assert.equal(bodyAt(active.seq).status, 'connected');
  assert.equal(bodyAt(expired.seq).status, 'expired');
  assert.deepEqual(untouched.map(row => bodyAt(row.seq)), before);
  assert.equal(jobs().length, 0); assert.equal(modelCalls, 0);
});

for (const status of ['EXPIRED', 'INACTIVE', 'FAILED', 'REVOKED']) {
  test(`${status} expires only its exactly bound pending card without resuming a job`, () => {
    const row = card({ connectedAccountId: 'matching', connectionAttempt: 'bound-attempt', jobId: 'original-job' });
    reconcileConnectionCards('owner', pendingConnectionCards('owner'), [ownAccount('matching', status)]);
    assert.equal(bodyAt(row.seq).status, 'expired');
    assert.equal(bodyAt(row.seq).connectionAttempt, 'bound-attempt');
    assert.equal(bodyAt(row.seq).jobId, 'original-job');
    assert.equal(jobs().length, 0);
  });
}

test('reconciliation cannot overwrite a changed body, dismissal, foreign owner or new generation', () => {
  const changed = card({ connectedAccountId: 'selected' }), dismissed = card({ connectedAccountId: 'selected' });
  const snapshot = pendingConnectionCards('owner');
  updateRow(bot.id, changed.seq, { ...bodyAt(changed.seq), connectionAttempt: 'newer-attempt' });
  updateRow(bot.id, dismissed.seq, { ...bodyAt(dismissed.seq), status: 'skipped' });
  reconcileConnectionCards('other', snapshot, [ownAccount('selected')]);
  reconcileConnectionCards('owner', snapshot, [ownAccount('selected')]);
  assert.equal(bodyAt(changed.seq).status, 'pending');
  assert.equal(bodyAt(dismissed.seq).status, 'skipped');
  const old = pendingConnectionCards('owner');
  clearConversation(bot.id); const replacement = card({ connectedAccountId: 'selected' });
  reconcileConnectionCards('owner', old, [ownAccount('selected')]);
  assert.equal(bodyAt(replacement.seq).status, 'pending');
  assert.equal(jobs().length, 0);
});

test('refresh preserves pending cards on provider failure and rechecks body after an in-flight lookup', async () => {
  const row = card({ connectedAccountId: 'selected' });
  listHook = async () => { throw new Error('SECRET provider failure'); };
  await refreshConnectionCards('owner');
  assert.equal(bodyAt(row.seq).status, 'pending');
  const started = deferred(), held = deferred();
  listHook = async () => { started.resolve(); await held.promise; return { items: [sdkAccount('selected')] }; };
  const refresh = refreshConnectionCards('owner');
  await started.promise;
  updateRow(bot.id, row.seq, { ...bodyAt(row.seq), connectionAttempt: 'newer-attempt' });
  held.resolve(); await refresh;
  assert.equal(bodyAt(row.seq).status, 'pending');
  assert.doesNotMatch(JSON.stringify(bodyAt(row.seq)), /SECRET/);
  assert.equal(jobs().length, 0);
});

test('refresh skips provider calls for unbound legacy cards and disabled integrations', async () => {
  card(); await refreshConnectionCards('owner');
  card({ connectedAccountId: 'bound' });
  setEnvOverride('COMPOSIO_API_KEY', '');
  await refreshConnectionCards('owner');
  assert.equal(listCalls.length, 0);
});

test('GET connections reconciles owned cards without resuming work or changing a foreign card', async () => {
  const own = card({ connectedAccountId: 'expired' }), other = card({ connectedAccountId: 'expired' }, foreign.id);
  accounts.owner = [sdkAccount('expired', 'EXPIRED')];
  const response = await request('/api/apps/connections');
  assert.equal(response.status, 200);
  assert.equal((await response.json() as any).connections[0].status, 'EXPIRED');
  assert.equal(bodyAt(own.seq).status, 'expired');
  assert.equal(bodyAt(other.seq, foreign.id).status, 'pending');
  assert.ok(listCalls.every(query => query.userIds[0] === 'owner'));
  assert.equal(jobs().length, 0); assert.equal(modelCalls, 0);
});

test('DELETE expired maps non-expired to 409 and provider failure to sanitized 503 without connection events', async () => {
  const events: any[] = [], stop = hub.subscribe('owner', event => { if (event.type === 'connections') events.push(event); });
  try {
    accounts.owner = [sdkAccount('active')];
    const active = await request('/api/apps/connections/active/expired', { method: 'DELETE' });
    assert.equal(active.status, 409);
    assert.equal((await active.json() as any).code, 'not_expired');
    listHook = async () => { throw new Error('SECRET upstream token https://oauth.example/private'); };
    const unavailable = await request('/api/apps/connections/expired/expired', { method: 'DELETE' });
    assert.equal(unavailable.status, 503);
    const body = await unavailable.json() as any;
    assert.equal(body.code, 'upstream_unavailable');
    assert.doesNotMatch(JSON.stringify(body), /SECRET|token|oauth\.example/);
    assert.deepEqual(deleted, []); assert.deepEqual(events, []);
  } finally { stop(); }
});

test('DELETE expired is account-specific, idempotent, authenticated and emits only to the owner', async () => {
  accounts.owner = [sdkAccount('expired', 'EXPIRED'), sdkAccount('keep', 'EXPIRED')];
  accounts.other = [sdkAccount('foreign', 'EXPIRED')];
  const events: string[] = [];
  const stops = ['owner', 'other'].map(user => hub.subscribe(user, event => { if (event.type === 'connections') events.push(user); }));
  try {
    assert.equal((await request('/api/apps/connections/expired/expired', { method: 'DELETE' }, 'invalid')).status, 401);
    for (const [id, removed] of [['foreign', false], ['expired', true], ['expired', false]] as const) {
      const response = await request(`/api/apps/connections/${id}/expired`, { method: 'DELETE' });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true, removed });
    }
    assert.deepEqual(deleted, ['expired']);
    assert.deepEqual(accounts.owner.map(account => account.id), ['keep']);
    assert.deepEqual(events, ['owner', 'owner', 'owner']);
  } finally { stops.forEach(stop => stop()); }
});

test('DELETE expired maps project changes and uncertain provider deletes to safe 503 codes', async () => {
  accounts.owner = [sdkAccount('selected', 'EXPIRED')];
  deleteHook = async () => { throw new Error('SECRET token https://oauth.example/uncertain'); };
  const unavailable = await request('/api/apps/connections/selected/expired', { method: 'DELETE' });
  assert.equal(unavailable.status, 503);
  const failure = await unavailable.json() as any;
  assert.equal(failure.code, 'upstream_unavailable');
  assert.doesNotMatch(JSON.stringify(failure), /SECRET|token|oauth\.example/);
  deleteHook = undefined;
  listHook = async () => { setEnvOverride('COMPOSIO_API_KEY', 'changed-card-project'); };
  const changed = await request('/api/apps/connections/selected/expired', { method: 'DELETE' });
  assert.equal(changed.status, 503);
  assert.equal((await changed.json() as any).code, 'project_changed');
  assert.deepEqual(deleted, ['selected']);
});

test('POST connect binds authorization through the helper and rejects a foreign or stale card with 409', async () => {
  const own = card(), other = card({}, foreign.id);
  const response = await postConnect(own);
  assert.equal(response.status, 200);
  assert.equal(bodyAt(own.seq).connectedAccountId, (await response.json() as any).connectedAccountId);
  assert.equal(authorizations[0].callback.searchParams.get('attempt'), bodyAt(own.seq).connectionAttempt);
  assert.equal((await postConnect(other)).status, 409);
  updateRow(bot.id, own.seq, { ...bodyAt(own.seq), status: 'expired' });
  assert.equal((await postConnect(own)).status, 409);
  assert.equal(authorizations.length, 1);
});

test('a bound ACTIVE callback resumes exactly once under simultaneous and repeated delivery and retains answerJobId', async () => {
  const row = card({ jobId: 'original-assignment' });
  await postConnect(row);
  const callback = authorizations[0].callback;
  accounts.owner = [sdkAccount(bodyAt(row.seq).connectedAccountId)];
  const responses = await Promise.all(Array.from({ length: 5 }, () => request(callback)));
  assert.ok(responses.every(response => response.status === 200));
  await settleAgentJobs();
  const answered = bodyAt(row.seq), answerJobId = answered.answerJobId;
  assert.equal(answered.status, 'connected');
  assert.ok(answerJobId);
  assert.equal(jobs().length, 1);
  assert.equal(jobs()[0].id, answerJobId);
  assert.equal(JSON.parse(jobs()[0].trigger).parentJobId, 'original-assignment');
  assert.match(await (await request(callback)).text(), /"ok":true/);
  await settleAgentJobs();
  assert.equal(bodyAt(row.seq).answerJobId, answerJobId);
  assert.equal(jobs().length, 1);
  assert.equal(modelCalls, 1);
});

test('a card reconciled to connected can still receive its bound callback exactly once', async () => {
  const row = card(); await postConnect(row);
  accounts.owner = [sdkAccount(bodyAt(row.seq).connectedAccountId)];
  await request('/api/apps/connections');
  assert.equal(bodyAt(row.seq).status, 'connected'); assert.equal(jobs().length, 0);
  await request(authorizations[0].callback); await settleAgentJobs();
  assert.equal(jobs().length, 1); assert.ok(bodyAt(row.seq).answerJobId);
});

test('independent work cannot overtake a provider-confirmed connection before its callback continuation', async () => {
  const row = card({ jobId: 'assignment-a' });
  await postConnect(row);
  accounts.owner = [sdkAccount(bodyAt(row.seq).connectedAccountId)];
  await request('/api/apps/connections');
  assert.equal(bodyAt(row.seq).status, 'pending', 'an assigned request waits for its exact continuation');
  assert.equal(bodyAt(row.seq).answerJobId, undefined);
  const independentId = enqueue(bot.id, { type: 'user', voiceAssignment: true, text: 'Independent work B' });
  await settleAgentJobs();
  assert.equal(jobs().find(job => job.id === independentId).state, 'queued');
  assert.equal(modelCalls, 0, 'B must wait for A\'s real continuation despite provider confirmation');
  assert.match(await (await request(authorizations[0].callback)).text(), /"ok":true/);
  await settleAgentJobs();
  const continuation = jobs().find(job => job.id === bodyAt(row.seq).answerJobId);
  assert.equal(JSON.parse(continuation.trigger).parentJobId, 'assignment-a');
  assert.equal(continuation.state, 'completed');
  assert.equal(jobs().find(job => job.id === independentId).state, 'completed');
  assert.equal(modelCalls, 2, 'A continues once, then queued B runs once');
});

test('an older resolved card callback retains its own assignment and answerJobId without claiming the later card', async () => {
  const older = card({ jobId: 'older-assignment' });
  await postConnect(older);
  const olderCallback = authorizations[0].callback;
  const later = card({ jobId: 'later-assignment' });
  await postConnect(later);
  accounts.owner = [sdkAccount(bodyAt(older.seq).connectedAccountId), sdkAccount(bodyAt(later.seq).connectedAccountId)];
  await request('/api/apps/connections');
  // Legacy callbacks/rows may already have marked several cards connected.
  // An exact callback must still select its own card rather than the newest one.
  updateRow(bot.id, older.seq, { ...bodyAt(older.seq), status: 'connected' });
  updateRow(bot.id, later.seq, { ...bodyAt(later.seq), status: 'connected' });
  assert.equal(bodyAt(older.seq).status, 'connected');
  assert.equal(bodyAt(later.seq).status, 'connected');
  const laterSnapshot = structuredClone(bodyAt(later.seq));
  assert.match(await (await request(olderCallback)).text(), /"ok":true/);
  await settleAgentJobs();
  const answerJobId = bodyAt(older.seq).answerJobId;
  assert.ok(answerJobId);
  assert.equal(jobs().length, 1);
  assert.equal(jobs()[0].id, answerJobId);
  assert.equal(JSON.parse(jobs()[0].trigger).parentJobId, 'older-assignment');
  assert.equal(JSON.parse(jobs()[0].trigger).connectionCardSeq, older.seq);
  assert.deepEqual(bodyAt(later.seq), laterSnapshot);
  assert.equal(bodyAt(later.seq).answerJobId, undefined);
  assert.match(await (await request(olderCallback)).text(), /"ok":true/);
  await settleAgentJobs();
  assert.equal(bodyAt(older.seq).answerJobId, answerJobId);
  assert.deepEqual(bodyAt(later.seq), laterSnapshot);
  assert.equal(jobs().length, 1); assert.equal(modelCalls, 1);
});

for (const status of ['INITIATED', 'INITIALIZING', 'EXPIRED', 'INACTIVE', 'FAILED', 'REVOKED']) {
  test(`a ${status} bound account cannot resume from another ACTIVE account of the same toolkit`, async () => {
    const row = card(); await postConnect(row);
    accounts.owner = [sdkAccount(bodyAt(row.seq).connectedAccountId, status), sdkAccount('unrelated-active')];
    assert.match(await (await request(authorizations[0].callback)).text(), /"ok":false/);
    await settleAgentJobs();
    assert.equal(bodyAt(row.seq).status, 'pending');
    assert.equal(bodyAt(row.seq).answerJobId, undefined);
    assert.equal(jobs().length, 0); assert.equal(modelCalls, 0);
  });
}

test('an old callback cannot bind a new generation, a newer attempt, or a legacy unbound replacement row', async () => {
  const row = card(); await postConnect(row);
  const callback = authorizations[0].callback, oldAccount = bodyAt(row.seq).connectedAccountId;
  await postConnect(row);
  const newer = structuredClone(bodyAt(row.seq));
  accounts.owner = [sdkAccount(oldAccount), sdkAccount(newer.connectedAccountId)];
  assert.match(await (await request(callback)).text(), /"ok":false/);
  assert.deepEqual(bodyAt(row.seq), newer);
  clearConversation(bot.id); const replacement = card();
  const expected = structuredClone(bodyAt(replacement.seq));
  assert.match(await (await request(callback)).text(), /"ok":false/);
  await settleAgentJobs();
  assert.deepEqual(bodyAt(replacement.seq), expected);
  const legacy = new URL(callback);
  legacy.searchParams.delete('generation'); legacy.searchParams.delete('attempt');
  assert.match(await (await request(legacy)).text(), /"ok":false/);
  await settleAgentJobs();
  assert.deepEqual(bodyAt(replacement.seq), expected);
  assert.equal(jobs().length, 0);
});

for (const race of ['generation', 'new-attempt', 'dismissal'] as const) {
  test(`callback verification cannot overwrite a ${race} change during its provider lookup`, async () => {
    const row = card(); await postConnect(row);
    const accountId = bodyAt(row.seq).connectedAccountId;
    accounts.owner = [sdkAccount(accountId)];
    const started = deferred(), held = deferred();
    let calls = 0;
    listHook = async () => { if (++calls === 2) { started.resolve(); await held.promise; } };
    const callback = request(authorizations[0].callback);
    await started.promise;
    if (race === 'generation') { clearConversation(bot.id); card({ connectedAccountId: accountId }); }
    else updateRow(bot.id, row.seq, { ...bodyAt(row.seq), ...(race === 'dismissal' ? { status: 'skipped' } : { connectionAttempt: 'newer-attempt', connectedAccountId: 'newer-account' }) });
    const expected = structuredClone(bodyAt(row.seq));
    held.resolve(); assert.equal((await callback).status, 200); await settleAgentJobs();
    assert.deepEqual(bodyAt(row.seq), expected);
    assert.equal(jobs().length, 0); assert.equal(modelCalls, 0);
  });
}
