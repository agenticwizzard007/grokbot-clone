import { register } from 'tsx/esm/api';
register();
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ho-f-'));
Object.assign(process.env, { NODE_ENV: 'test', SWARM_ROLE: 'standalone', DB_PATH: path.join(temp, 'app.db'), FILES_DIR: path.join(temp, 'files'),
  SESSION_SECRET: 'ho-f-fixture', COMPUTER_PROVIDER: 'local', INKBOX_TUNNEL: '0', COMPOSIO_API_KEY: '', WHATSAPP_DISABLED: '1' });
const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('No network in HO-F server tests'); };
const { db } = await import('../../server/src/db.ts');
(await import('../../server/src/agent/subagents.ts')).initSubagents();
const { initRooms, createRoom, dispatchRoomMessage } = await import('../../server/src/agent/rooms.ts');
initRooms();
await import('../../server/src/coordination/schema.ts');
await import('../../server/src/deliverables/schema.ts');
const { DDL } = await import('../../server/src/handoffs/schema.ts');
db.exec(DDL);
const { createBot } = await import('../../server/src/bots.ts');
const { acceptJob } = await import('../../server/src/agent/jobs.ts');
const { hub } = await import('../../server/src/lib/hub.ts');
const { transactionWithEffects } = await import('../../server/src/lib/commit-effects.ts');
const tasks = await import('../../server/src/handoffs/tasks.ts');
const rooms = await import('../../server/src/handoffs/rooms.ts');
let sequence = 0;
after(() => { db.close(); globalThis.fetch = originalFetch; fs.rmSync(temp, { recursive: true, force: true }); });

function fixture() {
  const userId = `fixture_${++sequence}`, time = Date.now();
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(userId, `${userId}@example.test`, 'Test account', time);
  const bots = ['Maker', 'Checker', 'Research', 'Editor'].map((name, index) => createBot(userId, { name, isPrimary: index === 0 }));
  bots.forEach(bot => db.prepare("UPDATE bot_setups SET onboarding_status='active' WHERE bot_id=?").run(bot.id));
  const roomId = createRoom(userId, 'Test project', bots.slice(0, 2).map(b => b.id));
  const taskId = `task_${sequence}`, loopId = `lp_${sequence}`;
  db.prepare("INSERT INTO tasks(id,bot_id,title,state,created_at,updated_at) VALUES(?,?,?,'working',?,?)").run(taskId, bots[0].id, 'Test draft', time, time);
  const spec = { name: 'Test loop', goal: 'Check the test draft', kind: 'maker_checker', steps: [
    { id: 'maker', botId: bots[0].id, role: 'maker', instruction: 'Draft' }, { id: 'checker', botId: bots[1].id, role: 'checker', instruction: 'Check' }],
    seed: { text: 'Test brief' }, exit: { mode: 'verdict' }, limits: { maxIterations: 4, maxMinutes: 30, stepTimeoutMinutes: 10 }, gate: { before: 'each', onCap: 'stop' }, roomId, taskId };
  db.prepare("INSERT INTO loops(id,user_id,owner_bot_id,room_id,task_id,name,spec,status,initiated_by,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'running','user',?,?,?)").run(loopId, userId, bots[0].id, roomId, taskId, spec.name, JSON.stringify(spec), loopId, time, time);
  const outputId = `out_${sequence}`, job = acceptJob(bots[0].id, { type: 'user', text: 'Test draft' });
  db.prepare("INSERT INTO run_outputs(id,user_id,bot_id,job_id,source,status,title,summary,manifest,provenance,content_hash,created_at) VALUES(?,?,?,?,'run','final','Test draft','Summary','[]','{}','hash',?)").run(outputId, userId, bots[0].id, job.id, time);
  const handoffId = `ho_${sequence}`;
  db.prepare("INSERT INTO handoffs(id,user_id,from_bot_id,to_bot_id,source_output_id,initiated_by,instruction,status,room_id,idempotency_key,fingerprint,created_at,updated_at) VALUES(?,?,?,?,?,'user',?,'queued',?,?,?,?,?)").run(handoffId, userId, bots[0].id, bots[1].id, outputId, 'Check the test draft', roomId, handoffId, 'test-hash', time, time);
  const transition = (status, reason = null) => {
    db.prepare('UPDATE loops SET status=?, stop_reason=? WHERE id=? AND user_id=?').run(status, reason, loopId, userId);
    tasks.syncLoopTasks(userId, loopId);
  };
  const task = () => db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
  return { userId, bots, roomId, taskId, loopId, spec, outputId, job, handoffId, transition, task };
}
function event(f, type, data = {}) {
  return Number(db.prepare('INSERT INTO handoff_events(user_id,loop_id,type,data,created_at) VALUES(?,?,?,?,?)').run(f.userId, f.loopId, type, JSON.stringify(data), Date.now()).lastInsertRowid);
}

