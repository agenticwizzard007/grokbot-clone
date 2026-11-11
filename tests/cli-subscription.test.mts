// node --import tsx --test --test-concurrency=1 tests/cli-subscription.test.mts
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';
import { Hono } from 'hono';
import { WebSocket } from 'ws';

// Configure every server module before importing it. Both API keys intentionally exist:
// a subscription failure must still never send a request to a paid API.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-cli-subscription-'));
const apiRequests: string[] = [];
const server = createServer((req, res) => {
  apiRequests.push(`${req.method} ${req.url}`);
  res.writeHead(503, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Unexpected API billing attempt in subscription test' } }));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
Object.assign(process.env, {
  DB_PATH: path.join(temp, 'test.db'), FILES_DIR: path.join(temp, 'files'), SESSION_SECRET: 'cli-test-only',
  SERVER_URL: base, APP_URL: base, COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '', ADMIN_EMAILS: '',
  DIRECT_API_KEY: 'configured-direct-test-key', DIRECT_BASE_URL: `${base}/direct`, DIRECT_MODEL: 'api-only-model',
  OPENROUTER_API_KEY: 'configured-openrouter-test-key', OPENROUTER_BASE_URL: `${base}/openrouter`,
  OPENROUTER_MODEL: 'api/default', LLM_PROVIDER: 'openrouter', INKBOX_TUNNEL: '0',
});

const { db } = await import('../server/src/db.js');
const { initSubagents } = await import('../server/src/agent/subagents.js');
const { initRooms } = await import('../server/src/agent/rooms.js');
initSubagents(); initRooms();
const { createCliPairing, authenticateCli, revokeCliPairing, selectCli, selectedCli } = await import('../server/src/cli/store.js');
const { attachCliSocket, cliStatus, cliRequest, disconnectCli, refreshCli, CLI_OFFLINE } = await import('../server/src/cli/bridge.js');
const { cliResponsesClient, prepareCliRequest } = await import('../server/src/cli/responses.js');
const { cliApi } = await import('../server/src/cli/routes.js');
const { requireUser } = await import('../server/src/lib/auth.js');
const { llmClient, defaultModel, llmProvider, modelFor, serverTools, providerFields } = await import('../server/src/lib/llm.js');
const { withUsage, recordModelUsage, usageReport } = await import('../server/src/usage.js');
const { createBot } = await import('../server/src/bots.js');
const { enqueue, runInBotQueue, interrupt } = await import('../server/src/agent/loop.js');
const { appendRow, listRows, loadHistory, getLive } = await import('../server/src/store.js');
const { consolidateBot } = await import('../server/src/agent/memory.js');
const { saveMcpServer, mcpToolName } = await import('../server/src/mcp/store.js');
const { voiceApi } = await import('../server/src/voice.js');
const { synthesize, transcribe, SUBSCRIPTION_VOICE_UNAVAILABLE } = await import('../server/src/lib/speech.js');

attachCliSocket(server);
const app = new Hono().route('/api/cli', cliApi);
const authenticated = new Hono();
authenticated.use('*', requireUser);
authenticated.route('/voice', voiceApi);
authenticated.get('/routing', async (c) => {
  // Routing must survive an async boundary supplied by actual requireUser middleware.
  await new Promise<void>(resolve => setImmediate(resolve));
  const model = defaultModel();
  const provider = llmProvider();
  const response: any = await llmClient(2000).responses.create({ model, input: [{ role: 'user', content: 'HTTP routing' }] });
  return c.json({ model, provider, text: response.output_text });
});
app.route('/authenticated', authenticated);

const users = ['cli-alice', 'cli-bob'] as const;
const [alice, bob] = users;
for (const id of users) {
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(id, `${id}@example.com`, id, Date.now());
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (session_hash(?),?,?,?)').run(id, id, Date.now(), Date.now() + 3_600_000);
  db.prepare('UPDATE auth_sessions SET last_seen_at=created_at,authenticated_at=created_at WHERE token=session_hash(?)').run(id);
}

type Provider = 'codex' | 'claude';
type Rpc = { id: string; method: 'status' | 'generate' | 'cancel'; params?: any };
const HOLD = Symbol('hold request until cancellation');
const verified = () => ({
  codex: { installed: true, authenticated: true, subscription: true },
  claude: { installed: true, authenticated: true, subscription: true },
});
const result = (text: string, tool_calls: { name: string; arguments: string }[] = []) => ({
  text: JSON.stringify({ text, tool_calls }),
  usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 30 } },
});
const bridges = new Set<FakeBridge>();
const bots = new Set<string>();

async function until(check: () => boolean, description: string) {
  const deadline = Date.now() + 2000;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(check(), description);
}

class FakeBridge {
  ws = new WebSocket(base.replace('http:', 'ws:') + '/api/cli-bridge');
  requests: Rpc[] = [];
  status: any = verified();
  generate: (request: Rpc) => any = () => result(this.userId);
  welcome = false;
  closed = new Promise<{ code: number; reason: string }>(resolve => {
    this.ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });

  constructor(readonly userId: string) {
    bridges.add(this);
    this.ws.on('error', () => {});
    this.ws.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'welcome') { this.welcome = true; return; }
      this.requests.push(message);
      if (message.method === 'status') this.respond(message.id, this.status);
      if (message.method === 'generate') {
        try {
          const reply = this.generate(message);
          if (reply !== HOLD) this.respond(message.id, reply);
        } catch (error) {
          this.ws.send(JSON.stringify({ id: message.id, error: (error as Error).message }));
        }
      }
    });
  }

  respond(id: string, value: unknown) { this.ws.send(JSON.stringify({ id, result: value })); }
  get generations() { return this.requests.filter(request => request.method === 'generate'); }
  async hello(secret: string) {
    await once(this.ws, 'open');
    this.ws.send(JSON.stringify({ type: 'hello', version: 1, token: secret, device: `Computer of ${this.userId}` }));
  }
}

