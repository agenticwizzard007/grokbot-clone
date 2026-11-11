import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { after, beforeEach, mock, test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-voice-assignment-queue-'));
let sequence = 0;
const planned: string[] = [];
const upstream = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  if (!req.url?.endsWith('/responses')) return res.end(JSON.stringify({ data: [] }));
  const last = body.input?.at(-1);
  const request = last?.role === 'user' ? String(last.content) : '';
  if (request) planned.push(request);
  let name = '', args: unknown = {};
  if (request.startsWith('WRITE ')) {
    name = 'SWARM_APPS_EXECUTE'; args = writeArgs(request.slice(6));
  } else if (request.startsWith('ASK ')) {
    name = 'ask_user'; args = { question: `Which region for ${request.slice(4)}?`, options: ['Europe', 'Asia'] };
  } else if (request === 'CONNECT') {
    name = 'request_app_connection'; args = { toolkit: 'slack', reason: 'Read the requested team channel.' };
  }
  const item = name ? { type: 'function_call', id: `item-${++sequence}`, call_id: `call-${sequence}`, name, arguments: JSON.stringify(args) }
    : { type: 'message', id: `item-${++sequence}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Finished.', annotations: [] }] };
  const response = { id: `response-${sequence}`, object: 'response', status: 'completed', model: body.model,
    output: [item], output_text: name ? '' : 'Finished.', usage: { input_tokens: 1, output_tokens: 1 } };
  if (!body.stream) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(response)); }
  res.setHeader('Content-Type', 'text/event-stream');
  for (const event of [{ type: 'response.output_item.added', item },
    ...(name ? [] : [{ type: 'response.output_text.delta', delta: 'Finished.' }]),
    { type: 'response.output_item.done', item }, { type: 'response.completed', response }]) res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.end();
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
const address = upstream.address();
assert.ok(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}/v1`;
Object.assign(process.env, { SWARM_ROLE: 'standalone', NODE_ENV: 'test', DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'),
  SESSION_SECRET: 'voice-queue-test', COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: 'test-project', INKBOX_TUNNEL: '0',
  DIRECT_API_KEY: 'test-model-key', DIRECT_BASE_URL: base, DIRECT_MODEL: 'queue-fixture-model', OPENROUTER_API_KEY: '',
  LLM_PROVIDER: 'direct', APP_URL: base, SERVER_URL: base, ADMIN_EMAILS: '', ADMIN_PHONES: '' });
const realFetch = globalThis.fetch;
mock.method(globalThis, 'fetch', async (input, init) => {
  const url = new URL(String(input));
  if (url.hostname === '127.0.0.1') return realFetch(input, init);
  if (url.hostname === 'registry.npmjs.org') return Response.json({ version: '0.28.0' });
  if (url.hostname === 'telemetry.composio.dev') return Response.json({});
  if (url.hostname === 'backend.composio.dev' && url.pathname.endsWith('/toolkits')) return Response.json({ items: ['github', 'slack'].map(slug => ({ slug, name: slug, meta: { categories: [] } })) });
  throw new Error(`Unexpected provider request: ${url.hostname}`);
});
const { db } = await import('../server/src/db.js');
const { initSubagents } = await import('../server/src/agent/subagents.js');
const { initRooms } = await import('../server/src/agent/rooms.js');
initSubagents(); initRooms();
const { createBot } = await import('../server/src/bots.js');
const { composio } = await import('../server/src/composio.js');
const { setEnvOverride } = await import('../server/src/env.js');
const { enqueue, settleAgentJobs, resolveApproval, initDurableJobs, runInBotQueue } = await import('../server/src/agent/loop.js');
const { acceptJob } = await import('../server/src/agent/jobs.js');
const { appendRow, clearConversation, getLive, loadHistory, updateRow } = await import('../server/src/store.js');
for (const id of ['alice', 'bob']) db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(id, `${id}@example.test`, id, Date.now());
const executed: string[] = [];
let bot: any, keySequence = 0;
beforeEach(async t => {
  await settleAgentJobs();
  db.exec('DELETE FROM bots; DELETE FROM policies');
  planned.length = 0; executed.length = 0;
  bot = createBot('alice', { name: 'Worker', isPrimary: true });
  setEnvOverride('COMPOSIO_API_KEY', `queue-project-${++keySequence}`);
  const client = composio();
  t.mock.method(client.connectedAccounts, 'list', async (input: any) => ({ items: [{ id: `github-${input.userIds[0]}`, toolkit: { slug: 'github' }, status: 'ACTIVE' }], nextCursor: null }));
  const tool = { slug: 'GITHUB_CREATE_ISSUE', toolkit: { slug: 'github' }, version: '20261101_00', tags: ['createHint'],
    description: 'Create the requested issue.', inputParameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } };
  t.mock.method(client.tools, 'getRawComposioTools', async () => [tool]);
  t.mock.method(client.tools, 'getRawComposioToolBySlug', async () => tool);
  t.mock.method(client.tools, 'execute', async (_slug, input: any) => { executed.push(input.arguments.title); return { data: { title: input.arguments.title }, successful: true }; });
});
after(async () => {
  await settleAgentJobs();
  await new Promise<void>(resolve => upstream.close(() => resolve()));
  mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true });
});