for (const [status, reason, expected] of [
  ['running', null, 'working'], ['awaiting_approval', null, 'needs_input'], ['succeeded', 'passed', 'done'],
  ['capped', 'max_iterations', 'needs_input'], ['failed', 'step_failed', 'needs_input'],
]) test(`loop task transition ${status} -> ${expected}`, () => {
  const f = fixture(); f.transition(status, reason);
  assert.equal(f.task().state, expected);
  assert.equal(tasks.getTaskHandoffLinks(f.userId)[f.taskId].loopId, f.loopId);
});

test('pause, resume, cancellation, stall and all nonpass reasons remain honest', () => {
  const f = fixture();
  for (const [status, reason, state] of [['paused', null, 'working'], ['running', null, 'working'], ['cancelled', 'user_stopped', 'needs_input'],
    ['stalled', 'stalled', 'needs_input'], ['capped', 'max_minutes', 'needs_input'], ['capped', 'max_cost', 'needs_input'], ['capped', 'max_tokens', 'needs_input'],
    ['failed', 'no_verdict', 'needs_input'], ['cancelled', 'declined', 'needs_input'], ['cancelled', 'gate_expired', 'needs_input']]) {
    f.transition(status, reason); assert.equal(f.task().state, state); assert.ok(f.task().note);
  }
});

test('starter task is reused at a gate; replay and restart do not inflate counts or notifications', () => {
  const f = fixture(), events = []; const stop = hub.subscribe(f.userId, e => events.push(e));
  f.transition('awaiting_approval');
  const before = events.length;
  tasks.syncLoopTasks(f.userId, f.loopId);
  assert.equal(events.length, before);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM tasks WHERE bot_id=? AND state='needs_input'").get(f.bots[0].id).n, 1);
  f.transition('running'); assert.equal(f.task().state, 'working');
  stop();
});

test('gate belongs to starter when linked task is elsewhere; resolved approval no longer counts', () => {
  const f = fixture(); db.prepare('UPDATE tasks SET bot_id=? WHERE id=?').run(f.bots[1].id, f.taskId);
  f.transition('awaiting_approval');
  const gate = db.prepare("SELECT t.* FROM tasks t JOIN handoff_task_links l ON l.task_id=t.id WHERE l.loop_id=? AND l.kind='gate'").get(f.loopId);
  assert.equal(gate.bot_id, f.bots[0].id); assert.equal(gate.state, 'needs_input');
  f.transition('running'); assert.equal(db.prepare('SELECT state FROM tasks WHERE id=?').get(gate.id).state, 'done');
  f.transition('awaiting_approval');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM handoff_task_links WHERE loop_id=? AND kind='gate'").get(f.loopId).n, 1);
});