async function connect(userId: string, secret = createCliPairing(userId)) {
  const bridge = new FakeBridge(userId);
  await bridge.hello(secret);
  await until(() => bridge.welcome, 'bridge handshake should finish');
  await refreshCli(userId);
  return bridge;
}

function req(userId: string | null, route = '', method = 'GET', body?: unknown) {
  return app.request(`/api/cli${route}`, {
    method, headers: { ...(userId ? { cookie: `swarm_session=${userId}` } : {}), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function choose(userId: string, provider: Provider) {
  const response = await req(userId, '', 'PUT', { provider });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).selected, provider);
}
function newBot(userId: string) {
  const bot = createBot(userId, { name: `Bot of ${userId}`, isPrimary: true, model: 'api/custom-model' });
  bots.add(bot.id);
  return bot;
}
const events = (userId: string) => db.prepare('SELECT * FROM usage_events WHERE user_id=? ORDER BY id').all(userId) as any[];
const requestBody = () => ({ model: 'ignored-api-model', input: [{ role: 'user', content: 'Use the app tools when needed.' }] });

beforeEach(() => { apiRequests.length = 0; });
afterEach(async () => {
  for (const id of bots) interrupt(id);
  for (const userId of users) disconnectCli(userId);
  for (const bridge of bridges) {
    if (bridge.ws.readyState !== WebSocket.CLOSED) bridge.ws.terminate();
  }
  await Promise.all([...bridges].map(bridge => bridge.closed));
  await Promise.all([...bots].map(id => runInBotQueue(id, async () => {})));
  bridges.clear(); bots.clear();
  db.exec('DELETE FROM cli_pairings; DELETE FROM cli_preferences; DELETE FROM usage_events; DELETE FROM bots; DELETE FROM mcp_servers;');
  assert.deepEqual(apiRequests, [], 'subscription paths must not call API inference, audio, MCP execution before approval, or token pricing');
});
after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('pairing secrets are hashed, scoped to a user, rotated independently, expired, and revocable', () => {
  const a1 = createCliPairing(alice), b1 = createCliPairing(bob);
  const row = db.prepare('SELECT * FROM cli_pairings WHERE user_id=?').get(alice) as any;
  assert.equal(row.token_hash, createHash('sha256').update(a1).digest('hex'));
  assert.notEqual(row.token_hash, a1);
  assert.ok(row.expires_at > Date.now() && row.expires_at <= Date.now() + 600_000);
  const a2 = createCliPairing(alice);
  assert.notEqual(a1, a2);
  assert.equal(authenticateCli(a1), null);
  db.prepare('UPDATE cli_pairings SET expires_at=? WHERE user_id=?').run(Date.now() - 1, alice);
  assert.equal(authenticateCli(a2), null);
  assert.equal(authenticateCli(b1), bob);
  assert.equal((db.prepare('SELECT expires_at FROM cli_pairings WHERE user_id=?').get(bob) as any).expires_at, null);
  assert.equal(authenticateCli(b1), bob, 'activated credentials permit reconnects');
  revokeCliPairing(alice);
  assert.equal(authenticateCli(a2), null);
  assert.equal(authenticateCli(b1), bob);
  assert.equal(authenticateCli('unknown-token'), null);
  assert.equal(authenticateCli('x'.repeat(257)), null);
  assert.equal(selectedCli(null), null);
});

test('all CLI REST mutations and status require a real, unexpired browser session', async () => {
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (session_hash(?),?,?,?)').run('expired', alice, Date.now() - 2000, Date.now() - 1);
  for (const credential of [null, 'invalid', 'expired']) {
    for (const [route, method] of [['', 'GET'], ['', 'PUT'], ['/refresh', 'POST'], ['/pair', 'POST'], ['/pair', 'DELETE']]) {
      const response = await req(credential, route, method, method === 'PUT' ? { provider: 'codex' } : undefined);
      assert.equal(response.status, 401, `${method} ${route} with ${credential}`);
      assert.deepEqual(await response.json(), { error: 'unauthenticated' });
    }
  }
  assert.equal((db.prepare('SELECT COUNT(*) n FROM cli_pairings').get() as any).n, 0);
});

test('REST status and mode validation fail closed and explicit null restores API mode', async () => {
  const response = await req(alice);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    selected: null, connected: false, device: null, runtime: 'bridge', serverLoginAvailable: true,
    providers: { codex: { installed: false, authenticated: false, subscription: false }, claude: { installed: false, authenticated: false, subscription: false } },
  });
  for (const body of [null, {}, { provider: 'openrouter' }, { provider: 'Codex' }, { provider: 1 }, { provider: {} }]) {
    assert.equal((await req(alice, '', 'PUT', body)).status, 400);
  }
  assert.equal((await app.request('/api/cli', { method: 'PUT', headers: { cookie: `swarm_session=${alice}` }, body: 'invalid JSON' })).status, 415);
  assert.equal((await app.request('/api/cli', { method: 'PUT', headers: { cookie: `swarm_session=${alice}`, 'content-type': 'application/json' }, body: 'invalid JSON' })).status, 400);
  assert.equal((await req(alice, '', 'PUT', { provider: 'codex' })).status, 409);
  assert.equal(selectedCli(alice), null);
  selectCli(alice, 'codex');
  const cleared = await req(alice, '', 'PUT', { provider: null });
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json()).selected, null);
  assert.equal(withUsage({ userId: alice }, defaultModel), 'api/default');
});