function writeArgs(title: string) { return { connectionId: 'github-alice', revision: 1, tool_slug: 'GITHUB_CREATE_ISSUE', arguments: { title } }; }
const assignment = (text: string, botId = bot.id) => enqueue(botId, { type: 'user', text, voiceAssignment: true });
const job = (id: string) => db.prepare('SELECT * FROM agent_jobs WHERE id=?').get(id) as any;
const trigger = (id: string) => JSON.parse(job(id).trigger);
const approvalFor = (jobId: string) => db.prepare("SELECT a.* FROM approvals a JOIN rows r ON r.bot_id=a.bot_id AND r.seq=a.row_seq JOIN bots b ON b.id=r.bot_id AND b.generation=r.generation WHERE json_extract(r.body,'$.jobId')=?").get(jobId) as any;
function pendingCard(jobId: string, kind: string) {
  const row = db.prepare("SELECT seq,body FROM rows WHERE bot_id=? AND generation=? AND kind='card' AND json_extract(body,'$.jobId')=? AND json_extract(body,'$.card')=?").get(bot.id, bot.generation, jobId, kind) as any;
  return row && { seq: row.seq, body: JSON.parse(row.body) };
}

for (const decision of ['allow', 'deny'] as const) {
  test(`independent A/B preserve A approval through ${decision}, then approve B exactly once`, async t => {
    const frozen = Date.now(); t.mock.method(Date, 'now', () => frozen);
    const a = assignment('WRITE A'), b = assignment('WRITE B');
    await settleAgentJobs();
    const apA = approvalFor(a);
    assert.equal(apA.status, 'pending'); assert.equal(job(b).state, 'queued');
    assert.equal(approvalFor(b), undefined); assert.deepEqual(executed, []);
    const other = createBot('alice', { name: 'Other worker', isPrimary: true });
    const independentOther = assignment('Read other work', other.id);
    await settleAgentJobs();
    assert.equal(job(independentOther).state, 'completed', 'a paused agent must release the account queue');
    resolveApproval('alice', apA.id, decision);
    await settleAgentJobs();
    const apB = approvalFor(b);
    assert.equal(approvalFor(a).status, decision === 'allow' ? 'allowed' : 'denied');
    assert.equal(apB.status, 'pending'); assert.notEqual(apB.id, apA.id);
    assert.deepEqual(executed, decision === 'allow' ? ['A'] : []);
    assert.ok(getLive(bot.id).awaiting);
    resolveApproval('alice', apB.id, 'allow'); resolveApproval('alice', apB.id, 'allow');
    await settleAgentJobs();
    assert.deepEqual(executed, decision === 'allow' ? ['A', 'B'] : ['B']);
    assert.equal(db.prepare('SELECT 1 FROM pending_turns WHERE bot_id=?').get(bot.id), undefined);
    assert.equal(trigger(b).parentJobId, undefined, 'B remains its own assignment');
  });
}

