import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { after, mock, test } from 'node:test';
import { Hono } from 'hono';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-voice-apps-'));
let textRequests = 0;
let setupScenario = '';
let closing = false;
const modelBodies: any[] = [];
const upstream = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  res.setHeader('Content-Type', 'application/json');
  if (req.url?.endsWith('/realtime/client_secrets')) return res.end(JSON.stringify({ value: 'ephemeral-test', expires_at: Math.floor(Date.now() / 1000) + 300 }));
  if (closing) return res.end(JSON.stringify({ id: 'summary', output: [], output_text: '', usage: {} }));
  textRequests++;
  if (setupScenario) {
    modelBodies.push(body);
    const last = body.input?.at(-1);
    let prior: any = null;
    if (last?.type === 'function_call_output') {
      try { prior = JSON.parse(last.output); } catch { prior = { error: last.output }; }
    }
    const name = !prior ? 'SWARM_APPS_SEARCH' : prior.tools ? 'SWARM_APPS_EXECUTE' : null;
    const args = name === 'SWARM_APPS_SEARCH' ? { toolkit: 'github', query: 'verify repository', connectionId: 'github-alice' } : executeArgs(setupScenario);
    const item = name ? { type: 'function_call', id: `item-${textRequests}`, call_id: `setup-${textRequests}`, name, arguments: JSON.stringify(args) }
      : { type: 'message', id: `item-${textRequests}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Setup access check finished.', annotations: [] }] };
    const response = { id: `response-${textRequests}`, object: 'response', status: 'completed', model: body.model, output: [item], usage: { input_tokens: 1, output_tokens: 1 } };
    res.setHeader('Content-Type', 'text/event-stream');
    for (const event of [{ type: 'response.output_item.added', item },
      ...(name ? [] : [{ type: 'response.output_text.delta', delta: 'Setup access check finished.' }]),
      { type: 'response.output_item.done', item }, { type: 'response.completed', response }]) res.write(`data: ${JSON.stringify(event)}\n\n`);
    return res.end();
  }
  res.statusCode = 500;
  res.end(JSON.stringify({ error: 'Native app calls must not use a text model.' }));
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
const address = upstream.address();
assert.ok(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}/v1`;
Object.assign(process.env, {
  SWARM_ROLE: 'standalone', DB_PATH: path.join(tmp, 'test.db'), FILES_DIR: path.join(tmp, 'files'), SESSION_SECRET: 'test-only',
  APP_URL: base, SERVER_URL: base, COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: 'test-project', INKBOX_TUNNEL: '0',
  XAI_API_KEY: 'private-voice-key', XAI_BASE_URL: base, DIRECT_API_KEY: 'private-text-key', DIRECT_BASE_URL: base,
  DIRECT_MODEL: 'text-model-test', OPENROUTER_API_KEY: '', LLM_PROVIDER: 'direct',
});
const realFetch = globalThis.fetch;
mock.method(globalThis, 'fetch', async (input, init) => {
  const url = new URL(String(input));
  if (url.hostname === '127.0.0.1') return realFetch(input, init);
  if (url.hostname === 'registry.npmjs.org') return Response.json({ version: '0.28.0' });
  if (url.hostname === 'telemetry.composio.dev') return Response.json({});
  if (url.hostname === 'backend.composio.dev' && url.pathname.endsWith('/toolkits')) return Response.json({ items: ['github', 'slack'].map(slug => ({ slug, name: slug === 'github' ? 'GitHub' : 'Slack', meta: { categories: [] }, composio_managed_auth_schemes: ['OAUTH2'] })) });
  throw new Error(`Unexpected provider request to ${url.hostname}.`);
});
const { db } = await import('../server/src/db.js');
await import('../server/src/db-config.js');
const { initSubagents } = await import('../server/src/agent/subagents.js');
const { initRooms } = await import('../server/src/agent/rooms.js');
initSubagents(); initRooms();
const { composio, resetAppDiscovery } = await import('../server/src/composio.js');
const client = composio();
let accounts = [{ id: 'github-alice', toolkit: { slug: 'github' }, status: 'ACTIVE' }];
const parameters = { type: 'object', properties: { repo: { type: 'string' } }, required: ['repo'], additionalProperties: false };
const rawTool = (slug: string, tags: string[] = ['readOnlyHint']) => ({ slug, description: 'Verify repository access.', toolkit: { slug: 'github' }, version: '20261101_00', tags, inputParameters: parameters });
let discovered = [rawTool('GITHUB_GET_REPOSITORY')];
// Discovery pages are cached briefly per toolkit; drop the cache whenever the mocked provider list changes.
const setDiscovered = (tools: typeof discovered) => { discovered = tools; resetAppDiscovery(); };
let providerFailure = false;
let providerThrow = false;
const executed: any[] = [];
mock.method(client.connectedAccounts, 'list', async (input: any) => ({ items: input.userIds[0] === 'alice' ? accounts : [{ id: 'github-bob', toolkit: { slug: 'github' }, status: 'ACTIVE' }], nextCursor: null }));
mock.method(client.tools, 'getRawComposioTools', async () => discovered as any);
mock.method(client.tools, 'getRawComposioToolBySlug', async slug => discovered.find(t => t.slug === slug) as any);
mock.method(client.tools, 'execute', async (slug, input) => {
  executed.push({ slug, input });
  if (providerThrow) throw new Error('private provider error');
  return { data: { repository: 'alice/project', canRead: true }, successful: !providerFailure, error: null, logId: 'provider-log' };
});
const { createBot } = await import('../server/src/bots.js');
const { appendRow, updateRow, getLive } = await import('../server/src/store.js');
const { settleAgentJobs, resolveApproval, runInBotQueue, enqueue } = await import('../server/src/agent/loop.js');
const { voiceApi } = await import('../server/src/voice.js');
const { requireUser } = await import('../server/src/lib/auth.js');
const app = new Hono();
app.use('*', requireUser);
app.route('/voice', voiceApi);
for (const id of ['alice', 'bob']) {
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(id, `${id}@example.com`, id, Date.now());
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(session_hash(?),?,?,?)').run(id, id, Date.now(), Date.now() + 3600_000);
}
const chief = createBot('alice', { name: 'Quinn', isPrimary: true });
const configuring = createBot('alice', { name: 'GitHub Triage' });
const foreign = createBot('bob', { name: 'Private Bob' });
const post = (endpoint: string, body: unknown, user = 'alice') => app.request(`/voice/${endpoint}`, { method: 'POST', headers: { cookie: `swarm_session=${user}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const openCalls: any[] = [];
const session = async (botId = chief.id) => {
  const response = await post('session', { botId });
  assert.equal(response.status, 200);
  const call = { ...await response.json() as any, botId };
  openCalls.push(call);
  return call;
};
let nextExecuteId = 0;
const tool = async (call: any, name: string, args: unknown = {}, toolCallId?: string) => {
  const invocationId = toolCallId ?? (name === 'SWARM_APPS_EXECUTE' ? `execute-${++nextExecuteId}` : undefined);
  const response = await post('tool', { botId: call.botId, callId: call.callId, name, args, toolCallId: invocationId });
  assert.equal(response.status, 200);
  return response.json() as Promise<any>;
};
const updates = async (call: any) => (await post('updates', { botId: call.botId, callId: call.callId })).json() as Promise<any>;
const search = (call: any, connectionId = 'github-alice') => tool(call, 'SWARM_APPS_SEARCH', { toolkit: 'github', query: 'verify repository access', connectionId });
const executeArgs = (slug = 'GITHUB_GET_REPOSITORY') => ({ connectionId: 'github-alice', revision: 1, tool_slug: slug, arguments: { repo: 'alice/project' } });
after(async () => {
  await settleAgentJobs();
  assert.equal(textRequests, 6, 'only the two explicit text setup scenarios call a text model');
  closing = true;
  for (const call of openCalls) await post('end', { botId: call.botId, callId: call.callId });
  await new Promise(resolve => setTimeout(resolve, 100));
  await new Promise<void>(resolve => upstream.close(() => resolve()));
  mock.restoreAll(); db.close(); fs.rmSync(tmp, { recursive: true, force: true });
});

test('setup voice exposes native app tools and verifies existing GitHub access directly', async () => {
  const call = await session(configuring.id);
  for (const name of ['list_app_connections', 'search_apps', 'request_app_connection', 'SWARM_APPS_SEARCH', 'SWARM_APPS_EXECUTE']) assert.ok(call.tools.some((t: any) => t.name === name), name);
  assert.match(call.instructions, /provider-verified read-only checks/);
  const listed = JSON.parse((await tool(call, 'list_app_connections')).output);
  assert.deepEqual(listed.connections, [{ id: 'github-alice', toolkit: 'github', status: 'ACTIVE', revision: 1, isDefault: false }]);
  const found = JSON.parse((await search(call)).output);
  assert.deepEqual(found.tools, [{ slug: 'GITHUB_GET_REPOSITORY', description: 'Verify repository access.', parameters, readOnly: true }]);
  const before = executed.length;
  const result = JSON.parse((await tool(call, 'SWARM_APPS_EXECUTE', executeArgs(), 'setup-read')).output);
  assert.deepEqual(result, { repository: 'alice/project', canRead: true });
  assert.equal(executed.length, before + 1);
  assert.deepEqual(executed.at(-1).input, { userId: 'alice', connectedAccountId: 'github-alice', version: '20261101_00', arguments: { repo: 'alice/project' } });
  assert.equal(textRequests, 0);
});

test('discovery and execution reject unknown, foreign and stale account/tool selections', async () => {
  const call = await session();
  const before = executed.length;
  assert.match((await tool(call, 'SWARM_APPS_EXECUTE', executeArgs())).output, /Discover this tool/);
  assert.match((await search(call, 'github-bob')).output, /could not be completed/);
  await search(call);
  for (const patch of [{ connectionId: 'github-bob' }, { revision: 2 }, { tool_slug: 'COMPOSIO_PROXY_EXECUTE' }]) {
    assert.match((await tool(call, 'SWARM_APPS_EXECUTE', { ...executeArgs(), ...patch })).output, /Discover this tool/);
  }
  const invalid = await post('tool', { botId: chief.id, callId: call.callId, name: 'list_app_connections' }, 'bob');
  assert.equal(invalid.status, 404);
  accounts.push({ id: 'github-alice-work', toolkit: { slug: 'github' }, status: 'ACTIVE' });
  assert.match((await tool(call, 'SWARM_APPS_SEARCH', { toolkit: 'github', query: 'read repository' })).output, /could not be completed/);
  assert.equal(JSON.parse((await search(call, 'github-alice-work')).output).connectionId, 'github-alice-work');
  accounts.pop();
  assert.equal(executed.length, before);
});

test('setup refuses write and unknown metadata despite saved allow policy, and rechecks changed metadata', async () => {
  const call = await session(configuring.id);
  const before = executed.length;
  db.prepare("INSERT OR REPLACE INTO policies(user_id,tool,mode) VALUES('alice','GITHUB_GET_AND_DELETE','always_allow')").run();
  for (const tags of [[], ['destructiveHint'], ['readOnlyHint', 'updateHint']]) {
    setDiscovered([rawTool('GITHUB_GET_AND_DELETE', tags)]);
    await search(call);
    assert.match((await tool(call, 'SWARM_APPS_EXECUTE', executeArgs('GITHUB_GET_AND_DELETE'))).output, /Only provider-verified read-only/);
  }
  setDiscovered([rawTool('GITHUB_GET_REPOSITORY')]);
  await search(call);
  setDiscovered([rawTool('GITHUB_GET_REPOSITORY', ['updateHint'])]);
  assert.match((await tool(call, 'SWARM_APPS_EXECUTE', executeArgs(), 'changed-metadata')).output, /failed or its outcome is uncertain/);
  setDiscovered([rawTool('GITHUB_GET_REPOSITORY')]);
  assert.equal(executed.length, before);
  db.prepare("DELETE FROM policies WHERE user_id='alice' AND tool='GITHUB_GET_AND_DELETE'").run();
});

test('active voice write waits for exact approval, resumes once, and delivers the result through updates', async () => {
  const call = await session();
  setDiscovered([rawTool('GITHUB_CREATE_ISSUE', ['createHint'])]);
  await search(call);
  const before = executed.length;
  const args = executeArgs('GITHUB_CREATE_ISSUE');
  const [assigned, duplicate] = await Promise.all([
    tool(call, 'SWARM_APPS_EXECUTE', args, 'write-approved'),
    tool(call, 'SWARM_APPS_EXECUTE', args, 'write-approved'),
  ]);
  assert.deepEqual(duplicate, assigned);
  assert.ok(assigned.taskId);
  await settleAgentJobs();
  const waiting = await updates(call);
  assert.equal(waiting.tasks[0].status, 'waiting');
  const approval = waiting.approvals.find((a: any) => a.body.jobId === assigned.taskId);
  assert.ok(approval);
  assert.deepEqual(approval.body.args, args);
  assert.match(approval.body.detail, /alice\/project/);
  assert.equal(executed.length, before);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const holding = runInBotQueue(chief.id, () => gate);
  try {
    resolveApproval('alice', approval.body.approvalId, 'allow');
    assert.equal((await updates(call)).tasks[0].status, 'queued');
    release(); await holding; await settleAgentJobs();
    assert.equal(executed.length, before + 1);
    const done = await updates(call);
    assert.equal(done.tasks[0].status, 'completed');
    assert.ok(done.updates.some((u: any) => u.kind === 'message' && u.text.includes('alice/project')));
    assert.ok(!done.approvals.some((a: any) => a.body.approvalId === approval.body.approvalId));
    assert.deepEqual(await tool(call, 'SWARM_APPS_EXECUTE', args, 'write-approved'), assigned);
    assert.equal(executed.length, before + 1);
    const conflict = await post('tool', { botId: chief.id, callId: call.callId, name: 'SWARM_APPS_EXECUTE', args: { ...args, arguments: { repo: 'other' } }, toolCallId: 'write-approved' });
    assert.equal(conflict.status, 409);
  } finally { release(); await holding; setDiscovered([rawTool('GITHUB_GET_REPOSITORY')]); }
});

test('untrusted read-looking slugs require approval; denial and blocking never dispatch', async () => {
  const call = await session();
  setDiscovered([rawTool('GITHUB_GET_AND_DELETE', [])]);
  await search(call);
  const before = executed.length;
  const assigned = await tool(call, 'SWARM_APPS_EXECUTE', executeArgs('GITHUB_GET_AND_DELETE'), 'denied-write');
  await settleAgentJobs();
  const approval = (await updates(call)).approvals.find((a: any) => a.body.jobId === assigned.taskId);
  assert.ok(approval);
  resolveApproval('alice', approval.body.approvalId, 'deny');
  await settleAgentJobs();
  assert.ok((await updates(call)).updates.some((u: any) => u.text.includes('declined')));
  db.prepare("INSERT OR REPLACE INTO policies(user_id,tool,mode) VALUES('alice','GITHUB_GET_AND_DELETE','blocked')").run();
  assert.match((await tool(call, 'SWARM_APPS_EXECUTE', executeArgs('GITHUB_GET_AND_DELETE'), 'blocked-write')).output, /blocked/);
  assert.equal(executed.length, before);
  db.prepare("DELETE FROM policies WHERE user_id='alice' AND tool='GITHUB_GET_AND_DELETE'").run();
  setDiscovered([rawTool('GITHUB_GET_REPOSITORY')]);
});

test('SDK unsuccessful and uncertain responses are failures and duplicate call IDs do not retry', async () => {
  const call = await session();
  await search(call);
  const before = executed.length;
  providerFailure = true;
  const failed = await tool(call, 'SWARM_APPS_EXECUTE', executeArgs(), 'failed-read');
  assert.match(JSON.parse(failed.output).error, /failed operation/);
  assert.deepEqual(await tool(call, 'SWARM_APPS_EXECUTE', executeArgs(), 'failed-read'), failed);
  providerFailure = false; providerThrow = true;
  const uncertain = await tool(call, 'SWARM_APPS_EXECUTE', executeArgs(), 'uncertain-read');
  assert.match(uncertain.output, /outcome is uncertain/);
  assert.ok(!uncertain.output.includes('private provider error'));
  assert.deepEqual(await tool(call, 'SWARM_APPS_EXECUTE', executeArgs(), 'uncertain-read'), uncertain);
  providerThrow = false;
  assert.equal(executed.length, before + 2);
});

test('an approved SDK failure reaches the call and marks its durable dispatch and activity as failed', async () => {
  const call = await session();
  setDiscovered([rawTool('GITHUB_CREATE_ISSUE', ['createHint'])]);
  await search(call);
  const assigned = await tool(call, 'SWARM_APPS_EXECUTE', executeArgs('GITHUB_CREATE_ISSUE'), 'approved-failure');
  await settleAgentJobs();
  const approval = (await updates(call)).approvals.find((a: any) => a.body.jobId === assigned.taskId);
  providerFailure = true;
  try {
    resolveApproval('alice', approval.body.approvalId, 'allow');
    await settleAgentJobs();
    const dispatchId = `${call.callId}:approved-failure`;
    assert.equal((db.prepare('SELECT state FROM tool_dispatches WHERE bot_id=? AND call_id=?').get(chief.id, dispatchId) as any).state, 'uncertain');
    const activity = db.prepare("SELECT body FROM rows WHERE bot_id=? AND kind='tool-call' AND json_extract(body,'$.callId')=?").get(chief.id, dispatchId) as any;
    assert.equal(JSON.parse(activity.body).status, 'error');
    assert.ok((await updates(call)).updates.some((u: any) => u.kind === 'message' && u.text.includes('failed operation')));
  } finally { providerFailure = false; discovered = [rawTool('GITHUB_GET_REPOSITORY')]; }
});

test('voice connection actions reuse cards, reflect confirmation, and exclude another account', async () => {
  const call = await session(configuring.id);
  const args = { toolkit: 'slack', reason: 'Coordinate the requested team updates.' };
  const first = await tool(call, 'request_app_connection', args);
  const again = await tool(call, 'request_app_connection', args);
  assert.deepEqual(first.connectionRequest, again.connectionRequest);
  const request = first.connectionRequest;
  assert.equal(request.botId, configuring.id);
  appendRow(foreign.id, 'card', { type: 'card', card: 'connect', toolkit: 'github', toolkitName: 'Private GitHub', status: 'pending', reason: 'Private' });
  appendRow(foreign.id, 'card', { type: 'card', card: 'approval', approvalId: 'private-approval', title: 'Private action', tool: 'PRIVATE_TOOL', args: {}, status: 'pending' });
  const pending = await updates(call);
  assert.ok(pending.connectionRequests.some((r: any) => r.botId === request.botId && r.seq === request.seq));
  assert.ok(!JSON.stringify(pending).includes('Private'));
  const row = db.prepare('SELECT body FROM rows WHERE bot_id=? AND seq=?').get(request.botId, request.seq) as any;
  updateRow(request.botId, request.seq, { ...JSON.parse(row.body), status: 'connected' });
  accounts.push({ id: 'slack-alice', toolkit: { slug: 'slack' }, status: 'ACTIVE' });
  const confirmed = await updates(call);
  assert.ok(!confirmed.connectionRequests.some((r: any) => r.botId === request.botId && r.seq === request.seq));
  assert.ok(confirmed.updates.some((u: any) => u.text.includes('authorization was confirmed')));
  const result = JSON.parse((await tool(call, 'list_app_connections')).output);
  assert.ok(result.connections.some((c: any) => c.id === 'slack-alice' && c.status === 'ACTIVE'));
  assert.equal(JSON.parse((await tool(call, 'request_app_connection', args)).output).status, 'connected');
  accounts.pop();
});

for (const decision of ['allow', 'deny'] as const) {
  test(`two native writes preserve independent approvals when the first is ${decision === 'allow' ? 'approved' : 'denied'}`, async t => {
    const sameMillisecond = Date.now();
    t.mock.method(Date, 'now', () => sameMillisecond);
    const call = await session();
    setDiscovered([rawTool('GITHUB_CREATE_ISSUE', ['createHint'])]);
    await search(call);
    const firstArgs = { ...executeArgs('GITHUB_CREATE_ISSUE'), arguments: { repo: `alice/first-${decision}` } };
    const secondArgs = { ...executeArgs('GITHUB_CREATE_ISSUE'), arguments: { repo: `alice/second-${decision}` } };
    const firstId = `two-writes-${decision}-a`, secondId = `two-writes-${decision}-b`;
    const before = executed.length;
    try {
      const first = await tool(call, 'SWARM_APPS_EXECUTE', firstArgs, firstId);
      const second = await tool(call, 'SWARM_APPS_EXECUTE', secondArgs, secondId);
      assert.ok(first.taskId); assert.ok(second.taskId);
      assert.notEqual(first.taskId, second.taskId);
      await settleAgentJobs();

      const pending = await updates(call);
      assert.deepEqual(pending.tasks.map((task: any) => [task.id, task.status]), [[first.taskId, 'waiting'], [second.taskId, 'queued']]);
      const firstApproval = pending.approvals.find((approval: any) => approval.body.jobId === first.taskId);
      assert.ok(firstApproval, 'the first approval remains pending instead of expiring');
      assert.deepEqual(firstApproval.body.args, firstArgs);
      assert.ok(!pending.approvals.some((approval: any) => approval.body.jobId === second.taskId), 'the second operation has not requested approval yet');
      assert.equal((db.prepare('SELECT state FROM agent_jobs WHERE id=?').get(second.taskId) as any).state, 'queued');
      assert.equal(executed.length, before);

      resolveApproval('alice', firstApproval.body.approvalId, decision);
      await settleAgentJobs();
      const between = await updates(call);
      assert.deepEqual(between.tasks.map((task: any) => [task.id, task.status]), [[first.taskId, 'completed'], [second.taskId, 'waiting']], 'finishing A must not inherit B’s waiting state');
      const completedFirst = db.prepare("SELECT finished_at FROM agent_jobs WHERE bot_id=? AND json_extract(trigger,'$.parentJobId')=? ORDER BY rowid DESC LIMIT 1").get(chief.id, first.taskId) as { finished_at: number };
      assert.equal(completedFirst.finished_at, sameMillisecond);
      assert.equal(getLive(chief.id).awaiting?.since, sameMillisecond, 'A finishes in the exact millisecond that B starts waiting');
      assert.ok(!between.approvals.some((approval: any) => approval.body.approvalId === firstApproval.body.approvalId));
      const secondApproval = between.approvals.find((approval: any) => approval.body.jobId === second.taskId);
      assert.ok(secondApproval, 'the second operation receives its own approval after the first resolves');
      assert.notEqual(secondApproval.body.approvalId, firstApproval.body.approvalId);
      assert.deepEqual(secondApproval.body.args, secondArgs);
      assert.equal(executed.slice(before).filter(result => result.input.arguments.repo === firstArgs.arguments.repo).length, decision === 'allow' ? 1 : 0);
      assert.equal(executed.slice(before).filter(result => result.input.arguments.repo === secondArgs.arguments.repo).length, 0);

      resolveApproval('alice', secondApproval.body.approvalId, 'allow');
      resolveApproval('alice', secondApproval.body.approvalId, 'allow');
      await settleAgentJobs();
      const done = await updates(call);
      assert.deepEqual(done.tasks.map((task: any) => [task.id, task.status]), [[first.taskId, 'completed'], [second.taskId, 'completed']]);
      assert.ok(!done.approvals.some((approval: any) => [first.taskId, second.taskId].includes(approval.body.jobId)));
      assert.equal(executed.slice(before).filter(result => result.input.arguments.repo === secondArgs.arguments.repo).length, 1);
      assert.deepEqual(await tool(call, 'SWARM_APPS_EXECUTE', firstArgs, firstId), first);
      assert.deepEqual(await tool(call, 'SWARM_APPS_EXECUTE', secondArgs, secondId), second);
      await settleAgentJobs();
      assert.equal(executed.length, before + (decision === 'allow' ? 2 : 1), 'approval and stable-ID replays never dispatch either operation twice');
    } finally {
      // Drain through the public approval path even when an assertion fails so a
      // pending native operation cannot interfere with later scenarios.
      for (let i = 0; i < 3; i++) {
        await settleAgentJobs();
        const pending = db.prepare("SELECT id FROM approvals WHERE bot_id=? AND status='pending'").all(chief.id) as { id: string }[];
        if (!pending.length) break;
        for (const approval of pending) resolveApproval('alice', approval.id, 'deny');
      }
      await settleAgentJobs();
      setDiscovered([rawTool('GITHUB_GET_REPOSITORY')]);
    }
  });
}

test('native writes require a stable transport ID before dispatch and stable-ID retries execute once', async () => {
  const call = await session();
  setDiscovered([rawTool('GITHUB_CREATE_ISSUE', ['createHint'])]);
  await search(call);
  db.prepare("INSERT OR REPLACE INTO policies(user_id,tool,mode) VALUES('alice','GITHUB_CREATE_ISSUE','always_allow')").run();
  const args = executeArgs('GITHUB_CREATE_ISSUE');
  const before = executed.length;
  try {
    for (let i = 0; i < 2; i++) {
      const missing = await post('tool', { botId: call.botId, callId: call.callId, name: 'SWARM_APPS_EXECUTE', args });
      assert.equal(missing.status, 400);
      assert.equal(typeof (await missing.json() as any).error, 'string');
    }
    for (const toolCallId of ['', '   ']) {
      const blank = await post('tool', { botId: call.botId, callId: call.callId, name: 'SWARM_APPS_EXECUTE', args, toolCallId });
      assert.equal(blank.status, 400);
    }
    assert.equal(executed.length, before, 'missing or blank invocation IDs never reach the provider');
    const stableId = 'always-allow-stable-write';
    const [first, replay] = await Promise.all([
      tool(call, 'SWARM_APPS_EXECUTE', args, stableId),
      tool(call, 'SWARM_APPS_EXECUTE', args, stableId),
    ]);
    assert.deepEqual(replay, first);
    assert.equal(JSON.parse(first.output).repository, 'alice/project');
    assert.deepEqual(await tool(call, 'SWARM_APPS_EXECUTE', args, stableId), first);
    assert.equal(executed.length, before + 1);
    const dispatch = db.prepare('SELECT state FROM tool_dispatches WHERE bot_id=? AND call_id=?').get(chief.id, `${call.callId}:${stableId}`) as any;
    assert.equal(dispatch.state, 'completed');
  } finally {
    db.prepare("DELETE FROM policies WHERE user_id='alice' AND tool='GITHUB_CREATE_ISSUE'").run();
    setDiscovered([rawTool('GITHUB_GET_REPOSITORY')]);
  }
});

test('text setup receives discovery tools, verifies GitHub reads and refuses writes even with always-allow', async () => {
  assert.equal(textRequests, 0, 'native calls never use text planning');
  const before = executed.length;
  for (const [slug, tags] of [['GITHUB_GET_REPOSITORY', ['readOnlyHint']], ['GITHUB_GET_AND_DELETE', ['destructiveHint']]] as const) {
    const bot = createBot('alice', { name: `Setup ${slug}` });
    setDiscovered([rawTool(slug, [...tags])]);
    setupScenario = slug;
    db.prepare("INSERT OR REPLACE INTO policies(user_id,tool,mode) VALUES('alice',?,'always_allow')").run(slug);
    enqueue(bot.id, { type: 'user', text: 'Verify the repository access required for this setup.' });
    await settleAgentJobs();
    setupScenario = '';
    for (const body of modelBodies.splice(0)) {
      const names = body.tools.map((t: any) => t.name);
      for (const name of ['list_app_connections', 'search_apps', 'request_app_connection', 'SWARM_APPS_SEARCH', 'SWARM_APPS_EXECUTE']) assert.ok(names.includes(name), name);
      assert.ok(!names.includes('schedule_routine'));
      assert.ok(!names.includes('open_browser'));
    }
    if (slug === 'GITHUB_GET_AND_DELETE') {
      const rows = db.prepare("SELECT body FROM rows WHERE bot_id=? AND kind='tool-call'").all(bot.id) as any[];
      assert.ok(rows.some(r => JSON.parse(r.body).status === 'error'));
    }
    db.prepare("DELETE FROM policies WHERE user_id='alice' AND tool=?").run(slug);
  }
  assert.equal(executed.length, before + 1, 'only the verified read executes');
  setDiscovered([rawTool('GITHUB_GET_REPOSITORY')]);
});