test('pair endpoint creates only the signed-in user credential and rotates only that user bridge', async () => {
  const a = await connect(alice), b = await connect(bob);
  await choose(alice, 'codex');
  await choose(bob, 'claude');
  const oldTokenHash = (db.prepare('SELECT token_hash FROM cli_pairings WHERE user_id=?').get(alice) as any).token_hash;
  const response = await req(alice, '/pair', 'POST', { userId: bob });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const { command } = await response.json();
  assert.match(command, /curl -fsSL/);
  assert.ok(command.includes(`'${base}/api/cli/script'`));
  assert.ok(command.includes(`--server '${base}'`));
  const secret = /--token '([^']+)'$/.exec(command)?.[1];
  assert.ok(secret, 'pairing command contains a shell-quoted credential');
  assert.notEqual((db.prepare('SELECT token_hash FROM cli_pairings WHERE user_id=?').get(alice) as any).token_hash, oldTokenHash);
  assert.equal(authenticateCli(secret), alice);
  assert.equal((await a.closed).code, 4401);
  assert.equal(cliStatus(alice).selected, 'codex', 'rotation must not silently enable API billing');
  assert.equal(cliStatus(bob).connected, true);
  assert.equal(b.ws.readyState, WebSocket.OPEN);
  assert.equal(cliStatus(bob).selected, 'claude');
});