test('independent B never consumes A question; explicit answer continues A before waking B', async () => {
  const a = assignment('ASK A'), b = assignment('WRITE B');
  await settleAgentJobs();
  const question = pendingCard(a, 'question');
  assert.equal(question.body.status, 'pending'); assert.equal(question.body.answerJobId, undefined);
  assert.equal(job(b).state, 'queued'); assert.equal(trigger(b).parentJobId, undefined);
  const answer = enqueue(bot.id, { type: 'user', text: 'Europe, please.', voiceAssignment: false });
  assert.equal(trigger(answer).parentJobId, a);
  assert.equal(pendingCard(a, 'question').body.answerJobId, answer);
  assert.equal(pendingCard(a, 'question').body.answer, 'Europe, please.');
  await settleAgentJobs();
  assert.equal(job(answer).state, 'completed'); assert.equal(approvalFor(b).status, 'pending');
  assert.deepEqual(planned.slice(0, 3), ['ASK A', 'Europe, please.', 'WRITE B']);
  assert.ok(loadHistory(bot.id).some(item => item.role === 'user' && item.content === 'Europe, please.'));
  resolveApproval('alice', approvalFor(b).id, 'allow'); await settleAgentJobs();
  assert.deepEqual(executed, ['B']);
});

test('a follow-up that asks another question keeps independent work queued until the final answer', async () => {
  const a = assignment('ASK first'), b = assignment('WRITE B');
  await settleAgentJobs();
  const followUp = enqueue(bot.id, { type: 'user', text: 'ASK second' });
  await settleAgentJobs();
  assert.equal(trigger(followUp).parentJobId, a); assert.equal(job(b).state, 'queued');
  assert.equal(pendingCard(followUp, 'question').body.status, 'pending');
  const answer = enqueue(bot.id, { type: 'user', text: 'Asia.' });
  await settleAgentJobs();
  assert.equal(trigger(answer).parentJobId, followUp);
  assert.equal(approvalFor(b).status, 'pending');
  resolveApproval('alice', approvalFor(b).id, 'deny'); await settleAgentJobs();
  assert.deepEqual(executed, []);
});

for (const kind of ['question', 'connect'] as const) {
  test(`already scheduled B cannot overtake a queued ${kind} continuation after its card resolves`, async () => {
    const a = assignment(kind === 'question' ? 'ASK A' : 'CONNECT');
    await settleAgentJobs();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const holding = runInBotQueue(bot.id, () => { entered(); return gate; });
    await started;
    try {
      const b = assignment('WRITE B');
      if (kind === 'connect') {
        const connect = pendingCard(a, 'connect');
        updateRow(bot.id, connect.seq, { ...connect.body, status: 'connected' });
      }
      const continuation = kind === 'question'
        ? enqueue(bot.id, { type: 'user', text: 'Europe, please.' })
        : enqueue(bot.id, { type: 'system', text: 'Slack authorization connected.' });
      assert.equal(trigger(continuation).parentJobId, a);
      release(); await holding; await settleAgentJobs();
      assert.equal(job(continuation).state, 'completed');
      assert.equal(approvalFor(b).status, 'pending', 'the continuation must not supersede a prematurely started B');
      assert.deepEqual(planned.slice(0, 3), [kind === 'question' ? 'ASK A' : 'CONNECT',
        kind === 'question' ? 'Europe, please.' : '[System notice] Slack authorization connected.', 'WRITE B']);
      resolveApproval('alice', approvalFor(b).id, 'allow'); await settleAgentJobs();
      assert.deepEqual(executed, ['B']);
    } finally { release(); await holding; await settleAgentJobs(); }
  });
}

