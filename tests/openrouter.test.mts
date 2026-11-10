import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test, mock } from 'node:test';
import { Hono } from 'hono';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-openrouter-'));
Object.assign(process.env, {
  DB_PATH: path.join(temp, 'db.sqlite'), FILES_DIR: path.join(temp, 'files'), SESSION_SECRET: 'openrouter-test-only',
  SERVER_URL: 'https://swarm.test', APP_URL: 'https://swarm.test', COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '', XAI_API_KEY: '',
  OPENROUTER_API_KEY: 'server-openrouter-key', OPENROUTER_BASE_URL: 'https://router.test/v1', OPENROUTER_MODEL: 'test/default',
  DIRECT_API_KEY: 'server-direct-key', DIRECT_BASE_URL: 'https://direct.test/v1', DIRECT_MODEL: 'server-model', LLM_PROVIDER: 'direct',
});
const random = () => crypto.randomBytes(32).toString('base64url');
const hash = (s: string) => crypto.createHash('sha256').update(s).digest('base64url');
const newKey = () => `sk-or-v1-${crypto.randomBytes(32).toString('hex')}`;
const keys = new Map<string, any>();
const codes = new Map<string, { key: string; subject: string | null; challenge: string }>();
const calls: { path: string; key: string; body: any }[] = [];
let toolTurn = false;
let inferenceRejected = false;
let exchangeRequests = 0;
mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
  const req = input instanceof Request ? input : new Request(input, init);
  const url = new URL(req.url);
  const auth = req.headers.get('authorization')?.replace('Bearer ', '') ?? '';
  const body = req.method === 'POST' ? await req.json() as any : null;
  if (url.hostname === 'registry.npmjs.org') return Response.json({ version: '0.28.0' });
  if (url.hostname === 'telemetry.composio.dev') return Response.json({});
  if (url.pathname === '/v1/auth/keys') {
    exchangeRequests++;
    const code = codes.get(body.code); codes.delete(body.code);
    if (!code || hash(body.code_verifier) !== code.challenge || body.code_challenge_method !== 'S256') return Response.json({ error: 'invalid code' }, { status: 403 });
    return Response.json({ key: code.key, user_id: code.subject });
  }
  if (url.pathname === '/v1/key') {
    const meta = keys.get(auth);
    return meta ? Response.json({ data: { label: 'Test key', ...meta } }) : Response.json({ error: auth }, { status: 401 });
  }
  if (url.pathname === '/v1/models') return Response.json({ data: ['test/default', 'test/alternate'].map(id => ({ id, name: id, supported_parameters: ['tools', 'reasoning'], architecture: { input_modalities: ['text', 'image'] }, context_length: 128000, pricing: { prompt: '0.000001', completion: '0.000002' } })) });
  calls.push({ path: req.url, key: auth, body });
  if (inferenceRejected) return Response.json({ error: { message: 'Key revoked' } }, { status: 401 });
  if (url.pathname === '/v1/audio/transcriptions') return Response.json({ text: 'My transcription.' });
  if (url.pathname === '/v1/audio/speech') return new Response('mock audio');
  if (url.pathname === '/v1/responses') {
    const text = 'Your personal OpenRouter key ran this task.';
    const item = toolTurn && !body.input.some((i: any) => i.type === 'function_call_output')
      ? { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'remember', arguments: JSON.stringify({ text: 'Prefers provider independence.' }) }
      : { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
    const response = { id: random(), object: 'response', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 5, cost: 0.001 } };
    if (!body.stream) return Response.json(response);
    const events: any[] = [{ type: 'response.output_item.added', output_index: 0, item }];
    if (item.type === 'message') events.push({ type: 'response.output_text.delta', delta: text });
    events.push({ type: 'response.output_item.done', item }, { type: 'response.completed', response });
    return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  }
  throw new Error(`Unexpected mock path: ${url.pathname}`);
});

