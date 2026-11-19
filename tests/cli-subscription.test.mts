// node --import tsx --test --test-concurrency=1 tests/cli-subscription.test.mts
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, mock, test } from 'node:test';
import { Hono } from 'hono';
import { WebSocket } from 'ws';
import { runGeneration } from '../companion/cli-bridge.mjs';

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
const { withNativeTools } = await import('../server/src/cli/native-tools.js');
const { modelsApi } = await import('../server/src/routes-models.js');
const { clearCliCatalog, cliCatalog, cliModelCatalog } = await import('../server/src/cli/catalog.js');
const { cliApi } = await import('../server/src/cli/routes.js');
const { requireUser } = await import('../server/src/lib/auth.js');
const { llmClient, defaultModel, llmProvider, modelFor, modelInfo, serverTools, providerFields } = await import('../server/src/lib/llm.js');
const { withUsage, recordModelUsage, usageReport } = await import('../server/src/usage.js');
const { createBot } = await import('../server/src/bots.js');
const { enqueue, runInBotQueue, interrupt } = await import('../server/src/agent/loop.js');
const { appendRow, listRows, loadHistory, getLive } = await import('../server/src/store.js');
const { consolidateBot } = await import('../server/src/agent/memory.js');
const { saveMcpServer, mcpToolName } = await import('../server/src/mcp/store.js');
const { voiceApi } = await import('../server/src/voice.js');
const { synthesize, transcribe, SUBSCRIPTION_VOICE_UNAVAILABLE } = await import('../server/src/lib/speech.js');