test('WebSocket handshake rejects expired, rotated, unknown, and revoked tokens', async () => {
  const expired = createCliPairing(alice);
  db.prepare('UPDATE cli_pairings SET expires_at=? WHERE user_id=?').run(Date.now() - 1, alice);
  const expiredBridge = new FakeBridge(alice);
  await expiredBridge.hello(expired);
  assert.equal((await expiredBridge.closed).code, 4401);
  const rotated = createCliPairing(alice);
  const revoked = createCliPairing(alice);
  revokeCliPairing(alice);
  for (const secret of [rotated, revoked, 'unknown']) {
    const bridge = new FakeBridge(alice);
    await bridge.hello(secret);
    assert.equal((await bridge.closed).code, 4401);
    assert.equal(bridge.welcome, false);
  }
  assert.equal(cliStatus(alice).connected, false);
});

test('both providers can be selected only after installed, authenticated subscription status is verified', async () => {
  const bridge = await connect(alice);
  for (const provider of ['codex', 'claude'] as const) {
    for (const field of ['installed', 'authenticated', 'subscription'] as const) {
      bridge.status = verified();
      bridge.status[provider][field] = false;
      const rejected = await req(alice, '', 'PUT', { provider });
      assert.equal(rejected.status, 409, `${provider} with ${field}=false`);
      assert.equal(selectedCli(alice), null);
      assert.equal(selectedCli(bob), null);
    }
    bridge.status = verified();
    await choose(alice, provider);
    assert.equal(cliStatus(alice).device, `Computer of ${alice}`);
    await req(alice, '', 'PUT', { provider: null });
  }
  assert.ok(bridge.requests.filter(request => request.method === 'status').length >= 8, 'selection refreshes CLI auth, rather than trusting stale status');
});

test('malformed bridge authentication reports produce 502 and preserve the previous selection', async () => {
  const bridge = await connect(alice);
  await choose(alice, 'codex');
  for (const status of [{}, null, { ...verified(), claude: { installed: true, authenticated: 'true', subscription: true } }]) {
    bridge.status = status;
    const response = await req(alice, '/refresh', 'POST');
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /invalid authentication status/);
    assert.equal((await req(alice, '', 'PUT', { provider: 'claude' })).status, 502);
    assert.equal(selectedCli(alice), 'codex');
  }
});

test('withUsage routes simultaneous users to their own CLI, model and subscription-only fields', async () => {
  const a = await connect(alice), b = await connect(bob);
  await choose(alice, 'codex'); await choose(bob, 'claude');
  const outputs = await Promise.all([[alice, 'codex'], [bob, 'claude']].map(async ([userId, provider]) => withUsage({ userId }, async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(defaultModel(), `${provider}/default`);
    assert.equal(llmProvider(), `${provider}-cli`);
    assert.equal(modelFor('expensive/api-model'), `${provider}/default`);
    assert.deepEqual(serverTools(), []);
    assert.deepEqual(providerFields({ effort: 'high', reasoning: true, cacheKey: 'test', safetyId: 'test' }), {});
    const response: any = await llmClient(2000).responses.create(requestBody());
    assert.equal(response.provider, `${provider}-cli`);
    assert.equal(response.model, `${provider}/default`);
    return response.output_text;
  })));
  assert.deepEqual(outputs, [alice, bob]);
  assert.equal(a.generations.length, 1); assert.equal(b.generations.length, 1);
  assert.equal(a.generations[0].params.provider, 'codex');
  assert.equal(b.generations[0].params.provider, 'claude');
  assert.equal(defaultModel(), 'api/default', 'ambient routing must not leak out of either request');
});