test('loop without a task still has one approver task at a gate', () => {
  const f = fixture(); delete f.spec.taskId;
  db.prepare('UPDATE loops SET task_id=NULL,spec=? WHERE id=?').run(JSON.stringify(f.spec), f.loopId);
  f.transition('awaiting_approval'); tasks.syncLoopTasks(f.userId, f.loopId);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM handoff_task_links WHERE loop_id=? AND kind='gate'").get(f.loopId).n, 1);
});

test('receiver task follows arrival, question, completion and failure without duplicates', () => {
  const f = fixture(); tasks.syncHandoffTasks(f.userId, f.handoffId); tasks.syncHandoffTasks(f.userId, f.handoffId);
  const receiver = () => db.prepare("SELECT t.* FROM tasks t JOIN handoff_task_links l ON l.task_id=t.id WHERE l.handoff_id=? AND l.kind='receiver'").get(f.handoffId);
  assert.equal(receiver().bot_id, f.bots[1].id); assert.match(receiver().title, /^From Maker:/); assert.equal(receiver().state, 'working');
  db.prepare("UPDATE handoffs SET status='running' WHERE id=?").run(f.handoffId);
  tasks.syncHandoffTasks(f.userId, f.handoffId, { needsInput: true }); assert.equal(receiver().state, 'needs_input');
  tasks.syncHandoffTasks(f.userId, f.handoffId); assert.equal(receiver().state, 'working');
  db.prepare("UPDATE handoffs SET status='completed' WHERE id=?").run(f.handoffId);
  tasks.syncHandoffTasks(f.userId, f.handoffId); assert.equal(receiver().state, 'done');
  db.prepare("UPDATE handoffs SET status='failed' WHERE id=?").run(f.handoffId);
  tasks.syncHandoffTasks(f.userId, f.handoffId); assert.equal(receiver().state, 'needs_input');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM handoff_task_links WHERE handoff_id=? AND kind='receiver'").get(f.handoffId).n, 1);
});

test('pending handoff asks sender; decline and opt-out create no receiver task', () => {
  const f = fixture();
  db.prepare("UPDATE handoffs SET status='pending_approval' WHERE id=?").run(f.handoffId);
  tasks.syncHandoffTasks(f.userId, f.handoffId);
  const gate = db.prepare("SELECT t.* FROM tasks t JOIN handoff_task_links l ON l.task_id=t.id WHERE l.handoff_id=?").get(f.handoffId);
  assert.equal(gate.bot_id, f.bots[0].id); assert.equal(gate.state, 'needs_input');
  db.prepare("UPDATE handoffs SET status='declined' WHERE id=?").run(f.handoffId); tasks.syncHandoffTasks(f.userId, f.handoffId);
  assert.equal(db.prepare('SELECT state FROM tasks WHERE id=?').get(gate.id).state, 'done');
  db.prepare("UPDATE handoffs SET status='queued', create_task=0 WHERE id=?").run(f.handoffId); tasks.syncHandoffTasks(f.userId, f.handoffId);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM handoff_task_links WHERE handoff_id=? AND kind='receiver'").get(f.handoffId).n, 0);
});

test('task output association uses the producer and done state; replays do not create outputs', () => {
  const f = fixture(); assert.equal(tasks.linkTaskOutput(f.userId, f.taskId, f.job.id), false);
  db.prepare("UPDATE tasks SET state='done' WHERE id=?").run(f.taskId);
  assert.equal(tasks.linkTaskOutput(f.userId, f.taskId, f.job.id), true);
  assert.equal(tasks.linkTaskOutput(f.userId, f.taskId, f.job.id), true);
  assert.equal(db.prepare('SELECT task_id FROM run_outputs WHERE id=?').get(f.outputId).task_id, f.taskId);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM run_outputs WHERE user_id=?').get(f.userId).n, 1);
});

