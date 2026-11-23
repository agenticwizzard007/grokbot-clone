import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-receipts-'));
Object.assign(process.env, {
  DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'), DEV_LOGIN: '1',
  SWARM_ROLE: 'standalone', SWARM_NO_SCHEDULER: '1', SESSION_SECRET: 'chat-receipt-fixture',
  COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '', DIRECT_API_KEY: 'fixture',
  OPENROUTER_API_KEY: '', LLM_PROVIDER: 'direct', INKBOX_TUNNEL: '0',
});
mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network request in chat receipt tests'); });
const { db } = await import('../server/src/db.js');
(await import('../server/src/agent/subagents.js')).initSubagents();
const { initRooms, createRoom } = await import('../server/src/agent/rooms.js');
initRooms();
const { createBot } = await import('../server/src/bots.js');
const { clearConversation, listRows } = await import('../server/src/store.js');
const { settleAgentJobs } = await import('../server/src/agent/loop.js');
const { llmClient } = await import('../server/src/lib/llm.js');
const { api } = await import('../server/src/routes.js');
const { apiErrorHandler } = await import('../server/src/lib/json.js');
const { Hono } = await import('hono');
const app = new Hono().onError(apiErrorHandler).route('/api', api);
let modelCalls = 0;
mock.method(llmClient(360_000).responses, 'create', async () => {
  modelCalls++;
  return (async function* () {
    const item = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixture accepted.', annotations: [] }] };
    yield { type: 'response.output_item.done', item };
    yield { type: 'response.completed', response: { output: [item] } };
  })();
});
const accounts: { id: string; cookie: string }[] = [];
for (const email of ['receipt-owner@example.test', 'receipt-other@example.test']) {
  const response = await app.request('/api/auth/dev', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, name: 'Test account' }) });
  assert.equal(response.status, 200);
  accounts.push({ id: (db.prepare('SELECT id FROM users WHERE email=?').get(email) as any).id, cookie: response.headers.get('set-cookie')!.split(';')[0] });
}
let sequence = 0;
function bot(owner = 0) {
  const value = createBot(accounts[owner].id, { name: `Fixture Bot ${++sequence}`, description: 'Summarize supplied notes.' });
  db.prepare("UPDATE bot_setups SET onboarding_status='active', confirmed_at=? WHERE bot_id=?").run(Date.now(), value.id);
  return value.id;
}
const send = (botId: string, submissionId: unknown, text = 'Summarize the supplied notes.', owner = 0) => app.request(`/api/bots/${botId}/messages`, {
  method: 'POST', headers: { cookie: accounts[owner].cookie, 'content-type': 'application/json' }, body: JSON.stringify({ text, submissionId }),
});
const jobs = (botId: string) => db.prepare('SELECT * FROM agent_jobs WHERE bot_id=?').all(botId) as any[];
const userRows = (botId: string) => listRows(botId).filter(row => row.body.type === 'message' && row.body.role === 'user');
after(async () => { await settleAgentJobs(); mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('P-02: concurrent and completed retries return the original receipt with one execution', async () => {
  const id = bot(), before = modelCalls;
  const responses = await Promise.all(Array.from({ length: 12 }, () => send(id, 'same-submission')));
  const receipts = await Promise.all(responses.map(async response => { assert.equal(response.status, 200); return response.json(); }));
  for (const receipt of receipts) assert.deepEqual(receipt, receipts[0]);
  assert.equal(receipts[0].submissionId, 'same-submission');
  assert.equal(receipts[0].jobIds.length, 1);
  await settleAgentJobs();
  assert.equal(modelCalls - before, 1);
  assert.equal(jobs(id).length, 1);
  assert.equal(userRows(id).length, 1);
  assert.deepEqual(await (await send(id, 'same-submission')).json(), receipts[0]);
  assert.equal((await send(id, 'same-submission', 'Different instructions.')).status, 409);
  assert.equal(jobs(id).length, 1);
  // An uncertain job and a new conversation generation must not allow the accepted work to restart.
  db.prepare("UPDATE agent_jobs SET state='uncertain' WHERE bot_id=?").run(id);
  clearConversation(id);
  assert.deepEqual(await (await send(id, 'same-submission')).json(), receipts[0]);
  assert.equal(userRows(id).length, 0);
  await settleAgentJobs();
  assert.equal(modelCalls - before, 1);
  // Read the receipt through a new process using the same temporary SQLite file.
  const script = `const { acceptMessage } = await import('./server/src/agent/message-receipts.ts');
    const receipt = acceptMessage(${JSON.stringify(accounts[0].id)}, ${JSON.stringify(id)}, 'same-submission', 'Summarize the supplied notes.', () => { throw Error('Must replay'); });
    process.stdout.write(JSON.stringify(receipt));`;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    encoding: 'utf8', env: { PATH: process.env.PATH, DB_PATH: process.env.DB_PATH, FILES_DIR: process.env.FILES_DIR, SWARM_ROLE: 'standalone', SESSION_SECRET: 'chat-receipt-fixture' },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), receipts[0]);
});