test('real requireUser establishes isolated routing for asynchronous signed-in HTTP handlers', async () => {
  await connect(alice); await connect(bob);
  await choose(alice, 'codex'); await choose(bob, 'claude');
  const responses = await Promise.all(users.map(userId => app.request('/authenticated/routing', { headers: { cookie: `swarm_session=${userId}` } })));
  assert.deepEqual(await Promise.all(responses.map(response => response.json())), [
    { model: 'codex/default', provider: 'codex-cli', text: alice },
    { model: 'claude/default', provider: 'claude-cli', text: bob },
  ]);
  const foreignBot = newBot(alice);
  const inherited = await withUsage({ userId: alice, botId: foreignBot.id }, () => app.request('/authenticated/routing', { headers: { cookie: `swarm_session=${bob}` } }));
  assert.deepEqual(await inherited.json(), { model: 'claude/default', provider: 'claude-cli', text: bob }, 'requireUser clears inherited bot attribution before routing the signed-in request');
  assert.equal((await app.request('/authenticated/routing')).status, 401);
});

test('adapter streams Responses API function_call items with exact app tool names and original arguments', async () => {
  const bridge = await connect(alice);
  const args = '{"message":"please review","nested":{"ok":true}}';
  bridge.generate = () => result('Requesting the app action.', [{ name: 'mcp_exact_tool', arguments: args }]);
  const stream = await cliResponsesClient(alice, 'codex', 2000).responses.create({
    ...requestBody(), stream: true,
    tools: [{ type: 'function', name: 'mcp_exact_tool', parameters: { type: 'object' } }, { type: 'web_search' }],
  });
  const emitted: any[] = [];
  for await (const event of stream) emitted.push(event);
  const final = emitted.at(-1);
  assert.equal(final.type, 'response.completed');
  assert.equal(final.response.billing, 'subscription');
  assert.equal(final.response.provider, 'codex-cli');
  assert.equal(final.response.output_text, 'Requesting the app action.');
  const [message, call] = final.response.output;
  assert.equal(message.type, 'message');
  assert.deepEqual(message.content, [{ type: 'output_text', text: 'Requesting the app action.' }]);
  assert.equal(call.type, 'function_call');
  assert.equal(call.name, 'mcp_exact_tool');
  assert.equal(call.arguments, args);
  assert.match(call.call_id, /^cli_/);
  assert.deepEqual(emitted.filter(event => event.type === 'response.output_item.done').map(event => event.item), final.response.output);
  assert.deepEqual(emitted.filter(event => event.type === 'response.output_text.delta').map(event => event.delta), ['Requesting the app action.']);
  assert.match(bridge.generations[0].params.prompt, /Do not use native CLI tools/);
  assert.ok(!bridge.generations[0].params.prompt.includes('"type":"web_search"'));
});

test('adapter rejects tool names absent from body.tools, including case variants and nonfunction tools', async () => {
  const bridge = await connect(alice);
  const client = cliResponsesClient(alice, 'codex', 2000);
  for (const name of ['allowed_extra', 'Allowed', 'web_search', 'shell', 'mcp_other_users_tool']) {
    bridge.generate = () => result('', [{ name, arguments: '{}' }]);
    await assert.rejects(client.responses.create({
      ...requestBody(), tools: [{ type: 'function', name: 'allowed' }, { type: 'web_search', name: 'web_search' }],
    }), /unavailable tool/);
  }
  bridge.generate = () => result('', [{ name: 'allowed', arguments: '{}' }]);
  await assert.rejects(client.responses.create(requestBody()), /unavailable tool/);
});

test('invalid JSON, malformed envelopes, empty replies and malformed tool argument objects are rejected', async () => {
  const bridge = await connect(alice);
  const client = cliResponsesClient(alice, 'claude', 2000);
  const body = { ...requestBody(), stream: true, tools: [{ type: 'function', name: 'allowed' }] };
  for (const text of ['not JSON', '```json\n{}\n```', 'null', '[]', '{}', '{"text":1,"tool_calls":[]}', '{"text":"hi","tool_calls":[],"extra":true}']) {
    bridge.generate = () => ({ text });
    await assert.rejects(client.responses.create(body), /invalid Swarm response/);
  }
  for (const argumentsText of ['not JSON', '{', 'null', '[]', '"text"', 'false', '3']) {
    bridge.generate = () => result('', [{ name: 'allowed', arguments: argumentsText }]);
    await assert.rejects(client.responses.create(body), /invalid arguments|must be a JSON object/);
  }
  for (const text of ['', '   ']) {
    bridge.generate = () => ({ text });
    await assert.rejects(client.responses.create(body), /empty response/);
  }
  bridge.generate = () => result('');
  await assert.rejects(client.responses.create(body), /neither a reply nor an action/);
});

