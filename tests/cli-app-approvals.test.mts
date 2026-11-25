import assert from 'node:assert/strict';
import { after, beforeEach, test, mock } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Hono } from 'hono';
import { WebSocket } from 'ws';
import { emailBody, emailArgs, installFakeCli } from './fixtures/cli-apps-runner.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-app-approvals-'));
const executable = installFakeCli(root);
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
const { listRows } = await import('../server/src/store.js');
const { approvalBinding } = await import('../server/src/security/approval.js');
const { saveMcpServer } = await import('../server/src/mcp/store.js');
const { selectCli, createCliPairing } = await import('../server/src/cli/store.js');
const { attachCliSocket, cliStatus, disconnectCli } = await import('../server/src/cli/bridge.js');
const { startBridge } = await import('../companion/cli-bridge.mjs');
const app = new Hono().route('/api', api);
const server = createServer(); attachCliSocket(server);
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const address = server.address(); assert.ok(address && typeof address !== 'string');
let serial = 0;
const audit = () => fs.existsSync(path.join(root, 'audit.jsonl')) ? fs.readFileSync(path.join(root, 'audit.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
beforeEach(() => { state.connected = true; state.unavailable = false; state.executions.length = 0; state.external.length = 0; fs.rmSync(path.join(root, 'audit.jsonl'), { force: true }); });
after(async () => { await settleAgentJobs(); await new Promise<void>(resolve => server.close(() => resolve())); mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

async function account(t: any, provider: 'codex' | 'claude', runtime: 'hosted' | 'companion') {
  const userId = `fixture-${++serial}`;
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(userId, `${userId}@example.test`, 'Fixture account', Date.now());
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(session_hash(?),?,?,?)').run(userId, userId, Date.now(), Date.now() + 3600000);
  const bot = createBot(userId, { name: 'CLI fixture', isPrimary: true });
  selectCli(userId, provider);
  db.prepare('UPDATE bots SET model=? WHERE id=?').run(`${provider}/default`, bot.id);
  const events: any[] = [];
  const unsubscribe = hub.subscribe(userId, event => events.push(event));
  const controller = new AbortController();
  let bridge: Promise<unknown> | undefined;
  if (runtime === 'companion') {
    bridge = startBridge({ server: `http://127.0.0.1:${address.port}`, token: createCliPairing(userId), codexPath: executable, claudePath: executable,
      env: { PATH: process.env.PATH, HOME: root }, signal: controller.signal, WebSocketImpl: WebSocket });
    for (let n = 0; n < 500 && !cliStatus(userId).connected; n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(cliStatus(userId).connected, true);
  }
  t.after(async () => { controller.abort(); disconnectCli(userId); await bridge; unsubscribe(); assert.deepEqual(state.external, []); });
  const request = async (url: string, body?: unknown) => {
    const r = await app.request(`/api${url}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: `swarm_session=${userId}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(r.status, 200, `${url}: ${await r.clone().text()}`); return r.json() as Promise<any>;
  };
  const chat = async (text: string) => { await request(`/bots/${bot.id}/messages`, { text }); await runInBotQueue(bot.id, async () => {}); };
  return { userId, bot, request, chat, events, rows: () => listRows(bot.id) as any[] };
}

for (const provider of ['codex', 'claude'] as const) for (const runtime of ['hosted', 'companion'] as const) {
  for (const action of ['create draft', 'send email']) test(`${provider} ${runtime}: Gmail ${action} persists an approval, emits SSE, delivers pending to the CLI and denial blocks execution`, { timeout: 30000 }, async t => {
    const a = await account(t, provider, runtime);
    await a.chat(`Please ${action} in Gmail with 16 lines.`);
    const card = a.rows().find(r => r.body.card === 'approval');
    assert.ok(card, JSON.stringify(a.rows()));
    const approval: any = db.prepare('SELECT * FROM approvals WHERE id=?').get(card.body.approvalId);
    const slug = action === 'create draft' ? 'GMAIL_CREATE_EMAIL_DRAFT' : 'GMAIL_SEND_EMAIL';
    assert.equal(card.body.args.tool_slug, slug);
    assert.deepEqual(card.body.args.arguments, emailArgs);
    assert.equal(card.body.args.arguments.body.split('\n').length, 16);
    assert.equal(approval.binding_hash, approvalBinding(a.userId, a.bot.id, approval.call_id, 'SWARM_APPS_EXECUTE', card.body.args));
    assert.ok(a.events.some(e => e.type === 'rows' && e.rows.some((r: any) => r.body.approvalId === approval.id && r.body.status === 'pending')));
    const events = audit();
    const names = events.find(e => e.kind === 'manifest').names;
    for (const name of ['list_app_connections', 'request_app_connection', 'SWARM_APPS_SEARCH', 'SWARM_APPS_EXECUTE', 'tool_search', 'tool_describe', 'tool_call']) assert.ok(names.includes(name), name);
    const pending = events.find(e => e.kind === 'result' && e.name === 'SWARM_APPS_EXECUTE');
    assert.equal(JSON.parse(pending.reply.content[0].text).approvalId, approval.id);
    assert.equal(JSON.parse(pending.reply.content[0].text).status, 'pending_approval');
    assert.match(pending.reply.content[1].text, /Stop.*wait/);
    assert.equal(a.rows().filter(r => r.body.card === 'approval').length, 1);
    assert.equal(state.executions.length, 0);
    await a.request(`/approvals/${approval.id}`, { decision: 'deny' });
    await runInBotQueue(a.bot.id, async () => {});
    assert.equal(state.executions.length, 0);
    assert.equal(a.rows().find(r => r.seq === card.seq).body.status, 'denied');
    assert.equal(a.rows().filter(r => r.body.card === 'approval').length, 1);
    assert.ok(a.rows().some(r => r.body.text?.includes('Nothing was sent or saved')));
    await a.request(`/approvals/${approval.id}`, { decision: 'allow' });
    await runInBotQueue(a.bot.id, async () => {});
    assert.equal(state.executions.length, 0, 'A later allow cannot reverse denial');
  });

  test(`${provider} ${runtime}: no Gmail connection produces the Connect card, not an approval or fake draft`, { timeout: 30000 }, async t => {
    state.connected = false;
    const a = await account(t, provider, runtime);
    await a.chat('Create a draft in Gmail.');
    const card = a.rows().find(r => r.body.card === 'connect');
    assert.ok(card, JSON.stringify(a.rows()));
    assert.match(card.body.reason, /Gmail is not connected/);
    assert.ok(a.events.some(e => e.type === 'rows' && e.rows.some((r: any) => r.seq === card.seq && r.body.card === 'connect')));
    assert.equal(a.rows().filter(r => ['approval', 'draft'].includes(r.body.card)).length, 0);
    assert.equal(state.executions.length, 0);
    const result = audit().find(e => e.kind === 'result' && e.name === 'SWARM_APPS_SEARCH');
    assert.match(result.reply.content[0].text, /No action approval has been requested/);
  });

  test(`${provider} ${runtime}: voice delegates to CLI main chat with the same persisted approval and denial`, { timeout: 30000 }, async t => {
    const a = await account(t, provider, runtime);
    const call = await a.request('/voice/session', { botId: a.bot.id });
    const payload = { botId: a.bot.id, callId: call.callId, name: 'send_task', args: { request: 'Create a Gmail draft with 16 lines.' }, toolCallId: 'voice-cli-fixture' };
    const assigned = await a.request('/voice/tool', payload);
    await runInBotQueue(a.bot.id, async () => {});
    const card = a.rows().find(r => r.body.card === 'approval');
    assert.ok(card); assert.equal(card.body.jobId, assigned.taskId);
    assert.deepEqual(await a.request('/voice/tool', payload), assigned);
    assert.equal(a.rows().filter(r => r.body.card === 'approval').length, 1);
    await a.request(`/approvals/${card.body.approvalId}`, { decision: 'deny' });
    await runInBotQueue(a.bot.id, async () => {});
    const updates = await a.request('/voice/updates', { botId: a.bot.id, callId: call.callId, after: 0 });
    assert.ok(updates.updates.some((u: any) => u.text.includes('declined in chat')));
    assert.equal(state.executions.length, 0);
    await a.request('/voice/end', { botId: a.bot.id, callId: call.callId });
  });

  test(`${provider} ${runtime}: CLI parsing preserves all 16 reply lines`, { timeout: 30000 }, async t => {
    const a = await account(t, provider, runtime); await a.chat('Return a plain reply with 16 lines.');
    assert.equal(a.rows().find(r => r.body.role === 'assistant')?.body.text, emailBody);
  });
}

for (const [toolkit, slug] of [['slack', 'SLACK_SEND_MESSAGE'], ['calendar', 'GOOGLECALENDAR_CREATE_EVENT']]) test(`CLI discovers ${toolkit} mid-run and uses the shared app approval`, { timeout: 30000 }, async t => {
  const a = await account(t, 'codex', 'hosted'); await a.chat(`Use fixture ${toolkit}.`);
  const card = a.rows().find(r => r.body.card === 'approval');
  assert.equal(card?.body.args.tool_slug, slug);
  assert.equal(state.executions.length, 0);
  await a.request(`/approvals/${card.body.approvalId}`, { decision: 'allow' });
  await runInBotQueue(a.bot.id, async () => {});
  assert.equal(state.executions.length, 1);
  assert.equal(state.executions[0].slug, slug);
});

for (const provider of ['codex', 'claude'] as const) test(`${provider}: deferred MCP tools discovered mid-run retain approval and denial checks`, { timeout: 30000 }, async t => {
  const a = await account(t, provider, 'hosted');
  const mcp = saveMcpServer(a.userId, { name: 'Fixture MCP', transport: 'http', url: 'https://mcp.fixture.test/mcp', botIds: [a.bot.id], requireApproval: true });
  db.prepare('UPDATE mcp_servers SET tools=? WHERE id=?').run(JSON.stringify([{ name: 'fixture_lookup', description: 'Fixture lookup', inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false } }]), mcp.id);
  await a.chat('Use fixture mcp lookup.');
  const card = a.rows().find(r => r.body.card === 'approval');
  assert.ok(card); assert.match(card.body.tool, /^mcp_/);
  assert.equal(audit().find(e => e.kind === 'manifest').names.some((name: string) => name.startsWith('mcp_')), false, 'MCP schema is deferred from the bounded initial manifest');
  assert.equal(JSON.parse(audit().find(e => e.kind === 'result' && e.name === 'tool_call').reply.content[0].text).approvalId, card.body.approvalId);
  await a.request(`/approvals/${card.body.approvalId}`, { decision: 'deny' });
  await runInBotQueue(a.bot.id, async () => {});
  assert.deepEqual(state.external, [], 'Denied MCP tool must not open its remote endpoint');
});

for (const provider of ['codex', 'claude'] as const) test(`${provider}: a saved blocked Gmail policy never creates an approval or executes`, { timeout: 30000 }, async t => {
  const a = await account(t, provider, 'hosted');
  db.prepare('INSERT INTO policies(user_id,tool,mode) VALUES(?,?,?)').run(a.userId, 'GMAIL_CREATE_EMAIL_DRAFT', 'blocked');
  await a.chat('Create a draft in Gmail.');
  assert.equal(a.rows().filter(r => r.body.card === 'approval').length, 0);
  assert.equal(state.executions.length, 0);
  const result = audit().find(e => e.kind === 'result' && e.name === 'SWARM_APPS_EXECUTE');
  assert.match(result.reply.content[0].text, /declined/);
  assert.equal(result.reply.isError, true);
});

test('a stale Gmail execution with no connected account produces a Connect card before approval', { timeout: 30000 }, async t => {
  state.connected = false;
  const a = await account(t, 'codex', 'hosted'); await a.chat('Create a draft using the stale account.');
  assert.equal(a.rows().filter(r => r.body.card === 'approval').length, 0);
  assert.ok(a.rows().some(r => r.body.card === 'connect' && /Gmail is not connected/.test(r.body.reason)));
  assert.equal(state.executions.length, 0);
  assert.match(audit().find(e => e.kind === 'result' && e.name === 'SWARM_APPS_EXECUTE').reply.content[0].text, /No action approval has been requested/);
});

test('unavailable app status does not claim Gmail is disconnected or create a Connect or approval card', { timeout: 30000 }, async t => {
  state.unavailable = true;
  const a = await account(t, 'codex', 'hosted'); await a.chat('Create a draft using the stale account.');
  assert.equal(a.rows().filter(r => ['connect', 'approval'].includes(r.body.card)).length, 0);
  assert.equal(state.executions.length, 0);
  assert.match(audit().find(e => e.kind === 'result' && e.name === 'SWARM_APPS_EXECUTE').reply.content[0].text, /could not be confirmed/);
});
