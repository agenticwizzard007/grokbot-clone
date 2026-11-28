import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fixture, makeLoop, spec, db, loops, runLoop, cleanup, jobs, finish, handoffs, output, hdb, hub, reconcile } from './server-fixture.test.mts';
const { createRoom } = await import('../../server/src/agent/rooms.js');
const { projectHandoffEvent } = await import('../../server/src/handoffs/rooms.js');
const { recoverHandoffProjections } = await import('../../server/src/handoffs/projections.js');
const { transactionWithEffects } = await import('../../server/src/lib/commit-effects.js');
after(cleanup);
const tick = () => new Promise(resolve => setImmediate(resolve));

function roomFixture() {
  const f = fixture();
  const roomId = createRoom(f.userId, 'Release review', [f.maker.id, f.checker.id]);
  const taskId = `task-${f.userId}`;
  db.prepare("INSERT INTO tasks(id,bot_id,title,state,note,created_at,updated_at) VALUES(?,?,?,'done','Ready',?,?)")
    .run(taskId, f.maker.id, 'Release draft', Date.now(), Date.now());
  return { ...f, roomId, taskId };
}
function task(id: string) { return db.prepare('SELECT state,note FROM tasks WHERE id=?').get(id) as { state: string; note: string }; }
function roomRows(roomId: string) {
  return (db.prepare("SELECT seq,body FROM rows WHERE bot_id=? AND kind IN ('event','handoff') ORDER BY seq").all(roomId) as { seq: number; body: string }[])
    .map(row => ({ seq: row.seq, body: JSON.parse(row.body) }));
}
function projected(seq: number) { return !!db.prepare('SELECT 1 FROM handoff_event_projections WHERE event_seq=?').get(seq); }

test('committed service transitions project room progress and linked task notes', async () => {
  const f = roomFixture(), l = makeLoop(f, { roomId: f.roomId, taskId: f.taskId }, false);
  assert.equal(roomRows(f.roomId).length, 0);
  await tick();
  assert.deepEqual(task(f.taskId), { state: 'working', note: 'Loop in progress.' });
  loops.controlLoop(f.userId, l.id, 'start');
  await tick();
  loops.controlLoop(f.userId, l.id, 'pause');
  await tick();
  assert.deepEqual(task(f.taskId), { state: 'working', note: 'Loop paused.' });
  loops.controlLoop(f.userId, l.id, 'resume');
  await tick();
  loops.controlLoop(f.userId, l.id, 'stop');
  await tick();
  assert.deepEqual(task(f.taskId), { state: 'needs_input', note: 'Stopped by you.' });
  for (const type of ['loop.created', 'loop.started', 'loop.paused', 'loop.resumed', 'loop.finished']) {
    const event = hdb.events(f.userId, { loopId: l.id }).find(e => e.type === type)!;
    assert.ok(event, type);
    assert.ok(projected(event.seq));
    const rows = roomRows(f.roomId).filter(row => row.body.ref === `#loop/${l.id}?event=${event.seq}`);
    assert.equal(rows.length, 1, type);
  }
  assert.ok(roomRows(f.roomId).some(row => row.body.text === 'Loop stopped: Stopped by you'));
});

test('converged loop projects each pass and completes its task without leaking content', async () => {
  const f = roomFixture(), l = makeLoop(f, { roomId: f.roomId, taskId: f.taskId });
  assert.equal((await runLoop(f, l.id)).stopReason, 'passed');
  await tick();
  assert.deepEqual(task(f.taskId), { state: 'done', note: 'All checks passed.' });
  const rows = roomRows(f.roomId);
  for (const pass of [1, 2, 3]) assert.ok(rows.some(row => row.body.text.startsWith(`Pass ${pass} of 3:`)));
  assert.ok(rows.some(row => row.body.text === 'Done in 3 passes'));
  assert.doesNotMatch(JSON.stringify(rows), /Placeholder|Fixture feedback|release note bullets/);
  const before = JSON.stringify(rows);
  for (const event of hdb.events(f.userId, { loopId: l.id })) projectHandoffEvent(f.userId, event.seq);
  reconcile.recoverHandoffs();
  await tick();
  assert.equal(JSON.stringify(roomRows(f.roomId)), before);
});