for (const status of ['connected', 'skipped'] as const) {
  test(`connection ${status} callback resumes A lineage and wakes independent B`, async () => {
    const a = assignment('CONNECT'), b = assignment('WRITE B');
    await settleAgentJobs();
    const connect = pendingCard(a, 'connect');
    assert.equal(connect.body.status, 'pending'); assert.equal(job(b).state, 'queued');
    assert.equal(db.prepare('SELECT 1 FROM pending_turns WHERE bot_id=?').get(bot.id), undefined, 'a connect handoff blocks without pending_turns');
    updateRow(bot.id, connect.seq, { ...connect.body, status });
    const callback = enqueue(bot.id, { type: 'system', text: `Slack authorization ${status}.` });
    assert.equal(trigger(callback).parentJobId, a);
    await settleAgentJobs();
    assert.equal(pendingCard(a, 'connect').body.answerJobId, callback);
    assert.equal(job(callback).state, 'completed'); assert.equal(approvalFor(b).status, 'pending');
    resolveApproval('alice', approvalFor(b).id, 'allow'); await settleAgentJobs();
    assert.deepEqual(executed, ['B']);
  });
}

for (const nativeFirst of [true, false]) {
  test(`legacy native and independent voice assignments share FIFO with native ${nativeFirst ? 'first' : 'second'}`, async () => {
    const native = () => enqueue(bot.id, { type: 'native-tool', name: 'SWARM_APPS_EXECUTE', args: writeArgs('native'), callId: 'native-stable-id', requireApproval: true });
    const first = nativeFirst ? native() : assignment('WRITE voice');
    const second = nativeFirst ? assignment('WRITE voice') : native();
    await settleAgentJobs();
    assert.equal(job(second).state, 'queued'); assert.equal(approvalFor(first).status, 'pending');
    resolveApproval('alice', approvalFor(first).id, 'allow'); await settleAgentJobs();
    assert.deepEqual(executed, [nativeFirst ? 'native' : 'voice']);
    assert.equal(approvalFor(second).status, 'pending');
    resolveApproval('alice', approvalFor(second).id, 'allow'); await settleAgentJobs();
    assert.deepEqual(executed, nativeFirst ? ['native', 'voice'] : ['voice', 'native']);
  });
}

test('explicit ordinary follow-up retains legacy supersede behavior', async () => {
  const a = assignment('WRITE A'); await settleAgentJobs();
  const correction = enqueue(bot.id, { type: 'user', text: 'WRITE corrected', voiceAssignment: false });
  await settleAgentJobs();
  assert.equal(approvalFor(a).status, 'expired'); assert.equal(approvalFor(correction).status, 'pending');
  resolveApproval('alice', approvalFor(correction).id, 'allow'); await settleAgentJobs();
  assert.deepEqual(executed, ['corrected']);
});

test('durably recovered independent assignments retain insertion order despite equal timestamps', async t => {
  const frozen = Date.now(); t.mock.method(Date, 'now', () => frozen);
  const a = acceptJob(bot.id, { type: 'user', text: 'WRITE A', voiceAssignment: true }).id;
  const b = acceptJob(bot.id, { type: 'user', text: 'WRITE B', voiceAssignment: true }).id;
  initDurableJobs(); await settleAgentJobs();
  assert.equal(approvalFor(a).status, 'pending'); assert.equal(job(b).state, 'queued');
  resolveApproval('alice', approvalFor(a).id, 'allow'); await settleAgentJobs();
  assert.equal(approvalFor(b).status, 'pending');
  resolveApproval('alice', approvalFor(b).id, 'allow'); await settleAgentJobs();
  assert.deepEqual(executed, ['A', 'B']);
});

test('pending decisions in older chat generations do not block a new independent assignment', async () => {
  appendRow(bot.id, 'card', { type: 'card', card: 'question', question: 'Old question', options: [], status: 'pending' });
  clearConversation(bot.id);
  bot = { ...bot, generation: bot.generation + 1 };
  const current = assignment('WRITE current'); await settleAgentJobs();
  assert.equal(approvalFor(current).status, 'pending');
  resolveApproval('alice', approvalFor(current).id, 'allow'); await settleAgentJobs();
  assert.deepEqual(executed, ['current']);
});
