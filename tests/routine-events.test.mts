import assert from 'node:assert/strict';
import { after, test, mock } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-routine-events-'));
Object.assign(process.env, {
  DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'),
  DEV_LOGIN: '1', SESSION_SECRET: 'events-test-only', COMPUTER_PROVIDER: 'local',
  COMPOSIO_API_KEY: 'mock-toolkit', DIRECT_API_KEY: '', OPENROUTER_API_KEY: '', INKBOX_TUNNEL: '0',
  ROUTINE_EVENT_MIN_GAP_SEC: '60', ROUTINE_MAX_RUNS_PER_DAY: '5', ROUTINE_PAUSE_IF_USER_IDLE_DAYS: '30',
});
mock.method(globalThis, 'fetch', async () => { throw new Error('Network is disabled in this fixture.'); });
const { composio } = await import('../server/src/composio.js');
mock.method(composio().triggers, 'subscribe', async () => {
  (composio().triggers as any).pusherService.connection = { channel: { subscribed: true, bind() {}, unbind() {} } };
});
mock.method(composio().triggers, 'enable', async () => ({}));
mock.method(composio().triggers, 'disable', async () => ({}));
const { db } = await import('../server/src/db.js');
const { acceptJob, beginJob, finishJob } = await import('../server/src/agent/jobs.js');
const { onJobStarted, onJobFinished } = await import('../server/src/deliverables/runs.js');
const { onTrigger, initTriggers } = await import('../server/src/triggers.js');
const { drainTriggerEvents } = await import('../server/src/trigger-events.js');
const { prepareEventInbox, deliverRuntimeEvents } = await import('../server/src/runtime/event-inbox.js');
prepareEventInbox(db);
after(() => { mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

let sequence = 0;
function fixture() {
  const id = `fixture_${++sequence}`, bot = `${id}_bot`, routine = `${id}_routine`, trigger = `${id}_trigger`;
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(id, `${id}@example.test`, 'Fixture', Date.now());
  db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(bot, id, 'Events', Date.now(), Date.now());
  db.prepare("INSERT INTO routines(id,bot_id,name,prompt,schedule,created_at,trigger_id) VALUES(?,?,?,'Process every event','event:TEST_EVENT',?,?)")
    .run(routine, bot, 'Fixture events', Date.now(), trigger);
  return { id, bot, routine, trigger };
}
type Fixture = ReturnType<typeof fixture>;
const enqueue = (botId: string, trigger: unknown) => acceptJob(botId, trigger).id;
const receipts = (f: Fixture) => db.prepare('SELECT * FROM routine_event_receipts WHERE routine_id=? ORDER BY received_at,rowid').all(f.routine) as any[];
const jobs = (f: Fixture) => db.prepare("SELECT * FROM agent_jobs WHERE bot_id=? AND json_extract(trigger,'$.routineId')=? ORDER BY rowid").all(f.bot, f.routine) as any[];
const quota = (f: Fixture) => (db.prepare('SELECT count(*) n FROM routine_runs WHERE user_id=?').get(f.id) as any).n;
const event = (f: Fixture, messageId: string) => ({ id: f.trigger, payload: { messageId } });
const expireGap = (f: Fixture) => db.prepare('UPDATE routines SET last_run_at=? WHERE id=?').run(Date.now() - 61_000, f.routine);
function complete(f: Fixture, jobId = jobs(f).at(-1).id) {
  beginJob(jobId); onJobStarted({ jobId, botId: f.bot });
  finishJob(jobId, true); onJobFinished({ jobId, botId: f.bot, status: 'completed' });
}
function restart(program: string, exitCode = 0) {
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    globalThis.fetch = async () => { throw Error('Network is disabled in this fixture.'); };
    const {composio} = await import('./server/src/composio.ts');
    composio().triggers.subscribe = async () => { composio().triggers.pusherService.connection = { channel: { subscribed: true, bind() {}, unbind() {} } }; };
    composio().triggers.enable = async () => ({});
    composio().triggers.disable = async () => ({});
    const {db} = await import('./server/src/db.ts');
    const jobs = await import('./server/src/agent/jobs.ts');
    const runs = await import('./server/src/deliverables/runs.ts');
    const triggers = await import('./server/src/triggers.ts');
    ${program}
    db.close();
  `], { cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 20_000 });
  assert.equal(child.status, exitCode, child.stderr || child.stdout);
}

test('distinct events during queued and running work are retained and processed in one later batch', () => {
  const f = fixture();
  onTrigger(event(f, 'first'), 'first'); drainTriggerEvents(enqueue);
  const first = jobs(f)[0];
  onTrigger(event(f, 'queued'), 'queued');
  beginJob(first.id); onJobStarted({ jobId: first.id, botId: f.bot });
  const large = { id: f.trigger, payload: { body: 'x'.repeat(9000), tail: 'retained-tail' } };
  onTrigger(large, 'running'); onTrigger(event(f, 'queued'), 'queued');
  // Even a long running job must block another admission after the old in-memory timeout.
  db.prepare('UPDATE agent_jobs SET started_at=? WHERE id=?').run(Date.now() - 31 * 60_000, first.id);
  expireGap(f); drainTriggerEvents(enqueue);
  assert.equal(jobs(f).length, 1); assert.equal(quota(f), 1);
  assert.equal(receipts(f).filter(r => !r.job_id).length, 2);
  finishJob(first.id, true); onJobFinished({ jobId: first.id, botId: f.bot, status: 'completed' });
  drainTriggerEvents(enqueue);
  const batch = jobs(f)[1], prompt = JSON.parse(batch.trigger).prompt;
  assert.ok(prompt.includes(JSON.stringify(large.payload)), 'the entire payload reaches the job');
  assert.equal(prompt.match(/"messageId":"queued"/g)?.length, 1);
  assert.ok(!prompt.includes('"messageId":"first"'));
  assert.equal(receipts(f).filter(r => r.job_id === batch.id).length, 2);
  assert.equal(quota(f), 2);
  complete(f, batch.id); expireGap(f);
  onTrigger(event(f, 'first'), 'first'); onTrigger(large, 'running'); drainTriggerEvents(enqueue);
  assert.equal(jobs(f).length, 2, 'completed receipts still deduplicate redelivery');
});

test('spacing retains multiple payloads until eligible, including identical payloads with distinct delivery IDs', () => {
  const f = fixture();
  db.prepare('UPDATE routines SET last_run_at=? WHERE id=?').run(Date.now(), f.routine);
  onTrigger(event(f, 'same'), 'delivery-a'); onTrigger(event(f, 'same'), 'delivery-b');
  drainTriggerEvents(enqueue);
  assert.equal(jobs(f).length, 0); assert.equal(quota(f), 0); assert.equal(receipts(f).length, 2);
  expireGap(f); drainTriggerEvents(enqueue);
  assert.equal(jobs(f).length, 1); assert.equal(quota(f), 1);
  assert.equal(JSON.parse(jobs(f)[0].trigger).prompt.match(/"messageId":"same"/g)?.length, 2);
  complete(f);
});

test('tenant acknowledgement follows retention, and lost acknowledgements and restart do not duplicate jobs', async () => {
  const f = fixture();
  db.prepare('UPDATE routines SET last_run_at=? WHERE id=?').run(Date.now(), f.routine);
  const page = ['restart-a', 'restart-b'].map(id => ({ id, ciphertext: id }));
  const delivery = {
    open: (e: any) => event(f, e.id), authorize: async () => {},
    apply: (payload: any, e: any) => onTrigger(payload, e.id), retryable: () => false,
  };
  assert.deepEqual(await deliverRuntimeEvents(db, page, delivery), page.map(e => e.id));
  assert.equal(receipts(f).length, 2); assert.equal(jobs(f).length, 0);
  expireGap(f);
  restart(`await triggers.initTriggers((bot, trigger) => jobs.acceptJob(bot, trigger).id);`);
  const admitted = jobs(f)[0];
  assert.ok(admitted); assert.equal(receipts(f).filter(r => r.job_id === admitted.id).length, 2);
  assert.deepEqual(await deliverRuntimeEvents(db, page, delivery), page.map(e => e.id));
  restart(`jobs.recoverJobs(); runs.recoverRoutineRuns();
    await triggers.initTriggers((bot, trigger) => jobs.acceptJob(bot, trigger).id);`);
  assert.deepEqual(jobs(f).map(j => j.id), [admitted.id], 'queued work survives without replacement');
  complete(f);
});

test('restart retains new events without replaying a job whose external effects are uncertain', () => {
  const f = fixture();
  onTrigger(event(f, 'started'), 'started'); drainTriggerEvents(enqueue);
  const first = jobs(f)[0];
  beginJob(first.id); onJobStarted({ jobId: first.id, botId: f.bot });
  onTrigger(event(f, 'after-start'), 'after-start'); expireGap(f);
  restart(`jobs.recoverJobs(); runs.recoverRoutineRuns();
    await triggers.initTriggers((bot, trigger) => jobs.acceptJob(bot, trigger).id);`);
  const recovered = jobs(f);
  assert.equal(recovered.length, 2); assert.equal(recovered[0].state, 'uncertain');
  assert.equal(JSON.parse(recovered[1].trigger).prompt.includes('"messageId":"after-start"'), true);
  assert.equal(JSON.parse(recovered[1].trigger).prompt.includes('"messageId":"started"'), false);
  complete(f);
});

test('process loss before the inbox commit rolls back retention and allows safe redelivery', async () => {
  const f = fixture(), data = event(f, 'uncommitted');
  restart(`db.transaction(() => {
    triggers.onTrigger(${JSON.stringify(data)}, 'uncommitted');
    db.prepare('INSERT INTO runtime_events VALUES(?,?)').run('uncommitted', Date.now());
    process.exit(65);
  })();`, 65);
  assert.equal(receipts(f).length, 0);
  assert.equal(db.prepare("SELECT 1 FROM runtime_events WHERE id='uncommitted'").get(), undefined);
  const ack = await deliverRuntimeEvents(db, [{ id: 'uncommitted', ciphertext: 'fixture' }], {
    open: () => data, authorize: async () => {},
    apply(payload, e) {
      onTrigger(payload, e.id);
      drainTriggerEvents(enqueue);
      assert.equal(jobs(f).length, 0, 'work must not start inside the inbox transaction');
    },
    retryable: () => false,
  });
  assert.deepEqual(ack, ['uncommitted']); assert.equal(receipts(f).length, 1);
  drainTriggerEvents(enqueue); assert.equal(jobs(f).length, 1); complete(f);
});

test('failed admission rolls back jobs, quota, execution and receipt assignment together', () => {
  const f = fixture(); onTrigger(event(f, 'retry'), 'retry');
  drainTriggerEvents((bot, trigger) => { acceptJob(bot, trigger); throw new Error('Queue unavailable'); });
  assert.equal(jobs(f).length, 0); assert.equal(quota(f), 0);
  assert.equal(receipts(f)[0].job_id, null);
  assert.equal((db.prepare('SELECT last_run_at FROM routines WHERE id=?').get(f.routine) as any).last_run_at, null);
  assert.equal((db.prepare('SELECT count(*) n FROM routine_executions WHERE routine_id=?').get(f.routine) as any).n, 0);
  drainTriggerEvents(enqueue); assert.equal(jobs(f).length, 1); complete(f);
});

test('account quotas, idle pauses and disabled routines defer retained events without spending extra runs', () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) db.prepare("INSERT INTO routine_runs VALUES(?,?,'manual',?)").run(f.id, f.routine, Date.now());
  onTrigger(event(f, 'limited'), 'limited'); drainTriggerEvents(enqueue);
  assert.equal(jobs(f).length, 0); assert.equal(quota(f), 5); assert.equal(receipts(f).length, 1);
  db.prepare('UPDATE routine_runs SET at=? WHERE user_id=?').run(Date.now() - 25 * 3600_000, f.id);
  db.prepare('UPDATE users SET created_at=? WHERE id=?').run(Date.now() - 40 * 86400_000, f.id);
  drainTriggerEvents(enqueue); assert.equal(jobs(f).length, 0);
  db.prepare('UPDATE users SET created_at=? WHERE id=?').run(Date.now(), f.id);
  db.prepare('UPDATE routines SET enabled=0 WHERE id=?').run(f.routine);
  drainTriggerEvents(enqueue); assert.equal(jobs(f).length, 0);
  db.prepare('UPDATE routines SET enabled=1 WHERE id=?').run(f.routine);
  drainTriggerEvents(enqueue); assert.equal(jobs(f).length, 1); assert.equal(quota(f), 6); complete(f);
});

test('realtime receipts deduplicate stable content without confusing subscription IDs with event IDs', () => {
  const f = fixture();
  onTrigger({ id: f.trigger, uuid: 'subscription', payload: { messageId: 'one', text: 'body' } });
  onTrigger({ payload: { text: 'body', messageId: 'one' }, uuid: 'subscription', id: f.trigger });
  onTrigger({ id: f.trigger, uuid: 'subscription', payload: { messageId: 'two', text: 'body' } });
  assert.equal(receipts(f).length, 2);
  drainTriggerEvents(enqueue); assert.equal(jobs(f).length, 1); complete(f);
});

test('bounded batches retain overflow for a later eligible run', () => {
  const f = fixture();
  for (let i = 0; i < 53; i++) onTrigger(event(f, `item-${i}`), `item-${i}`);
  drainTriggerEvents(enqueue);
  assert.equal(receipts(f).filter(r => !r.job_id).length, 3);
  complete(f); expireGap(f); drainTriggerEvents(enqueue);
  assert.equal(receipts(f).filter(r => !r.job_id).length, 0);
  const ids = jobs(f).flatMap(j => [...JSON.parse(j.trigger).prompt.matchAll(/"messageId":"(item-\d+)"/g)].map(m => m[1]));
  assert.equal(ids.length, 53); assert.equal(new Set(ids).size, 53); complete(f);
});

test('initialization and the periodic drain process pending work without another incoming event', async () => {
  const f = fixture();
  db.prepare('UPDATE routines SET last_run_at=? WHERE id=?').run(Date.now(), f.routine);
  onTrigger(event(f, 'timer'), 'timer');
  await initTriggers(enqueue); assert.equal(jobs(f).length, 0);
  expireGap(f);
  const deadline = Date.now() + 4000;
  while (!jobs(f).length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(jobs(f).length, 1); complete(f);
});