const { db } = await import('../server/src/db.js');
const { initSubagents } = await import('../server/src/agent/subagents.js');
const { initRooms } = await import('../server/src/agent/rooms.js');
initSubagents(); initRooms();
const { api } = await import('../server/src/routes.js');
const { configApi } = await import('../server/src/routes-config.js');
const { usageApi } = await import('../server/src/routes-usage.js');
const { userFromCookieHeader } = await import('../server/src/lib/auth.js');
const { unsealSecret } = await import('../server/src/settings.js');
const { withUsage } = await import('../server/src/usage-context.js');
const { llmClient, llmProvider, defaultModel, modelFor } = await import('../server/src/lib/llm.js');
const { openrouterConnection, personalOpenRouterKey } = await import('../server/src/providers/openrouter.js');
const { selectCli, selectedCli } = await import('../server/src/cli/store.js');
const { transcribe, synthesize } = await import('../server/src/lib/speech.js');
const { runInBotQueue, enqueue } = await import('../server/src/agent/loop.js');
const { createBot } = await import('../server/src/bots.js');
const { appendRow, listRows, loadHistory } = await import('../server/src/store.js');
const app = new Hono().route('/api', api).route('/api', configApi).route('/api/usage', usageApi);
const sessionCookie = (r: Response) => r.headers.getSetCookie().find(v => v.startsWith('swarm_session='))?.split(';')[0];
const sessionUser = (r: Response) => userFromCookieHeader(sessionCookie(r));
function account() {
  const id = random();
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(id, `${id}@example.com`, 'Member', Date.now());
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (?,?,?,?)').run(id, id, Date.now(), Date.now() + 3600000);
  return { id, cookie: `swarm_session=${id}` };
}
function request(cookie: string | undefined, suffix = '', method = 'GET', body?: unknown, extra: Record<string, string> = {}) {
  return app.request(`/api/providers/openrouter${suffix}`, { method, headers: { ...(cookie ? { cookie } : {}), 'content-type': 'application/json', ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function start(cookie?: string, nativeCookie?: string) {
  const response = await app.request(`/api/auth/openrouter/start${cookie ? '?intent=link' : ''}`, { headers: { cookie: [cookie, nativeCookie].filter(Boolean).join('; ') } });
  assert.equal(response.status, 302);
  const url = new URL(response.headers.get('location')!);
  assert.equal(url.origin, 'https://openrouter.ai');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('callback_url'), 'https://swarm.test/api/auth/openrouter/callback');
  assert.match(response.headers.get('set-cookie')!, /HttpOnly/);
  assert.match(response.headers.get('set-cookie')!, /Secure/);
  assert.match(response.headers.get('set-cookie')!, /SameSite=Lax/);
  return { state: url.searchParams.get('state')!, challenge: url.searchParams.get('code_challenge')!, cookie: [response.headers.get('set-cookie')!.split(';')[0], cookie, nativeCookie].filter(Boolean).join('; ') };
}
function callback(flow: Awaited<ReturnType<typeof start>>, subject: string | null, overrides: { cookie?: string; state?: string; key?: string; error?: string } = {}) {
  const key = overrides.key ?? newKey(), code = random();
  if (!keys.has(key)) keys.set(key, { is_management_key: false });
  codes.set(code, { key, subject, challenge: flow.challenge });
  const query = new URLSearchParams({ code, state: overrides.state ?? flow.state, ...(overrides.error ? { error: overrides.error } : {}) });
  return { key, code, response: app.request(`/api/auth/openrouter/callback?${query}`, { headers: { cookie: overrides.cookie ?? flow.cookie } }) };
}
async function connect(user: ReturnType<typeof account>, key = newKey()) {
  keys.set(key, { is_management_key: false });
  const res = await request(user.cookie, '/key', 'PUT', { key });
  assert.equal(res.status, 200, await res.clone().text());
  return key;
}
after(() => { mock.restoreAll(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

test('OAuth signup creates the primary Bot, encrypts secrets, and repeated login restores the same account', async () => {
  const subject = random(), flow = await start();
  const attempt = db.prepare('SELECT verifier FROM openrouter_login_attempts WHERE id=?').get(flow.state) as any;
  assert.match(attempt.verifier, /^v1:/); assert.equal(hash(unsealSecret(attempt.verifier)!), flow.challenge);
  const signup = callback(flow, subject); const response = await signup.response;
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const user = sessionUser(response)!; assert.ok(user);
  assert.match(user.email, /@openrouter.invalid$/);
  assert.equal((db.prepare('SELECT count(*) n FROM bots WHERE user_id=? AND is_primary=1').get(user.id) as any).n, 1);
  const row = openrouterConnection(user.id)!;
  assert.match(row.encrypted_key!, /^v1:/); assert.ok(!JSON.stringify(row).includes(signup.key));
  assert.equal(personalOpenRouterKey(user.id), signup.key);
  const again = callback(await start(), subject); const signedIn = await again.response;
  assert.equal(sessionUser(signedIn)?.id, user.id); assert.equal(personalOpenRouterKey(user.id), again.key);
  const replay = await app.request(`/api/auth/openrouter/callback?state=${flow.state}&code=${signup.code}`, { headers: { cookie: flow.cookie } });
  assert.match(replay.headers.get('location')!, /openrouter_session/); assert.equal(sessionUser(replay), null);
});

test('callbacks reject missing cookies, state mismatch, expired attempts, cancellation, and missing identity', async () => {
  for (const scenario of ['cookie', 'state', 'expired', 'denied', 'identity']) {
    const flow = await start(); const before = exchangeRequests;
    if (scenario === 'expired') db.prepare('UPDATE openrouter_login_attempts SET expires_at=0 WHERE id=?').run(flow.state);
    const result = callback(flow, scenario === 'identity' ? null : random(), scenario === 'cookie' ? { cookie: '' } : scenario === 'state' ? { state: random() } : scenario === 'denied' ? { error: 'access_denied' } : {});
    const response = await result.response;
    assert.equal(sessionUser(response), null);
    assert.match(response.headers.get('location')!, /openrouter_(session|denied|identity)/);
    assert.equal(exchangeRequests - before, scenario === 'identity' ? 1 : 0);
  }
  const flow = await start();
  const denial = await app.request('/api/auth/openrouter/callback?error=access_denied', { headers: { cookie: flow.cookie } });
  assert.match(denial.headers.get('location')!, /openrouter_denied/);
});

test('linking preserves accounts, rejects cross-account links and changed/expired sessions', async () => {
  const alice = account(), bob = account(), subject = random();
  const linked = await callback(await start(alice.cookie), subject).response;
  assert.equal(sessionUser(linked)?.id, alice.id);
  const login = await callback(await start(), subject).response;
  assert.equal(sessionUser(login)?.id, alice.id);
  for (const [user, identity] of [[bob, subject], [alice, random()]] as const) {
    const rejected = await callback(await start(user.cookie), identity).response;
    assert.match(rejected.headers.get('location')!, /openrouter_already_linked/); assert.equal(sessionUser(rejected), null);
  }
  const flow = await start(bob.cookie);
  const changed = await callback(flow, random(), { cookie: flow.cookie.replace(bob.cookie, alice.cookie) }).response;
  assert.match(changed.headers.get('location')!, /openrouter_link_signin/);
  const expired = await start(bob.cookie);
  db.prepare('UPDATE auth_sessions SET expires_at=0 WHERE token=?').run(bob.id);
  assert.match((await callback(expired, random()).response).headers.get('location')!, /openrouter_link_signin/);
});

test('manual keys require authentication, safe origin, JSON, and valid inference credentials', async () => {
  for (const [suffix, method, body] of [['', 'GET', undefined], ['/key', 'PUT', { key: newKey() }], ['', 'PUT', { enabled: true }], ['/key', 'DELETE', {}]] as const) assert.equal((await request(undefined, suffix, method, body)).status, 401);
  const user = account(), key = await connect(user);
  assert.equal((await request(user.cookie, '/key', 'PUT', { key }, { origin: 'https://evil.test' })).status, 403);
  assert.equal((await request(user.cookie, '/key', 'PUT', { key }, { 'content-type': 'text/plain' })).status, 415);
  for (const value of [null, '', 'invalid', newKey(), 'x'.repeat(5000)]) {
    const response = await request(user.cookie, '/key', 'PUT', { key: value });
    assert.ok(response.status >= 400); assert.equal(personalOpenRouterKey(user.id), key);
  }
  const management = newKey(); keys.set(management, { is_management_key: true });
  assert.equal((await request(user.cookie, '/key', 'PUT', { key: management })).status, 400);
  const expired = newKey(); keys.set(expired, { expires_at: '2020-01-01T00:00:00Z' });
  assert.equal((await request(user.cookie, '/key', 'PUT', { key: expired })).status, 400);
  const status = await request(user.cookie); assert.equal(status.headers.get('cache-control'), 'no-store');
  const statusBody = await status.json(); assert.equal(statusBody.linked, false); assert.equal(statusBody.hint, `…${key.slice(-4)}`);
  assert.ok(!JSON.stringify(statusBody).includes(key));
});

test('pasted keys and creator IDs never become login identities or merge accounts', async () => {
  const alice = account(), bob = account(), key = newKey();
  keys.set(key, { label: alice.id, creator_user_id: alice.id });
  assert.equal((await request(bob.cookie, '/key', 'PUT', { key, userId: alice.id })).status, 200);
  assert.equal(personalOpenRouterKey(bob.id), key); assert.equal(openrouterConnection(alice.id), null);
  assert.equal(db.prepare('SELECT 1 FROM openrouter_identities WHERE user_id=?').get(bob.id), undefined);
});

test('simultaneous users, per-user defaults, queued Bot ownership, and rotated keys remain isolated', async () => {
  const alice = account(), bob = account(), aKey = await connect(alice), bKey = await connect(bob);
  assert.equal((await request(alice.cookie, '', 'PUT', { model: 'test/alternate' })).status, 200);
  assert.equal((await request(alice.cookie, '', 'PUT', { model: 'unsupported/model' })).status, 400);
  const before = calls.length;
  await Promise.all([alice, bob].map(user => withUsage({ userId: user.id }, async () => {
    await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(llmProvider(), 'openrouter');
    assert.equal(defaultModel(), user === alice ? 'test/alternate' : 'test/default');
    assert.equal(modelFor('codex/default'), defaultModel());
    await llmClient(2000).responses.create({ model: defaultModel(), input: 'Hello' });
  })));
  assert.deepEqual(new Set(calls.slice(before).map(c => c.key)), new Set([aKey, bKey]));
  const bot = createBot(bob.id, { name: 'Queued Bot' });
  await withUsage({ userId: alice.id }, () => runInBotQueue(bot.id, async () => {
    await llmClient(2000).responses.create({ model: defaultModel(), input: 'Background job' });
  }));
  assert.equal(calls.at(-1)!.key, bKey);
  const replacement = await connect(alice);
  await withUsage({ userId: alice.id }, () => llmClient(2000).responses.create({ model: defaultModel(), input: 'Rotation' }));
  assert.equal(calls.at(-1)!.key, replacement);
  const models = await app.request('/api/settings/models', { headers: { cookie: alice.cookie } });
  assert.equal((await models.json()).provider, 'openrouter');
});

test('subscription choice stays authoritative; switching to OpenRouter is explicit', async () => {
  const user = account(); selectCli(user.id, 'codex'); await connect(user);
  withUsage({ userId: user.id }, () => assert.equal(llmProvider(), 'codex-cli'));
  const status = await (await request(user.cookie)).json(); assert.equal(status.active, false);
  assert.equal((await request(user.cookie, '', 'PUT', { enabled: true })).status, 200);
  assert.equal(selectedCli(user.id), null);
  withUsage({ userId: user.id }, () => assert.equal(llmProvider(), 'openrouter'));
});

test('disconnect and corrupt ciphertext fail closed, while identity survives key removal', async () => {
  const signup = await callback(await start(), random()).response;
  const user = sessionUser(signup)!, cookie = sessionCookie(signup)!;
  const oldKey = personalOpenRouterKey(user.id);
  db.prepare("UPDATE provider_connections SET encrypted_key='v1:corrupt' WHERE user_id=?").run(user.id);
  withUsage({ userId: user.id }, () => assert.throws(() => llmClient(2000), /Reconnect OpenRouter/));
  keys.set(oldKey, {}); await request(cookie, '/key', 'PUT', { key: oldKey });
  const disconnected = await (await request(cookie, '/key', 'DELETE', {})).json();
  assert.equal(disconnected.connected, false); assert.equal(disconnected.linked, true); assert.equal(disconnected.active, true);
  const count = calls.length;
  withUsage({ userId: user.id }, () => assert.throws(() => llmClient(2000), /Reconnect OpenRouter/));
  assert.equal(calls.length, count);
  assert.equal((await request(cookie, '', 'PUT', { enabled: true })).status, 409);
  await request(cookie, '', 'PUT', { enabled: false });
  await withUsage({ userId: user.id }, () => llmClient(2000).responses.create({ model: defaultModel(), input: 'Explicit server default' }));
  assert.equal(calls.at(-1)!.key, 'server-direct-key');
});

test('audio uses the personal key and does not retry with a shared paid key', async () => {
  const user = account(), key = await connect(user);
  await withUsage({ userId: user.id }, async () => {
    assert.equal(await transcribe({ data: Buffer.from('audio'), mime: 'audio/wav' }), 'My transcription.');
    await synthesize('Hello', 'luna');
    assert.equal(calls.at(-1)!.key, key); assert.equal(calls.at(-2)!.key, key);
    inferenceRejected = true;
    const before = calls.length;
    try { await assert.rejects(transcribe({ data: Buffer.from('audio'), mime: 'audio/wav' })); }
    finally { inferenceRejected = false; }
    assert.equal(calls.length - before, 1);
  });
});

test('provider usage reads only the requesting user’s key, including non-owners', async () => {
  const alice = account(), bob = account(), aKey = await connect(alice), bKey = await connect(bob);
  keys.set(aKey, { usage: 11 }); keys.set(bKey, { usage: 22 });
  for (const [user, usage] of [[alice, 11], [bob, 22], [alice, 11]] as const) {
    const res = await app.request('/api/usage/provider', { headers: { cookie: user.cookie } });
    assert.equal(res.status, 200); assert.equal((await res.json()).openrouter.usage.allTime, usage);
  }
});

test('real agent loop streams a reply and executes a tool using the owner’s key', async () => {
  const user = account(), other = account(), key = await connect(user);
  const bot = createBot(user.id, { name: 'OpenRouter integration', model: 'test/alternate', isPrimary: true });
  const row = appendRow(bot.id, 'message', { type: 'message', role: 'user', text: 'Remember that I prefer provider independence.' });
  const before = calls.length; toolTurn = true;
  try {
    withUsage({ userId: other.id }, () => enqueue(bot.id, { type: 'user', text: 'Remember that I prefer provider independence.' }));
    await runInBotQueue(bot.id, async () => {});
  } finally { toolTurn = false; }
  const requests = calls.slice(before).filter(c => c.path.endsWith('/responses'));
  assert.equal(requests.length, 2); assert.ok(requests.every(c => c.key === key && c.body.model === 'test/alternate' && c.body.store === false));
  assert.ok(loadHistory(bot.id).some((i: any) => i.type === 'function_call_output'));
  assert.ok(db.prepare('SELECT 1 FROM memories WHERE bot_id=? AND text=?').get(bot.id, 'Prefers provider independence.'));
  assert.ok(listRows(bot.id).some((r: any) => r.body.text === 'Your personal OpenRouter key ran this task.'));
});

test('native OpenRouter login and linking bind the browser handoff to app PKCE and session', async () => {
  for (const linking of [false, true]) {
    const user = account(), verifier = random(), state = random();
    let startURL = `/api/auth/native/start?provider=openrouter&challenge=${hash(verifier)}&state=${state}`;
    if (linking) {
      const prepared = await app.request('/api/auth/native/openrouter/prepare', { method: 'POST', headers: { cookie: user.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ state, challenge: hash(verifier) }) });
      assert.equal(prepared.status, 200); const { ticket } = await prepared.json();
      startURL = `/api/auth/native/start?ticket=${ticket}`;
      assert.ok(!startURL.includes(user.id));
    }
    const native = await app.request(startURL);
    assert.equal(native.headers.get('location'), '/api/auth/openrouter/start');
    if (linking) assert.equal((await app.request(startURL)).status, 401);
    const nativeCookie = native.headers.get('set-cookie')!.split(';')[0];
    const flow = await start(undefined, nativeCookie);
    const response = await callback(flow, random()).response;
    const callbackURL = new URL(response.headers.get('location')!);
    assert.equal(callbackURL.protocol, 'so.swarms.app:'); assert.equal(callbackURL.searchParams.get('state'), state);
    const exchange = (secret: string) => app.request('/api/auth/native/exchange', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: callbackURL.searchParams.get('code'), verifier: secret }) });
    assert.equal((await exchange(random())).status, 401);
    const completed = await exchange(verifier); assert.equal(completed.status, 200);
    assert.ok(sessionUser(completed)); if (linking) assert.equal(sessionUser(completed)?.id, user.id);
    assert.equal((await exchange(verifier)).status, 401);
  }
});

test('account deletion cascades credentials and OAuth identities', async () => {
  const response = await callback(await start(), random()).response;
  const user = sessionUser(response)!;
  db.prepare('DELETE FROM users WHERE id=?').run(user.id);
  assert.equal(openrouterConnection(user.id), null);
  assert.equal(db.prepare('SELECT 1 FROM openrouter_identities WHERE user_id=?').get(user.id), undefined);
});
