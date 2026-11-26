import assert from 'node:assert/strict';
import { after, beforeEach, test, mock } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Hono } from 'hono';
import { WebSocket } from 'ws';
import { mockCliProvider, modelOutputs, modelTools, usesCodeMode, codeModeAction } from './fixtures/real-cli-provider.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-real-apps-'));
Object.assign(process.env, { NODE_ENV: 'production', DEV_LOGIN: '0', SWARM_ROLE: 'standalone', DB_PATH: path.join(root, 'db'), FILES_DIR: path.join(root, 'files'), CLI_PROFILES_DIR: path.join(root, 'profiles'), SESSION_SECRET: 'fixture', COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: 'fixture', XAI_API_KEY: 'fixture', XAI_BASE_URL: 'https://model.fixture/v1', DIRECT_API_KEY: '', OPENROUTER_API_KEY: '', LLM_PROVIDER: 'direct', INKBOX_TUNNEL: '0' });
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
const { cliApi } = await import('../server/src/cli/routes.js');
const app = new Hono().route('/api/cli', cliApi).route('/api', api);
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
  const fixture = await mockCliProvider(directory, (provider: string, body: any) => (modelTools(provider, body).length || usesCodeMode(body)) ? choose(provider, body) : { text: 'Fixture auxiliary response.' });
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
  t.after(async () => { await settleAgentJobs(); controller.abort(); disconnectCli(userId); await bridge; unsubscribe(); await fixture.close(); assert.deepEqual(fixture.errors, []); assert.deepEqual(state.external, []); });
  const request = async (url: string, body?: unknown) => {
    const r = await app.request(`/api${url}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: `swarm_session=${userId}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(r.status, 200, `${url}: ${await r.clone().text()}`); return r.json() as Promise<any>;
  };
  const chat = async () => { await request(`/bots/${bot.id}/messages`, { text: 'Draft a Gmail email to test@example.com with subject Recheck and a two paragraph body about scheduling a product demo next week. Do not send it.' }); await runInBotQueue(bot.id, async () => {}); };
  return { ...fixture, userId, bot, request, chat, events, logs, cliEvents: fixture.events, rows: () => listRows(bot.id) as any[] };
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

for (const provider of ['codex', 'claude'] as const) test(`R7 hosted ${provider} retains the approval tool run through a running and completed decision reply offering 19 tools`, { timeout: 30000 }, async t => {
  let decided = false;
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const running = new Promise<void>(resolve => { started = resolve; });
  const choose = script('direct');
  const a = await account(t, provider, 'hosted', async (provider: string, body: any) => {
    if (decided) { started(); await gate; return { text: 'Nothing was saved.' }; }
    return choose(provider, body);
  });
  t.after(() => release());
  await a.chat();
  const card = a.rows().find(r => r.body.card === 'approval');
  const before = (await a.request('/cli')).runsByProvider[provider];
  assert.equal(before.latest.toolsOffered, 19);
  assert.equal(before.lastToolRun.lastTool, 'SWARM_APPS_EXECUTE');
  assert.equal(before.lastToolRun.result, 'pending_approval');
  decided = true;
  try {
    await a.request(`/approvals/${card.body.approvalId}`, { decision: 'deny' });
    await running;
    const during = (await a.request('/cli')).runsByProvider[provider];
    assert.equal(during.latest.toolsOffered, 19);
    assert.equal(during.latest.lastTool, null);
    assert.equal(during.latest.result, 'running');
    assert.equal(during.latest.trigger, 'approval_decision');
    assert.equal(during.latest.errorCode, null);
    assert.deepEqual(during.lastToolRun, { ...before.lastToolRun, result: 'denied' });
    assert.notDeepEqual(during.latest, during.lastToolRun);
  } finally { release(); }
  await runInBotQueue(a.bot.id, async () => {});
  const after = (await a.request('/cli')).runsByProvider[provider];
  assert.equal(after.latest.toolsOffered, 19);
  assert.equal(after.latest.lastTool, null);
  assert.equal(after.latest.result, 'no_tool_call');
  assert.equal(after.latest.trigger, 'approval_decision');
  assert.deepEqual(after.lastToolRun, { ...before.lastToolRun, result: 'denied' });
  assert.equal(state.executions.length, 0);
});

for (const provider of ['codex', 'claude'] as const) for (const decision of ['allow', 'deny'] as const) test(`R13 real ${provider}: pending Gmail survives later internal generations until ${decision}`, { timeout: 60000 }, async t => {
  const choose = script('direct');
  let phase = 'approval', step = 0, decisionStep = 0;
  let jobId = '';
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const running = new Promise<void>(resolve => { started = resolve; });
  const a = await account(t, provider, 'hosted', async (provider: string, body: any) => {
    if (phase === 'approval') return choose(provider, body);
    if (phase === 'decision') {
      if (decisionStep++ === 0) return { name: provider === 'claude' ? 'mcp__swarm__tool_describe' : 'tool_describe', args: { tool_name: 'read_team_job' } };
      if (decisionStep === 2) {
        const described = objects(provider, body).find((o: any) => o.name === 'read_team_job' && o.schema_hash);
        assert.ok(described);
        return { name: provider === 'claude' ? 'mcp__swarm__tool_call' : 'tool_call', args: { tool_name: described.name, schema_hash: described.schema_hash, arguments: { jobId } } };
      }
      return { text: 'Your decision was recorded.' };
    }
    if (step++ === 0) {
      started(); await gate;
      return { name: provider === 'claude' ? 'mcp__swarm__tool_describe' : 'tool_describe', args: { tool_name: 'create_task' } };
    }
    if (step === 2) {
      const described = objects(provider, body).find((o: any) => o.name === 'create_task' && o.schema_hash);
      assert.ok(described, JSON.stringify(modelOutputs(provider, body)));
      return { name: provider === 'claude' ? 'mcp__swarm__tool_call' : 'tool_call', args: { tool_name: described.name, schema_hash: described.schema_hash, arguments: { title: 'Local fixture task' } } };
    }
    return { text: 'Internal check completed.' };
  });
  t.after(() => release());
  await a.chat();
  const card = a.rows().find(r => r.body.card === 'approval');
  const before = (await a.request('/cli')).runsByProvider[provider];
  assert.equal(before.latest.result, 'pending_approval');
  assert.equal(before.lastToolRun.lastTool, 'SWARM_APPS_EXECUTE');
  // Another Bot can run internal work while the first waits for its decision.
  const background = createBot(a.userId, { name: 'Internal fixture', isPrimary: true });
  db.prepare('UPDATE bots SET model=? WHERE id=?').run(`${provider}/default`, background.id);
  const internal = async () => {
    await a.request(`/bots/${background.id}/messages`, { text: 'Create a local fixture task.' });
    await runInBotQueue(background.id, async () => {});
  };
  phase = 'internal';
  const work = internal();
  let during: any;
  try {
    await running;
    during = await a.request('/cli');
  } finally { release(); await work; }
  const completed = await a.request('/cli');
  const stored = db.prepare('SELECT result,last_tool FROM cli_last_runs WHERE user_id=?').get(a.userId) as any;
  assert.equal(stored.result, 'completed');
  assert.equal(stored.last_tool, 'create_task');
  assert.deepEqual(completed.runsByProvider[provider], before);
  assert.deepEqual(completed.lastRun, before.latest);
  assert.deepEqual(during.runsByProvider[provider], before);
  assert.deepEqual(during.lastRun, before.latest);
  assert.ok(a.logs.some(e => e.event === 'tool_result' && e.resolvedTool === 'create_task' && e.admission === 'returned'), JSON.stringify({ logs: a.logs.filter(e => e.event === 'tool_result'), rows: listRows(background.id) }));
  jobId = (db.prepare('SELECT id FROM agent_jobs WHERE bot_id=? ORDER BY created_at DESC LIMIT 1').get(background.id) as any).id;
  // read_team_job is available to the coordinator for this account.
  db.prepare('UPDATE bots SET is_primary=CASE WHEN id=? THEN 1 ELSE 0 END WHERE user_id=?').run(a.bot.id, a.userId);
  phase = 'decision';
  await a.request(`/approvals/${card.body.approvalId}`, { decision });
  await runInBotQueue(a.bot.id, async () => {});
  const after = (await a.request('/cli')).runsByProvider[provider];
  assert.equal(after.latest.trigger, 'approval_decision');
  assert.equal(after.latest.result, 'completed');
  assert.equal(after.latest.lastTool, 'read_team_job');
  assert.ok(a.logs.some(e => e.event === 'tool_result' && e.resolvedTool === 'read_team_job' && e.admission === 'returned'));
  assert.deepEqual(after.lastToolRun, { ...before.lastToolRun, result: decision === 'allow' ? 'allowed' : 'denied' });
  assert.equal(state.executions.length, decision === 'allow' ? 1 : 0);
  phase = 'internal'; step = 0;
  await internal();
  const later = (await a.request('/cli')).runsByProvider[provider];
  assert.equal(later.latest.result, 'completed');
  assert.equal(later.lastToolRun.result, 'completed');
  assert.equal(later.lastToolRun.lastTool, 'create_task');
  const starts = a.logs.filter(e => e.event === 'start');
  assert.ok(starts.every(start => a.logs.some(e => e.generationId === start.generationId && ['finish', 'failure'].includes(e.event))), 'Every finished generation has a terminal diagnostic');
});

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
    const pendingRun = (await a.request('/cli')).runsByProvider[provider].lastToolRun;
    assert.equal(pendingRun.lastTool, 'SWARM_APPS_EXECUTE', 'Resolved app action, not the tool_call wrapper');
    assert.equal(pendingRun.result, 'pending_approval');
    assert.equal(pendingRun.errorCode, null);
    await a.request(`/approvals/${approval.id}`, { decision: 'deny' });
    await runInBotQueue(a.bot.id, async () => {});
    const decidedRun = (await a.request('/cli')).runsByProvider[provider];
    assert.equal(decidedRun.latest.trigger, 'approval_decision');
    assert.equal(decidedRun.latest.result, 'no_tool_call', JSON.stringify({ run: decidedRun.latest, notices: a.rows().filter(r => r.body.type === 'notice').map(r => r.body.text) }));
    assert.deepEqual(decidedRun.lastToolRun, { ...pendingRun, result: 'denied' });
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
  assert.match(notice, /Gmail:.*rejected authorization.*Check the app for changes/);
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


test('real hosted Codex default model reproduces the disabled code-mode host', { timeout: 30000 }, async t => {
  let step = 0;
  const a = await account(t, 'codex', 'hosted', (_: string, body: any) => step++ === 0
    ? codeModeAction({ name: 'SWARM_APPS_SEARCH', args: { toolkit: 'gmail', query: 'create email draft' } })
    : { text: texts(modelOutputs('codex', body)).join('\n') }, { codexModel: null, codexConfig: ['features.code_mode_host=false'] });
  await a.chat();
  assert.ok(a.requests.some(r => usesCodeMode(r.body)));
  const outputs = JSON.stringify(a.requests.flatMap(r => modelOutputs('codex', r.body)));
  assert.match(outputs, /code-mode host is disabled/);
  assert.ok(a.cliEvents('codex').some(e => e.item?.type === 'error' && /Code Mode is unavailable because code-mode host is disabled/.test(e.item.message)));
  assert.ok(a.rows().some(r => /Settings > Models & access/.test(r.body.text ?? '')));
  assert.equal((await a.request('/cli')).lastRun.errorCode, 'cli_tool_host_disabled');
  assert.equal((await a.request('/cli')).lastRun.result, 'rejected_by_cli');
  assert.equal(a.rows().filter(r => r.body.card === 'approval').length, 0);
  assert.equal(state.executions.length, 0);
});


for (const route of ['direct', 'search', 'voice', 'allow', 'without Landlock'] as const) test(`real hosted Codex default model ${route}: approval persists, emits SSE, returns pending and records the run`, { timeout: 30000 }, async t => {
  let step = 0;
  const a = await account(t, 'codex', 'hosted', (_: string, body: any) => {
    if (step++ === 0 && route !== 'direct') return codeModeAction({ name: 'SWARM_APPS_SEARCH', args: { toolkit: 'gmail', query: 'create email draft' } });
    if (step === (route === 'direct' ? 1 : 2)) {
      if (route !== 'direct') assert.match(JSON.stringify(modelOutputs('codex', body)), /GMAIL_CREATE_EMAIL_DRAFT/);
      return codeModeAction({ name: 'SWARM_APPS_EXECUTE', args: executeArgs });
    }
    return { text: 'Approval is waiting in the main chat.' };
  }, { codexModel: null, denyLandlock: route === 'without Landlock' });
  let call: any, assigned: any;
  if (route === 'voice') {
    call = await a.request('/voice/session', { botId: a.bot.id });
    assigned = await a.request('/voice/tool', { botId: a.bot.id, callId: call.callId, name: 'send_task', args: { request: 'Create a Gmail draft. Do not send it.' }, toolCallId: 'default-model-voice' });
    await runInBotQueue(a.bot.id, async () => {});
  } else await a.chat();
  const card = a.rows().find(r => r.body.card === 'approval');
  assert.ok(card, JSON.stringify({ rows: a.rows(), outputs: a.requests.flatMap(r => modelOutputs('codex', r.body)), events: a.cliEvents('codex') }));
  assert.ok(a.events.some(e => e.type === 'rows' && e.rows.some((r: any) => r.body.approvalId === card.body.approvalId)), JSON.stringify(a.events));
  const returned = JSON.stringify(a.requests.flatMap(r => modelOutputs('codex', r.body)));
  assert.match(returned, /pending_approval/); assert.ok(returned.includes(card.body.approvalId));
  assert.equal((db.prepare('SELECT status FROM approvals WHERE id=?').get(card.body.approvalId) as any).status, 'pending');
  const diagnostic = (await a.request('/cli')).lastRun;
  assert.equal(diagnostic.provider, 'codex'); assert.equal(diagnostic.runtime, 'server');
  assert.ok(diagnostic.toolsOffered > 0); assert.equal(diagnostic.lastTool, 'SWARM_APPS_EXECUTE');
  assert.equal(diagnostic.result, 'pending_approval'); assert.equal(diagnostic.errorCode, null);
  assert.equal(state.executions.length, 0);
  if (assigned) assert.equal(card.body.jobId, assigned.taskId);
  const args = a.args('codex')[0];
  for (const value of ['--ephemeral', '--ignore-user-config', 'read-only', 'approval_policy="never"', 'cli_auth_credentials_store="file"', 'features.shell_tool=false', 'features.code_mode_host=true']) assert.ok(args.includes(value), value);
  await a.request(`/approvals/${card.body.approvalId}`, { decision: route === 'allow' ? 'allow' : 'deny' });
  await runInBotQueue(a.bot.id, async () => {});
  assert.equal(state.executions.length, route === 'allow' ? 1 : 0);
  if (route === 'allow') {
    assert.equal(state.executions[0].slug, 'GMAIL_CREATE_EMAIL_DRAFT');
    assert.equal(state.executions[0].input.userId, a.userId);
    assert.equal(state.executions[0].input.connectedAccountId, 'fixture-gmail');
    assert.deepEqual(state.executions[0].input.arguments, email);
  }
  if (call) {
    const updates = await a.request('/voice/updates', { botId: a.bot.id, callId: call.callId, after: 0 });
    assert.ok(updates.updates.some((u: any) => u.text.includes('declined in chat')));
    await a.request('/voice/end', { botId: a.bot.id, callId: call.callId });
  }
});


test('real hosted Codex default model keeps local execution unavailable while app tools remain callable', { timeout: 30000 }, async t => {
  let step = 0;
  const forbidden = path.join(root, 'forbidden-write');
  const a = await account(t, 'codex', 'hosted', () => step++ === 0 ? { code: `text({ globals: [typeof process, typeof require, typeof fetch, typeof Deno], tools: ALL_TOOLS.map(t => t.name) }); text(await tools.apply_patch(${JSON.stringify(`*** Begin Patch\n*** Add File: ${forbidden}\n+forbidden\n*** End Patch`)}));` } : { text: 'Capability check complete.' }, { codexModel: null, denyLandlock: true });
  await a.chat();
  const output = JSON.stringify(a.requests.flatMap(r => modelOutputs('codex', r.body)));
  assert.match(output, /undefined/);
  assert.match(output, /undefined.*undefined.*undefined.*undefined/);
  assert.match(output, /mcp__swarm__SWARM_APPS_EXECUTE/);
  assert.doesNotMatch(output, /exec_command|shell_command|read_file|write_file|spawn_agent/);
  assert.match(output, /patch rejected|rejected by.*approval|not permitted/i);
  assert.equal(fs.existsSync(forbidden), false);
  assert.equal((await a.request('/cli')).lastRun.result, 'no_tool_call');
  assert.equal(state.executions.length, 0);
});

for (const scenario of ['subjects', 'provider error', 'auth error', 'timeout', 'stale revision', 'missing', 'expired'] as const) test(`R11-3 real hosted Codex: Gmail read ${scenario}`, { timeout: 30000 }, async t => {
  const { composio, resetAppDiscovery } = await import('../server/src/composio.js');
  resetAppDiscovery();
  const sdk = composio();
  const read = { slug: 'GMAIL_FETCH_EMAILS', toolkit: { slug: 'gmail' }, version: '20261101_00', tags: ['readOnlyHint'],
    inputParameters: { type: 'object', properties: { user_id: { type: 'string' }, max_results: { type: 'integer' } } } };
  t.mock.method(sdk.tools, 'getRawComposioTools', async () => [read]);
  t.mock.method(sdk.tools, 'getRawComposioToolBySlug', async () => read);
  let dispatches = 0;
  t.mock.method(sdk.tools, 'execute', async (_slug: string, input: any) => {
    dispatches++; assert.equal(input.connectedAccountId, 'fixture-gmail'); assert.equal(input.arguments.user_id, 'me');
    assert.match(input.userId, /^real-fixture-/);
    if (scenario === 'provider error') throw Object.assign(new Error('PRIVATE_PROVIDER_BODY'), { status: 503 });
    if (scenario === 'auth error') throw Object.assign(new Error('PRIVATE_PROVIDER_BODY'), { status: 401 });
    if (scenario === 'timeout') throw new DOMException('PRIVATE_PROVIDER_BODY', 'TimeoutError');
    return { successful: true, data: { subjects: ['Fixture one', 'Fixture two', 'Fixture three'] } };
  });
  if (scenario === 'missing') state.connected = false;
  if (scenario === 'expired') state.accountStatus = 'EXPIRED';
  let step = 0;
  const a = await account(t, 'codex', 'hosted', (_provider: string, body: any) => {
    const action = [
      { name: 'list_app_connections', args: {} },
      { name: 'SWARM_APPS_SEARCH', args: { toolkit: 'gmail', query: 'fetch 3 email subjects', connectionId: 'fixture-gmail' } },
      { name: 'SWARM_APPS_EXECUTE', args: { connectionId: 'fixture-gmail', revision: scenario === 'stale revision' ? 2 : 1, tool_slug: 'GMAIL_FETCH_EMAILS', arguments: { user_id: 'me', max_results: 3 } } },
      { text: 'Fixture one, Fixture two, Fixture three.' },
    ][Math.min(step++, 3)];
    return usesCodeMode(body) ? codeModeAction(action) : action;
  }, { codexModel: null });
  await a.request(`/bots/${a.bot.id}/messages`, { text: 'Read 3 Gmail subjects.' }); await runInBotQueue(a.bot.id, async () => {});
  const rows = a.rows(), notices = rows.filter(r => r.body.type === 'notice').map(r => r.body.text).join('\n');
  assert.doesNotMatch(notices, /connection failed|Native tool execution failed|PRIVATE_PROVIDER_BODY/);
  assert.equal(rows.filter(r => r.body.card === 'approval').length, scenario === 'stale revision' ? 1 : 0);
  if (scenario === 'subjects') {
    assert.equal(dispatches, 1); assert.ok(rows.some(r => r.body.role === 'assistant' && r.body.text?.includes('Fixture three')));
    assert.ok(a.requests.some(r => JSON.stringify(modelOutputs('codex', r.body)).includes('Fixture one')));
  } else if (scenario === 'missing' || scenario === 'expired') {
    assert.equal(dispatches, 0); assert.equal(rows.filter(r => r.body.card === 'connect').length, 1);
    assert.match(JSON.stringify(rows), scenario === 'expired' ? /needs to be reconnected/ : /is not connected/);
  } else if (scenario === 'stale revision') {
    assert.equal(dispatches, 0);
    const card = rows.find(r => r.body.card === 'approval');
    await a.request(`/approvals/${card.body.approvalId}`, { decision: 'allow' }); await runInBotQueue(a.bot.id, async () => {});
    assert.equal(dispatches, 0);
    assert.match(JSON.stringify(a.rows()), /connection revision is no longer available/);
  } else {
    assert.equal(dispatches, 1);
    assert.match(notices, scenario === 'provider error' ? /temporarily unavailable/ : scenario === 'auth error' ? /rejected authorization/ : /timed out/);
    assert.ok(rows.some(r => r.body.name === 'SWARM_APPS_EXECUTE' && r.body.status === 'error'));
    const code = scenario === 'provider error' ? 'app_provider' : scenario === 'auth error' ? 'app_auth' : 'app_timeout';
    assert.ok(a.logs.some(log => log.event === 'tool_result' && log.errorClass === code));
    const status = await a.request('/cli');
    assert.equal(status.runsByProvider.codex.lastToolRun.lastTool, 'SWARM_APPS_EXECUTE');
    assert.equal(status.runsByProvider.codex.lastToolRun.errorCode, code);
    assert.equal(status.runsByProvider.codex.lastToolRun.result, 'error');
  }
});

for (const provider of ['codex', 'claude'] as const) test(`R12 real ${provider}: completed internal task output reaches the reply with its title and no ID`, { timeout: 30000 }, async t => {
  let step = 0;
  const a = await account(t, provider, 'hosted', (_: string, body: any) => {
    const call = (name: string, args: unknown) => ({ name: provider === 'claude' ? `mcp__swarm__${name}` : name, args });
    if (step++ === 0) return call('tool_describe', { tool_name: 'create_task' });
    if (step === 2) {
      const described = objects(provider, body).find((o: any) => o.name === 'create_task' && o.schema_hash);
      assert.ok(described);
      return call('tool_call', { tool_name: 'create_task', schema_hash: described.schema_hash, arguments: { title: 'Task fixture 1' } });
    }
    // Echo the actual tool output through the real CLI reply and chat persistence path.
    return { text: texts(modelOutputs(provider, body).at(-1)).join('\n') };
  });
  await a.request(`/bots/${a.bot.id}/messages`, { text: 'Create a task titled Task fixture 1.' });
  await runInBotQueue(a.bot.id, async () => {});
  const task = db.prepare('SELECT id FROM tasks WHERE bot_id=? AND title=?').get(a.bot.id, 'Task fixture 1') as { id: string };
  assert.ok(task);
  const reply = a.rows().filter(r => r.body.role === 'assistant').map(r => r.body.text).join('\n');
  assert.match(reply, /Created the task "Task fixture 1"/);
  assert.ok(!reply.includes(task.id));
  assert.doesNotMatch(reply, /\(ID task\)|\{"task_id"/);
  const run = (await a.request('/cli')).runsByProvider[provider].lastToolRun;
  assert.equal(run.lastTool, 'create_task');
  assert.equal(run.result, 'completed');
  assert.equal(run.errorCode, null);
});
