import assert from 'node:assert/strict';
import { after, beforeEach, test, mock } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Hono } from 'hono';
import { WebSocket } from 'ws';
import { mockCliProvider, modelOutputs, modelTools } from './fixtures/real-cli-provider.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-real-apps-'));
Object.assign(process.env, { NODE_ENV: 'test', SWARM_ROLE: 'standalone', DB_PATH: path.join(root, 'db'), FILES_DIR: path.join(root, 'files'), CLI_PROFILES_DIR: path.join(root, 'profiles'), SESSION_SECRET: 'fixture', COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: 'fixture', XAI_API_KEY: 'fixture', XAI_BASE_URL: 'https://model.fixture/v1', DIRECT_API_KEY: '', OPENROUTER_API_KEY: '', LLM_PROVIDER: 'direct', INKBOX_TUNNEL: '0' });
const { state } = await import('./fixtures/cli-apps-backends.mjs');
const { db } = await import('../server/src/db.js');
const { createBot } = await import('../server/src/bots.js');
const { runInBotQueue, settleAgentJobs } = await import('../server/src/agent/loop.js');
const { initSubagents } = await import('../server/src/agent/subagents.js');
const { initRooms } = await import('../server/src/agent/rooms.js');
initSubagents(); initRooms();
const { api } = await import('../server/src/routes.js');
const { hub } = await import('../server/src/lib/hub.js');
const { listRows, appendRow } = await import('../server/src/store.js');
const { saveMcpServer } = await import('../server/src/mcp/store.js');
const { selectCli, createCliPairing } = await import('../server/src/cli/store.js');
const { attachCliSocket, cliStatus, disconnectCli } = await import('../server/src/cli/bridge.js');
const { startBridge } = await import('../companion/cli-bridge.mjs');
const app = new Hono().route('/api', api);
const server = createServer(); attachCliSocket(server);
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const address = server.address(); assert.ok(address && typeof address !== 'string');
let serial = 0;
beforeEach(() => { state.connected = true; state.disabled = false; state.unavailable = false; state.accountStatus = 'ACTIVE'; state.executions.length = 0; state.external.length = 0; });
after(async () => { await settleAgentJobs(); await new Promise<void>(resolve => server.close(() => resolve())); mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
const email = { recipient_email: 'test@example.com', subject: 'Recheck', body: 'First paragraph about scheduling a demo next week.\n\nSecond paragraph about available times.', is_html: false };
const executeArgs = { connectionId: 'fixture-gmail', revision: 1, tool_slug: 'GMAIL_CREATE_EMAIL_DRAFT', arguments: email };
const texts = (value: any): string[] => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(texts) : value?.text ? [value.text] : [];
function objects(provider: string, body: any) {
  return modelOutputs(provider, body).flatMap(texts).flatMap((text: string) => { try { return [JSON.parse(text)]; } catch { return []; } });
}

async function account(t: any, provider: 'codex' | 'claude', runtime: 'hosted' | 'companion', choose: any, config: any = {}) {
  const logs: any[] = [];
  t.mock.method(console, 'info', (label: string, data: string) => { if (label === '[cli-generation]') logs.push(JSON.parse(data)); });
  const directory = path.join(root, String(++serial)); fs.mkdirSync(directory);
  const fixture = await mockCliProvider(directory, (provider: string, body: any) => modelTools(provider, body).length ? choose(provider, body) : { text: 'Fixture auxiliary response.' });
  const executable = fixture.install(provider, config);
  process.env[provider === 'codex' ? 'SWARM_CLI_CODEX_PATH' : 'SWARM_CLI_CLAUDE_PATH'] = executable;
  const userId = `real-fixture-${serial}`;
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(userId, `${userId}@example.test`, 'Fixture account', Date.now());
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(session_hash(?),?,?,?)').run(userId, userId, Date.now(), Date.now() + 3600000);
  // A fresh Bot has never had Gmail explicitly assigned. Connected apps are account scoped.
  const bot = createBot(userId, { name: 'Real CLI fixture', isPrimary: true });
  selectCli(userId, provider);
  db.prepare('UPDATE bots SET model=? WHERE id=?').run(`${provider}/default`, bot.id);
  const events: any[] = [];
  const unsubscribe = hub.subscribe(userId, event => events.push(event));
  const controller = new AbortController();
  let bridge: Promise<unknown> | undefined;
  if (runtime === 'companion') {
    bridge = startBridge({ server: `http://127.0.0.1:${address.port}`, token: createCliPairing(userId), codexPath: fixture.install('codex', config), claudePath: fixture.install('claude'),
      env: { PATH: process.env.PATH, HOME: directory }, signal: controller.signal, WebSocketImpl: WebSocket });
    for (let n = 0; n < 500 && !cliStatus(userId).connected; n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(cliStatus(userId).connected, true);
  }
  t.after(async () => { controller.abort(); disconnectCli(userId); await bridge; unsubscribe(); await fixture.close(); assert.deepEqual(fixture.errors, []); assert.deepEqual(state.external, []); });
  const request = async (url: string, body?: unknown) => {
    const r = await app.request(`/api${url}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: `swarm_session=${userId}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(r.status, 200, `${url}: ${await r.clone().text()}`); return r.json() as Promise<any>;
  };
  const chat = async () => { await request(`/bots/${bot.id}/messages`, { text: 'Draft a Gmail email to test@example.com with subject Recheck and a two paragraph body about scheduling a product demo next week. Do not send it.' }); await runInBotQueue(bot.id, async () => {}); };
  return { ...fixture, userId, bot, request, chat, events, logs, rows: () => listRows(bot.id) as any[] };
}

function script(route: 'direct' | 'search' | 'deferred') {
  let step = 0;
  return (provider: string, body: any) => {
    const name = (n: string) => provider === 'claude' ? `mcp__swarm__${n}` : n;
    const call = (n: string, args: unknown) => ({ name: name(n), args });
    const found = objects(provider, body);
    if (found.some((o: any) => o.status === 'pending_approval')) return { text: 'Approval is waiting in the main chat.' };
    if (route === 'direct') return step++ === 0 ? call('SWARM_APPS_EXECUTE', executeArgs) : { text: 'Nothing was sent or saved.' };
    if (step++ === 0) return call('list_app_connections', {});
    if (step === 2) return call('SWARM_APPS_SEARCH', { toolkit: 'gmail', query: 'create email draft', connectionId: 'fixture-gmail' });
    if (step === 3) {
      const discovery = found.find((o: any) => o.tools?.some((t: any) => t.slug === 'GMAIL_CREATE_EMAIL_DRAFT'));
      assert.ok(discovery, JSON.stringify(modelOutputs(provider, body)));
      assert.equal(discovery.connectionId, executeArgs.connectionId);
      assert.equal(discovery.revision, executeArgs.revision);
      if (route === 'search') return call('SWARM_APPS_EXECUTE', executeArgs);
      return call('tool_search', { query: 'SWARM_APPS_EXECUTE' });
    }
    if (route === 'deferred' && step === 4) return call('tool_describe', { tool_name: 'SWARM_APPS_EXECUTE' });
    if (route === 'deferred' && step === 5) {
      const described = found.find((o: any) => o.name === 'SWARM_APPS_EXECUTE' && o.schema_hash);
      assert.ok(described);
      return call('tool_call', { tool_name: described.name, schema_hash: described.schema_hash, arguments: executeArgs });
    }
    return { text: 'Nothing was sent or saved.' };
  };
}

for (const provider of ['codex', 'claude'] as const) for (const runtime of ['hosted', 'companion'] as const) {
  for (const route of ['direct', 'search', 'deferred'] as const) test(`real ${provider} ${runtime} ${route}: Gmail approval persists, emits SSE, reaches the CLI and denial blocks execution`, { timeout: 30000 }, async t => {
    const a = await account(t, provider, runtime, script(route));
    await a.chat();
    const card = a.rows().find(r => r.body.card === 'approval');
    assert.ok(card, JSON.stringify(a.rows()));
    const approval: any = db.prepare('SELECT * FROM approvals WHERE id=?').get(card.body.approvalId);
    assert.equal(approval.status, 'pending');
    assert.deepEqual(card.body.args, executeArgs);
    assert.ok(a.events.some(e => e.type === 'rows' && e.rows.some((r: any) => r.body.approvalId === approval.id && r.body.status === 'pending')));
    const offered = a.requests.flatMap(r => modelTools(provider, r.body)).map((t: any) => t.name);
    for (const n of ['SWARM_APPS_SEARCH', 'SWARM_APPS_EXECUTE', 'tool_search', 'tool_describe', 'tool_call']) assert.ok(offered.includes(n), n);
    assert.equal(offered.includes('GMAIL_CREATE_EMAIL_DRAFT'), false, 'App slugs are parameters, not native registrations');
    const pending = a.requests.flatMap(r => objects(provider, r.body)).find(o => o.status === 'pending_approval');
    assert.equal(pending?.approvalId, approval.id, 'The real CLI delivered the pending tool result to the mock model');
    assert.equal(pending.executed, false);
    const start = a.logs.find(e => e.event === 'start' && e.manifestCount > 0);
    assert.equal(start.provider, provider); assert.equal(start.runtime, runtime === 'hosted' ? 'server' : 'bridge');
    assert.match(start.manifestNamesHash, /^[a-f0-9]{64}$/);
    assert.equal(start.manifestCount, new Set(offered).size);
    assert.ok(a.logs.some(e => e.event === 'tool' && e.admission === 'admitted'));
    assert.ok(a.logs.some(e => e.event === 'tool_result' && e.admission === 'pending_approval'));
    assert.doesNotMatch(JSON.stringify(a.logs), /test@example.com|First paragraph|Bearer|offline-fixture/);
    assert.equal(state.executions.length, 0);
    await a.request(`/approvals/${approval.id}`, { decision: 'deny' });
    await runInBotQueue(a.bot.id, async () => {});
    assert.equal(a.rows().find(r => r.seq === card.seq).body.status, 'denied');
    assert.equal(a.rows().filter(r => r.body.card === 'approval').length, 1);
    assert.equal(state.executions.length, 0);
    await a.request(`/approvals/${approval.id}`, { decision: 'allow' });
    await runInBotQueue(a.bot.id, async () => {});
    assert.equal(state.executions.length, 0, 'A later allow cannot reverse denial');
  });

  test(`real ${provider} ${runtime}: voice uses the main chat approval and denial`, { timeout: 30000 }, async t => {
    const a = await account(t, provider, runtime, script('search'));
    const call = await a.request('/voice/session', { botId: a.bot.id });
    const assigned = await a.request('/voice/tool', { botId: a.bot.id, callId: call.callId, name: 'send_task', args: { request: 'Create a Gmail draft. Do not send it.' }, toolCallId: 'real-voice-fixture' });
    await runInBotQueue(a.bot.id, async () => {});
    const card = a.rows().find(r => r.body.card === 'approval');
    assert.ok(card, JSON.stringify(a.rows())); assert.equal(card.body.jobId, assigned.taskId);
    await a.request(`/approvals/${card.body.approvalId}`, { decision: 'deny' });
    await runInBotQueue(a.bot.id, async () => {});
    const updates = await a.request('/voice/updates', { botId: a.bot.id, callId: call.callId, after: 0 });
    assert.ok(updates.updates.some((u: any) => u.text.includes('declined in chat')));
    assert.equal(state.executions.length, 0);
    await a.request('/voice/end', { botId: a.bot.id, callId: call.callId });
  });
}

test('real Codex reproduces the old auto/never rejection before Swarm admission', { timeout: 30000 }, async t => {
  let step = 0;
  const a = await account(t, 'codex', 'hosted', (_provider: string, body: any) => step++ === 0
    ? { name: 'SWARM_APPS_SEARCH', args: { toolkit: 'gmail', query: 'create email draft' } }
    : { text: texts(modelOutputs('codex', body)).join('\n') }, { codexConfig: ['mcp_servers.swarm.default_tools_approval_mode="auto"'] });
  await a.chat();
  assert.match(JSON.stringify(a.requests.at(-1)?.body.input), /MCP tool call requires approval, but approval policy is never/);
  assert.equal(a.rows().filter(r => r.body.type === 'tool-call').length, 0);
  assert.equal(a.rows().filter(r => r.body.card === 'approval').length, 0);
  assert.equal(state.executions.length, 0);
  assert.ok(a.rows().some(r => /CLI approval policy blocked/.test(r.body.text ?? '') && /Settings > Subscriptions/.test(r.body.text)));
  assert.ok(!a.rows().some(r => /try again once access is restored|Pending approval/.test(r.body.text ?? '')));
  assert.ok(a.logs.some(e => e.tool === 'SWARM_APPS_SEARCH' && e.admission === 'cli_rejected' && e.errorClass === 'cli_approval_rejected'));
});

test('real Codex rejects a raw Gmail slug and a legacy flattened name, then calls the namespaced wrapper', { timeout: 30000 }, async t => {
  let step = 0;
  const a = await account(t, 'codex', 'hosted', () => [
    { name: 'GMAIL_CREATE_EMAIL_DRAFT', args: email },
    { name: 'mcp__swarm__SWARM_APPS_SEARCH', namespace: null, args: { toolkit: 'gmail', query: 'create draft' } },
    { name: 'SWARM_APPS_EXECUTE', args: executeArgs },
    { text: 'Approval is waiting in the main chat.' },
  ][Math.min(step++, 3)]);
  await a.chat();
  const results = JSON.stringify(a.requests.flatMap(r => modelOutputs('codex', r.body)));
  assert.match(results, /unsupported call: mcp__swarmGMAIL_CREATE_EMAIL_DRAFT/);
  assert.match(results, /unsupported call: mcp__swarm__SWARM_APPS_SEARCH/);
  assert.equal(a.rows().filter(r => r.body.card === 'approval').length, 1);
  assert.equal(state.executions.length, 0);
});

test('real Codex: an uncertain approved write never becomes a reconnect card claiming nothing happened', { timeout: 30000 }, async t => {
  const { composio } = await import('../server/src/composio.js');
  let dispatches = 0;
  t.mock.method(composio().tools, 'execute', async () => {
    dispatches++; state.accountStatus = 'EXPIRED';
    throw Object.assign(new Error('Private provider response sentinel'), { status: 401 });
  });
  const a = await account(t, 'codex', 'hosted', script('search'));
  await a.chat();
  const card = a.rows().find(r => r.body.card === 'approval'); assert.ok(card);
  await a.request(`/approvals/${card.body.approvalId}`, { decision: 'allow' }); await runInBotQueue(a.bot.id, async () => {});
  assert.equal(dispatches, 1);
  assert.equal(a.rows().filter(r => r.body.card === 'connect').length, 0);
  const notice = a.rows().filter(r => r.body.type === 'notice').map(r => r.body.text).join('\n');
  assert.match(notice, /Gmail connection failed.*Check the app for changes/);
  assert.doesNotMatch(notice, /Nothing has been sent|sentinel/);
});

for (const provider of ['codex', 'claude'] as const) {
  test(`real ${provider}: a tool absent from the initial manifest executes only through described tool_call and still needs approval`, { timeout: 30000 }, async t => {
    let step = 0;
    const a = await account(t, provider, 'hosted', (_: string, body: any) => {
      const name = (n: string) => provider === 'claude' ? `mcp__swarm__${n}` : n;
      const found = objects(provider, body);
      if (step++ === 0) return { name: name('tool_search'), args: { query: 'fixture deferred lookup' } };
      if (step === 2) {
        const hit = found.flatMap((o: any) => Array.isArray(o) ? o : []).find((o: any) => o.name?.startsWith('mcp_'));
        assert.ok(hit); return { name: name('tool_describe'), args: { tool_name: hit.name } };
      }
      if (step === 3) {
        const tool = found.find((o: any) => o.name?.startsWith('mcp_') && o.parameters);
        assert.ok(tool); return { name: name('tool_call'), args: { tool_name: tool.name, schema_hash: tool.schema_hash, arguments: { key: 'fixture' } } };
      }
      return { text: 'Nothing was executed.' };
    });
    const custom = saveMcpServer(a.userId, { name: 'Fixture MCP', transport: 'http', url: 'https://mcp.fixture.test/mcp', botIds: [a.bot.id], requireApproval: true });
    db.prepare('UPDATE mcp_servers SET tools=? WHERE id=?').run(JSON.stringify([{ name: 'fixture_deferred_lookup', description: 'Fixture deferred lookup', inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false } }]), custom.id);
    await a.chat();
    assert.ok(a.requests.every(r => modelTools(provider, r.body).every((tool: any) => !tool.name.startsWith('mcp_'))));
    const card = a.rows().find(r => r.body.card === 'approval'); assert.ok(card); assert.match(card.body.tool, /^mcp_/);
    assert.ok(a.requests.flatMap(r => objects(provider, r.body)).some(o => o.status === 'pending_approval' && o.approvalId === card.body.approvalId));
    await a.request(`/approvals/${card.body.approvalId}`, { decision: 'deny' }); await runInBotQueue(a.bot.id, async () => {});
    assert.deepEqual(state.external, []);
  });

  for (const scenario of ['missing', 'expired', 'unavailable', 'blocked'] as const) test(`real ${provider}: ${scenario} Gmail gives evidence-based guidance without a fake approval`, { timeout: 30000 }, async t => {
    if (scenario === 'missing') state.connected = false;
    if (scenario === 'expired') state.accountStatus = 'EXPIRED';
    if (scenario === 'unavailable') state.unavailable = true;
    let step = 0;
    const a = await account(t, provider, 'hosted', (_: string, body: any) => step++ === 0
      ? { name: provider === 'claude' ? 'mcp__swarm__SWARM_APPS_EXECUTE' : 'SWARM_APPS_EXECUTE', args: executeArgs }
      : { text: texts(modelOutputs(provider, body).at(-1)).join('\n') });
    if (scenario === 'blocked') db.prepare('INSERT INTO policies(user_id,tool,mode) VALUES(?,?,?)').run(a.userId, 'GMAIL_CREATE_EMAIL_DRAFT', 'blocked');
    const historical = appendRow(a.bot.id, 'message', { type: 'message', role: 'assistant', text: 'Please try again once access is restored.' });
    const savedHistorical = a.rows().find(r => r.seq === historical.seq);
    await a.chat();
    assert.deepEqual(a.rows().find(r => r.seq === historical.seq), savedHistorical, 'Old chat messages stay unchanged');
    const rows = a.rows().filter(r => r.seq > historical.seq);
    assert.equal(rows.filter(r => r.body.card === 'approval').length, 0);
    assert.equal(state.executions.length, 0);
    if (scenario === 'missing' || scenario === 'expired') {
      const card = rows.find(r => r.body.card === 'connect'); assert.ok(card, JSON.stringify(rows));
      assert.match(card.body.reason, scenario === 'expired' ? /Gmail needs to be reconnected.*Connect card/ : /Gmail is not connected/);
    } else {
      assert.equal(rows.filter(r => r.body.card === 'connect').length, 0);
      const text = rows.filter(r => r.body.role === 'assistant').map(r => r.body.text).join('\n');
      assert.match(text, scenario === 'unavailable' ? /provider did not return its status.*Open Connected apps/ : /user declined this action.*Do not retry/);
    }
    assert.doesNotMatch(JSON.stringify(rows), /try again once access is restored|Pending approval/);
  });

  test(`real ${provider}: allowing the persisted Gmail card executes once with the same account identity`, { timeout: 30000 }, async t => {
    const a = await account(t, provider, 'hosted', script('search'));
    await a.chat();
    const card = a.rows().find(r => r.body.card === 'approval'); assert.ok(card);
    assert.equal(state.executions.length, 0);
    await a.request(`/approvals/${card.body.approvalId}`, { decision: 'allow' });
    await runInBotQueue(a.bot.id, async () => {});
    assert.equal(state.executions.length, 1);
    assert.equal(state.executions[0].slug, 'GMAIL_CREATE_EMAIL_DRAFT');
    assert.equal(state.executions[0].input.userId, a.userId);
    assert.equal(state.executions[0].input.connectedAccountId, 'fixture-gmail');
    assert.deepEqual(state.executions[0].input.arguments, email);
  });
}