test('foreign loop, task, handoff and room ids cannot be projected', () => {
  const a = fixture(), b = fixture();
  assert.throws(() => tasks.syncLoopTasks(b.userId, a.loopId), /not found/);
  assert.throws(() => tasks.syncHandoffTasks(b.userId, a.handoffId), /not found/);
  assert.throws(() => tasks.linkTaskOutput(b.userId, a.taskId, a.job.id), /not found/);
  assert.throws(() => rooms.roomHandoffTargets(b.userId, a.roomId, a.bots[0].id), /not found/);
  assert.deepEqual(tasks.getTaskHandoffLinks(b.userId), {});
  db.prepare('UPDATE loops SET task_id=? WHERE id=?').run(a.taskId, b.loopId);
  assert.throws(() => b.transition('awaiting_approval'), /not found/);
  assert.equal(a.task().state, 'working');
});

test('room targets list members first and refuse rooms, outsiders, foreign agents and setup', () => {
  const f = fixture(), other = fixture();
  const targets = rooms.roomHandoffTargets(f.userId, f.roomId, f.bots[0].id);
  assert.equal(targets[0].id, f.bots[1].id); assert.equal(targets[0].disabled, false);
  assert.ok(targets.slice(1).every(t => !t.member && t.disabled));
  for (const id of [f.roomId, f.bots[0].id, f.bots[2].id, other.bots[0].id]) assert.throws(() => rooms.assertRoomHandoffTarget(f.userId, f.roomId, f.bots[0].id, id));
  db.prepare("UPDATE bot_setups SET onboarding_status='interviewing' WHERE bot_id=?").run(f.bots[1].id);
  assert.throws(() => rooms.assertRoomHandoffTarget(f.userId, f.roomId, f.bots[0].id, f.bots[1].id));
});

test('one compact room event per transition, no internal payloads, safe replay', () => {
  const f = fixture(), kinds = ['created', 'approval_requested', 'approved', 'declined', 'started', 'step_dispatched', 'step_completed', 'step_failed', 'verdict', 'paused', 'resumed', 'extended', 'finished'];
  for (const type of kinds) {
    const seq = event(f, `loop.${type}`, { iteration: 3, gaps: 2, stopReason: 'passed', instruction: 'PRIVATE_INSTRUCTION', body: 'PRIVATE_BODY', feedback: 'PRIVATE_FEEDBACK', packet: 'PRIVATE_PACKET' });
    assert.equal(rooms.postLoopRoomEvent(f.userId, seq), rooms.postLoopRoomEvent(f.userId, seq));
  }
  for (const type of ['handoff.read', 'output.finalized', 'verdict.corrected']) assert.equal(rooms.postLoopRoomEvent(f.userId, event(f, type, { body: 'PRIVATE_BODY' })), null);
  const rows = db.prepare("SELECT * FROM rows WHERE bot_id=? AND kind='event'").all(f.roomId);
  assert.equal(rows.length, kinds.length); assert.ok(!JSON.stringify(rows).includes('PRIVATE_'));
  assert.ok(rows.every(row => JSON.parse(row.body).audience === 'user'));
  assert.equal(JSON.parse(rows.at(-1).body).text, 'Done in 3 passes');
  assert.ok(rows.every(row => JSON.parse(row.body).ref.startsWith(`#loop/${f.loopId}`)));
});

