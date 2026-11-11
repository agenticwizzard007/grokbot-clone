// Ordinary chat through a real local CLI websocket and mocked private app SDK.
// node --import tsx --test --test-concurrency=1 tests/cli-apps.test.mts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, mock, test } from 'node:test';
import { Hono } from 'hono';
import { WebSocket } from 'ws';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-cli-apps-'));
const apiRequests: string[] = [];
const server = createServer((req, res) => {
  apiRequests.push(`${req.method} ${req.url}`);
  res.writeHead(503, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Unexpected API inference request' } }));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
Object.assign(process.env, {
  DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'), SESSION_SECRET: 'cli-apps-test-only',
  SWARM_ROLE: 'standalone', NODE_ENV: 'test', SERVER_URL: base, APP_URL: base, COMPUTER_PROVIDER: 'local',
  COMPOSIO_API_KEY: '', ADMIN_EMAILS: '', ADMIN_PHONES: '', INKBOX_TUNNEL: '0',
  DIRECT_API_KEY: 'unused-direct-key', DIRECT_BASE_URL: `${base}/direct`, DIRECT_MODEL: 'api-only-model',
  OPENROUTER_API_KEY: 'unused-openrouter-key', OPENROUTER_BASE_URL: `${base}/openrouter`, LLM_PROVIDER: 'direct',
});
mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === 'registry.npmjs.org') return Response.json({ version: '0.28.0' });
  if (url.hostname === 'telemetry.composio.dev') return Response.json({});
  if (url.hostname === 'backend.composio.dev' && url.pathname === '/api/v3.1/toolkits') {
    return Response.json({ items: [{ slug: 'github', name: 'GitHub', meta: { categories: [{ name: 'Developer tools' }] }, composio_managed_auth_schemes: ['OAUTH2'] }], next_cursor: null });
  }
  apiRequests.push(url.href);
  return Response.json({ error: 'Unexpected real provider or pricing request' }, { status: 503 });
});

const { db } = await import('../server/src/db.js');
const { initSubagents } = await import('../server/src/agent/subagents.js');
const { initRooms } = await import('../server/src/agent/rooms.js');
initSubagents(); initRooms();
const { api } = await import('../server/src/routes.js');
const { cliApi } = await import('../server/src/cli/routes.js');
const { attachCliSocket, disconnectCli, refreshCli } = await import('../server/src/cli/bridge.js');
const { selectedCli } = await import('../server/src/cli/store.js');
const { clearCliCatalog } = await import('../server/src/cli/catalog.js');
const { sessionHash } = await import('../server/src/lib/auth.js');
const { createBot } = await import('../server/src/bots.js');
const { interrupt, runInBotQueue, settleAgentJobs } = await import('../server/src/agent/loop.js');
const { getLive, listRows, loadHistory } = await import('../server/src/store.js');
const { composio } = await import('../server/src/composio.js');
const { setEnvOverride } = await import('../server/src/env.js');
attachCliSocket(server);
const app = new Hono().route('/api/cli', cliApi).route('/api', api);

