import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-run-'));
Object.assign(process.env, { NODE_ENV: 'test', SWARM_ROLE: 'standalone', DEV_LOGIN: '1', SWARM_NO_SCHEDULER: '1',
  DB_PATH: path.join(temp, 'app.db'), FILES_DIR: path.join(temp, 'files'), SESSION_SECRET: 'stop-run-fixture',
  COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: 'fixture', DIRECT_API_KEY: 'fixture', OPENROUTER_API_KEY: '',
  LLM_PROVIDER: 'direct', DIRECT_BASE_URL: 'http://127.0.0.1:1', INKBOX_TUNNEL: '0', SWARM_ACCOUNT_CONCURRENCY: '1',
});
await import('./fixtures/stop-voice-backends.mjs');
const { db } = await import('../server/src/db.js');
(await import('../server/src/agent/subagents.js')).initSubagents();
(await import('../server/src/agent/rooms.js')).initRooms();
const { api } = await import('../server/src/routes.js');
const { createBot } = await import('../server/src/bots.js');
const { listRows, getLive, appendRow, updateRow, appendHistory, loadHistory, setLive } = await import('../server/src/store.js');
const { enqueue, interrupt, settleAgentJobs, turnSignal } = await import('../server/src/agent/loop.js');
const { llmClient } = await import('../server/src/lib/llm.js');
const { hub } = await import('../server/src/lib/hub.js');
const { currentRun, withRun } = await import('../server/src/agent/run-scope.js');
const app = new Hono().route('/api', api);
const login = await app.request('/api/auth/dev', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'stop-run@example.test', name: 'QA account' }) });
const cookie = login.headers.get('set-cookie')!.split(';')[0];
const { user } = await (await app.request('/api/auth/me', { headers: { cookie } })).json() as any;
after(async () => { await settleAgentJobs(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });
function bot(active = true) {
  const b = createBot(user.id, { name: 'Cancellation fixture' });
  if (active) db.prepare("UPDATE bot_setups SET onboarding_status='active',confirmed_at=? WHERE bot_id=?").run(Date.now(), b.id);
  return b.id;
}
async function until(check: () => boolean, label = 'condition') {
  const deadline = Date.now() + 3000;
  while (!check()) { assert.ok(Date.now() < deadline, `Timed out: ${label}`); await new Promise(r => setTimeout(r, 5)); }
}
const message = (text: string) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
async function* answer(text: string) {
  const item = message(text);
  yield { type: 'response.output_item.added', item };
  yield { type: 'response.output_text.delta', delta: text };
  yield { type: 'response.output_item.done', item };
  yield { type: 'response.completed', response: { output: [item] } };
}
for (const phase of ['request', 'stream'] as const) test(`stop-then-send releases ${phase} and account slot before a slow provider drains`, async t => {
  const id = bot(phase === 'request'), held = Promise.withResolvers<void>();
  let calls = 0, oldSignal: AbortSignal | undefined, oldScope: ReturnType<typeof currentRun>, streamAborted = false, drained = false;
  t.mock.method(llmClient(360_000).responses, 'create', async (body: any, options: any) => {
    if (++calls > 1) {
      // Fake model deliberately answers the previous prompt too unless history closes it.
      const closed = body.input.some((item: any) => typeof item.content === 'string' && item.content.includes('This request was cancelled.'));
      return answer(closed ? 'Tea is a warm drink.' : 'LATE BEES ESSAY Tea is a warm drink.');
    }
    oldSignal = options.signal; oldScope = currentRun();
    if (phase === 'request') { await held.promise; drained = true; return answer('LATE BEES ESSAY'); }
    return Object.assign((async function* () {
      yield { type: 'response.output_text.delta', delta: 'Bees have a long history.' };
      await held.promise; drained = true;
      yield* answer('LATE BEES ESSAY');
    })(), { controller: { abort: () => { streamAborted = true; } } });
  });
  const events: any[] = [], off = hub.subscribe(user.id, ev => events.push(ev));
  try {
    const first = enqueue(id, { type: 'user', text: 'Write a long essay about bees.' });
    await until(() => !!oldSignal);
    if (phase === 'stream') await until(() => listRows(id).some(r => r.body.type === 'message' && r.body.streaming));
    assert.equal((await app.request(`/api/bots/${id}/interrupt`, { method: 'POST', headers: { cookie } })).status, 200);
    assert.equal(oldSignal!.aborted, true);
    const second = enqueue(id, { type: 'user', text: 'Write about tea.' });
    await until(() => calls === 2, 'replacement provider starts without releasing the first');
    await settleAgentJobs();
    assert.equal(drained, false);
    assert.equal(db.prepare('SELECT state FROM agent_jobs WHERE id=?').get(first)?.state, 'cancelled');
    assert.equal(db.prepare('SELECT state FROM agent_jobs WHERE id=?').get(second)?.state, 'completed');
    const replies = listRows(id).filter(r => r.body.type === 'message');
    assert.equal(replies.at(-1)?.body.text, 'Tea is a warm drink.');
    assert.equal(replies.length, phase === 'stream' ? 2 : 1);
    if (phase === 'stream') { assert.equal(streamAborted, true); assert.equal(replies[0].body.interrupted, true); assert.notEqual(replies[0].body.jobId, replies[1].body.jobId); }
    assert.ok(listRows(id).some(r => r.body.type === 'notice' && r.body.text === 'You stopped this request.'));
    const before = JSON.stringify(listRows(id)), history = JSON.stringify(loadHistory(id)), eventCount = events.length;
    withRun(oldScope, () => {
      assert.equal(turnSignal(id), oldSignal, 'old callbacks retain their own aborted signal');
      assert.throws(() => appendRow(id, 'message', { type: 'message', role: 'assistant', text: 'late text' }));
      assert.throws(() => updateRow(id, replies.at(-1)!.seq, { type: 'message', role: 'assistant', text: 'late tool output' }));
      assert.throws(() => appendHistory(id, [message('late history')]));
      setLive(id, { isRunning: true });
      hub.emit(user.id, { type: 'tasks', botId: id });
    });
    held.resolve(); await until(() => drained); await new Promise(r => setTimeout(r, 30));
    assert.equal(JSON.stringify(listRows(id)), before);
    assert.equal(JSON.stringify(loadHistory(id)), history);
    assert.equal(events.length, eventCount, 'cancelled callbacks never broadcast');
    assert.ok(events.some(ev => ev.type === 'rows' && ev.runId === second && ev.runBotId === id));
    assert.equal(getLive(id).isRunning, false);
  } finally { held.resolve(); off(); await settleAgentJobs(); }
});

test('stop cancels queued jobs and removes account-slot waiters', async t => {
  const a = bot(), b = bot(), held = Promise.withResolvers<void>();
  const requests: string[] = [];
  t.mock.method(llmClient(360_000).responses, 'create', async (body: any) => {
    const prompt = body.input.at(-1).content; requests.push(prompt);
    if (prompt === 'held') await held.promise;
    return answer('done');
  });
  enqueue(a, { type: 'user', text: 'held' });
  await until(() => requests.length === 1);
  const cancelled = enqueue(b, { type: 'user', text: 'must never run' });
  await new Promise(r => setTimeout(r, 20));
  interrupt(b, undefined, 'user');
  assert.ok(listRows(b).some(row => row.body.type === 'notice' && row.body.text === 'You stopped this request.' && row.body.terminal));
  interrupt(a, undefined, 'user');
  enqueue(b, { type: 'user', text: 'replacement' });
  await until(() => requests.includes('replacement'));
  assert.deepEqual(requests, ['held', 'replacement']);
  assert.equal(db.prepare('SELECT state FROM agent_jobs WHERE id=?').get(cancelled)?.state, 'cancelled');
  held.resolve(); await settleAgentJobs(); await new Promise(r => setTimeout(r, 30));
});

test('stop aborts a running connected-app tool and fences its late result', async t => {
  const id = bot(), held = Promise.withResolvers<void>();
  db.prepare("INSERT OR IGNORE INTO policies(user_id,tool,mode) VALUES(?,?,'always_allow')").run(user.id, 'GMAIL_FETCH_EMAILS');
  const { composio } = await import('../server/src/composio.js');
  let signal: AbortSignal | undefined, calls = 0, finished = false;
  t.mock.method(composio().tools, 'execute', async (_slug: string, _body: any, options: any) => {
    signal = options.signal; await held.promise; finished = true;
    return { successful: true, data: { text: 'LATE TOOL OUTPUT' } };
  });
  t.mock.method(llmClient(360_000).responses, 'create', async () => ++calls === 1 ? (async function* () {
    yield { type: 'response.completed', response: { output: [{ type: 'function_call', call_id: 'slow-tool', name: 'SWARM_APPS_EXECUTE',
      arguments: JSON.stringify({ connectionId: 'fixture-gmail', revision: 1, tool_slug: 'GMAIL_FETCH_EMAILS', arguments: { scenario: 'slow' } }) }] } };
  })() : answer('Tea only.'));
  try {
    enqueue(id, { type: 'user', text: 'Run slow tool' }); await until(() => !!signal);
    interrupt(id, undefined, 'user'); assert.equal(signal!.aborted, true);
    enqueue(id, { type: 'user', text: 'Tea' }); await until(() => calls === 2); await settleAgentJobs();
    assert.equal(finished, false);
    const before = JSON.stringify(listRows(id));
    held.resolve(); await until(() => finished); await new Promise(r => setTimeout(r, 30));
    assert.equal(JSON.stringify(listRows(id)), before);
    assert.doesNotMatch(JSON.stringify(loadHistory(id)), /LATE TOOL OUTPUT/);
    assert.equal(listRows(id).find(r => r.body.type === 'tool-call')?.body.status, 'uncertain');
  } finally { held.resolve(); await settleAgentJobs(); }
});

for (const provider of ['direct', 'openrouter'] as const) test(`${provider}: Stop closes the real HTTP provider stream`, async t => {
  const { createServer } = await import('node:http');
  const { once } = await import('node:events');
  const { env } = await import('../server/src/env.js');
  const saved = { directBaseUrl: env.directBaseUrl, openrouterBaseUrl: env.openrouterBaseUrl };
  t.mock.getter(env, 'llmProvider', () => provider);
  t.mock.getter(env, 'openrouterKey', () => 'fixture');
  let started = false, closed = false;
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [] })); return; }
    for await (const _ of req) { /* consume the local request */ }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Partial bees' })}\n\n`);
    started = true; res.on('close', () => { closed = true; });
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as any).port}/v1`;
  Object.assign(env, { directBaseUrl: base, openrouterBaseUrl: base });
  const id = bot();
  try {
    enqueue(id, { type: 'user', text: 'Long response' }); await until(() => started);
    interrupt(id, undefined, 'user'); await until(() => closed, 'HTTP provider connection closed'); await settleAgentJobs();
    assert.equal(getLive(id).isRunning, false);
    assert.equal(listRows(id).some(r => r.body.type === 'message'), false);
  } finally { interrupt(id); await settleAgentJobs(); Object.assign(env, saved); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('SSE backpressure preserves run start and stop boundaries before delivering rows', async () => {
  const { SseQueue } = await import('../server/src/routes.js');
  const { useStore } = await import('../web/src/store.js');
  const id = bot(), queue = new SseQueue();
  const state = (runId: string, revision: number, isRunning: boolean) => ({ botId: id, runId, revision, isRunning, activity: null, awaiting: null, startedAt: null });
  const row = (runId: string, seq: number, text: string) => ({ botId: id, generation: 1, seq, updatedSeq: seq, kind: 'message' as const, createdAt: seq, body: { type: 'message' as const, role: 'assistant' as const, text, jobId: runId } });
  queue.push({ type: 'live', state: state('old', 1, true) });
  queue.push({ type: 'rows', botId: id, generation: 1, runId: 'old', rows: [row('old', 1, 'Partial bees')] });
  queue.push({ type: 'live', state: state('old', 2, true) });
  queue.push({ type: 'live', state: state('old', 3, false) });
  queue.push({ type: 'live', state: state('new', 4, true) });
  queue.push({ type: 'rows', botId: id, generation: 1, runId: 'new', rows: [row('new', 2, 'Tea only')] });
  queue.push({ type: 'live', state: state('new', 5, false) });
  while (queue.length) useStore.getState().handleEvent(JSON.parse(queue.shift()!));
  assert.deepEqual(Object.values(useStore.getState().transcripts[id].bySeq).map(r => r.body.text), ['Partial bees', 'Tea only']);
  assert.equal(useStore.getState().live[id].runId, 'new');
});

for (const method of ['direct', 'summary']) test(`${method}: cancelled compaction passes the run signal and cannot replace history`, async t => {
  const { maybeCompact, memoryConfig } = await import('../server/src/agent/memory.js');
  const { withUsage } = await import('../server/src/usage-context.js');
  const id = bot(), controller = new AbortController(), held = Promise.withResolvers<void>();
  const saved = { ...memoryConfig }; Object.assign(memoryConfig, { compactChars: 1000, keepTurns: 1, compactMethod: method });
  t.after(() => Object.assign(memoryConfig, saved));
  const items = Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: 'history '.repeat(200) }));
  appendHistory(id, items);
  let seen: AbortSignal | undefined, calls = 0;
  const result = async (options: any) => { calls++; seen = options.signal; await held.promise; return { output: [{ role: 'user', content: 'late summary' }], output_text: 'late summary' }; };
  t.mock.method(llmClient(300_000), 'post', async (_url: any, options: any) => result(options));
  t.mock.method(llmClient(300_000).responses, 'create', async (_body: any, options: any) => result(options));
  const pending = withUsage({ userId: user.id, botId: id }, () => maybeCompact(id, items, { force: true, signal: controller.signal }));
  const rejected = assert.rejects(pending);
  await until(() => !!seen); assert.equal(seen, controller.signal);
  controller.abort(new Error('Stop compaction')); held.resolve(); await rejected;
  assert.deepEqual(loadHistory(id), items);
  assert.equal(calls, 1, 'cancellation never starts a fallback model');
});