for (const managed of [true, false]) test(`${managed ? 'managed' : 'unmanaged'} rollback never projects rows, tasks or SSE`, async () => {
  const f = roomFixture(), seen: string[] = [];
  const stop = hub.subscribe(f.userId, event => seen.push(event.type));
  const write = () => {
    makeLoop(f, { roomId: f.roomId, taskId: f.taskId }, false);
    assert.equal(roomRows(f.roomId).length, 0);
    throw new Error('Rollback');
  };
  try {
    assert.throws(() => managed ? transactionWithEffects(write) : db.transaction(write)(), /Rollback/);
    await tick();
    recoverHandoffProjections(f.userId);
    assert.deepEqual(task(f.taskId), { state: 'done', note: 'Ready' });
    assert.equal(roomRows(f.roomId).length, 0);
    assert.equal(hdb.db.prepare('SELECT 1 FROM handoff_events WHERE user_id=?').get(f.userId), undefined);
    assert.deepEqual(seen, []);
  } finally { stop(); }
});

test('unmanaged committed transaction projects after the outer commit', async () => {
  const f = roomFixture();
  db.transaction(() => {
    makeLoop(f, { roomId: f.roomId, taskId: f.taskId }, false);
    assert.equal(roomRows(f.roomId).length, 0);
    assert.equal(task(f.taskId).note, 'Ready');
  })();
  await tick();
  assert.equal(roomRows(f.roomId).length, 1);
  assert.equal(task(f.taskId).note, 'Loop in progress.');
});

test('projection failure is isolated, logged and retried atomically by recovery', async t => {
  const f = roomFixture(), seen: string[] = [];
  const stop = hub.subscribe(f.userId, event => { if (['rows', 'tasks'].includes(event.type)) seen.push(event.type); });
  const errors = t.mock.method(console, 'error', () => {});
  db.exec(`CREATE TEMP TRIGGER fail_room_projection BEFORE INSERT ON rows
    WHEN NEW.bot_id='${f.roomId}' BEGIN SELECT RAISE(ABORT,'Projection unavailable'); END;`);
  try {
    const l = makeLoop(f, { roomId: f.roomId, taskId: f.taskId }, false);
    await tick();
    assert.equal(loops.getLoop(f.userId, l.id).status, 'draft');
    assert.deepEqual(task(f.taskId), { state: 'done', note: 'Ready' });
    assert.equal(roomRows(f.roomId).length, 0);
    assert.deepEqual(seen, []);
    const event = hdb.events(f.userId, { loopId: l.id })[0];
    assert.equal(projected(event.seq), false);
    assert.ok(errors.mock.calls.some(call => String(call.arguments[0]).includes('projection failed; deferred for recovery')));
    db.exec('DROP TRIGGER fail_room_projection');
    reconcile.recoverHandoffs();
    assert.ok(projected(event.seq));
    assert.equal(task(f.taskId).note, 'Loop in progress.');
    assert.equal(roomRows(f.roomId).length, 1);
    const count = seen.length;
    reconcile.recoverHandoffs();
    assert.equal(seen.length, count);
  } finally { db.exec('DROP TRIGGER IF EXISTS fail_room_projection'); stop(); }
});

test('recovery backfills historical terminal events and replay does not duplicate notifications', async () => {
  const f = roomFixture(), l = makeLoop(f, { roomId: f.roomId, taskId: f.taskId }, false);
  loops.controlLoop(f.userId, l.id, 'stop');
  await tick();
  db.prepare('DELETE FROM rows WHERE bot_id=?').run(f.roomId);
  db.prepare('DELETE FROM handoff_event_projections WHERE event_seq IN (SELECT seq FROM handoff_events WHERE user_id=?)').run(f.userId);
  db.prepare("UPDATE tasks SET state='working',note='' WHERE id=?").run(f.taskId);
  reconcile.recoverHandoffs();
  const rows = roomRows(f.roomId);
  assert.equal(rows.length, 2);
  assert.deepEqual(task(f.taskId), { state: 'needs_input', note: 'Stopped by you.' });
  const seen: string[] = [], stop = hub.subscribe(f.userId, event => seen.push(event.type));
  try {
    db.prepare('DELETE FROM handoff_event_projections WHERE event_seq IN (SELECT seq FROM handoff_events WHERE user_id=?)').run(f.userId);
    reconcile.recoverHandoffs();
    assert.deepEqual(roomRows(f.roomId), rows);
    assert.deepEqual(seen, []);
  } finally { stop(); }
});

