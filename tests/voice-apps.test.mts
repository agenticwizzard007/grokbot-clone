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
let expectedTextRequests = 0;
let setupScenario = '';
let connectionScenario: 'request' | 'verify' | undefined;
let activeScenario: { slug: string; step: number; calls: string[]; results: any[] } | undefined;
let rejectNextModelRequest = false;
const rejectedBodies: any[] = [];
let closing = false;
const modelBodies: any[] = [];
const upstream = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  res.setHeader('Content-Type', 'application/json');
  if (req.url?.endsWith('/realtime/client_secrets')) return res.end(JSON.stringify({ value: 'ephemeral-test', expires_at: Math.floor(Date.now() / 1000) + 300 }));
  if (closing) return res.end(JSON.stringify({ id: 'summary', output: [], output_text: '', usage: {} }));
  if (!body.stream) return res.end(JSON.stringify({ id: 'summary', output: [], output_text: '', usage: {} }));
  textRequests++;
  if (rejectNextModelRequest) {
    rejectNextModelRequest = false;
    rejectedBodies.push(body);
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: { message: 'Invalid tool schema', type: 'invalid_request_error' } }));
  }
  if (connectionScenario) {
    modelBodies.push(body);
    const last = body.input?.at(-1);
    const name = connectionScenario === 'request' ? 'request_app_connection' : last?.type === 'function_call_output' ? null : 'list_app_connections';
    const args = connectionScenario === 'request' ? { toolkit: 'slack', reason: 'Coordinate the requested team updates.' } : {};
    const text = `Connection status: ${last?.output ?? 'pending'}`;
    const item = name ? { type: 'function_call', id: `item-${textRequests}`, call_id: `connect-${textRequests}`, name, arguments: JSON.stringify(args) }
      : { type: 'message', id: `item-${textRequests}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
    const response = { id: `response-${textRequests}`, object: 'response', status: 'completed', model: body.model, output: [item], usage: { input_tokens: 1, output_tokens: 1 } };
    res.setHeader('Content-Type', 'text/event-stream');
    for (const event of [{ type: 'response.output_item.added', item }, ...(name ? [] : [{ type: 'response.output_text.delta', delta: text }]),
      { type: 'response.output_item.done', item }, { type: 'response.completed', response }]) res.write(`data: ${JSON.stringify(event)}\n\n`);
    return res.end();
  }
  if (activeScenario) {
    modelBodies.push(body);
    const last = body.input?.at(-1);
    let prior: any = null;
    if (last?.type === 'function_call_output') {
      try { prior = JSON.parse(last.output); } catch { prior = { error: last.output }; }
      activeScenario.results.push(prior);
    }
    const step = activeScenario.step++;
    const name = ['list_app_connections', 'SWARM_APPS_SEARCH', 'SWARM_APPS_EXECUTE'][step];
    let args: any = {};
    if (step === 1) args = { toolkit: 'github', connectionId: prior.connections[0].id, query: activeScenario.slug };
    if (step === 2) args = { connectionId: prior.connectionId, revision: prior.revision, tool_slug: prior.tools.find((t: any) => t.slug === activeScenario!.slug).slug, arguments: { repo: 'alice/project' } };
    if (name) activeScenario.calls.push(name);
    const executeCall = body.input?.filter((item: any) => item.type === 'function_call' && item.name === 'SWARM_APPS_EXECUTE').at(-1);
    const previousResult = executeCall && body.input?.find((item: any) => item.type === 'function_call_output' && item.call_id === executeCall.call_id);
    const text = step >= 4 ? `Earlier app result: ${previousResult?.output ?? 'missing'}` : `App result: ${JSON.stringify(prior)}`;
    const item = name ? { type: 'function_call', id: `item-${textRequests}`, call_id: `active-${textRequests}`, name, arguments: JSON.stringify(args) }
      : { type: 'message', id: `item-${textRequests}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
    const response = { id: `response-${textRequests}`, object: 'response', status: 'completed', model: body.model, output: [item], usage: { input_tokens: 1, output_tokens: 1 } };
    res.setHeader('Content-Type', 'text/event-stream');
    for (const event of [{ type: 'response.output_item.added', item },
      ...(name ? [] : [{ type: 'response.output_text.delta', delta: text }]),
      { type: 'response.output_item.done', item }, { type: 'response.completed', response }]) res.write(`data: ${JSON.stringify(event)}\n\n`);
    return res.end();
  }
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
let connectionReads = 0, discoveryReads = 0, metadataReads = 0;
mock.method(client.connectedAccounts, 'list', async (input: any) => { connectionReads++; return { items: input.userIds[0] === 'alice' ? accounts : [{ id: 'github-bob', toolkit: { slug: 'github' }, status: 'ACTIVE' }], nextCursor: null }; });
mock.method(client.tools, 'getRawComposioTools', async () => { discoveryReads++; return discovered as any; });
mock.method(client.tools, 'getRawComposioToolBySlug', async slug => { metadataReads++; return discovered.find(t => t.slug === slug) as any; });
mock.method(client.tools, 'execute', async (slug, input) => {
  executed.push({ slug, input });
  if (providerThrow) throw new Error('private provider error');
  return { data: { repository: 'alice/project', canRead: true }, successful: !providerFailure, error: null, logId: 'provider-log' };
});
const { createBot } = await import('../server/src/bots.js');
const { appendRow, updateRow, getLive, loadHistory } = await import('../server/src/store.js');
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
let nextTaskId = 0;
const tool = async (call: any, name: string, args: unknown = {}, toolCallId?: string, transcript?: { role: 'user' | 'assistant'; text: string }[]) => {
  const invocationId = toolCallId ?? (name === 'send_task' ? `send-task-${++nextTaskId}` : undefined);
  const response = await post('tool', { botId: call.botId, callId: call.callId, name, args, toolCallId: invocationId, transcript });
  assert.equal(response.status, 200);
  return response.json() as Promise<any>;
};
const updates = async (call: any) => (await post('updates', { botId: call.botId, callId: call.callId })).json() as Promise<any>;
const executeArgs = (slug = 'GITHUB_GET_REPOSITORY') => ({ connectionId: 'github-alice', revision: 1, tool_slug: slug, arguments: { repo: 'alice/project' } });
const native = (call: any, args: ReturnType<typeof executeArgs>, id: string, requireApproval = true, readOnly = false) => {
  const dispatchId = `${call.callId}:${id}`;
  return { taskId: enqueue(chief.id, { type: 'native-tool', name: 'SWARM_APPS_EXECUTE', args, callId: dispatchId, requireApproval, readOnly }), dispatchId };
};
const pendingApproval = async (call: any, taskId: string) => (await updates(call)).approvals.find((approval: any) => approval.body.jobId === taskId);
const jobState = (id: string) => (db.prepare('SELECT state FROM agent_jobs WHERE id=?').get(id) as any)?.state;
const counts = () => ({ connectionReads, discoveryReads, metadataReads, executed: executed.length,
  jobs: (db.prepare('SELECT count(*) n FROM agent_jobs').get() as any).n, textRequests });
after(async () => {
  await settleAgentJobs();
  closing = true;
  for (const call of openCalls) await post('end', { botId: call.botId, callId: call.callId });
  await new Promise(resolve => setTimeout(resolve, 100));
  await new Promise<void>(resolve => upstream.close(() => resolve()));
  mock.restoreAll(); db.close(); fs.rmSync(tmp, { recursive: true, force: true });
  assert.equal(textRequests, expectedTextRequests, 'only explicit chat scenarios call a text model');
});

test('active and setup voice sessions offer coordination but no direct external adapters', async () => {
  for (const botId of [chief.id, configuring.id]) {
    const call = await session(botId);
    const names = call.tools.map((tool: any) => tool.name);
    assert.ok(names.includes('send_task'));
    const send = call.tools.find((tool: any) => tool.name === 'send_task');
    assert.deepEqual(send.parameters.properties.mode.enum, ['task', 'follow_up']);
    for (const name of ['list_app_connections', 'search_apps', 'request_app_connection', 'SWARM_APPS_SEARCH', 'SWARM_APPS_EXECUTE']) assert.ok(!names.includes(name), name);
    assert.ok(!names.some((name: string) => name.startsWith('mcp_') || name.startsWith('COMPOSIO_')));
    assert.match(call.instructions, /send_task/);
    assert.doesNotMatch(call.instructions, /Call list_app_connections|Use SWARM_APPS_SEARCH|Then call SWARM_APPS_EXECUTE/);
  }
});

test('direct app and MCP names direct voice to send_task without dispatch, task creation or replay', async () => {
  const call = await session();
  const before = counts();
  for (const name of ['list_app_connections', 'search_apps', 'request_app_connection', 'SWARM_APPS_SEARCH', 'SWARM_APPS_EXECUTE', 'mcp_private_write', 'COMPOSIO_MULTI_EXECUTE_TOOL']) {
    const args = name === 'SWARM_APPS_EXECUTE' ? executeArgs() : { toolkit: 'github', query: 'Inspect repository', reason: 'Verify access' };
    const first = await tool(call, name, args, `legacy-${name}`);
    assert.match(first.output, /send_task/);
    assert.equal(first.taskId, undefined);
    assert.equal(first.connectionRequest, undefined);
    assert.deepEqual(await tool(call, name, args, `legacy-${name}`), first);
    assert.match((await tool(call, name, args)).output, /send_task/, 'A legacy name without an invocation ID still cannot dispatch');
  }
  await settleAgentJobs();
  assert.deepEqual(counts(), before);
  const invalid = await post('tool', { botId: chief.id, callId: call.callId, name: 'list_app_connections' }, 'bob');
  assert.equal(invalid.status, 404);
});

test('send_task requires a stable nonblank HTTP invocation ID before any work is accepted', async () => {
  const call = await session();
  const before = counts();
  for (const toolCallId of [undefined, '', '   ', '\t\n']) {
    const response = await post('tool', { botId: chief.id, callId: call.callId, name: 'send_task', args: { request: 'Read my connected repository.' }, toolCallId });
    assert.equal(response.status, 400);
    assert.equal(typeof (await response.json() as any).error, 'string');
  }
  for (const mode of ['replace', 'automatic', '']) {
    const rejected = await tool(call, 'send_task', { request: 'Do not enqueue invalid modes.', mode }, `bad-mode-${mode}`);
    assert.match(rejected.output, /invalid|schema/i);
  }
  await settleAgentJobs();
  assert.deepEqual(counts(), before);
});

test('tool and end transcripts enter normal chat context without enqueuing a task', async () => {
  const call = await session();
  const before = counts();
  const transcript = [
    { role: 'user' as const, text: 'Remember this spoken repository context for the next assignment.' },
    { role: 'assistant' as const, text: 'I will preserve that context in our conversation.' },
  ];
  const state = await tool(call, 'list_agents', {}, 'spoken-context', transcript);
  const history = JSON.stringify(loadHistory(chief.id));
  for (const line of transcript) assert.ok(history.includes(line.text));
  assert.deepEqual(await tool(call, 'list_agents', {}, 'spoken-context', transcript), state);
  assert.equal(JSON.stringify(loadHistory(chief.id)), history, 'An invocation replay cannot duplicate spoken context');
  const finalLine = { role: 'user' as const, text: 'Final spoken correction: keep the audit notes too.' };
  const ended = await post('end', { botId: chief.id, callId: call.callId, transcript: [...transcript, finalLine] });
  assert.equal(ended.status, 200);
  const after = JSON.stringify(loadHistory(chief.id));
  assert.ok(after.includes(finalLine.text));
  for (const line of transcript) assert.equal(after.split(line.text).length - 1, 1, 'The final transcript does not duplicate earlier context');
  await settleAgentJobs();
  assert.deepEqual(counts(), before);
});

test('persisted native-tool writes still await approval and publish their results to live voice', async () => {
  const call = await session();
  setDiscovered([rawTool('GITHUB_CREATE_ISSUE', ['createHint'])]);
  const before = executed.length;
  const args = executeArgs('GITHUB_CREATE_ISSUE');
  const assigned = native(call, args, 'persisted-approved');
  await settleAgentJobs();
  const approval = await pendingApproval(call, assigned.taskId);
  assert.ok(approval); assert.deepEqual(approval.body.args, args);
  assert.equal(executed.length, before);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const holding = runInBotQueue(chief.id, () => gate);
  try {
    resolveApproval('alice', approval.body.approvalId, 'allow');
    const resume = db.prepare("SELECT id FROM agent_jobs WHERE json_extract(trigger,'$.parentJobId')=? ORDER BY rowid DESC LIMIT 1").get(assigned.taskId) as any;
    assert.equal(jobState(resume.id), 'queued');
    release(); await holding; await settleAgentJobs();
    assert.equal(executed.length, before + 1); assert.equal(jobState(resume.id), 'completed');
    const done = await updates(call);
    assert.ok(done.updates.some((u: any) => u.kind === 'message' && u.text.includes('alice/project')));
    assert.ok(!done.approvals.some((a: any) => a.body.approvalId === approval.body.approvalId));
    resolveApproval('alice', approval.body.approvalId, 'allow');
    await settleAgentJobs(); assert.equal(executed.length, before + 1);
  } finally { release(); await holding; setDiscovered([rawTool('GITHUB_GET_REPOSITORY')]); }
});

test('persisted untrusted read-looking operations require approval and denial/blocking never dispatch', async () => {
  const call = await session();
  setDiscovered([rawTool('GITHUB_GET_AND_DELETE', [])]);
  const before = executed.length;
  try {
    const assigned = native(call, executeArgs('GITHUB_GET_AND_DELETE'), 'persisted-denied');
    await settleAgentJobs();
    const approval = await pendingApproval(call, assigned.taskId);
    assert.ok(approval);
    resolveApproval('alice', approval.body.approvalId, 'deny');
    await settleAgentJobs();
    assert.ok((await updates(call)).updates.some((u: any) => u.text.includes('declined')));
    db.prepare("INSERT OR REPLACE INTO policies(user_id,tool,mode) VALUES('alice','GITHUB_GET_AND_DELETE','blocked')").run();
    native(call, executeArgs('GITHUB_GET_AND_DELETE'), 'persisted-blocked');
    await settleAgentJobs(); assert.equal(executed.length, before);
  } finally {
    db.prepare("DELETE FROM policies WHERE user_id='alice' AND tool='GITHUB_GET_AND_DELETE'").run();
    setDiscovered([rawTool('GITHUB_GET_REPOSITORY')]);
  }
});

test('persisted failed/uncertain app dispatches cannot be replayed by re-enqueuing the same call ID', async () => {
  const call = await session();
  const before = executed.length;
  try {
    for (const failure of ['unsuccessful', 'uncertain'] as const) {
      providerFailure = failure === 'unsuccessful'; providerThrow = failure === 'uncertain';
      const id = `persisted-${failure}`;
      const assigned = native(call, executeArgs(), id, false, true);
      await settleAgentJobs();
      const dispatch = db.prepare('SELECT state FROM tool_dispatches WHERE bot_id=? AND call_id=?').get(chief.id, assigned.dispatchId) as any;
      assert.equal(dispatch.state, 'uncertain');
      const activity = db.prepare("SELECT body FROM rows WHERE bot_id=? AND kind='tool-call' AND json_extract(body,'$.callId')=? ORDER BY seq LIMIT 1").get(chief.id, assigned.dispatchId) as any;
      assert.equal(JSON.parse(activity.body).status, 'error');
      const afterFirst = executed.length;
      native(call, executeArgs(), id, false, true);
      await settleAgentJobs(); assert.equal(executed.length, afterFirst);
    }
    assert.equal(executed.length, before + 2);
    assert.ok((await updates(call)).updates.some((u: any) => u.kind === 'message' && u.text.includes('failed operation')));
  } finally { providerFailure = false; providerThrow = false; }
});

test('approved persisted SDK failure reaches voice and marks its durable dispatch/activity failed', async () => {
  const call = await session();
  setDiscovered([rawTool('GITHUB_CREATE_ISSUE', ['createHint'])]);
  const assigned = native(call, executeArgs('GITHUB_CREATE_ISSUE'), 'persisted-approved-failure');
  await settleAgentJobs();
  const approval = await pendingApproval(call, assigned.taskId);
  assert.ok(approval);
  providerFailure = true;
  try {
    resolveApproval('alice', approval.body.approvalId, 'allow'); await settleAgentJobs();
    assert.equal((db.prepare('SELECT state FROM tool_dispatches WHERE bot_id=? AND call_id=?').get(chief.id, assigned.dispatchId) as any).state, 'uncertain');
    const activity = db.prepare("SELECT body FROM rows WHERE bot_id=? AND kind='tool-call' AND json_extract(body,'$.callId')=?").get(chief.id, assigned.dispatchId) as any;
    assert.equal(JSON.parse(activity.body).status, 'error');
    assert.ok((await updates(call)).updates.some((u: any) => u.kind === 'message' && u.text.includes('failed operation')));
  } finally { providerFailure = false; setDiscovered([rawTool('GITHUB_GET_REPOSITORY')]); }
});

test('voice delegates connection requests to chat and receives owned confirmation cards/results', async () => {
  expectedTextRequests += 3;
  const call = await session();
  connectionScenario = 'request';
  try {
    const assigned = await tool(call, 'send_task', { bot_id: configuring.id, request: 'Connect Slack for the requested team updates.' });
    await settleAgentJobs();
    const pending = await updates(call);
    const request = pending.connectionRequests.find((r: any) => r.botId === configuring.id);
    assert.ok(request);
    const row = db.prepare('SELECT body FROM rows WHERE bot_id=? AND seq=?').get(request.botId, request.seq) as any;
    const card = JSON.parse(row.body);
    assert.equal(card.jobId, assigned.taskId);
    assert.equal(pending.tasks.find((task: any) => task.id === assigned.taskId).status, 'waiting');
    appendRow(foreign.id, 'card', { type: 'card', card: 'connect', toolkit: 'github', toolkitName: 'Private GitHub', status: 'pending', reason: 'Private' });
    appendRow(foreign.id, 'card', { type: 'card', card: 'approval', approvalId: 'private-approval', title: 'Private action', tool: 'PRIVATE_TOOL', args: {}, status: 'pending' });
    assert.ok(!JSON.stringify(await updates(call)).includes('Private'));
    updateRow(request.botId, request.seq, { ...card, status: 'connected' });
    accounts.push({ id: 'slack-alice', toolkit: { slug: 'slack' }, status: 'ACTIVE' });
    const confirmed = await updates(call);
    assert.ok(!confirmed.connectionRequests.some((r: any) => r.botId === request.botId && r.seq === request.seq));
    assert.ok(confirmed.updates.some((u: any) => u.text.includes('authorization was confirmed')));
    connectionScenario = 'verify';
    await tool(call, 'send_task', { bot_id: configuring.id, request: 'Verify the connected Slack account.', mode: 'follow_up' });
    await settleAgentJobs();
    const listed = loadHistory(configuring.id).filter(item => item.type === 'function_call_output').map(item => { try { return JSON.parse(item.output); } catch { return {}; } });
    assert.ok(listed.some(result => result.connections?.some((account: any) => account.id === 'slack-alice' && account.status === 'ACTIVE')));
  } finally { connectionScenario = undefined; accounts = accounts.filter(account => account.toolkit.slug !== 'slack'); modelBodies.length = 0; }
});

for (const decision of ['allow', 'deny'] as const) {
  test(`persisted native writes preserve independent approvals when the first is ${decision === 'allow' ? 'approved' : 'denied'}`, async t => {
    const sameMillisecond = Date.now();
    t.mock.method(Date, 'now', () => sameMillisecond);
    const call = await session();
    setDiscovered([rawTool('GITHUB_CREATE_ISSUE', ['createHint'])]);
    const firstArgs = { ...executeArgs('GITHUB_CREATE_ISSUE'), arguments: { repo: `alice/first-${decision}` } };
    const secondArgs = { ...executeArgs('GITHUB_CREATE_ISSUE'), arguments: { repo: `alice/second-${decision}` } };
    const before = executed.length;
    try {
      const first = native(call, firstArgs, `two-writes-${decision}-a`);
      const second = native(call, secondArgs, `two-writes-${decision}-b`);
      assert.notEqual(first.taskId, second.taskId);
      await settleAgentJobs();
      const pending = await updates(call);
      const firstApproval = pending.approvals.find((approval: any) => approval.body.jobId === first.taskId);
      assert.ok(firstApproval); assert.deepEqual(firstApproval.body.args, firstArgs);
      assert.ok(!pending.approvals.some((approval: any) => approval.body.jobId === second.taskId));
      assert.equal(jobState(second.taskId), 'queued'); assert.equal(executed.length, before);
      resolveApproval('alice', firstApproval.body.approvalId, decision); await settleAgentJobs();
      const between = await updates(call);
      assert.ok(!between.approvals.some((approval: any) => approval.body.approvalId === firstApproval.body.approvalId));
      const secondApproval = between.approvals.find((approval: any) => approval.body.jobId === second.taskId);
      assert.ok(secondApproval); assert.notEqual(secondApproval.body.approvalId, firstApproval.body.approvalId); assert.deepEqual(secondApproval.body.args, secondArgs);
      const completedFirst = db.prepare("SELECT state,finished_at FROM agent_jobs WHERE bot_id=? AND json_extract(trigger,'$.parentJobId')=? ORDER BY rowid DESC LIMIT 1").get(chief.id, first.taskId) as any;
      assert.equal(completedFirst.state, 'completed'); assert.equal(completedFirst.finished_at, sameMillisecond);
      assert.equal(getLive(chief.id).awaiting?.since, sameMillisecond);
      assert.equal(executed.slice(before).filter(result => result.input.arguments.repo === firstArgs.arguments.repo).length, decision === 'allow' ? 1 : 0);
      assert.equal(executed.slice(before).filter(result => result.input.arguments.repo === secondArgs.arguments.repo).length, 0);
      resolveApproval('alice', secondApproval.body.approvalId, 'allow'); resolveApproval('alice', secondApproval.body.approvalId, 'allow');
      await settleAgentJobs();
      const done = await updates(call);
      assert.ok(!done.approvals.some((approval: any) => [first.taskId, second.taskId].includes(approval.body.jobId)));
      assert.equal(executed.slice(before).filter(result => result.input.arguments.repo === secondArgs.arguments.repo).length, 1);
      const completedSecond = db.prepare("SELECT state FROM agent_jobs WHERE bot_id=? AND json_extract(trigger,'$.parentJobId')=? ORDER BY rowid DESC LIMIT 1").get(chief.id, second.taskId) as any;
      assert.equal(completedSecond.state, 'completed');
      assert.equal(executed.length, before + (decision === 'allow' ? 2 : 1));
    } finally {
      for (let i = 0; i < 3; i++) {
        await settleAgentJobs();
        const pending = db.prepare("SELECT id FROM approvals WHERE bot_id=? AND status='pending'").all(chief.id) as { id: string }[];
        if (!pending.length) break;
        for (const approval of pending) resolveApproval('alice', approval.id, 'deny');
      }
      await settleAgentJobs(); setDiscovered([rawTool('GITHUB_GET_REPOSITORY')]);
    }
  });
}

test('text setup receives discovery tools, verifies GitHub reads and refuses writes even with always-allow', async () => {
  expectedTextRequests += 6;
  const requestsBefore = textRequests;
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
  assert.equal(textRequests - requestsBefore, 6);
  setDiscovered([rawTool('GITHUB_GET_REPOSITORY')]);
});

for (const source of ['chat', 'voice delegation'] as const) {
  for (const [slug, tags, mutation] of [
    ['GITHUB_GET_REPOSITORY', ['readOnlyHint'], false],
    ['GITHUB_CREATE_ISSUE', ['createHint'], true],
    ['GITHUB_GET_AND_DELETE', ['destructiveHint'], true],
    ['GITHUB_GET_UNKNOWN', [], true],
    ['GITHUB_GET_CONFLICTING', ['readOnlyHint', 'updateHint'], true],
  ] as const) {
    test(`${source}: ${slug} lists a connection, discovers and ${mutation ? 'approves the action' : 'executes a verified read'}, then returns the result`, async () => {
      expectedTextRequests += 4;
      const bot = createBot('alice', { name: `${source} ${slug}` });
      db.prepare("UPDATE bot_setups SET onboarding_status='active' WHERE bot_id=?").run(bot.id);
      setDiscovered([rawTool(slug, [...tags])]);
      activeScenario = { slug, step: 0, calls: [], results: [] };
      const before = executed.length;
      const request = 'Use the already connected GitHub account to perform the requested repository task.';
      const args = { bot_id: bot.id, request };
      const invocationId = `delegate-active-${slug}`;
      const transcript = [
        { role: 'user' as const, text: `For ${slug}, use alice/project and preserve the repository context.` },
        { role: 'assistant' as const, text: 'I will ask the assigned agent to report the verified result.' },
      ];
      let call: any, jobId: string;
      let assigned: any;
      try {
        if (source === 'voice delegation') {
          call = await session();
          const jobsBefore = counts().jobs;
          const simultaneous = await Promise.all([
            tool(call, 'send_task', args, invocationId, transcript),
            tool(call, 'send_task', args, invocationId, transcript),
          ]);
          assigned = simultaneous[0];
          assert.deepEqual(simultaneous[1], assigned, 'Concurrent retries return the original assignment');
          jobId = assigned.taskId;
          assert.ok(jobId);
          assert.equal(counts().jobs, jobsBefore + 1, 'Concurrent retries enqueue exactly one assignment');
          assert.equal(JSON.parse((db.prepare('SELECT trigger FROM agent_jobs WHERE id=?').get(jobId) as any).trigger).voiceAssignment, true, 'Omitting mode creates an independent task');
          for (const changed of [{ ...args, request: `${request} Changed.` }, { ...args, mode: 'follow_up' }]) {
            const conflict = await post('tool', { botId: chief.id, callId: call.callId, name: 'send_task', args: changed, toolCallId: invocationId });
            assert.equal(conflict.status, 409, 'A stable ID cannot be reused for changed arguments');
          }
          const coordinatorHistory = JSON.stringify(loadHistory(chief.id));
          for (const line of transcript) assert.ok(coordinatorHistory.includes(line.text));
          assert.ok(coordinatorHistory.includes(`delegated to ${bot.name} (${bot.id})`));
          assert.ok(coordinatorHistory.includes(request));
        } else jobId = enqueue(bot.id, { type: 'user', text: request });
        await settleAgentJobs();
        if (mutation) {
          assert.equal(executed.length, before, 'no write executes before approval');
          const approval = db.prepare("SELECT id FROM approvals WHERE bot_id=? AND status='pending'").get(bot.id) as any;
          assert.ok(approval);
          if (call) {
            const pending = await updates(call);
            assert.equal(pending.tasks.find((t: any) => t.id === jobId).status, 'waiting');
            assert.ok(pending.approvals.some((a: any) => a.body.approvalId === approval.id));
          }
          resolveApproval('alice', approval.id, 'allow');
          await settleAgentJobs();
        }
        assert.deepEqual(activeScenario.calls, ['list_app_connections', 'SWARM_APPS_SEARCH', 'SWARM_APPS_EXECUTE']);
        assert.equal(activeScenario.results[0].connections[0].id, 'github-alice');
        assert.equal(activeScenario.results[1].tools[0].slug, slug);
        assert.deepEqual(activeScenario.results[2], { repository: 'alice/project', canRead: true });
        assert.equal(executed.length, before + 1);
        assert.equal(executed.at(-1).slug, slug);
        assert.equal(executed.at(-1).input.connectedAccountId, 'github-alice');
        const history = loadHistory(bot.id);
        const requestIndex = history.findIndex(item => item.role === 'user' && JSON.stringify(item).includes(request));
        assert.ok(requestIndex >= 0, 'The original request is durable model context');
        let previousIndex = requestIndex;
        for (const name of ['list_app_connections', 'SWARM_APPS_SEARCH', 'SWARM_APPS_EXECUTE']) {
          const callIndex = history.findIndex(item => item.type === 'function_call' && item.name === name);
          assert.ok(callIndex > previousIndex, `${name} follows the request and prior tool output`);
          const outputIndex = history.findIndex(item => item.type === 'function_call_output' && item.call_id === history[callIndex].call_id);
          assert.ok(outputIndex > callIndex, `${name} has a matched durable output`);
          previousIndex = outputIndex;
        }
        const executeOutput = history[previousIndex];
        assert.deepEqual(JSON.parse(executeOutput.output), { repository: 'alice/project', canRead: true });
        assert.ok(history.findIndex((item, i) => i > previousIndex && item.role === 'assistant' && JSON.stringify(item).includes('alice/project')) > previousIndex, 'The assistant result follows the app output');
        if (call) {
          for (const line of transcript) assert.ok(JSON.stringify(history).includes(line.text), 'The target receives the spoken context');
          for (const line of transcript) assert.ok(JSON.stringify(modelBodies[0].input).includes(line.text), 'Spoken context reaches the actual target model');
        }
        const reply = db.prepare("SELECT body FROM rows WHERE bot_id=? AND kind='message' AND json_extract(body,'$.role')='assistant' ORDER BY seq DESC LIMIT 1").get(bot.id) as any;
        assert.match(JSON.parse(reply.body).text, /alice\/project/);
        assert.equal(db.prepare("SELECT COUNT(*) n FROM rows WHERE bot_id=? AND kind='card' AND json_extract(body,'$.card')='connect'").get(bot.id).n, 0, 'already connected accounts never require new sign-in');
        for (const body of modelBodies.splice(0)) {
          const names = body.tools.map((t: any) => t.name);
          for (const name of ['list_app_connections', 'SWARM_APPS_SEARCH', 'SWARM_APPS_EXECUTE']) assert.ok(names.includes(name));
          assert.match(body.input[0].content, /Connected apps: github/);
        }
        if (call) {
          const done = await updates(call);
          assert.equal(done.tasks.find((t: any) => t.id === jobId).status, 'completed');
          assert.ok(done.updates.some((u: any) => u.botId === bot.id && u.kind === 'message' && u.text.includes('alice/project')));
          const beforeReplay = counts();
          assert.deepEqual(await tool(call, 'send_task', args, invocationId, transcript), assigned);
          await settleAgentJobs();
          assert.deepEqual(counts(), beforeReplay, 'Completed assignments cannot be dispatched again by replay');
          expectedTextRequests++;
          const followUp = { bot_id: bot.id, request: 'What was the earlier repository result?', mode: 'follow_up' };
          const follow = await tool(call, 'send_task', followUp, `${invocationId}-follow-up`);
          await settleAgentJobs();
          assert.notEqual(follow.taskId, jobId, 'A follow-up after completion has its own durable job');
          assert.equal(JSON.parse((db.prepare('SELECT trigger FROM agent_jobs WHERE id=?').get(follow.taskId) as any).trigger).voiceAssignment, false);
          const followInput = modelBodies.at(-1).input;
          assert.ok(followInput.some((item: any) => item.type === 'function_call' && item.name === 'SWARM_APPS_EXECUTE'));
          assert.ok(followInput.some((item: any) => item.type === 'function_call_output' && item.call_id === executeOutput.call_id && item.output === executeOutput.output), 'Follow-up receives the earlier app result');
          const followHistory = loadHistory(bot.id);
          assert.ok(followHistory.some(item => item.role === 'assistant' && JSON.stringify(item).includes('Earlier app result:') && JSON.stringify(item).includes('alice/project')));
          assert.equal(executed.length, before + 1, 'Answering from conversation history does not repeat the provider operation');
          const followDone = await updates(call);
          assert.equal(followDone.tasks.find((t: any) => t.id === follow.taskId).status, 'completed');
          assert.ok(followDone.updates.some((u: any) => u.botId === bot.id && u.kind === 'message' && u.text.includes('Earlier app result:')));
          const afterFollow = counts();
          assert.deepEqual(await tool(call, 'send_task', followUp, `${invocationId}-follow-up`), follow);
          await settleAgentJobs();
          assert.deepEqual(counts(), afterFollow);
        }
      } finally {
        activeScenario = undefined;
        modelBodies.length = 0;
        setDiscovered([rawTool('GITHUB_GET_REPOSITORY')]);
      }
    });
  }
}

test('a model HTTP400 retries without custom MCP schemas while retaining all native app schemas', async () => {
  expectedTextRequests += 5;
  const bot = createBot('alice', { name: 'App schema fallback', isPrimary: true });
  const { saveMcpServer, mcpToolName } = await import('../server/src/mcp/store.js');
  const server = saveMcpServer('alice', { name: 'Invalid custom schema fixture', transport: 'http', url: 'https://mcp.example.test', botIds: [bot.id] });
  db.prepare('UPDATE mcp_servers SET tools=?,checked_at=? WHERE id=?').run(JSON.stringify([{ name: 'bad_tool', inputSchema: { type: 'object' } }]), Date.now(), server.id);
  const customName = mcpToolName(server, 'bad_tool');
  activeScenario = { slug: 'GITHUB_GET_REPOSITORY', step: 0, calls: [], results: [] };
  rejectNextModelRequest = true;
  const before = executed.length;
  try {
    enqueue(bot.id, { type: 'user', text: 'Read the repository using the existing connected app.' });
    await settleAgentJobs();
    const rejected = rejectedBodies.pop();
    assert.ok(rejected.tools.some((t: any) => t.name === customName));
    assert.deepEqual(modelBodies[0].tools, rejected.tools.filter((t: any) => t.name !== customName), 'retry removes only custom MCP tools');
    for (const name of ['list_app_connections', 'search_apps', 'request_app_connection', 'SWARM_APPS_SEARCH', 'SWARM_APPS_EXECUTE']) assert.ok(modelBodies[0].tools.some((t: any) => t.name === name));
    assert.equal(executed.length, before + 1);
    assert.deepEqual(activeScenario.results.at(-1), { repository: 'alice/project', canRead: true });
  } finally {
    activeScenario = undefined; modelBodies.length = 0;
    db.prepare('DELETE FROM mcp_servers WHERE id=?').run(server.id);
  }
});

test('a model HTTP400 without custom MCP tools fails visibly instead of silently removing app access', async () => {
  expectedTextRequests += 1;
  const bot = createBot('alice', { name: 'Native schema error', isPrimary: true });
  activeScenario = { slug: 'GITHUB_GET_REPOSITORY', step: 0, calls: [], results: [] };
  rejectNextModelRequest = true;
  const before = executed.length;
  try {
    const jobId = enqueue(bot.id, { type: 'user', text: 'Read the repository.' });
    await settleAgentJobs();
    const rejected = rejectedBodies.pop();
    assert.ok(rejected.tools.some((t: any) => t.name === 'SWARM_APPS_SEARCH'));
    assert.equal(modelBodies.length, 0, 'no reduced-schema retry');
    assert.equal((db.prepare('SELECT state FROM agent_jobs WHERE id=?').get(jobId) as any).state, 'uncertain');
    assert.equal(executed.length, before);
    const notices = db.prepare("SELECT body FROM rows WHERE bot_id=? AND kind='notice'").all(bot.id) as any[];
    assert.ok(notices.some(row => JSON.parse(row.body).text.includes('Invalid tool schema')));
  } finally { activeScenario = undefined; modelBodies.length = 0; }
});