test('request preparation strips model tags, attaches uploaded images and rejects remote image URLs', () => {
  const body = { ...requestBody(), input: [{ role: 'user', _m: 'direct:private-tag', content: [
    { type: 'input_text', text: 'Look at this' }, { type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' },
  ] }] };
  const prepared = prepareCliRequest(body);
  assert.deepEqual(prepared.images, [{ mediaType: 'image/png', data: 'aGVsbG8=' }]);
  assert.ok(!prepared.prompt.includes('private-tag'));
  assert.ok(!prepared.prompt.includes('aGVsbG8='));
  assert.match(prepared.prompt, /Attached image 1/);
  assert.throws(() => prepareCliRequest({ input: [{ type: 'input_image', image_url: 'https://remote.example/private.png' }] }), /Remote image URLs are not supported/);
});

test('cancelled AbortSignal sends a cancel RPC for exactly the pending generation and permits later requests', async () => {
  const bridge = await connect(alice);
  bridge.generate = () => HOLD;
  const controller = new AbortController();
  const pending = cliResponsesClient(alice, 'codex', 2000).responses.create(requestBody(), { signal: controller.signal });
  const rejected = assert.rejects(pending, /cancelled/);
  await until(() => bridge.generations.length === 1, 'pending generation reaches the bridge');
  const generation = bridge.generations[0];
  controller.abort();
  await rejected;
  await until(() => bridge.requests.some(request => request.method === 'cancel' && request.id === generation.id), 'abort sends cancellation to the bridge');
  bridge.respond(generation.id, result('late response must be ignored'));
  bridge.generate = () => result('next response');
  assert.equal((await cliResponsesClient(alice, 'codex', 2000).responses.create(requestBody())).output_text, 'next response');
  const count = bridge.generations.length;
  await assert.rejects(cliRequest(alice, 'generate', {}, 1000, controller.signal), /cancelled/);
  assert.equal(bridge.generations.length, count, 'already-cancelled requests never start inference');
});

test('offline selection and revoked pairings reject without API fallback, including an in-flight request', async () => {
  selectCli(alice, 'codex');
  await assert.rejects(withUsage({ userId: alice }, () => llmClient(2000).responses.create(requestBody())), { message: CLI_OFFLINE });
  assert.equal(withUsage({ userId: alice }, defaultModel), 'codex/default');
  const a = await connect(alice), b = await connect(bob);
  await choose(bob, 'claude');
  a.generate = () => HOLD;
  const cachedClient = withUsage({ userId: alice }, () => llmClient(2000));
  const pending = cachedClient.responses.create(requestBody());
  const rejected = assert.rejects(pending, { message: CLI_OFFLINE });
  await until(() => a.generations.length === 1, 'in-flight request reaches Alice bridge');
  const revoked = await req(alice, '/pair', 'DELETE', { userId: bob });
  assert.equal(revoked.status, 200);
  assert.equal((await revoked.json()).selected, 'codex');
  await rejected;
  assert.equal((await a.closed).code, 4401);
  await assert.rejects(cachedClient.responses.create(requestBody()), { message: CLI_OFFLINE });
  assert.equal(cliStatus(alice).connected, false);
  assert.equal(cliStatus(bob).connected, true);
  assert.equal((await withUsage({ userId: bob }, () => llmClient(2000).responses.create(requestBody())) as any).output_text, bob);
  assert.equal(b.generations.length, 1);
});

test('bridge authentication failures propagate to the caller without API fallback', async () => {
  const bridge = await connect(alice);
  await choose(alice, 'codex');
  bridge.generate = () => { throw new Error('Subscription login was revoked. Sign in again.'); };
  await assert.rejects(withUsage({ userId: alice }, () => llmClient(2000).responses.create(requestBody())), /Subscription login was revoked/);
  assert.equal(selectedCli(alice), 'codex');
});

test('subscription usage records tokens and subscription cost without consulting API token prices', async () => {
  const bridge = await connect(alice);
  await choose(alice, 'codex');
  bridge.generate = () => ({ ...result('done'), usage: { input_tokens: 1234, output_tokens: 56, input_tokens_details: { cached_tokens: 90 }, cost: 99 } });
  const bot = newBot(alice);
  await withUsage({ userId: alice, botId: bot.id, kind: 'chat' }, async () => {
    const response = await llmClient(2000).responses.create(requestBody());
    await recordModelUsage({ model: defaultModel(), response });
  });
  const [event] = events(alice);
  assert.equal(events(alice).length, 1);
  assert.equal(events(bob).length, 0);
  assert.equal(event.bot_id, bot.id);
  assert.equal(event.provider, 'codex-cli');
  assert.equal(event.model, 'codex/default');
  assert.equal(event.kind, 'chat');
  assert.equal(event.cost_source, 'subscription');
  assert.equal(event.cost_usd, 0);
  assert.deepEqual([event.input_tokens, event.cached_tokens, event.output_tokens], [1234, 90, 56]);
  const report = usageReport(alice, 'today');
  assert.equal(report.totals.costUsd, 0);
  assert.equal(report.totals.estimatedUsd, 0);
  assert.equal(report.totals.unpricedRequests, 0);
});

test('a real queued Bot turn routes to its owner bridge and enters the existing MCP approval path', async () => {
  const a = await connect(alice), b = await connect(bob);
  await choose(alice, 'codex'); await choose(bob, 'claude');
  const bot = newBot(alice);
  const mcp = saveMcpServer(alice, { name: 'Approval fixture', transport: 'http', url: 'https://mcp-approval.example.test/must-not-run', botIds: [bot.id], requireApproval: true });
  // Model a previously discovered tool; discovery is covered by mcp.test.mts.
  db.prepare('UPDATE mcp_servers SET tools=?,checked_at=? WHERE id=?').run(JSON.stringify([
    { name: 'write_note', description: 'Write a note', inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } },
  ]), Date.now(), mcp.id);
  const name = mcpToolName(mcp, 'write_note');
  a.generate = () => result('', [{ name, arguments: '{"message":"owner-approved work"}' }]);
  withUsage({ userId: bob }, () => enqueue(bot.id, { type: 'user', text: 'Please write a note.' }));
  await runInBotQueue(bot.id, async () => {});
  assert.equal(a.generations.length, 1);
  assert.equal(b.generations.length, 0, 'an inherited foreign HTTP context must not choose its CLI');
  assert.equal(a.generations[0].params.provider, 'codex');
  assert.ok(a.generations[0].params.prompt.includes(name), 'the available app tool reaches the bridge');
  const approval = db.prepare('SELECT * FROM approvals WHERE bot_id=?').get(bot.id) as any;
  assert.ok(approval, 'the CLI action must enter the normal app approval loop');
  assert.equal(approval.tool, `${name}:bot:${bot.id}`);
  assert.equal(approval.status, 'pending');
  const call = listRows(bot.id).find(row => row.body.type === 'tool-call')?.body as any;
  assert.equal(call.name, name);
  assert.equal(call.status, 'awaiting-approval');
  assert.deepEqual(call.args, { message: 'owner-approved work' });
  assert.ok(getLive(bot.id).awaiting, 'the Bot is paused waiting for user approval');
  const card = listRows(bot.id).find(row => row.body.type === 'card' && row.body.card === 'approval')?.body as any;
  assert.equal(card.approvalId, approval.id);
  assert.equal(card.tool, `${name}:bot:${bot.id}`);
  assert.equal(card.toolkitName, 'Approval fixture');
  assert.equal(card.status, 'pending');
  assert.ok(db.prepare('SELECT 1 FROM pending_turns WHERE bot_id=?').get(bot.id));
  assert.ok(loadHistory(bot.id).some(item => item.type === 'function_call' && item.name === name));
  const [event] = events(alice);
  assert.equal(event.user_id, alice);
  assert.equal(event.bot_id, bot.id);
  assert.equal(event.provider, 'codex-cli');
  assert.equal(event.cost_source, 'subscription');
  assert.equal(events(bob).length, 0);
  const queuedRouting = await withUsage({ userId: bob }, () => runInBotQueue(bot.id, async () => ({ model: defaultModel(), provider: llmProvider() })));
  assert.deepEqual(queuedRouting, { model: 'codex/default', provider: 'codex-cli' });
});