test('process exit between commit and projection is recovered without duplicate room rows', () => {
  const f = roomFixture();
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { writeSync } from 'node:fs';
    const { createLoop } = await import('./server/src/handoffs/loop-service.ts');
    const result = createLoop(${JSON.stringify(f.userId)}, ${JSON.stringify({ spec: spec(f, { roomId: f.roomId, taskId: f.taskId }), idempotencyKey: 'exit-before-projection', start: false })});
    writeSync(1, result.loop.id);
    process.exit(0);
  `], { env: process.env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const event = hdb.events(f.userId, { loopId: child.stdout })[0];
  assert.ok(event);
  assert.equal(projected(event.seq), false);
  assert.equal(roomRows(f.roomId).length, 0);
  reconcile.recoverHandoffs();
  reconcile.recoverHandoffs();
  assert.ok(projected(event.seq));
  assert.equal(roomRows(f.roomId).length, 1);
  assert.equal(task(f.taskId).note, 'Loop in progress.');
});

for (const linked of [true, false]) test(`agent gate tasks stay unique and resolve with ${linked ? 'a linked task' : 'no linked task'}`, async () => {
  const f = roomFixture();
  const l = loops.createLoop(f.userId, { spec: spec(f, { roomId: f.roomId, ...(linked ? { taskId: f.taskId } : {}) }), idempotencyKey: 'gate', start: true }, 'agent', f.maker.id).loop;
  await tick();
  const tasks = () => db.prepare("SELECT t.* FROM tasks t JOIN handoff_task_links l ON l.task_id=t.id WHERE l.loop_id=? AND t.state='needs_input'").all(l.id);
  assert.equal(tasks().length, 1);
  if (!linked) assert.match((tasks()[0] as { title: string }).title, /^Approve loop:/);
  reconcile.recoverHandoffs();
  assert.equal(tasks().length, 1);
  loops.controlLoop(f.userId, l.id, 'approve');
  await tick();
  assert.equal(tasks().length, 0);
  loops.controlLoop(f.userId, l.id, 'stop');
  await tick();
  assert.equal(tasks().length, linked ? 1 : 0);
});

test('real handoff completion updates one room receipt and the existing receiver task', async () => {
  const f = roomFixture(), source = output(f);
  const h = handoffs.createHandoff(f.userId, { source: { outputId: source.id }, toBotId: f.checker.id, instruction: 'Review the release.', roomId: f.roomId, createTask: true, returnResult: false, idempotencyKey: 'room-send' }).handoff;
  await tick();
  reconcile.reconcileHandoffs(f.userId);
  await tick();
  const receiver = db.prepare("SELECT * FROM agent_jobs WHERE bot_id=? AND state IN ('queued','running')").get(f.checker.id) as { id: string };
  assert.ok(receiver);
  const linkedTasks = () => db.prepare("SELECT t.* FROM tasks t JOIN handoff_task_links l ON t.id=l.task_id WHERE l.handoff_id=? AND l.kind='receiver'").all(h.id) as { id: string; state: string; note: string }[];
  assert.equal(linkedTasks().length, 1);
  assert.equal(linkedTasks()[0].note, 'Handoff in progress.');
  const receipt = roomRows(f.roomId).find(row => row.body.handoffId === h.id)!;
  assert.ok(receipt);
  jobs.beginJob(receiver.id);
  finish(f, receiver.id, 'The release is ready.');
  await tick();
  assert.equal(linkedTasks().length, 1);
  assert.equal(linkedTasks()[0].state, 'done');
  assert.equal(linkedTasks()[0].note, 'Handoff completed.');
  const rows = roomRows(f.roomId).filter(row => row.body.handoffId === h.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].seq, receipt.seq);
  assert.equal(rows[0].body.status, 'completed');
});