test('room projection and notifications roll back with the service transaction', () => {
  const f = fixture(), seq = event(f, 'loop.started'), notifications = [];
  const stop = hub.subscribe(f.userId, e => notifications.push(e));
  assert.throws(() => transactionWithEffects(() => { rooms.postLoopRoomEvent(f.userId, seq); tasks.syncLoopTasks(f.userId, f.loopId); throw new Error('rollback'); }), /rollback/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM rows WHERE bot_id=?').get(f.roomId).n, 0);
  assert.deepEqual(notifications, []); stop();
});

test('room handoff receipt updates once in place and never contains the instruction', () => {
  const f = fixture(), seq = rooms.postRoomHandoff(f.userId, f.handoffId);
  assert.equal(rooms.postRoomHandoff(f.userId, f.handoffId), seq);
  db.prepare("UPDATE handoffs SET status='completed' WHERE id=?").run(f.handoffId);
  assert.equal(rooms.postRoomHandoff(f.userId, f.handoffId), seq);
  const rows = db.prepare("SELECT body FROM rows WHERE bot_id=? AND kind='handoff'").all(f.roomId);
  assert.equal(rows.length, 1); assert.equal(JSON.parse(rows[0].body).status, 'completed');
  assert.ok(!rows[0].body.includes('Check the test draft'));
});

test('ordinary room dispatch keeps the three responder cap and has no loop parsing', () => {
  const f = fixture(); db.prepare('UPDATE bots SET members=? WHERE id=?').run(JSON.stringify(f.bots.map(b => b.id)), f.roomId);
  const calls = []; dispatchRoomMessage(f.roomId, 'Please discuss the loop', (id, trigger) => calls.push({ id, trigger }));
  assert.equal(calls.length, 3);
  calls.length = 0; dispatchRoomMessage(f.roomId, '@Checker loop', (id, trigger) => calls.push({ id, trigger }));
  assert.deepEqual(calls.map(c => c.id), [f.bots[1].id]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM loops WHERE user_id=?').get(f.userId).n, 1);
});


test('task links API requires a session, scopes results, and honors both feature switches', async () => {
  const a = fixture(), b = fixture(); a.transition('awaiting_approval');
  for (const f of [a, b]) db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(session_hash(?),?,?,?)').run(f.userId, f.userId, Date.now(), Date.now() + 60000);
  assert.equal((await tasks.handoffTasksApi.request('/handoff-task-links')).status, 401);
  const get = f => tasks.handoffTasksApi.request('/handoff-task-links', { headers: { cookie: `swarm_session=${f.userId}` } });
  const response = await get(a); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).links[a.taskId].loopId, a.loopId);
  assert.deepEqual((await (await get(b)).json()).links, {});
  db.prepare('INSERT INTO handoff_user_settings(user_id,enabled,updated_at) VALUES(?,0,?)').run(a.userId, Date.now());
  assert.equal((await get(a)).status, 503);
  process.env.HANDOFFS_DISABLED = '1';
  try { assert.equal((await get(b)).status, 503); } finally { delete process.env.HANDOFFS_DISABLED; }
});


test('owned implementation files contain no em or en dash copy', () => {
  for (const file of ['server/src/handoffs/rooms.ts', 'server/src/handoffs/tasks.ts', 'web/src/components/config/TaskCards.tsx', 'web/src/components/config/TasksView.tsx', 'web/src/components/config/BotTasksPage.tsx']) {
    assert.doesNotMatch(fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'), /[\u2013\u2014]/, file);
  }
});


test('single event projection entry point updates room and tasks and is replay safe', () => {
  const f = fixture();
  db.prepare("UPDATE loops SET status='awaiting_approval' WHERE id=?").run(f.loopId);
  const seq = event(f, 'loop.approval_requested', { iteration: 1 });
  rooms.projectHandoffEvent(f.userId, seq); rooms.projectHandoffEvent(f.userId, seq);
  assert.equal(f.task().state, 'needs_input');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM rows WHERE bot_id=? AND kind='event'").get(f.roomId).n, 1);
  const handoffSeq = Number(db.prepare("INSERT INTO handoff_events(user_id,handoff_id,type,data,created_at) VALUES(?,?,'handoff.created','{}',?)").run(f.userId, f.handoffId, Date.now()).lastInsertRowid);
  rooms.projectHandoffEvent(f.userId, handoffSeq); rooms.projectHandoffEvent(f.userId, handoffSeq);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM handoff_task_links WHERE handoff_id=? AND kind='receiver'").get(f.handoffId).n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM rows WHERE bot_id=? AND kind='handoff'").get(f.roomId).n, 1);
});