attachCliSocket(server);
const app = new Hono().route('/api/cli', cliApi).route('/api', modelsApi);
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
type Rpc = { id: string; method: 'status' | 'generate' | 'catalog' | 'cancel'; params?: any };
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
  catalog: (request: Rpc) => any = request => ({
    models: [{ id: `${request.params.provider}/account-model`, name: `Model for ${this.userId}`, efforts: ['low','high'], defaultEffort: 'low', vision: true }],
    defaultModel: `${request.params.provider}/account-model`, plan: this.userId, usage: { available: true, checkedAt: Date.now(), windows: [{label:'Weekly',usedPercent:43,resetsAt:null}] },
  });
  generate: (request: Rpc) => any = () => result(this.userId);
  welcome = false;
  toolReplies = new Map<string, { resolve: (result: any) => void; reject: (error: Error) => void }>();
  closed = new Promise<{ code: number; reason: string }>(resolve => {
    this.ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });

  constructor(readonly userId: string) {
    bridges.add(this);
    this.ws.on('error', () => {});
    this.ws.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'welcome') { this.welcome = true; return; }
      if (message.type === 'tool_result') {
        const key = `${message.id}:${message.callId}`, pending = this.toolReplies.get(key);
        this.toolReplies.delete(key);
        if (message.error) pending?.reject(new Error(message.error)); else pending?.resolve(message.result);
        return;
      }
      this.requests.push(message);
      if (message.method === 'status') this.respond(message.id, this.status);
      if (message.method === 'catalog') { const reply = this.catalog(message); if (reply !== HOLD) this.respond(message.id, reply); }
      if (message.method === 'generate') {
        try {
          const reply = this.generate(message);
          if (reply !== HOLD) void this.deliver(message, reply).catch(error => this.ws.send(JSON.stringify({ id: message.id, error: error.message })));
        } catch (error) {
          this.ws.send(JSON.stringify({ id: message.id, error: (error as Error).message }));
        }
      }
    });
  }

  respond(id: string, value: unknown) { this.ws.send(JSON.stringify({ id, result: value })); }
  toolCall(id: string, call: any): Promise<any> {
    return new Promise((resolve, reject) => {
      this.toolReplies.set(`${id}:${call.id}`, { resolve, reject });
      this.ws.send(JSON.stringify({ id, type: 'tool_call', call }));
    });
  }
  async deliver(rpc: Rpc, reply: any) {
    reply = await reply;
    // Existing model fixtures express desired actions as envelopes. Simulate the
    // native MCP exchange when the application enables it for a queued Bot.
    let parsed: any;
    try { parsed = JSON.parse(reply.text); } catch {}
    if (rpc.params?.nativeTools?.length && parsed?.tool_calls?.length) {
      for (const [index, tool] of parsed.tool_calls.entries()) {
        const value = await this.toolCall(rpc.id, { id: `fixture-${index}`, name: tool.name, arguments: JSON.parse(tool.arguments) });
        if (value.stop) { this.respond(rpc.id, { ...result(''), stopped: true }); return; }
      }
      reply = result(parsed.text || 'Tool completed.');
    }
    this.respond(rpc.id, reply);
  }
  get generations() { return this.requests.filter(request => request.method === 'generate'); }
  async hello(secret: string) {
    await once(this.ws, 'open');
    this.ws.send(JSON.stringify({ type: 'hello', version: 1, nativeMcp: true, noGenerationDeadline: true, token: secret, device: `Computer of ${this.userId}` }));
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
const requestBody = () => ({ input: [{ role: 'user', content: 'Use the app tools when needed.' }] });

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
  for (const id of users) clearCliCatalog(id);
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

test('action schemas use the current function manifest and leave custom structured output unchanged', () => {
  const tools = [{ type: 'function', name: 'SWARM_APPS_SEARCH', parameters: { type: 'object' } },
    { type: 'function', name: 'SWARM_APPS_EXECUTE', parameters: { type: 'object' } },
    { type: 'computer', name: 'not_a_function' }];
  const prepared = prepareCliRequest({ ...requestBody(), tools: [...tools, tools[0]] });
  assert.deepEqual(prepared.actionNames, ['SWARM_APPS_SEARCH', 'SWARM_APPS_EXECUTE']);
  assert.deepEqual(prepared.schema.properties.tool_calls.items.properties.name.enum, prepared.actionNames);
  assert.equal(prepared.schema.properties.tool_calls.maxItems, 32);
  assert.match(prepared.prompt, /never invoke them as native CLI tool_use/);
  assert.match(prepared.prompt, /current action list is authoritative/);
  const empty = prepareCliRequest(requestBody());
  assert.deepEqual(empty.actionNames, []);
  assert.equal(empty.schema.properties.tool_calls.maxItems, 0);
  const schema = { type: 'object', properties: { memories: { type: 'array', items: { type: 'string' } } } };
  const custom = prepareCliRequest({ ...requestBody(), tools, text: { format: { schema } } });
  assert.deepEqual(custom.schema, schema);
  assert.equal(custom.actionNames, undefined);
  const native = prepareCliRequest({ ...requestBody(), tools: tools.slice(0, 2) }, true);
  assert.deepEqual(native.nativeTools?.map(tool => tool.name), ['SWARM_APPS_SEARCH', 'SWARM_APPS_EXECUTE']);
  assert.equal(native.schema.properties.tool_calls.maxItems, 0);
  assert.equal(native.actionNames, undefined);
  assert.match(native.prompt, /registered swarm MCP tools/);
  assert.doesNotMatch(native.prompt, /never invoke them as native CLI tool_use/);
  assert.deepEqual(prepareCliRequest({ ...requestBody(), tools, text: { format: { schema } } }, true).schema, schema);
});

// Connect the real process runner to the real WebSocket/Responses/agent loop.
// Only the CLI executable and external app provider are fixtures.
function nativeClaude(t: any, bridge: FakeBridge, events: any[]) {
  const pending: Promise<void>[] = [];
  const auditFile = path.join(temp, `native-mcp-results-${bridge.userId}.jsonl`);
  fs.writeFileSync(auditFile, '');
  let index = 0;
  bridge.generate = rpc => {
    assert.equal(index++, 0, 'all native tools finish within one model generation');
    const executable = path.join(temp, `native-claude-${bridge.userId}-${index}.mjs`);
    fs.writeFileSync(executable, `#!${process.execPath}
      import fs from 'node:fs';
      if (process.argv[2] === 'auth') console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',subscriptionType:'max'}));
      else {
        for await (const chunk of process.stdin) {}
        const args=process.argv.slice(2), value=args[args.indexOf('--mcp-config')+1];
        const config=JSON.parse(value.startsWith('{')?value:fs.readFileSync(value,'utf8')).mcpServers.swarm;
        if(!config) throw new Error('No registered Swarm MCP server');
        let id=0,session;
        const request=async(method,params={},notification=false)=>{
          const response=await fetch(config.url,{method:'POST',headers:{...config.headers,'content-type':'application/json',accept:'application/json, text/event-stream',...(session?{'mcp-session-id':session}:{})},body:JSON.stringify({jsonrpc:'2.0',...(!notification?{id:++id}:{}),method,params})});
          session=response.headers.get('mcp-session-id')||session;
          if(notification&&response.status===202)return;
          const text=await response.text();
          const data=response.headers.get('content-type')?.includes('text/event-stream')?JSON.parse(text.split('\\n').find(line=>line.startsWith('data:')).slice(5)):JSON.parse(text);
          if(data.error)throw new Error(JSON.stringify(data.error));return data.result;
        };
        await request('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'native-test-cli',version:'1'}});
        await request('notifications/initialized',{},true);
        const listed=await request('tools/list');
        console.log(JSON.stringify({type:'system',subtype:'init',mcp_servers:[{name:'swarm',status:'connected'}]}));
        for(const event of ${JSON.stringify(events)}) {
          if(event.type==='assistant') {
            for(const tool of event.message.content.filter(block=>block.type==='tool_use')) {
              if(!listed.tools.some(item=>item.name===tool.name)) throw new Error('Requested tool was not registered');
              const result=await request('tools/call',{name:tool.name,arguments:tool.input});
              fs.appendFileSync(${JSON.stringify(auditFile)},JSON.stringify({name:tool.name,result})+'\\n');
            }
          } else console.log(JSON.stringify(event));
        }
      }
    `, { mode: 0o700 });
    pending.push(runGeneration(rpc.params, { claudePath: executable, env: { PATH: process.env.PATH, HOME: temp }, onToolCall: call => bridge.toolCall(rpc.id, call) })
      .then(reply => bridge.respond(rpc.id, reply), error => bridge.ws.send(JSON.stringify({ id: rpc.id, error: error.message }))));
    return HOLD;
  };
  t.after(() => Promise.all(pending));
  return () => fs.readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
const nativeAction = (name: string, input: unknown) => ({ type: 'assistant', message: { role: 'assistant', content: [
  { type: 'text', text: 'This invented execution claim must not appear.' }, { type: 'tool_use', id: 'native-action', name, input },
] } });

test('a native Claude app write pauses for approval and resumes its exact action once', async t => {
  const { setEnvOverride } = await import('../server/src/env.js');
  setEnvOverride('COMPOSIO_API_KEY', 'native-write-test');
  t.after(() => setEnvOverride('COMPOSIO_API_KEY', ''));
  const { composio } = await import('../server/src/composio.js');
  t.mock.method(globalThis, 'fetch', async input => {
    const host = new URL(String(input)).hostname;
    if (host === 'registry.npmjs.org') return Response.json({ version: '0.28.0' });
    if (host === 'telemetry.composio.dev') return Response.json({});
    throw new Error('Unexpected network call before write approval');
  });
  const client = composio();
  t.mock.method(client.connectedAccounts, 'list', async () => ({ items: [{ id: 'github-alice', toolkit: { slug: 'github' }, status: 'ACTIVE' }], nextCursor: null }));
  let executed = 0;
  const tool = { slug: 'GITHUB_CREATE_ISSUE', toolkit: { slug: 'github' }, version: '20261101_00', tags: ['createHint'], inputParameters: { type: 'object' } };
  t.mock.method(client.tools, 'getRawComposioToolBySlug', async () => tool);
  t.mock.method(client.tools, 'execute', async () => { executed++; return { data: { issue: 17 }, successful: true }; });
  const bridge = await connect(alice);
  await choose(alice, 'claude');
  const bot = newBot(alice);
  const args = { connectionId: 'github-alice', revision: 1, tool_slug: 'GITHUB_CREATE_ISSUE', arguments: { title: 'Review me' } };
  nativeClaude(t, bridge, [nativeAction('SWARM_APPS_EXECUTE', args)]);
  enqueue(bot.id, { type: 'user', text: 'Create this GitHub issue.' });
  await runInBotQueue(bot.id, async () => {});
  assert.equal(bridge.generations.length, 1);
  const call: any = listRows(bot.id).find(row => row.body.type === 'tool-call')?.body;
  assert.equal(call?.name, 'SWARM_APPS_EXECUTE');
  assert.equal(call.status, 'awaiting-approval');
  assert.deepEqual(call.args, args);
  const approval = db.prepare('SELECT * FROM approvals WHERE bot_id=?').get(bot.id) as any;
  assert.equal(approval?.status, 'pending');
  assert.equal(executed, 0);
  assert.doesNotMatch(JSON.stringify(listRows(bot.id)), /invented execution claim/);
  db.prepare("UPDATE approvals SET status='allowed' WHERE id=?").run(approval.id);
  bridge.generate = () => result('Created the requested issue.');
  enqueue(bot.id, { type: 'resume' });
  await runInBotQueue(bot.id, async () => {});
  assert.equal(executed, 1);
  assert.equal(db.prepare('SELECT 1 FROM pending_turns WHERE bot_id=?').get(bot.id), undefined);
  assert.equal(listRows(bot.id).filter(row => row.body.type === 'tool-call').length, 1, 'resuming does not request or dispatch a second write');
  assert.equal((listRows(bot.id).find(row => row.body.type === 'tool-call')?.body as any).status, 'done');
  assert.match(bridge.generations[1].params.prompt, /issue.*17/);
});

test('a setup agent discovers and verifies GitHub through MCP in one Claude session without activation', async t => {
  const { setEnvOverride } = await import('../server/src/env.js');
  const { beginSetupInterview, isConfiguring } = await import('../server/src/bot-setup.js');
  setEnvOverride('COMPOSIO_API_KEY', 'native-setup-test');
  t.after(() => setEnvOverride('COMPOSIO_API_KEY', ''));
  t.mock.method(globalThis, 'fetch', async input => {
    const host = new URL(String(input)).hostname;
    if (host === 'registry.npmjs.org') return Response.json({ version: '0.28.0' });
    if (host === 'telemetry.composio.dev') return Response.json({});
    throw new Error('Unexpected network call during setup verification');
  });
  const { composio } = await import('../server/src/composio.js');
  const client = composio(), dispatches: any[] = [];
  const tool = { slug: 'GITHUB_GET_AUTHENTICATED_USER', name: 'Read GitHub account', description: 'Verify the connected GitHub user',
    toolkit: { slug: 'github' }, version: '20261101_00', tags: ['readOnlyHint'], inputParameters: { type: 'object', properties: {}, additionalProperties: false } };
  t.mock.method(client.connectedAccounts, 'list', async () => ({ items: [{ id: 'github-alice', toolkit: { slug: 'github' }, status: 'ACTIVE' }], nextCursor: null }));
  t.mock.method(client.tools, 'getRawComposioTools', async () => [tool]);
  t.mock.method(client.tools, 'getRawComposioToolBySlug', async () => tool);
  t.mock.method(client.tools, 'execute', async (...args) => { dispatches.push(args); return { data: { login: 'verified-account' }, successful: true }; });
  const bridge = await connect(alice);
  await choose(alice, 'claude');
  const bot = newBot(alice);
  beginSetupInterview(bot.id);
  db.prepare("UPDATE bot_setups SET onboarding_status='review' WHERE bot_id=?").run(bot.id);
  const results = nativeClaude(t, bridge, [
    nativeAction('SWARM_APPS_SEARCH', { toolkit: 'github', query: 'verify connected user' }),
    nativeAction('SWARM_APPS_EXECUTE', { connectionId: 'github-alice', revision: 1, tool_slug: tool.slug, arguments: {} }),
    { type: 'result', subtype: 'success', structured_output: { text: 'Verified GitHub account: verified-account.', tool_calls: [] } },
  ]);
  enqueue(bot.id, { type: 'user', text: 'We connected GitHub. Verify that it works.' });
  await runInBotQueue(bot.id, async () => {});
  assert.equal(isConfiguring(bot.id), true);
  assert.equal(bridge.generations.length, 1);
  assert.deepEqual(results().map(call => call.name), ['SWARM_APPS_SEARCH', 'SWARM_APPS_EXECUTE']);
  assert.match(JSON.stringify(results()[0]), /readOnly.*true/);
  assert.match(JSON.stringify(results()[1]), /verified-account/);
  assert.deepEqual(dispatches, [[tool.slug, { userId: alice, connectedAccountId: 'github-alice', version: tool.version, arguments: {} }]]);
  const rows = listRows(bot.id);
  const calls: any[] = rows.filter(row => row.body.type === 'tool-call').map(row => row.body);
  assert.deepEqual(calls.map(call => [call.name, call.status]), [['SWARM_APPS_SEARCH', 'done'], ['SWARM_APPS_EXECUTE', 'done']]);
  assert.ok(calls.every(call => call.startedAt && call.completedAt));
  assert.ok(rows.some(row => row.body.type === 'message' && row.body.role === 'assistant' && row.body.text.includes('Verified GitHub')));
  assert.doesNotMatch(JSON.stringify(rows), /invented execution claim|No such tool available|Something went wrong/);
  assert.equal(db.prepare('SELECT 1 FROM approvals WHERE bot_id=?').get(bot.id), undefined);
});

test('subscription agent deadline override survives long waits without changing API or housekeeping deadlines', { timeout: 15000 }, async t => {
  const api = withUsage({ userId: alice }, () => llmClient(1234, { subscriptionTimeoutMs: 0 }));
  assert.equal((api as any).timeout, 1234, 'API requests retain their configured deadline');
  const bridge = await connect(alice);
  selectCli(alice, 'claude');
  await withUsage({ userId: alice }, () => llmClient(1234).responses.create({ model: 'claude/default', ...requestBody() }));
  assert.equal(bridge.generations[0].params.timeoutMs, 1234, 'background/housekeeping callers keep finite deadlines');
  bridge.generate = () => HOLD;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  let settled = false;
  const pending = withUsage({ userId: alice }, () => llmClient(360_000, { subscriptionTimeoutMs: 0 }).responses.create({ model: 'claude/default', ...requestBody() }, { signal: controller.signal }));
  void pending.then(() => { settled = true; }, () => { settled = true; });
  try {
    while (bridge.generations.length < 2) await new Promise(resolve => setImmediate(resolve));
    assert.equal(bridge.generations[1].params.timeoutMs, 0);
    t.mock.timers.tick(40 * 60_000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'the adapter must not convert zero to a one-second transport deadline');
    bridge.respond(bridge.generations[1].id, result('finished after a long task'));
    assert.equal((await pending).output_text, 'finished after a long task');
  } finally { controller.abort(); t.mock.timers.reset(); await pending.catch(() => {}); }
});

for (const provider of ['claude', 'codex'] as const) test(`${provider}: a long agent job checkpoints twice and completes without replaying tool actions`, { timeout: 60000 }, async t => {
  const { toolMap } = await import('../server/src/agent/tools.js');
  const bridge = await connect(alice); await choose(alice, provider);
  const bot = newBot(alice);
  let executed = 0;
  t.mock.method(toolMap.get('list_app_connections')!, 'impl', async () => ({ output: `checkpoint-result-${++executed}` }));
  const generationStarts: number[] = [];
  bridge.generate = async rpc => {
    generationStarts.push(executed);
    if (executed) assert.ok(rpc.params.prompt.includes(`checkpoint-result-${executed}`), 'continuation receives the last completed tool result');
    while (executed < 125) {
      const value = await bridge.toolCall(rpc.id, { id: `action-${executed + 1}`, name: 'list_app_connections', arguments: {} });
      if (value.stop) return { ...result(''), stopped: true };
    }
    return result('All 125 actions completed.');
  };
  const jobId = enqueue(bot.id, { type: 'user', text: 'Complete a long task with 125 actions.' });
  await runInBotQueue(bot.id, async () => {});
  assert.equal(executed, 125);
  assert.deepEqual(generationStarts, [0, 60, 120]);
  assert.equal((db.prepare('SELECT state FROM agent_jobs WHERE id=?').get(jobId) as any).state, 'completed');
  const calls = loadHistory(bot.id).filter(item => item.type === 'function_call');
  const outputs = loadHistory(bot.id).filter(item => item.type === 'function_call_output');
  assert.equal(calls.length, 125); assert.equal(outputs.length, 125);
  assert.equal(new Set(calls.map(item => item.call_id)).size, 125);
  assert.ok(listRows(bot.id).some(row => row.body.type === 'message' && row.body.role === 'assistant' && row.body.text === 'All 125 actions completed.'));
  assert.ok(!listRows(bot.id).some(row => row.body.type === 'notice' && row.body.tone === 'error'));
});

test('Stop still cancels a continuation after a tool checkpoint', { timeout: 45000 }, async t => {
  const { toolMap } = await import('../server/src/agent/tools.js');
  const bridge = await connect(alice); await choose(alice, 'claude');
  const bot = newBot(alice); let executed = 0, continued = false;
  t.mock.method(toolMap.get('list_app_connections')!, 'impl', async () => ({ output: `completed-${++executed}` }));
  bridge.generate = rpc => {
    if (executed === 60) { continued = true; return HOLD; }
    return (async () => {
      for (let i = 0; i < 60; i++) {
        const value = await bridge.toolCall(rpc.id, { id: `action-${i}`, name: 'list_app_connections', arguments: {} });
        if (value.stop) return { ...result(''), stopped: true };
      }
      return result('Unexpectedly finished before continuing.');
    })();
  };
  enqueue(bot.id, { type: 'user', text: 'Continue working until stopped.' });
  const expires = Date.now() + 30000;
  while (!continued && Date.now() < expires) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(continued, true);
  interrupt(bot.id);
  await runInBotQueue(bot.id, async () => {});
  assert.equal(executed, 60);
  await until(() => bridge.requests.some(request => request.method === 'cancel' && request.id === bridge.generations[1].id), 'Stop reaches the continued generation');
  assert.ok(listRows(bot.id).some(row => row.body.type === 'notice' && row.body.text === 'Stopped.'));
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

test('adapter preserves reported usage completeness and leaves missing counters unknown', async () => {
  const bridge = await connect(alice);
  const client = cliResponsesClient(alice, 'codex', 2000);
  for (const stream of [false, true]) for (const fixture of [
    { usage: { input_tokens: 0, output_tokens: 0 }, status: undefined, expected: 'complete' },
    { usage: { input_tokens: 12, output_tokens: 3 }, status: 'complete', expected: 'complete' },
    { usage: { input_tokens: 12, output_tokens: 3 }, status: 'partial', expected: 'partial' },
    { usage: { input_tokens: 12 }, status: 'partial', expected: 'partial' },
    { usage: { output_tokens: 3 }, status: undefined, expected: 'partial' },
    { usage: undefined, status: 'unavailable', expected: 'unavailable' },
    { usage: undefined, status: undefined, expected: 'unavailable' },
    { usage: null, status: 'complete', expected: 'unavailable' },
    { usage: [], status: 'complete', expected: 'unavailable' },
    { usage: 'invalid', status: 'complete', expected: 'unavailable' },
    { usage: {}, status: 'partial', expected: 'unavailable' },
    { usage: { input_tokens: -1, output_tokens: 0.5 }, status: 'complete', expected: 'unavailable' },
    { usage: { input_tokens: 12, output_tokens: 3 }, status: 'not-a-status', expected: 'complete' },
    { usage: { input_tokens: 0, output_tokens: 0 }, status: 'unavailable', expected: 'unavailable' },
  ]) {
    bridge.generate = () => ({ text: result('done').text, usage: fixture.usage, usage_status: fixture.status });
    let response = await client.responses.create({ ...requestBody(), stream });
    if (stream) {
      const events: any[] = [];
      for await (const event of response) events.push(event);
      assert.equal(events.at(-1).type, 'response.completed');
      response = events.at(-1).response;
    }
    assert.equal(response.usage_status, fixture.expected);
    if (fixture.expected === 'unavailable') assert.equal(Object.hasOwn(response, 'usage'), false);
    else assert.deepEqual(response.usage, fixture.usage, 'do not invent cached or missing token counters');
    assert.equal(response.billing, 'subscription');
  }
  bridge.generate = () => ({ text: result('done').text, usage_status: 'complete',
    usage: { input_tokens: -1, output_tokens: 2, input_tokens_details: { cached_tokens: '5' } } });
  const malformed = await client.responses.create(requestBody());
  assert.equal(malformed.usage_status, 'partial');
  assert.deepEqual(malformed.usage, { output_tokens: 2 });
});

for (const stream of [false, true]) for (const observed of [false, true]) test(`native approval stop preserves ${observed ? 'partial' : 'unavailable'} usage in ${stream ? 'streaming' : 'direct'} responses`, async () => {
  const bridge = await connect(alice);
  const usage = observed ? { input_tokens: 91, output_tokens: 7, input_tokens_details: { cached_tokens: 13 } } : undefined;
  bridge.generate = rpc => {
    void bridge.toolCall(rpc.id, { id: 'generation:string:approval', name: 'write_note', arguments: {} }).then(reply => {
      assert.equal(reply.stop, true);
      // A runner's claimed completeness cannot turn an intentional stop into
      // a measured completed generation.
      // The application's stop remains authoritative even if a runner omits its flag.
      bridge.respond(rpc.id, { text: result('').text, ...(stream ? { stopped: true } : {}), usage_status: observed ? 'complete' : 'unavailable', usage });
    });
    return HOLD;
  };
  let executed = 0;
  let response = await withNativeTools(alice, async () => { executed++; return { output: 'Waiting for approval', stop: true }; }, () =>
    cliResponsesClient(alice, 'claude', 2000).responses.create({ ...requestBody(), stream,
      tools: [{ type: 'function', name: 'write_note', parameters: { type: 'object' } }] }));
  if (stream) {
    const emitted: any[] = [];
    for await (const event of response) emitted.push(event);
    response = emitted.at(-1).response;
    assert.equal(emitted.at(-1).type, 'response.completed');
  }
  assert.equal(response.usage_status, observed ? 'partial' : 'unavailable');
  assert.deepEqual(response.usage, usage);
  assert.equal(Object.hasOwn(response, 'usage'), observed);
  assert.equal(response.billing, 'subscription');
  assert.deepEqual(response.output, []);
  assert.equal(executed, 1);
  assert.equal(bridge.generations.length, 1, 'accounting must not retry a stopped generation');
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
  const { toolSchemaHash } = await import('../server/src/agent/tool-catalog.js');
  const { mcpSchemas } = await import('../server/src/mcp/client.js');
  const schema = mcpSchemas(alice, bot.id).find(tool => tool.name === name)!;
  a.generate = () => result('', [{ name: 'tool_call', arguments: JSON.stringify({ tool_name: name, arguments: { message: 'owner-approved work' }, schema_hash: toolSchemaHash(schema) }) }]);
  withUsage({ userId: bob }, () => enqueue(bot.id, { type: 'user', text: 'Please write a note.' }));
  await runInBotQueue(bot.id, async () => {});
  assert.equal(a.generations.length, 1);
  assert.equal(b.generations.length, 0, 'an inherited foreign HTTP context must not choose its CLI');
  assert.equal(a.generations[0].params.provider, 'codex');
  assert.equal(a.generations[0].params.timeoutMs, 0, 'agent turns have no total CLI generation deadline');
  assert.ok(a.generations[0].params.nativeTools.some((tool: any) => tool.name === 'tool_call'), 'deferred execution reaches the bridge as a native tool');
  assert.ok(!a.generations[0].params.nativeTools.some((tool: any) => tool.name === name), 'additional schemas are loaded on demand');
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
  assert.ok(loadHistory(bot.id).some(item => item.type === 'function_call' && item.name === 'tool_call'));
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

for (const provider of ['codex', 'claude'] as const) {
  test(`${provider}: HTTP picker uses the account catalog and plan usage, never configured API models`, async () => {
    const bridge = await connect(alice); await choose(alice, provider);
    const response = await app.request('/api/models', {headers:{cookie:`swarm_session=${alice}`}});
    assert.equal(response.status,200);
    const data = await response.json();
    assert.equal(data.provider,`${provider}-cli`); assert.equal(data.billing,'plan'); assert.equal(data.canFast,false);
    assert.deepEqual(data.models.map((m:any)=>m.id),[`${provider}/account-model`]);
    assert.equal(data.models[0].billing,'plan'); assert.equal(data.models[0].price,null);
    assert.equal(data.plan,alice);assert.equal(data.usage.windows[0].usedPercent,43);
    assert.equal(bridge.requests.filter(r=>r.method==='catalog').length,1);
  });
  test(`${provider}: explicit model/effort/images/tools reach the bridge and preserve Responses usage`,async()=>{
    const bridge=await connect(alice);await choose(alice,provider);
    bridge.generate=()=>({...result('selected'),model:'account-model'});
    await withUsage({userId:alice},async()=>{
      assert.equal(modelFor(`${provider}/account-model`),`${provider}/account-model`);
      const response:any=await llmClient(3000).responses.create({model:`${provider}/account-model`,reasoning:{effort:'high'},input:[{role:'user',content:[{type:'input_image',image_url:'data:image/png;base64,aGVsbG8='}]}],tools:[{type:'function',name:'remember',parameters:{type:'object'}}]});
      assert.equal(response.model,`${provider}/account-model`);
      await recordModelUsage({model:`${provider}/default`,response});
    });
    const params=bridge.generations[0].params;
    assert.equal(params.model,'account-model');assert.equal(params.effort,'high');assert.equal(params.images.length,1);assert.match(params.prompt,/remember/);
    assert.equal(events(alice)[0].model,`${provider}/account-model`);
  });
  test(`${provider}: explicit default alias resolves metadata, high effort, generation and usage to the account default`, async () => {
    const bridge = await connect(alice);
    await choose(alice, provider);
    bridge.generate = () => ({ ...result('Resolved account default.'), model: 'account-model' });
    const bot = newBot(alice);
    const alias = `${provider}/default`, resolved = `${provider}/account-model`;
    await withUsage({ userId: alice, botId: bot.id, kind: 'chat' }, async () => {
      assert.equal(defaultModel(), alias);
      assert.equal(modelFor(alias), alias);
      const info = await modelInfo(alias, true);
      assert.ok(info, 'saved explicit default aliases must have the account default metadata');
      assert.equal(info.id, resolved);
      assert.deepEqual(info.efforts, ['low', 'high']);
      const fields = providerFields({ effort: 'high', reasoning: info.reasoning, efforts: info.efforts, cacheKey: bot.id, safetyId: alice });
      assert.deepEqual(fields, { reasoning: { effort: 'high' } });
      const response: any = await llmClient(3000).responses.create({ ...requestBody(), model: alias, ...fields });
      assert.equal(response.model, info.id, 'generation identity must agree with the resolved metadata');
      assert.equal(response.provider, `${provider}-cli`);
      assert.equal(response.billing, 'subscription');
      assert.equal(response.output_text, 'Resolved account default.');
      await recordModelUsage({ model: alias, response });
    });
    assert.equal(bridge.generations.length, 1);
    const params = bridge.generations[0].params;
    assert.equal(params.provider, provider);
    assert.equal(params.model, 'account-model', 'default is resolved before dispatching the native CLI request');
    assert.equal(params.effort, 'high');
    assert.equal(bridge.requests.filter(request => request.method === 'catalog').length, 1);
    const [event] = events(alice);
    assert.equal(events(alice).length, 1);
    assert.equal(event.bot_id, bot.id);
    assert.equal(event.model, resolved, 'usage must record the resolved response identity, not the saved alias');
    assert.equal(event.provider, `${provider}-cli`);
    assert.equal(event.cost_source, 'subscription');
    assert.equal(event.cost_usd, 0);
    assert.deepEqual([event.input_tokens, event.cached_tokens, event.output_tokens], [100, 30, 20]);
    assert.equal(events(bob).length, 0);
  });
  test(`${provider}: a queued Bot with a saved default alias keeps high effort and owner attribution`, async () => {
    const ownerBridge = await connect(alice), otherBridge = await connect(bob);
    await choose(alice, provider);
    await choose(bob, provider === 'codex' ? 'claude' : 'codex');
    const bot = newBot(alice);
    const alias = `${provider}/default`, resolved = `${provider}/account-model`;
    db.prepare('UPDATE bots SET model=?,effort=? WHERE id=?').run(alias, 'high', bot.id);
    ownerBridge.generate = () => ({ ...result('Saved default turn completed.'), model: 'account-model' });
    withUsage({ userId: bob }, () => enqueue(bot.id, { type: 'user', text: 'Reply using my saved default and high effort.' }));
    await runInBotQueue(bot.id, async () => {});
    assert.equal(ownerBridge.generations.length, 1, 'the saved alias must reach generation through the real turn loop');
    assert.equal(otherBridge.generations.length, 0, 'ambient foreign attribution cannot choose another account or provider');
    const params = ownerBridge.generations[0].params;
    assert.equal(params.provider, provider);
    assert.equal(params.model, 'account-model');
    assert.equal(params.effort, 'high');
    assert.match(params.prompt, /Reply using my saved default and high effort/);
    assert.ok(listRows(bot.id).some(row => row.body.type === 'message' && row.body.role === 'assistant' && row.body.text === 'Saved default turn completed.' && !row.body.streaming));
    assert.equal(getLive(bot.id).isRunning, false);
    assert.deepEqual(db.prepare('SELECT model,effort FROM bots WHERE id=?').get(bot.id), { model: alias, effort: 'high' }, 'runtime resolution must preserve the saved default preference');
    const [event] = events(alice);
    assert.equal(events(alice).length, 1);
    assert.equal(event.user_id, alice);
    assert.equal(event.bot_id, bot.id);
    assert.equal(event.kind, 'chat');
    assert.equal(event.provider, `${provider}-cli`);
    assert.equal(event.model, resolved);
    assert.equal(event.cost_source, 'subscription');
    assert.equal(event.cost_usd, 0);
    assert.equal(events(bob).length, 0);
  });
  test(`${provider}: foreign/unlisted model and unsupported effort never generate or fall back`,async()=>{
    const bridge=await connect(alice);await choose(alice,provider);
    for(const [model,effort] of [['api/paid-model','high'],[`${provider}/removed`,'high'],[`${provider}/account-model`,'max']]){
      await assert.rejects(cliResponsesClient(alice,provider,3000).responses.create({...requestBody(),model,reasoning:{effort}}),/not part|no longer offered|not supported/);
    }
    assert.equal(bridge.generations.length,0);
  });
  test(`${provider}: retained screenshot history rejects a text-only model before dispatch`,async()=>{
    const bridge=await connect(alice);await choose(alice,provider);
    const catalog=bridge.catalog;bridge.catalog=request=>{const value=catalog(request);value.models[0].vision=false;return value;};
    await assert.rejects(cliResponsesClient(alice,provider,3000).responses.create({model:`${provider}/account-model`,input:[{role:'user',content:[{type:'input_image',image_url:'data:image/png;base64,aGVsbG8='}]},{role:'user',content:'Hi'}]}),/cannot read images/);
    assert.equal(bridge.generations.length,0);
  });
}

test('credential changes fence a delayed catalog response so stale account data is not cached',async()=>{
 const bridge=await connect(alice);await choose(alice,'codex');
 const original=bridge.catalog;bridge.catalog=()=>HOLD;
 const pending=cliCatalog(alice,'codex',true);
 await until(()=>bridge.requests.some(r=>r.method==='catalog'),'catalog is in flight');
 const request=bridge.requests.find(r=>r.method==='catalog')!;
 clearCliCatalog(alice);
 bridge.respond(request.id,original(request));
 await assert.rejects(pending,/connection changed/);
});

test('cancelling explicit model discovery cancels that RPC before generation',async()=>{
 const bridge=await connect(alice);await choose(alice,'codex');bridge.catalog=()=>HOLD;
 const controller=new AbortController();
 const pending=cliResponsesClient(alice,'codex',3000).responses.create({...requestBody(),model:'codex/account-model'},{signal:controller.signal});
 await until(()=>bridge.requests.some(r=>r.method==='catalog'),'catalog is in flight');
 const request=bridge.requests.find(r=>r.method==='catalog')!;controller.abort();
 await assert.rejects(pending,/cancelled/);
 await until(()=>bridge.requests.some(r=>r.method==='cancel'&&r.id===request.id),'matching catalog cancellation');
 assert.equal(bridge.generations.length,0);
});

test('concurrent model discovery shares one RPC while cancellation remains caller-specific', async () => {
  const bridge = await connect(alice); await choose(alice, 'claude');
  const original = bridge.catalog; bridge.catalog = () => HOLD;
  const controller = new AbortController();
  const first = cliModelCatalog(alice, 'claude', controller.signal);
  const second = cliModelCatalog(alice, 'claude');
  await until(() => bridge.requests.some(r => r.method === 'catalog'), 'catalog starts');
  const requests = bridge.requests.filter(r => r.method === 'catalog');
  assert.equal(requests.length, 1);
  const rejection = assert.rejects(first, /cancelled/);
  controller.abort(); await rejection;
  assert.equal(bridge.requests.some(r => r.method === 'cancel' && r.id === requests[0].id), false);
  bridge.respond(requests[0].id, original(requests[0]));
  assert.equal((await second).models[0].id, 'claude/account-model');
  assert.equal(bridge.generations.length, 0);
});

test('generation reuses capabilities for five minutes while forced usage refresh and invalidation stay fresh', async () => {
  const bridge = await connect(alice); await choose(alice, 'claude');
  await cliModelCatalog(alice, 'claude');
  const calls = () => bridge.requests.filter(r => r.method === 'catalog').length;
  assert.equal(calls(), 1);
  let time = Date.now();
  const clock = mock.method(Date, 'now', () => time);
  try {
    time += 31_000;
    await cliModelCatalog(alice, 'claude');
    assert.equal(calls(), 1, 'a slow model round must not force another catalog process');
    await cliCatalog(alice, 'claude', true);
    assert.equal(calls(), 2, 'explicit picker/usage refresh still contacts the provider');
    time += 300_001;
    await cliModelCatalog(alice, 'claude');
    assert.equal(calls(), 3, 'capabilities still expire');
    clearCliCatalog(alice);
    await cliModelCatalog(alice, 'claude');
    assert.equal(calls(), 4, 'credential invalidation overrides cache age');
  } finally { clock.mock.restore(); }
});

test('replacing a CLI bridge drops capabilities from the previous connection', async () => {
  const first = await connect(alice); await choose(alice, 'claude');
  assert.equal((await cliModelCatalog(alice, 'claude')).models[0].id, 'claude/account-model');
  const second = await connect(alice);
  const catalog = second.catalog;
  second.catalog = request => {
    const result = catalog(request);
    result.models[0].id = 'claude/reconnected-model';
    result.defaultModel = 'claude/reconnected-model';
    return result;
  };
  assert.equal((await cliModelCatalog(alice, 'claude')).models[0].id, 'claude/reconnected-model');
  assert.equal((await first.closed).code, 4401);
});