type Provider = 'codex' | 'claude';
type Rpc = { id: string; method: 'status' | 'catalog' | 'generate' | 'cancel'; params?: any };
type AppCall = { name: string; args: Record<string, unknown> };
const parameters = { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'], additionalProperties: false };
const appArguments = { owner: 'octo-owner', repo: 'private-project' };
const providerData = { repositories: ['octo-owner/private-project'], receipt: 'mock-provider-receipt' };
const appTool = (slug: string, tags?: string[]) => ({ slug, name: 'Inspect repositories', description: 'Inspect the requested repository.',
  toolkit: { slug: 'github', name: 'GitHub' }, version: '20261101_00', tags, inputParameters: parameters,
  readOnlyHint: true, internalKey: 'metadata-private-secret' });
let sequence = 0, owner: string, foreign: string, cookie: string, foreignCookie: string, bot: any;
let tool = appTool('GITHUB_PEEK', ['readOnlyHint']);
let accountQueries: any[] = [], executions: any[] = [], metadataQueries: string[] = [], oauthStarts = 0;
const bridges = new Set<ScriptedBridge>();
const accountId = () => `github-${owner}`;
const jobs = () => db.prepare('SELECT * FROM agent_jobs WHERE bot_id=? ORDER BY created_at,rowid').all(bot.id) as any[];
const approvals = () => db.prepare('SELECT * FROM approvals WHERE bot_id=? ORDER BY created_at,rowid').all(bot.id) as any[];

function request(pathname: string, method = 'GET', body?: unknown, session = cookie) {
  return app.request(`/api${pathname}`, { method, headers: { cookie: session, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function until(check: () => boolean, description: string) {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(check(), description);
}
function conversation(rpc: Rpc): any[] {
  const marker = '\n\nConversation:\n';
  const index = rpc.params.prompt.indexOf(marker);
  assert.ok(index >= 0);
  return JSON.parse(rpc.params.prompt.slice(index + marker.length));
}
function availableTools(rpc: Rpc): any[] {
  if (rpc.params.nativeTools?.length) return rpc.params.nativeTools;
  const marker = '\n\nAvailable Swarm tools:\n';
  const index = rpc.params.prompt.indexOf(marker);
  assert.ok(index >= 0);
  return JSON.parse(rpc.params.prompt.slice(index + marker.length).split('\n\nConversation:\n')[0]);
}
// Native MCP results from the current generation; earlier generations' results come from the conversation.
let nativeOutputs = new Map<string, any>();
function toolOutput(rpc: Rpc, name: string) {
  if (nativeOutputs.has(name)) return nativeOutputs.get(name);
  const items = conversation(rpc);
  const call = items.filter(item => item.type === 'function_call' && item.name === name).at(-1);
  const output = call && items.find(item => item.type === 'function_call_output' && item.call_id === call.call_id);
  return output ? JSON.parse(output.output) : undefined;
}
const envelope = (text: string, calls: AppCall[] = []) => ({ text: JSON.stringify({ text,
  tool_calls: calls.map(call => ({ name: call.name, arguments: JSON.stringify(call.args) })) }),
  usage: { input_tokens: 51, output_tokens: 13 } });

class ScriptedBridge {
  ws = new WebSocket(base.replace('http:', 'ws:') + '/api/cli-bridge');
  closed = new Promise<void>(resolve => this.ws.once('close', () => resolve()));
  welcome = false;
  cleanup = false;
  requests: Rpc[] = [];
  failures: Error[] = [];
  toolReplies = new Map<string, { resolve: (result: any) => void; reject: (error: Error) => void }>();
  constructor() {
    bridges.add(this);
    this.ws.on('error', () => {});
    this.ws.on('message', raw => {
      const rpc = JSON.parse(raw.toString());
      if (rpc.type === 'welcome') { this.welcome = true; return; }
      if (rpc.type === 'tool_result') {
        const key = `${rpc.id}:${rpc.callId}`, pending = this.toolReplies.get(key);
        this.toolReplies.delete(key);
        if (rpc.error) pending?.reject(new Error(rpc.error)); else pending?.resolve(rpc.result);
        return;
      }
      this.requests.push(rpc);
      try {
        if (rpc.method === 'status') this.reply(rpc, { codex: { installed: true, authenticated: true, subscription: true }, claude: { installed: true, authenticated: true, subscription: true } });
        if (rpc.method === 'catalog') this.reply(rpc, { models: [{ id: `${rpc.params.provider}/account-model`, name: 'Fixture model', efforts: ['low', 'medium', 'high'], defaultEffort: 'low', vision: true }],
          defaultModel: `${rpc.params.provider}/account-model`, plan: 'Fixture plan', usage: { available: false, checkedAt: Date.now(), windows: [] } });
        if (rpc.method === 'generate') {
          if (this.cleanup) this.reply(rpc, envelope('Cleanup complete'));
          else void this.deliver(rpc).catch(error => { this.failures.push(error as Error); this.ws.send(JSON.stringify({ id: rpc.id, error: (error as Error).message })); });
        }
      } catch (error) {
        this.failures.push(error as Error);
        this.ws.send(JSON.stringify({ id: rpc.id, error: (error as Error).message }));
      }
    });
  }
  get generations() { return this.requests.filter(rpc => rpc.method === 'generate'); }
  reply(rpc: Rpc, result: unknown) { this.ws.send(JSON.stringify({ id: rpc.id, result })); }
  toolCall(id: string, call: { id: string; name: string; arguments: unknown }): Promise<any> {
    return new Promise((resolve, reject) => {
      this.toolReplies.set(`${id}:${call.id}`, { resolve, reject });
      this.ws.send(JSON.stringify({ id, type: 'tool_call', call }));
    });
  }
  /** The scripted model expresses each next action as an envelope; with native MCP the bridge executes them as tool calls in-generation. */
  async deliver(rpc: Rpc) {
    nativeOutputs = new Map();
    try {
      for (let step = 0; step < 8; step++) {
        const reply = this.generate(rpc);
        const parsed = JSON.parse(reply.text);
        if (!rpc.params.nativeTools?.length || !parsed.tool_calls.length) return this.reply(rpc, reply);
        for (const [index, call] of parsed.tool_calls.entries()) {
          const value = await this.toolCall(rpc.id, { id: `fixture-${step}-${index}`, name: call.name, arguments: JSON.parse(call.arguments) });
          if (value?.stop) return this.reply(rpc, { ...envelope(''), stopped: true });
          nativeOutputs.set(call.name, typeof value?.output === 'string' ? JSON.parse(value.output) : value?.output);
        }
      }
      throw new Error('Scripted native session did not finish');
    } finally { nativeOutputs = new Map(); }
  }
  generate(rpc: Rpc) {
    const names = availableTools(rpc).map(definition => definition.name);
    for (const name of ['list_app_connections', 'SWARM_APPS_SEARCH', 'SWARM_APPS_EXECUTE']) assert.ok(names.includes(name), `${name} must remain offered throughout ordinary chat`);
    const listing = toolOutput(rpc, 'list_app_connections');
    if (!listing) return envelope('', [{ name: 'list_app_connections', args: {} }]);
    assert.equal(listing.ok, true); assert.equal(listing.available, true);
    assert.deepEqual(listing.connections.map((connection: any) => connection.id), [accountId()]);
    const discovery = toolOutput(rpc, 'SWARM_APPS_SEARCH');
    if (!discovery) return envelope('', [{ name: 'SWARM_APPS_SEARCH', args: { toolkit: 'github', query: 'inspect repositories', connectionId: listing.connections[0].id } }]);
    assert.equal(discovery.connectionId, accountId()); assert.equal(discovery.revision, 1);
    assert.equal(discovery.tools.length, 1); assert.equal(discovery.tools[0].slug, tool.slug);
    assert.equal(discovery.tools[0].readOnly, tool.tags?.includes('readOnlyHint') === true && !tool.tags.includes('updateHint'));
    const executed = toolOutput(rpc, 'SWARM_APPS_EXECUTE');
    if (!executed) return envelope('', [{ name: 'SWARM_APPS_EXECUTE', args: { connectionId: discovery.connectionId,
      revision: discovery.revision, tool_slug: discovery.tools[0].slug, arguments: appArguments } }]);
    assert.deepEqual(executed, providerData, 'The CLI receives the real app result after execution/resume');
    return envelope(`Verified ${executed.repositories[0]} (${executed.receipt})`);
  }
}

async function connect(provider: Provider) {
  const paired = await request('/cli/pair', 'POST');
  assert.equal(paired.status, 200, await paired.clone().text());
  const token = /--token '([^']+)'$/.exec((await paired.json()).command)?.[1];
  assert.ok(token);
  const bridge = new ScriptedBridge();
  await once(bridge.ws, 'open');
  bridge.ws.send(JSON.stringify({ type: 'hello', version: 1, nativeMcp: true, token, device: 'CLI connected-app fixture' }));
  await until(() => bridge.welcome, 'CLI handshake completes');
  await refreshCli(owner);
  const selected = await request('/cli', 'PUT', { provider });
  assert.equal(selected.status, 200, await selected.clone().text()); assert.equal(selectedCli(owner), provider);
  return bridge;
}
async function chat(bridge: ScriptedBridge) {
  const sent = await request(`/bots/${bot.id}/messages`, 'POST', { text: 'Inspect my connected GitHub repository and report the result.' });
  assert.equal(sent.status, 200, await sent.clone().text());
  assert.equal((await sent.json()).row.botId, bot.id);
  await runInBotQueue(bot.id, async () => {});
  assert.deepEqual(bridge.failures, []);
}
function assertFinished(bridge: ScriptedBridge, provider: Provider, expectedJobs: number) {
  // Native MCP: one generation per job (actions run in-generation; an approval pause ends the first).
  assert.deepEqual(bridge.failures, []); assert.equal(bridge.generations.length, expectedJobs);
  assert.ok(bridge.generations.every(rpc => rpc.params.provider === provider));
  assert.equal(executions.length, 1);
  assert.deepEqual(executions[0], [tool.slug, { userId: owner, connectedAccountId: accountId(), version: tool.version, arguments: appArguments }]);
  assert.ok(metadataQueries.includes(tool.slug));
  assert.ok(accountQueries.length >= 3); assert.ok(accountQueries.every(query => query.accountType === 'PRIVATE' && query.userIds.length === 1 && query.userIds[0] === owner));
  assert.equal(oauthStarts, 0);
  assert.ok(!listRows(bot.id).some(row => row.body.type === 'card' && row.body.card === 'connect'), 'An existing connection does not request OAuth');
  const replies = listRows(bot.id).filter(row => row.body.type === 'message' && row.body.role === 'assistant');
  assert.equal(replies.length, 1); assert.equal((replies[0].body as any).text, `Verified ${providerData.repositories[0]} (${providerData.receipt})`);
  const history = loadHistory(bot.id);
  for (const name of ['list_app_connections', 'SWARM_APPS_SEARCH', 'SWARM_APPS_EXECUTE']) {
    const calls = history.filter(item => item.type === 'function_call' && item.name === name);
    assert.equal(calls.length, 1);
    assert.equal(history.filter(item => item.type === 'function_call_output' && item.call_id === calls[0].call_id).length, 1);
  }
  assert.doesNotMatch(JSON.stringify(bridge.generations.map(conversation)), /foreign-account|account-private-secret|metadata-private-secret|access_token/);
  assert.equal(jobs().length, expectedJobs); assert.ok(jobs().every(job => job.state === 'completed'));
  assert.equal(db.prepare('SELECT 1 FROM pending_turns WHERE bot_id=?').get(bot.id), undefined);
  assert.equal(getLive(bot.id).isRunning, false); assert.equal(getLive(bot.id).awaiting, null);
  const usage = db.prepare('SELECT * FROM usage_events WHERE user_id=?').all(owner) as any[];
  assert.equal(usage.length, expectedJobs); assert.ok(usage.every(event => event.provider === `${provider}-cli` && event.cost_source === 'subscription' && event.cost_usd === 0));
}

beforeEach(() => {
  owner = `usr_cli_apps_${++sequence}`; foreign = `usr_cli_foreign_${sequence}`;
  for (const id of [owner, foreign]) {
    const rawSession = randomUUID(), session = `swarm_session=${rawSession}`;
    if (id === owner) cookie = session; else foreignCookie = session;
    db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(id, `${id}@example.test`, id, Date.now());
    db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at,last_seen_at,authenticated_at) VALUES (?,?,?,?,?,?)')
      .run(sessionHash(rawSession), id, Date.now(), Date.now() + 3_600_000, Date.now(), Date.now());
  }
  bot = createBot(owner, { name: 'Connected app chief', isPrimary: true, effort: 'low' });
  tool = appTool('GITHUB_PEEK', ['readOnlyHint']);
  apiRequests.length = 0; accountQueries = []; executions = []; metadataQueries = []; oauthStarts = 0;
  setEnvOverride('COMPOSIO_API_KEY', `cli-app-project-${sequence}`);
  const client = composio();
  mock.method(client.connectedAccounts, 'list', async (query: any) => {
    accountQueries.push(query);
    const id = query.userIds[0] === owner ? accountId() : 'foreign-account';
    return { items: [{ id, toolkit: { slug: 'github' }, status: 'ACTIVE', data: { access_token: 'account-private-secret' } }], nextCursor: null };
  });
  mock.method(client.tools, 'getRawComposioTools', async () => [tool]);
  mock.method(client.tools, 'getRawComposioToolBySlug', async (slug: string) => { metadataQueries.push(slug); assert.equal(slug, tool.slug); return tool; });
  mock.method(client.tools, 'execute', async (...args: any[]) => { executions.push(args); return { data: providerData, successful: true, error: null, logId: 'local-app-fixture' }; });
  mock.method(client, 'create', async () => { oauthStarts++; throw new Error('Existing account must not initiate OAuth'); });
});
afterEach(async () => {
  for (const bridge of bridges) bridge.cleanup = true;
  interrupt(bot.id); disconnectCli(owner);
  for (const bridge of bridges) if (bridge.ws.readyState !== WebSocket.CLOSED) bridge.ws.terminate();
  await Promise.all([...bridges].map(bridge => bridge.closed));
  await settleAgentJobs(); bridges.clear(); clearCliCatalog(owner);
  for (const id of [owner, foreign]) db.prepare('DELETE FROM users WHERE id=?').run(id);
  assert.deepEqual(apiRequests, [], 'CLI app chat must not fall back to paid inference, pricing or real provider HTTP');
});
after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true });
});