test('nonstream structured memory output preserves the requested schema and Responses API shape', async () => {
  const bridge = await connect(alice);
  const schema = { type: 'object', properties: { memories: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } } }, required: ['memories'], additionalProperties: false };
  const text = JSON.stringify({ memories: [{ text: 'Prefers short updates.' }] });
  bridge.generate = () => ({ text, usage: { input_tokens: 44, output_tokens: 12 } });
  const response = await cliResponsesClient(alice, 'claude', 2000).responses.create({
    ...requestBody(), text: { format: { type: 'json_schema', name: 'memories', strict: true, schema } }, store: false,
  });
  assert.equal(response[Symbol.asyncIterator], undefined, 'memory gets a nonstream response');
  assert.equal(response.output_text, text);
  assert.deepEqual(response.output, [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }]);
  assert.deepEqual(bridge.generations[0].params.schema, schema);
  assert.equal(response.billing, 'subscription');
  bridge.generate = () => ({ text: '{"memories":' });
  await assert.rejects(cliResponsesClient(alice, 'claude', 2000).responses.create({ ...requestBody(), text: { format: { schema } } }), /invalid structured output/);
  await assert.rejects(cliResponsesClient(alice, 'claude', 2000).post(), /local history summaries/);
});

test('background memory consolidation uses the Bot owner subscription, schema and usage despite another ambient user', async () => {
  const a = await connect(alice), b = await connect(bob);
  await choose(alice, 'codex'); await choose(bob, 'claude');
  const bot = newBot(alice);
  appendRow(bot.id, 'message', { type: 'message', role: 'user', text: 'Remember that I prefer concise progress updates.' });
  a.generate = () => ({ text: JSON.stringify({ memories: [{ text: 'Prefers concise progress updates.' }] }), usage: { input_tokens: 80, output_tokens: 15 } });
  const consolidated = await withUsage({ userId: bob }, () => consolidateBot(bot.id));
  assert.deepEqual(consolidated.added, ['Prefers concise progress updates.']);
  assert.equal(a.generations.length, 1);
  assert.equal(b.generations.length, 0);
  assert.equal(a.generations[0].params.provider, 'codex');
  assert.deepEqual(a.generations[0].params.schema.required, ['memories']);
  assert.ok(a.generations[0].params.schema.properties.memories);
  assert.deepEqual(db.prepare('SELECT text,source FROM memories WHERE bot_id=?').all(bot.id), [{ text: 'Prefers concise progress updates.', source: 'learned' }]);
  const [event] = events(alice);
  assert.equal(event.bot_id, bot.id);
  assert.equal(event.kind, 'memory');
  assert.equal(event.provider, 'codex-cli');
  assert.equal(event.cost_source, 'subscription');
  assert.equal(event.cost_usd, 0);
  assert.equal(events(bob).length, 0);
});

test('voice session, preview and dictation return 409 in either selected CLI mode despite configured API keys', async () => {
  await connect(alice);
  for (const provider of ['codex', 'claude'] as const) {
    await choose(alice, provider);
    for (const endpoint of ['session', 'preview', 'stt']) {
      const response = await app.request(`/authenticated/voice/${endpoint}`, {
        method: 'POST', headers: { cookie: `swarm_session=${alice}`, 'content-type': 'application/json' }, body: '{}',
      });
      assert.equal(response.status, 409, `${provider}: ${endpoint}`);
      assert.deepEqual(await response.json(), { error: SUBSCRIPTION_VOICE_UNAVAILABLE });
    }
    await assert.rejects(withUsage({ userId: alice }, () => synthesize('hello')), /subscription/i);
    await assert.rejects(withUsage({ userId: alice }, () => transcribe({ data: Buffer.alloc(512), mime: 'audio/webm' })), /subscription/i);
  }
  assert.equal((await app.request('/authenticated/voice/session', { method: 'POST', body: '{}' })).status, 401);
  assert.equal(events(alice).length, 0);
});
