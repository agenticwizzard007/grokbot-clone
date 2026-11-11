import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { Hono } from 'hono';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-voice-coordinator-'));
let toolSequence = 0;
const modelInputs: any[][] = [];
let summaryGate: Promise<void> | undefined;
let summaryStarted: (() => void) | undefined;
const upstream = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  if (req.url?.endsWith('/realtime/client_secrets')) {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ value: 'ephemeral-test', expires_at: Math.floor(Date.now() / 1000) + 300 }));
  }
  if (!body.stream && JSON.stringify(body.input).includes('held-summary-context')) {
    summaryStarted?.();
    await summaryGate;
  }
  if (body.stream) modelInputs.push(body.input);
  const text = 'Finished the requested research; findings are ready.';
  const lastInput = body.input?.at(-1);
  const scenario = lastInput?.role === 'user' ? String(lastInput.content) : '';
  const item = scenario.includes('question scenario') || scenario.includes('approval scenario')
    ? { id: `tool-${++toolSequence}`, type: 'function_call', call_id: `call-${toolSequence}`, name: scenario.includes('question scenario') ? 'ask_user' : 'TEST_WRITE', arguments: JSON.stringify(scenario.includes('question scenario') ? { question: 'Which region?', options: ['Europe', 'Asia'] } : {}) }
    : { id: 'msg-test', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
  const response = { id: 'resp-test', object: 'response', model: body.model, status: 'completed', output: [item], output_text: text, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
  if (!body.stream) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(response)); }
  res.setHeader('Content-Type', 'text/event-stream');
  for (const event of [
    { type: 'response.output_item.added', item },
    ...(item.type === 'message' ? [{ type: 'response.output_text.delta', delta: text }] : []),
    { type: 'response.output_item.done', item },
    { type: 'response.completed', response },
  ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.end();
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
const address = upstream.address();
assert.ok(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}/v1`;
Object.assign(process.env, {
  DB_PATH: path.join(tmp, 'test.db'), FILES_DIR: path.join(tmp, 'files'), SESSION_SECRET: 'test-only',
  APP_URL: base, SERVER_URL: base, COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '', INKBOX_TUNNEL: '0',
  XAI_API_KEY: 'private-voice-key', XAI_BASE_URL: base,
  DIRECT_API_KEY: 'private-text-key', DIRECT_BASE_URL: base, DIRECT_MODEL: 'text-model-test',
  OPENROUTER_API_KEY: '', LLM_PROVIDER: 'direct',
});
const { db } = await import('../server/src/db.js');
await import('../server/src/db-config.js');
const { initSubagents } = await import('../server/src/agent/subagents.js');
const { initRooms } = await import('../server/src/agent/rooms.js');
initSubagents(); initRooms();
const { createBot } = await import('../server/src/bots.js');
const { appendRow, updateRow, loadHistory, clearConversation } = await import('../server/src/store.js');
const { runInBotQueue, settleAgentJobs, resolveApproval, enqueue } = await import('../server/src/agent/loop.js');
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
const researcher = createBot('alice', { name: 'Researcher' });
const foreign = createBot('bob', { name: 'Private Bob' });
// This fixture represents an already activated specialist.
db.prepare("UPDATE bot_setups SET onboarding_status='active' WHERE bot_id=?").run(researcher.id);
const post = (user: string, endpoint: string, body: unknown) => app.request(`/voice/${endpoint}`, { method: 'POST', headers: { cookie: `swarm_session=${user}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const session = async (botId = chief.id, user = 'alice') => {
  const response = await post(user, 'session', { botId });
  assert.equal(response.status, 200);
  return response.json();
};
const tool = (callId: string, name: string, args: unknown = {}, toolCallId?: string) => post('alice', 'tool', { botId: chief.id, callId, name, args, toolCallId });
const updates = async (callId: string, after = 0) => (await post('alice', 'updates', { botId: chief.id, callId, after })).json();
const close = (callId: string) => post('alice', 'end', { botId: chief.id, callId });
after(async () => {
  await settleAgentJobs();
  // Summaries run after /end; all tests end calls without requesting remote summaries except one
  // queued-task test, whose summary request is allowed to drain before closing the mock.
  await new Promise(resolve => setTimeout(resolve, 150));
  await new Promise<void>(resolve => upstream.close(() => resolve()));
  db.close(); fs.rmSync(tmp, { recursive: true, force: true });
});

test('session has native coordinator tools and distinguishes live voice from text configuration', async () => {
  const call = await session();
  const names = call.tools.map((t: any) => t.name);
  for (const name of ['get_platform_state', 'list_agents', 'get_agent', 'create_bot', 'update_agent', 'control_agent', 'send_task']) assert.ok(names.includes(name), name);
  assert.match(call.instructions, /native master coordinator/);
  assert.match(call.instructions, /Never open Swarm in a browser/);
  const state = JSON.parse((await (await tool(call.callId, 'get_platform_state')).json()).output);
  assert.equal(state.llm.provider, 'direct');
  assert.equal(state.activeVoiceSession.provider, 'xai');
  assert.equal(state.activeVoiceSession.model, call.model);
  assert.equal(state.usage.scope, 'account');
  assert.ok(!JSON.stringify(state).includes('private-voice-key'));
  assert.ok(!JSON.stringify(state).includes('private-text-key'));
  await close(call.callId);
});

test('tool and update endpoints require the exact account and call bot, including read tools', async () => {
  const call = await session();
  for (const endpoint of ['tool', 'updates']) {
    const body = { botId: chief.id, callId: call.callId, name: 'get_platform_state', after: 0 };
    assert.equal((await post('bob', endpoint, body)).status, 404);
    assert.equal((await post('alice', endpoint, { ...body, botId: researcher.id })).status, 404);
    assert.equal((await post('alice', endpoint, { ...body, callId: 'unknown' })).status, 404);
  }
  for (const name of ['get_platform_state', 'recall_text_messages', 'peek_activity', 'send_task']) {
    const response = await (await tool(call.callId, name, { bot_id: foreign.id, request: 'Read private messages.' }, `isolation-${name}`)).json();
    assert.match(response.output, /could not be completed/);
    assert.ok(!response.output.includes('Private Bob'));
  }
  await close(call.callId);
  assert.equal((await tool(call.callId, 'list_agents')).status, 404);
});

test('team feed receives finalized replies, inputs and questions from unopened chats exactly once', async () => {
  const call = await session();
  const row = appendRow(researcher.id, 'message', { type: 'message', role: 'assistant', text: 'Partial', streaming: true });
  appendRow(foreign.id, 'message', { type: 'message', role: 'assistant', text: 'Never disclose this.' });
  assert.deepEqual((await updates(call.callId)).updates, []);
  updateRow(researcher.id, row.seq, { type: 'message', role: 'assistant', text: 'Research findings.', streaming: false });
  updateRow(researcher.id, row.seq, { type: 'message', role: 'assistant', text: 'Research findings.', streaming: false });
  appendRow(researcher.id, 'message', { type: 'message', role: 'user', text: 'Please check the sources.', from: { kind: 'bot', id: chief.id, name: 'Quinn' } });
  const question = appendRow(researcher.id, 'card', { type: 'card', card: 'question', status: 'pending', question: 'Which region?', options: [] });
  const feed = await updates(call.callId);
  assert.deepEqual(feed.updates.map((u: any) => u.kind), ['message', 'input', 'waiting']);
  assert.ok(feed.updates.every((u: any) => u.botId === researcher.id && u.botName === 'Researcher'));
  assert.deepEqual((await updates(call.callId, feed.cursor)).updates, []);
  assert.deepEqual((await updates(call.callId)).updates, feed.updates, 'replay is safe after a lost response');
  updateRow(researcher.id, question.seq, { ...question.body, status: 'dismissed' } as any);
  await close(call.callId);
});

test('delegation targets any owned agent, is idempotent, and an unrelated reply does not finish queued work', async () => {
  const call = await session();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const holding = runInBotQueue(researcher.id, () => gate);
  try {
    const args = { bot_id: researcher.id, request: 'Research three sources.' };
    const [a, b] = await Promise.all([tool(call.callId, 'send_task', args, 'delegate-1'), tool(call.callId, 'send_task', args, 'delegate-1')]);
    const result = await a.json();
    assert.deepEqual(await b.json(), result);
    assert.equal(result.taskBotId, researcher.id); assert.ok(result.taskId);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM agent_jobs WHERE bot_id=?').get(researcher.id) as any).n, 1);
    assert.equal((await tool(call.callId, 'send_task', { ...args, request: 'Different' }, 'delegate-1')).status, 409);
    appendRow(researcher.id, 'message', { type: 'message', role: 'assistant', text: 'A reply to older work.' });
    const feed = await updates(call.callId);
    assert.equal(feed.tasks[0].status, 'queued');
    assert.equal(feed.tasks[0].id, result.taskId);
    release(); await holding; await settleAgentJobs();
    const complete = await updates(call.callId);
    assert.equal(complete.tasks[0].status, 'completed');
    assert.ok(complete.updates.some((u: any) => u.text.includes('findings are ready')));
    assert.equal((db.prepare('SELECT user_id FROM agent_jobs WHERE id=?').get(result.taskId) as any).user_id, 'alice');
  } finally { release(); await holding; await settleAgentJobs(); await close(call.callId); }
});

test('feed overflow reports missed updates instead of silently presenting a complete history', async () => {
  const call = await session();
  for (let i = 0; i < 205; i++) appendRow(researcher.id, 'message', { type: 'message', role: 'assistant', text: `Update ${i}` });
  const feed = await updates(call.callId);
  assert.equal(feed.updates.length, 21);
  assert.equal(feed.updates[0].kind, 'status');
  assert.match(feed.updates[0].text, /missed/);
  assert.equal(feed.cursor, 25);
  let cursor = feed.cursor;
  const seen = new Set(feed.updates.map((u: any) => u.id));
  while (cursor < 205) {
    const page = await updates(call.callId, cursor);
    assert.ok(page.cursor > cursor);
    for (const u of page.updates) { assert.ok(!seen.has(u.id)); seen.add(u.id); }
    cursor = page.cursor;
  }
  assert.equal(seen.size, 201);
  await close(call.callId);
});


test('a pending question remains waiting and its spoken answer continues the same assignment', async () => {
  const call = await session();
  const assigned = await (await tool(call.callId, 'send_task', { bot_id: researcher.id, request: 'question scenario: request the region before researching.' }, 'question-work')).json();
  await settleAgentJobs();
  assert.equal((await updates(call.callId)).tasks[0].status, 'waiting');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const holding = runInBotQueue(researcher.id, () => gate);
  try {
    const answer = await (await tool(call.callId, 'send_task', { bot_id: researcher.id, request: 'Europe, please.', mode: 'follow_up' }, 'question-answer')).json();
    assert.equal(answer.taskId, assigned.taskId, 'answers preserve the original assignment identity');
    const feed = await updates(call.callId);
    assert.equal(feed.tasks.length, 1);
    assert.equal(feed.tasks[0].status, 'queued');
    const card = JSON.parse((db.prepare("SELECT body FROM rows WHERE bot_id=? AND json_extract(body,'$.jobId')=? AND json_extract(body,'$.card')='question'").get(researcher.id, assigned.taskId) as any).body);
    assert.equal(card.status, 'answered'); assert.ok(card.answerJobId);
    assert.equal(JSON.parse((db.prepare('SELECT trigger FROM agent_jobs WHERE id=?').get(card.answerJobId) as any).trigger).parentJobId, assigned.taskId);
    release(); await holding; await settleAgentJobs();
    assert.equal((await updates(call.callId)).tasks[0].status, 'completed');
  } finally { release(); await holding; await settleAgentJobs(); await close(call.callId); }
});

test('approval continuation remains queued/running under the original assignment until its result', async () => {
  const call = await session();
  const assigned = await (await tool(call.callId, 'send_task', { bot_id: researcher.id, request: 'approval scenario: perform the requested action.' }, 'approval-work')).json();
  await settleAgentJobs();
  assert.equal((await updates(call.callId)).tasks[0].status, 'waiting');
  const approval = db.prepare("SELECT id FROM approvals WHERE bot_id=? AND status='pending' ORDER BY created_at DESC LIMIT 1").get(researcher.id) as any;
  assert.ok(approval);
  let release!: () => void;
  const holding = runInBotQueue(researcher.id, () => new Promise<void>(resolve => { release = resolve; }));
  await Promise.resolve(); await Promise.resolve();
  try {
    resolveApproval('alice', approval.id, 'allow');
    const feed = await updates(call.callId);
    assert.equal(feed.tasks.length, 1);
    assert.equal(feed.tasks[0].id, assigned.taskId);
    assert.equal(feed.tasks[0].status, 'queued', 'approval does not finish the original assignment');
    const resumed = db.prepare("SELECT trigger FROM agent_jobs WHERE bot_id=? AND json_extract(trigger,'$.parentJobId')=?").get(researcher.id, assigned.taskId) as any;
    assert.equal(JSON.parse(resumed.trigger).type, 'resume');
    release(); await holding; await settleAgentJobs();
    assert.equal((await updates(call.callId)).tasks[0].status, 'completed');
  } finally { release(); await holding; await settleAgentJobs(); await close(call.callId); }
});

test('stopping a paused question cancels the assignment and dismisses its pending input', async () => {
  const call = await session();
  const assigned = await (await tool(call.callId, 'send_task', { bot_id: researcher.id, request: 'question scenario: wait for my decision.' }, 'stoppable-question')).json();
  await settleAgentJobs();
  assert.equal((await updates(call.callId)).tasks[0].status, 'waiting');
  const result = JSON.parse((await (await tool(call.callId, 'control_agent', { bot_id: researcher.id, action: 'stop' }, 'stop-question')).json()).output);
  assert.equal(result.ok, true);
  assert.equal((await updates(call.callId)).tasks[0].status, 'cancelled');
  const card = JSON.parse((db.prepare("SELECT body FROM rows WHERE bot_id=? AND json_extract(body,'$.jobId')=? AND json_extract(body,'$.card')='question'").get(researcher.id, assigned.taskId) as any).body);
  assert.equal(card.status, 'dismissed');
  await close(call.callId);
});


test('connection handoffs stay waiting and connection callbacks continue their assignment', async () => {
  const call = await session();
  const assigned = await (await tool(call.callId, 'send_task', { bot_id: researcher.id, request: 'Prepare the app handoff.' }, 'connect-work')).json();
  await settleAgentJobs();
  const card = appendRow(researcher.id, 'card', { type: 'card', card: 'connect', jobId: assigned.taskId, toolkit: 'test', toolkitName: 'Test app', reason: 'Need access', status: 'pending' });
  assert.equal((await updates(call.callId)).tasks[0].status, 'waiting');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const holding = runInBotQueue(researcher.id, () => gate);
  try {
    updateRow(researcher.id, card.seq, { ...card.body, status: 'connected' } as any);
    const resumedId = enqueue(researcher.id, { type: 'system', text: 'The user connected Test app. Continue with what you were doing.' });
    assert.equal(JSON.parse((db.prepare('SELECT trigger FROM agent_jobs WHERE id=?').get(resumedId) as any).trigger).parentJobId, assigned.taskId);
    assert.equal((await updates(call.callId)).tasks[0].status, 'queued');
    release(); await holding; await settleAgentJobs();
    assert.equal((await updates(call.callId)).tasks[0].status, 'completed');
  } finally { release(); await holding; await settleAgentJobs(); await close(call.callId); }
});

test('spoken context and cross-agent delegation are shared without replaying the request', async () => {
  const call = await session();
  const transcript = [
    { role: 'user', text: 'Use only the copper-ledger dataset for this research.' },
    { role: 'assistant', text: 'I will pass that constraint to the researcher.' },
  ];
  const payload = { botId: chief.id, callId: call.callId, name: 'send_task', toolCallId: 'context-assignment',
    args: { bot_id: researcher.id, request: 'Research the totals.' }, transcript };
  const jobsBefore = (db.prepare('SELECT COUNT(*) n FROM agent_jobs').get() as any).n;
  const assigned = await (await post('alice', 'tool', payload)).json();
  await settleAgentJobs();
  assert.equal((db.prepare('SELECT COUNT(*) n FROM agent_jobs').get() as any).n, jobsBefore + 1);
  const targetHistory = JSON.stringify(loadHistory(researcher.id));
  assert.match(targetHistory, /copper-ledger/);
  assert.match(targetHistory, /Research the totals/);
  assert.match(targetHistory, /findings are ready/);
  const chiefHistory = JSON.stringify(loadHistory(chief.id));
  assert.match(chiefHistory, /copper-ledger/);
  assert.match(chiefHistory, new RegExp(assigned.taskId));
  assert.match(chiefHistory, /Already queued/);
  assert.match(chiefHistory, /Update from Researcher/);
  assert.ok(modelInputs.some(input => JSON.stringify(input).includes('copper-ledger') && JSON.stringify(input).includes('Research the totals')));
  const length = loadHistory(chief.id).length;
  assert.deepEqual(await (await post('alice', 'tool', payload)).json(), assigned);
  assert.equal(loadHistory(chief.id).length, length, 'transport replay cannot duplicate context or dispatch');
  const ended = await post('alice', 'end', { botId: chief.id, callId: call.callId, transcript });
  assert.equal(ended.status, 200);
  assert.equal(loadHistory(chief.id).length, length, 'end does not append the same speech twice');
});

test('end-of-call speech is context for the next text turn, never an automatic task', async () => {
  const call = await session();
  const transcript = [
    { role: 'user', text: 'Keep the next report in violet-notebook format.' },
    { role: 'assistant', text: 'I will remember that format for the next request.' },
  ];
  const jobsBefore = (db.prepare('SELECT COUNT(*) n FROM agent_jobs').get() as any).n;
  await post('alice', 'end', { botId: chief.id, callId: call.callId, transcript });
  assert.equal((db.prepare('SELECT COUNT(*) n FROM agent_jobs').get() as any).n, jobsBefore);
  const history = loadHistory(chief.id);
  const note = history.find(item => typeof item.content === 'string' && item.content.includes('violet-notebook'));
  assert.ok(note);
  assert.match(note.content, /transcript context/);
  assert.match(note.content, /not a new task or approval/);
  assert.match(note.content, /"role":"user"/);
  assert.match(note.content, /"role":"assistant"/);
  await post('alice', 'end', { botId: chief.id, callId: call.callId, transcript });
  assert.equal(loadHistory(chief.id).length, history.length);
  enqueue(chief.id, { type: 'user', text: 'What report format did we agree on?' });
  await settleAgentJobs();
  assert.ok(JSON.stringify(modelInputs.at(-1)).includes('violet-notebook'));
});

test('native management results reach the affected chat without spawning another run', async () => {
  const call = await session();
  const jobsBefore = (db.prepare('SELECT COUNT(*) n FROM agent_jobs').get() as any).n;
  const result = await (await tool(call.callId, 'update_agent', { bot_id: researcher.id, label: 'Source verification' }, 'context-update')).json();
  assert.equal(JSON.parse(result.output).ok, true);
  for (const botId of [chief.id, researcher.id]) {
    const history = JSON.stringify(loadHistory(botId));
    assert.match(history, /Native coordinator action update_agent/);
    assert.match(history, /Source verification/);
  }
  assert.equal((db.prepare('SELECT COUNT(*) n FROM agent_jobs').get() as any).n, jobsBefore);
  await close(call.callId);
});

test('context sync enforces owner and generation and preserves repeated speech in order', async () => {
  const call = await session();
  const prefix = [{ role: 'user', text: 'First copper preference.' }, { role: 'assistant', text: 'Understood.' }];
  const postContext = (transcript: unknown, user = 'alice') => post(user, 'tool', { botId: chief.id, callId: call.callId, name: 'peek_activity', transcript });
  assert.equal((await postContext([{ role: 'user', text: 'foreign-context-token' }], 'bob')).status, 404);
  assert.ok(!JSON.stringify(loadHistory(chief.id)).includes('foreign-context-token'));
  await postContext(prefix);
  const before = loadHistory(chief.id).length;
  await postContext([...prefix, { role: 'user', text: 'Second copper preference.' }, ...prefix]);
  assert.equal(loadHistory(chief.id).length, before + 1);
  const appended = loadHistory(chief.id).at(-1).content;
  assert.ok(appended.indexOf('Second copper preference.') < appended.indexOf('First copper preference.'));
  const length = loadHistory(chief.id).length;
  await postContext(prefix);
  assert.equal(loadHistory(chief.id).length, length, 'older snapshots do not duplicate context');
  assert.equal((await postContext([{ role: 'system', text: 'invalid role' }])).status, 400);
  clearConversation(chief.id);
  assert.equal((await postContext(prefix)).status, 409);
  await post('alice', 'end', { botId: chief.id, callId: call.callId, transcript: prefix });
  assert.deepEqual(loadHistory(chief.id), [], 'a stale call cannot restore a cleared conversation');
});

test('ordered snapshots reject disjoint stale windows and retain identical speech with distinct IDs', async () => {
  const call = await session();
  const window = (start: number) => Array.from({ length: 200 }, (_, i) => ({ id: `caption-${start + i}`, role: 'user', text: 'Repeated agreed phrase.' }));
  const sync = (transcript: unknown, transcriptRevision: number) => post('alice', 'tool', { botId: chief.id, callId: call.callId, name: 'peek_activity', transcript, transcriptRevision });
  assert.equal((await sync(window(200), 2)).status, 200);
  const before = loadHistory(chief.id).length;
  assert.equal((await sync(window(0), 1)).status, 200);
  assert.equal(loadHistory(chief.id).length, before, 'a disjoint older window cannot restore earlier speech');
  assert.equal((await sync(window(201), 3)).status, 200);
  assert.equal(loadHistory(chief.id).length, before + 1);
  const added = loadHistory(chief.id).at(-1).content;
  assert.ok(added.includes('caption-400'));
  assert.equal(added.split('Repeated agreed phrase.').length - 1, 1, 'only the newly spoken identical phrase is appended');
  assert.equal((await sync(window(201), 3)).status, 200);
  assert.equal(loadHistory(chief.id).length, before + 1);
  await post('alice', 'end', { botId: chief.id, callId: call.callId, transcript: window(0), transcriptRevision: 1 });
  assert.equal(loadHistory(chief.id).length, before + 1, 'a stale end snapshot cannot roll back current context');
});

test('a held call summary cannot overwrite a new-generation row after chat is cleared', async () => {
  const call = await session();
  let release!: () => void;
  summaryGate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { summaryStarted = resolve; });
  try {
    const ended = await (await post('alice', 'end', { botId: chief.id, callId: call.callId,
      transcript: [{ role: 'user', text: 'held-summary-context belongs only to the cleared conversation.' }] })).json();
    await started;
    clearConversation(chief.id);
    let row = appendRow(chief.id, 'message', { type: 'message', role: 'user', text: 'New conversation must survive.' });
    while (row.seq < ended.seq) row = appendRow(chief.id, 'message', { type: 'message', role: 'user', text: 'New conversation must survive.' });
    assert.equal(row.seq, ended.seq);
    release();
    await new Promise(resolve => setTimeout(resolve, 100));
    const current = db.prepare('SELECT body FROM rows WHERE bot_id=? AND generation=? AND seq=?').get(chief.id, row.generation, row.seq) as any;
    assert.deepEqual(JSON.parse(current.body), row.body);
    assert.ok(!JSON.stringify(loadHistory(chief.id)).includes('held-summary-context'));
  } finally { release(); summaryGate = undefined; summaryStarted = undefined; }
});

test('fresh calls omit historical connect cards and show one current request per toolkit even at equal timestamps', async t => {
  const frozen = Date.now();
  t.mock.method(Date, 'now', () => frozen);
  const target = createBot('alice', { name: 'Connection cleanup target' });
  const card = (botId: string, toolkit: string) => appendRow(botId, 'card', {
    type: 'card', card: 'connect', toolkit, toolkitName: toolkit, reason: 'Authorize requested work', status: 'pending',
  });
  card(target.id, 'exa'); card(target.id, 'exa');
  const call = await session();
  try {
    assert.equal((await updates(call.callId)).connectionRequests.length, 0, 'old cards are not inherited by a new call');
    card(target.id, 'exa');
    const newest = card(target.id, 'exa');
    const gmail = card(target.id, 'gmail');
    card(foreign.id, 'private-service');
    const requests = (await updates(call.callId)).connectionRequests;
    assert.equal(requests.length, 2);
    assert.equal(requests.find((r: any) => r.toolkit === 'exa').seq, newest.seq);
    assert.equal(requests.find((r: any) => r.toolkit === 'gmail').seq, gmail.seq);
    assert.ok(requests.every((r: any) => r.botId === target.id));
  } finally { await close(call.callId); clearConversation(target.id); }
});

test('delegating to an agent exposes its existing connection blocker once, without creating another authorization', async () => {
  const target = createBot('alice', { name: 'Blocked connection target' });
  const card = appendRow(target.id, 'card', { type: 'card', card: 'connect', toolkit: 'exa', toolkitName: 'Exa', reason: 'Pending setup', status: 'pending' });
  const call = await session();
  try {
    assert.equal((await updates(call.callId)).connectionRequests.length, 0);
    await tool(call.callId, 'send_task', { bot_id: target.id, request: 'Continue the requested setup.' }, 'connection-blocker-task');
    await settleAgentJobs();
    const result = await updates(call.callId);
    assert.deepEqual(result.connectionRequests, [{ botId: target.id, seq: card.seq, toolkit: 'exa', toolkitName: 'Exa' }]);
    assert.equal(result.tasks[0].status, 'queued');
    updateRow(target.id, card.seq, { ...card.body, status: 'skipped' } as any);
    enqueue(target.id, { type: 'system', text: 'The user skipped connecting Exa. Continue without it.' });
    await settleAgentJobs();
    assert.equal((await updates(call.callId)).connectionRequests.length, 0);
  } finally { await close(call.callId); clearConversation(target.id); }
});
