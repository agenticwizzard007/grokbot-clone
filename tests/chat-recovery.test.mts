import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-recovery-'));
Object.assign(process.env, {
  DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'), DEV_LOGIN: '1',
  SWARM_ROLE: 'standalone', SWARM_NO_SCHEDULER: '1', SESSION_SECRET: 'recovery-fixture',
  COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '', DIRECT_API_KEY: 'fixture',
  OPENROUTER_API_KEY: '', LLM_PROVIDER: 'direct', INKBOX_TUNNEL: '0',
});
mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network request'); });
const { db } = await import('../server/src/db.js');
const { createBot } = await import('../server/src/bots.js');
const { appendRow, updateRow, listRows, getBotRow } = await import('../server/src/store.js');
const { withUsage } = await import('../server/src/usage-context.js');
const { acceptJob, beginJob, finishJob, beginTool, finishTool, recoverJobs } = await import('../server/src/agent/jobs.js');
const { holdLegacyDatabase } = await import('../server/src/platform/legacy-database-fence.js');
(await import('../server/src/agent/subagents.js')).initSubagents();
(await import('../server/src/agent/rooms.js')).initRooms();
const { enqueue, settleAgentJobs } = await import('../server/src/agent/loop.js');
const { toolMap } = await import('../server/src/agent/tools.js');
const { localAccess } = await import('../server/src/computers/local-access.js');
for (const id of ['owner', 'usr_held_recovery']) db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(id, `${id}@example.test`, 'QA account', Date.now());
after(async () => { await settleAgentJobs(); mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
const bot = (owner = 'owner') => createBot(owner, { name: 'Recovery fixture' }).id;
const job = (id: string, trigger: object = { type: 'user', text: 'Fixture request' }) => {
  const accepted = acceptJob(id, trigger); beginJob(accepted.id); return accepted.id;
};
const notices = (id: string) => listRows(id).filter(row => row.body.type === 'notice' && row.body.recovery);
const tool = (id: string, jobId: string | undefined, callId: string, status: 'running' | 'queued' | 'done' = 'running') => appendRow(id, 'tool-call', {
  type: 'tool-call', jobId, callId, name: 'list_app_connections', label: `Fixture ${callId}`, status,
});

test('P-05: interrupted streaming is terminal, attributed and durable without changing completed work', () => {
  const id = bot(), completed = job(id);
  const done = withUsage({ botId: id, jobId: completed }, () => appendRow(id, 'message', { type: 'message', role: 'assistant', text: 'Completed reply', streaming: false }));
  finishJob(completed, true);
  const interrupted = job(id);
  const partial = withUsage({ botId: id, jobId: interrupted }, () => appendRow(id, 'message', { type: 'message', role: 'assistant', text: 'Partial reply', streaming: true }));
  // Streaming rewrites must retain the original job outside its async context.
  updateRow(id, partial.seq, { type: 'message', role: 'assistant', text: 'Partial reply updated', streaming: true });
  const queued = acceptJob(id, { type: 'user', text: 'Waiting request' });
  assert.ok(recoverJobs().some(row => row.id === queued.id));
  const rows = listRows(id);
  assert.deepEqual(rows.find(row => row.seq === done.seq), done);
  assert.deepEqual(rows.find(row => row.seq === partial.seq)?.body, { type: 'message', role: 'assistant', text: 'Partial reply updated', streaming: false, interrupted: true, jobId: interrupted, audience: 'user' });
  const notice = notices(id)[0];
  assert.equal(notice.body.jobId, interrupted);
  assert.equal(notice.body.type === 'notice' && notice.body.recovery?.jobId, interrupted);
  assert.match(notice.body.type === 'notice' ? notice.body.text : '', /did not finish/);
  const rev = getBotRow(id).rev;
  recoverJobs();
  assert.equal(notices(id).length, 1);
  assert.equal(getBotRow(id).rev, rev, 'repeated recovery does not rewrite the transcript');
});

test('P-05: dispatch outcomes distinguish completed, uncertain and never dispatched steps', () => {
  const id = bot(), interrupted = job(id);
  const finished = tool(id, interrupted, 'finished', 'done');
  beginTool(id, 'finished', 'list_app_connections', 'fixture'); finishTool(id, 'finished', true);
  tool(id, interrupted, 'unknown'); beginTool(id, 'unknown', 'list_app_connections', 'fixture');
  tool(id, interrupted, 'not-started', 'queued');
  tool(id, interrupted, 'recorded-result'); beginTool(id, 'recorded-result', 'list_app_connections', 'fixture'); finishTool(id, 'recorded-result', true);
  recoverJobs();
  const rows = listRows(id);
  assert.deepEqual(rows.find(row => row.seq === finished.seq), finished);
  assert.deepEqual(rows.filter(row => row.body.type === 'tool-call').map(row => (row.body as any).status), ['done', 'uncertain', 'interrupted', 'done']);
  const notice = notices(id)[0].body;
  assert.ok(notice.type === 'notice' && notice.recovery);
  assert.match(notice.text, /check the affected app before retrying/);
  assert.deepEqual(notice.recovery.activity.map(step => step.status), ['done', 'uncertain', 'interrupted', 'done']);
  assert.equal(beginTool(id, 'unknown', 'list_app_connections', 'fixture'), false, 'uncertain dispatch cannot replay');
  assert.equal((db.prepare('SELECT state FROM agent_jobs WHERE id=?').get(interrupted) as any).state, 'uncertain');
});

test('P-05: first upgrade reconciles untagged rows only within the interrupted turn', () => {
  const id = bot();
  const old = tool(id, undefined, 'old');
  db.prepare('UPDATE rows SET created_at=1 WHERE bot_id=? AND seq=?').run(id, old.seq);
  const interrupted = job(id);
  const legacy = appendRow(id, 'message', { type: 'message', role: 'assistant', text: 'Legacy partial', streaming: true });
  tool(id, undefined, 'legacy'); beginTool(id, 'legacy', 'list_app_connections', 'fixture');
  recoverJobs();
  const rows = listRows(id);
  assert.equal((rows.find(row => row.seq === old.seq)?.body as any).status, 'running');
  assert.equal(rows.find(row => row.seq === legacy.seq)?.body.jobId, interrupted);
  assert.equal((rows.find(row => row.seq === legacy.seq)?.body as any).streaming, false);
  assert.equal((notices(id)[0].body as any).recovery.activity.length, 1);
});

test('P-05: an interrupted resume closes its old pending batch without replaying siblings', () => {
  const id = bot(), parent = job(id);
  const first = tool(id, parent, 'resumed'), second = tool(id, parent, 'sibling', 'queued');
  finishJob(parent, true);
  db.prepare('INSERT INTO pending_turns(bot_id,state) VALUES(?,?)').run(id, JSON.stringify({ jobId: parent, approvalId: '', calls: [{ rowSeq: first.seq }, { rowSeq: second.seq }] }));
  job(id, { type: 'resume', parentJobId: parent });
  beginTool(id, 'resumed', 'list_app_connections', 'fixture');
  recoverJobs();
  assert.equal(db.prepare('SELECT 1 FROM pending_turns WHERE bot_id=?').get(id), undefined);
  assert.deepEqual((notices(id)[0].body as any).recovery.activity.map((step: any) => step.status), ['uncertain', 'interrupted']);
});

test('P-05: a crash while saving an approval expires that interrupted batch', () => {
  const id = bot(), interrupted = job(id);
  const action = tool(id, interrupted, 'pending', 'queued');
  const card = appendRow(id, 'card', { type: 'card', card: 'approval', approvalId: 'fixture-approval', jobId: interrupted, title: 'Fixture action', detail: 'Local fixture', tool: 'fixture', status: 'pending' });
  db.prepare("INSERT INTO approvals(id,bot_id,row_seq,call_id,tool,status,created_at) VALUES(?,?,?,?,?,'pending',?)").run('fixture-approval', id, card.seq, 'pending', 'fixture', Date.now());
  db.prepare('INSERT INTO pending_turns(bot_id,state) VALUES(?,?)').run(id, JSON.stringify({ jobId: interrupted, approvalId: 'fixture-approval', calls: [{ rowSeq: action.seq }] }));
  recoverJobs();
  assert.equal((db.prepare('SELECT status FROM approvals WHERE id=?').get('fixture-approval') as any).status, 'expired');
  assert.equal((listRows(id).find(row => row.seq === card.seq)?.body as any).status, 'expired');
  assert.equal(db.prepare('SELECT 1 FROM pending_turns WHERE bot_id=?').get(id), undefined);
});

test('P-05: the real dispatcher retains the resumed job attribution through completion', async t => {
  const id = bot(), parent = job(id);
  db.prepare("UPDATE bot_setups SET onboarding_status='active',confirmed_at=? WHERE bot_id=?").run(Date.now(), id);
  const action = tool(id, parent, 'continued', 'queued');
  finishJob(parent, true);
  db.prepare('INSERT INTO pending_turns(bot_id,state) VALUES(?,?)').run(id, JSON.stringify({
    jobId: parent, native: true, approvalId: '', computerRevision: localAccess('owner').revision, depth: 0, outputs: [],
    calls: [{ rowSeq: action.seq, call_id: 'continued', name: 'list_app_connections', arguments: '{}' }],
  }));
  let dispatches = 0;
  t.mock.method(toolMap.get('list_app_connections')!, 'impl', async () => { dispatches++; return { output: 'Fixture result' }; });
  const resumed = enqueue(id, { type: 'resume' });
  await settleAgentJobs();
  const result = listRows(id).find(row => row.seq === action.seq)!;
  assert.equal(dispatches, 1);
  assert.equal(result.body.jobId, resumed);
  assert.equal((result.body as any).status, 'done');
});

test('P-05: recovery preserves waiting approvals, internal work and held accounts', () => {
  const waiting = bot(), paused = job(waiting);
  tool(waiting, paused, 'waiting', 'queued');
  finishJob(paused, true);
  db.prepare('INSERT INTO pending_turns(bot_id,state) VALUES(?,?)').run(waiting, JSON.stringify({ jobId: paused, approvalId: '', calls: [] }));
  const internal = bot(), background = job(internal, { type: 'system', text: 'Internal', audience: 'internal' });
  const internalRow = appendRow(internal, 'message', { type: 'message', role: 'assistant', text: 'Internal', streaming: true, audience: 'internal', jobId: background });
  const held = bot('usr_held_recovery'), heldJob = job(held);
  tool(held, heldJob, 'held'); beginTool(held, 'held', 'list_app_connections', 'fixture');
  holdLegacyDatabase(db, 'usr_held_recovery', 'chat-recovery-hold', '1');
  const snapshot = JSON.stringify(listRows(held));
  recoverJobs();
  assert.ok(db.prepare('SELECT 1 FROM pending_turns WHERE bot_id=?').get(waiting));
  assert.deepEqual(listRows(internal).find(row => row.seq === internalRow.seq), internalRow);
  assert.equal(notices(internal).length, 0);
  assert.equal(notices(waiting).length, 0);
  assert.equal(JSON.stringify(listRows(held)), snapshot);
  assert.equal((db.prepare('SELECT state FROM agent_jobs WHERE id=?').get(heldJob) as any).state, 'running');
});

test('P-05: recovery commits the notice and state together or retries the entire recovery', () => {
  const id = bot(), interrupted = job(id);
  tool(id, interrupted, 'atomic'); beginTool(id, 'atomic', 'list_app_connections', 'fixture');
  db.exec(`CREATE TEMP TRIGGER fail_recovery BEFORE INSERT ON rows WHEN NEW.kind='notice' AND NEW.bot_id='${id}' BEGIN SELECT RAISE(ABORT, 'Fixture recovery failure'); END;`);
  assert.throws(recoverJobs, /Fixture recovery failure/);
  db.exec('DROP TRIGGER fail_recovery');
  assert.equal((db.prepare('SELECT state FROM agent_jobs WHERE id=?').get(interrupted) as any).state, 'running');
  assert.equal((db.prepare('SELECT state FROM tool_dispatches WHERE bot_id=?').get(id) as any).state, 'dispatching');
  assert.equal(notices(id).length, 0);
  recoverJobs();
  assert.equal(notices(id).length, 1);
});