test('P-02: IDs are scoped to an owned Bot and new IDs permit intentional repeated text', async () => {
  const first = bot(), second = bot(), foreign = bot(1);
  const receipts = [];
  for (const [id, owner] of [[first, 0], [second, 0], [foreign, 1]] as const) {
    const response = await send(id, 'shared-id', 'Same text.', owner);
    assert.equal(response.status, 200);
    receipts.push(await response.json());
  }
  assert.equal(new Set(receipts.flatMap(receipt => receipt.jobIds)).size, 3);
  assert.equal((await send(foreign, 'shared-id')).status, 404);
  assert.equal((await send(first, 'shared-id', 'Same text.', 1)).status, 404);
  assert.equal((await send(first, 'new-id', 'Same text.')).status, 200);
  await settleAgentJobs();
  assert.equal(userRows(first).length, 2);
  assert.equal(jobs(first).length, 2);
});

test('P-02: group retries dispatch each original member once even after membership changes', async () => {
  const members = [bot(), bot()], extra = bot(), before = modelCalls;
  const room = createRoom(accounts[0].id, 'Fixture group', members);
  const responses = await Promise.all([send(room, 'group-id'), send(room, 'group-id')]);
  const receipt = await responses[0].json();
  assert.equal(responses[0].status, 200);
  assert.deepEqual(await responses[1].json(), receipt);
  assert.equal(receipt.jobIds.length, 2);
  await settleAgentJobs();
  assert.equal(modelCalls - before, 2);
  db.prepare('UPDATE bots SET members=? WHERE id=?').run(JSON.stringify([...members, extra]), room);
  assert.deepEqual(await (await send(room, 'group-id')).json(), receipt);
  assert.equal((await send(room, 'group-id', 'Changed group instructions.')).status, 409);
  await settleAgentJobs();
  assert.equal(userRows(room).length, 1);
  assert.deepEqual(members.map(id => jobs(id).length), [1, 1]);
  assert.equal(jobs(extra).length, 0);
  assert.equal(modelCalls - before, 2);
});

test('P-02: partial group admission rolls back all jobs and can be safely retried', async () => {
  const members = [bot(), bot()], before = modelCalls;
  const room = createRoom(accounts[0].id, 'Admission fixture', members);
  // Fail the second member at the durable admission boundary in this temporary database.
  db.exec(`CREATE TEMP TRIGGER fail_fixture_admission BEFORE INSERT ON agent_jobs
    WHEN NEW.bot_id='${members[1]}' BEGIN SELECT RAISE(ABORT, 'Fixture admission failure'); END;`);
  try { assert.equal((await send(room, 'rollback-id')).status, 500); }
  finally { db.exec('DROP TRIGGER fail_fixture_admission'); }
  await settleAgentJobs();
  assert.equal(modelCalls, before);
  assert.equal(userRows(room).length, 0);
  assert.deepEqual(members.map(id => jobs(id).length), [0, 0]);
  assert.equal(db.prepare('SELECT 1 FROM message_receipts WHERE bot_id=?').get(room), undefined);
  const response = await send(room, 'rollback-id');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).jobIds.length, 2);
  await settleAgentJobs();
  assert.equal(modelCalls - before, 2);
  assert.equal(userRows(room).length, 1);
});

test('P-02: empty groups also replay their receipt without repeating notices', async () => {
  const room = createRoom(accounts[0].id, 'Empty fixture', []);
  const receipt = await (await send(room, 'empty-group-id')).json();
  assert.deepEqual(receipt.jobIds, []);
  assert.deepEqual(await (await send(room, 'empty-group-id')).json(), receipt);
  assert.equal(listRows(room).length, 2);
});

test('P-02: malformed IDs do no work and older clients retain their send contract', async () => {
  const id = bot();
  for (const value of [null, '', 12, {}, 'has spaces', 'a'.repeat(129)]) assert.equal((await send(id, value)).status, 400);
  assert.equal(userRows(id).length, 0);
  assert.equal(jobs(id).length, 0);
  for (let i = 0; i < 2; i++) assert.equal((await send(id, undefined)).status, 200);
  await settleAgentJobs();
  assert.equal(userRows(id).length, 2);
});