for (const provider of ['codex', 'claude'] as const) {
  test(`${provider}: ordinary chat lists its existing private connection, discovers a verified read and returns its output`, { timeout: 15000 }, async () => {
    const bridge = await connect(provider);
    await chat(bridge);
    assert.equal(approvals().length, 0, 'Provider-attested reads must not require approval merely because their slug lacks a read verb');
    assertFinished(bridge, provider, 1);
  });

  for (const metadata of ['write', 'unknown'] as const) test(`${provider}: a read-looking app tool with ${metadata} metadata waits for approval and resumes exactly once`, { timeout: 15000 }, async () => {
    tool = metadata === 'write' ? appTool('GITHUB_GET_AND_DELETE', ['readOnlyHint', 'updateHint']) : appTool('GITHUB_LIST_UNKNOWN');
    const bridge = await connect(provider);
    await chat(bridge);
    assert.equal(executions.length, 0, 'Write/unknown provider metadata must pause before SDK execution regardless of a read-looking slug');
    assert.equal(bridge.generations.length, 1);
    assert.equal(approvals().length, 1);
    const approval = approvals()[0];
    assert.equal(approval.status, 'pending'); assert.ok(approval.tool.includes(tool.slug)); assert.ok(approval.binding_hash);
    const card = listRows(bot.id).find(row => row.body.type === 'card' && row.body.card === 'approval')!.body as any;
    assert.equal(card.approvalId, approval.id); assert.equal(card.jobId, jobs()[0].id); assert.equal(card.status, 'pending');
    assert.deepEqual(card.args, { connectionId: accountId(), revision: 1, tool_slug: tool.slug, arguments: appArguments });
    assert.ok(getLive(bot.id).awaiting); assert.ok(db.prepare('SELECT 1 FROM pending_turns WHERE bot_id=?').get(bot.id));
    const dispatchRow = listRows(bot.id).find(row => row.body.type === 'tool-call' && row.body.name === 'SWARM_APPS_EXECUTE')!;
    const dispatch = dispatchRow.body as any;
    assert.equal(dispatch.status, 'awaiting-approval');
    const foreignApproval = await request(`/approvals/${approval.id}`, 'POST', { decision: 'allow' }, foreignCookie);
    assert.equal(foreignApproval.status, 404); assert.equal(executions.length, 0); assert.equal(approvals()[0].status, 'pending');
    const allowed = await Promise.all([request(`/approvals/${approval.id}`, 'POST', { decision: 'allow' }), request(`/approvals/${approval.id}`, 'POST', { decision: 'allow' })]);
    for (const response of allowed) assert.equal(response.status, 200, await response.clone().text());
    await runInBotQueue(bot.id, async () => {});
    assert.equal(approvals()[0].status, 'allowed');
    assert.equal((listRows(bot.id).find(row => row.seq === dispatchRow.seq)!.body as any).status, 'done');
    assertFinished(bridge, provider, 2);
    const resumed = jobs().filter(job => JSON.parse(job.trigger).type === 'resume');
    assert.equal(resumed.length, 1); assert.equal(JSON.parse(resumed[0].trigger).parentJobId, jobs()[0].id);
    assert.equal((await request(`/approvals/${approval.id}`, 'POST', { decision: 'allow' })).status, 200);
    await runInBotQueue(bot.id, async () => {});
    assert.equal(executions.length, 1); assert.equal(jobs().length, 2); assert.equal(bridge.generations.length, 2);
  });
}
