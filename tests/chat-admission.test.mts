import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-admission-'));
Object.assign(process.env, {
  DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'), DEV_LOGIN: '1',
  NODE_ENV: 'development', SWARM_ROLE: 'standalone', SWARM_NO_SCHEDULER: '1',
  SESSION_SECRET: 'admission-fixture', COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '',
  DIRECT_API_KEY: 'fixture', OPENROUTER_API_KEY: '', LLM_PROVIDER: 'direct', INKBOX_TUNNEL: '0',
});
mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected external request'); });
const { db } = await import('../server/src/db.js');
(await import('../server/src/agent/subagents.js')).initSubagents();
const { initRooms, createRoom } = await import('../server/src/agent/rooms.js');
initRooms();
const { createBot } = await import('../server/src/bots.js');
const { getLive, onRowChange } = await import('../server/src/store.js');
const { hub } = await import('../server/src/lib/hub.js');
const { settleAgentJobs } = await import('../server/src/agent/loop.js');
const { acceptJob } = await import('../server/src/agent/jobs.js');
const { llmClient } = await import('../server/src/lib/llm.js');
const { api } = await import('../server/src/routes.js');
const { apiErrorHandler } = await import('../server/src/lib/json.js');
const { Hono } = await import('hono');
const app = new Hono().onError(apiErrorHandler).route('/api', api);
let modelCalls = 0;
let modelGate: Promise<void> | undefined;
mock.method(llmClient(360_000).responses, 'create', async () => {
  modelCalls++;
  await modelGate;
  return (async function* () {
    const item = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixture reply.', annotations: [] }] };
    yield { type: 'response.output_item.done', item };
    yield { type: 'response.completed', response: { output: [item] } };
  })();
});
after(async () => { await settleAgentJobs(); mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
let sequence = 0;
async function fixture(pending: number) {
  const email = `admission-${++sequence}@example.test`;
  const login = await app.request('/api/auth/dev', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, name: 'Fixture account' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const userId = (db.prepare('SELECT id FROM users WHERE email=?').get(email) as any).id;
  const bot = (active = true) => {
    const result = createBot(userId, { name: `Fixture Bot ${++sequence}` });
    if (active) db.prepare("UPDATE bot_setups SET onboarding_status='active',confirmed_at=? WHERE bot_id=?").run(Date.now(), result.id);
    return result.id;
  };
  const filler = bot();
  for (let i = 0; i < pending; i++) acceptJob(filler, { type: 'user', text: 'Waiting fixture' });
  await Promise.resolve();
  const send = (id: string, submissionId?: string) => app.request(`/api/bots/${id}/messages`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Fixture request', submissionId }),
  });
  const count = (table: string) => (db.prepare(`SELECT count(*) n FROM ${table} WHERE user_id=?`).get(userId) as any).n;
  return { userId, bot, filler, send, count };
}
const rows = (id: string) => db.prepare('SELECT * FROM rows WHERE bot_id=? ORDER BY seq').all(id);
const jobs = (id: string) => db.prepare('SELECT * FROM agent_jobs WHERE bot_id=?').all(id);
async function capacity(response: Response) {
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '5');
  assert.deepEqual(await response.json(), {
    error: 'Your task queue is full. Wait for running tasks to finish.', code: 'chat_capacity', retryable: true,
  });
}

for (const keyed of [true, false]) test(`P-08: full queue rejects a direct chat without effects, keyed=${keyed}`, async () => {
  const f = await fixture(64), id = f.bot(), beforeCalls = modelCalls;
  const beforeRows = rows(id), beforeLive = getLive(id), beforeEvents = f.count('native_events');
  const events: unknown[] = [], observed: unknown[] = [];
  const off = hub.subscribe(f.userId, event => events.push(event));
  const offRows = onRowChange((owner, row) => { if (owner === f.userId) observed.push(row); });
  try {
    await capacity(await f.send(id, keyed ? 'direct-capacity' : undefined));
    await settleAgentJobs();
    assert.deepEqual(rows(id), beforeRows);
    assert.deepEqual(getLive(id), beforeLive);
    assert.deepEqual(jobs(id), []);
    assert.equal(f.count('message_receipts'), 0);
    assert.equal(f.count('native_events'), beforeEvents);
    assert.deepEqual(events, []);
    assert.deepEqual(observed, []);
    assert.equal(modelCalls, beforeCalls);
  } finally { off(); offRows(); }
});

for (const configuring of [false, true]) test(`P-08: nearly full queue rolls back every group responder and notice, setup=${configuring}`, async () => {
  const f = await fixture(configuring ? 63 : 62), members = [f.bot(!configuring), f.bot(), f.bot()];
  const room = createRoom(f.userId, 'Admission group', members), beforeCalls = modelCalls;
  const beforeRows = rows(room), beforeLive = members.map(getLive), beforeEvents = f.count('native_events');
  const events: unknown[] = [], observed: unknown[] = [];
  const off = hub.subscribe(f.userId, event => events.push(event));
  const offRows = onRowChange((owner, row) => { if (owner === f.userId) observed.push(row); });
  try {
    await capacity(await f.send(room, 'group-capacity'));
    await settleAgentJobs();
    assert.deepEqual(rows(room), beforeRows);
    assert.deepEqual(members.map(jobs), [[], [], []]);
    assert.deepEqual(members.map(getLive), beforeLive);
    assert.equal(f.count('message_receipts'), 0);
    assert.equal(f.count('native_events'), beforeEvents);
    assert.deepEqual(events, []);
    assert.deepEqual(observed, []);
    assert.equal(modelCalls, beforeCalls);
  } finally { off(); offRows(); }
  // Free exactly enough capacity and retry the same submission ID.
  db.prepare("UPDATE agent_jobs SET state='completed' WHERE id=(SELECT id FROM agent_jobs WHERE bot_id=? LIMIT 1)").run(f.filler);
  const response = await f.send(room, 'group-capacity');
  assert.equal(response.status, 200);
  const receipt = await response.json();
  assert.equal(receipt.jobIds.length, configuring ? 2 : 3);
  await settleAgentJobs();
  assert.equal(modelCalls - beforeCalls, receipt.jobIds.length);
  assert.deepEqual(await (await f.send(room, 'group-capacity')).json(), receipt);
  await settleAgentJobs();
  assert.equal(modelCalls - beforeCalls, receipt.jobIds.length);
});

test('P-08: competing groups reserve the final slots as one unit and publish only committed receipts', async () => {
  const f = await fixture(61), members = [f.bot(), f.bot(), f.bot()];
  const room = createRoom(f.userId, 'Final slots', members), beforeCalls = modelCalls;
  const gate = Promise.withResolvers<void>();
  modelGate = gate.promise;
  const observations: { inTransaction: boolean; jobs: number; receipts: number }[] = [];
  const observe = () => observations.push({ inTransaction: db.inTransaction, jobs: f.count('agent_jobs'), receipts: f.count('message_receipts') });
  const off = hub.subscribe(f.userId, observe);
  const offRows = onRowChange((owner) => { if (owner === f.userId) observe(); });
  try {
    const responses = await Promise.all([f.send(room, 'first-group'), f.send(room, 'second-group')]);
    assert.deepEqual(responses.map(r => r.status), [200, 429]);
    await capacity(responses[1]);
    const receipt = await responses[0].json();
    assert.equal(receipt.jobIds.length, 3);
    assert.deepEqual(members.map(id => jobs(id).length), [1, 1, 1]);
    assert.ok(observations.length > 0);
    for (const observation of observations) assert.deepEqual(observation, { inTransaction: false, jobs: 64, receipts: 1 });
    // Receipt replay remains successful even when no slots are free.
    assert.deepEqual(await (await f.send(room, 'first-group')).json(), receipt);
  } finally { off(); offRows(); modelGate = undefined; gate.resolve(); await settleAgentJobs(); }
  assert.equal(modelCalls - beforeCalls, 3);
});

test('P-08: receipt write failure discards a fully reserved direct submission and its live state', async () => {
  const f = await fixture(63), id = f.bot(), beforeCalls = modelCalls;
  const beforeRows = rows(id), beforeLive = getLive(id), beforeEvents = f.count('native_events');
  const events: unknown[] = [], observed: unknown[] = [];
  const off = hub.subscribe(f.userId, event => events.push(event));
  const offRows = onRowChange((owner, row) => { if (owner === f.userId) observed.push(row); });
  db.exec("CREATE TEMP TRIGGER fail_chat_receipt BEFORE INSERT ON message_receipts BEGIN SELECT RAISE(ABORT, 'Fixture receipt failure'); END;");
  try {
    assert.equal((await f.send(id, 'receipt-failure')).status, 500);
    await settleAgentJobs();
    assert.deepEqual(rows(id), beforeRows);
    assert.deepEqual(getLive(id), beforeLive);
    assert.deepEqual(jobs(id), []);
    assert.equal(f.count('message_receipts'), 0);
    assert.equal(f.count('native_events'), beforeEvents);
    assert.deepEqual(events, []);
    assert.deepEqual(observed, []);
    assert.equal(modelCalls, beforeCalls);
    assert.equal(db.prepare('SELECT 1 FROM knowledge_learning_state WHERE bot_id=?').get(id), undefined);
  } finally { db.exec('DROP TRIGGER fail_chat_receipt'); off(); offRows(); }
  const response = await f.send(id, 'receipt-failure');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).jobIds.length, 1);
  await settleAgentJobs();
  assert.equal(modelCalls - beforeCalls, 1);
  assert.equal(jobs(id).length, 1);
});
