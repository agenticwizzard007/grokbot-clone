// Routine guardrails (server/src/routine-limits.ts): isolated database, no model or VM needed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-routine-limits-'));
Object.assign(process.env, {
  DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'), SESSION_SECRET: 'test-only-secret', COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '',
  ROUTINE_MIN_INTERVAL_MIN: '15', ROUTINE_MAX_PER_BOT: '3', ROUTINE_MAX_PER_USER: '4', ROUTINE_MAX_RUNS_PER_DAY: '5', ROUTINE_EVENT_MIN_GAP_SEC: '60', ROUTINE_PAUSE_IF_USER_IDLE_DAYS: '30',
});
const { db } = await import('../server/src/db.js');
await import('../server/src/db-config.js');
const { createBot } = await import('../server/src/bots.js');
const { appendRow } = await import('../server/src/store.js');
const { toolMap } = await import('../server/src/agent/tools.js');
const { runInBotQueue } = await import('../server/src/agent/loop.js');
const { initRoutines, runRoutine, unscheduleRoutine } = await import('../server/src/routines.js');
const { checkRoutineCreate, checkRoutineRun, minGapMinutes } = await import('../server/src/routine-limits.js');
const { Hono } = await import('hono');
const { api } = await import('../server/src/routes.js');
const app = new Hono().route('/api', api);

const DAY = 24 * 3600_000;
for (const id of ['u1', 'u2', 'idle']) db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(id, `${id}@example.com`, id, Date.now() - (id === 'idle' ? 40 * DAY : 0));
db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (?,?,?,?)').run('s1', 'u1', Date.now(), Date.now() + 60_000);
const b1 = createBot('u1', { name: 'One', isPrimary: true });
const b2 = createBot('u1', { name: 'Two' });
const idleBot = createBot('idle', { name: 'Idle', isPrimary: true });
const enqueued: { botId: string; t: any }[] = [];
initRoutines((botId, t) => { enqueued.push({ botId, t }); });

let n = 0;
function addRoutine(botId: string, schedule = '0 9 * * *', enabled = 1, lastRun: number | null = null) {
  const id = `rt_test${++n}`;
  db.prepare('INSERT INTO routines(id,bot_id,name,prompt,schedule,timezone,enabled,created_at,last_run_at) VALUES (?,?,?,?,?,?,?,?,?)').run(id, botId, `R${n}`, 'do it', schedule, 'UTC', enabled, Date.now(), lastRun);
  return id;
}
const routine = (id: string) => db.prepare('SELECT * FROM routines WHERE id=?').get(id) as any;
const req = (p: string, init: RequestInit = {}) => app.request(`/api${p}`, { ...init, headers: { 'content-type': 'application/json', cookie: 'swarm_session=s1', ...(init.headers ?? {}) } });

test('schedules faster than the minimum interval are refused, slower ones accepted', () => {
  assert.equal(minGapMinutes('*/5 * * * *'), 5);
  assert.match(checkRoutineCreate(b1.id, '*/5 * * * *')!, /at most every 15 minutes, and this schedule runs every 5/);
  assert.match(checkRoutineCreate(b1.id, '* * * * * *')!, /at most every 15 minutes/); // with seconds
  assert.match(checkRoutineCreate(b1.id, '0,5 9 * * *')!, /every 5/); // two runs 5 minutes apart once a day
  assert.equal(checkRoutineCreate(b1.id, '*/15 * * * *'), null);
  assert.equal(checkRoutineCreate(b1.id, '0 8 * * 1-5'), null);
  assert.equal(checkRoutineCreate(b1.id, 'event:GMAIL_NEW_GMAIL_MESSAGE'), null, 'event routines have no interval');
});

test('the Bot\'s create_routine tool enforces the interval and creates nothing', async () => {
  const before = (db.prepare('SELECT COUNT(*) n FROM routines').get() as any).n;
  const r = await toolMap.get('create_routine')!.impl({ name: 'Too often', prompt: 'check', schedule: '*/5 * * * *' }, { userId: 'u1', botId: b1.id } as any);
  assert.match(String(r.output), /at most every 15 minutes/);
  assert.match(String(r.output), /event routine/);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM routines').get() as any).n, before);
  const ok = await toolMap.get('create_routine')!.impl({ name: 'Morning', prompt: 'brief me', schedule: '0 8 * * *' }, { userId: 'u1', botId: b1.id } as any);
  assert.match(String(ok.output), /"ok":true/);
  for (const r of db.prepare('SELECT id FROM routines').all() as any[]) unscheduleRoutine(r.id);
  db.prepare('DELETE FROM routines').run();
});

test('active routines are capped per Bot and per account; paused ones don\'t count', () => {
  for (let i = 0; i < 3; i++) addRoutine(b1.id);
  assert.match(checkRoutineCreate(b1.id, '0 9 * * *')!, /already has 3 active routines \(the limit is 3\)/);
  addRoutine(b1.id, '0 9 * * *', 0); // paused
  assert.equal(checkRoutineCreate(b2.id, '0 9 * * *'), null);
  addRoutine(b2.id);
  assert.match(checkRoutineCreate(b2.id, '0 9 * * *')!, /account already has 4 active routines/);
});

test('re-enabling a paused routine respects the caps (API)', async () => {
  const paused = (db.prepare("SELECT id FROM routines WHERE enabled=0").get() as any).id;
  const r = await req(`/routines/${paused}`, { method: 'PATCH', body: JSON.stringify({ enabled: true }) });
  assert.equal(r.status, 429);
  assert.match((await r.json()).error, /active routines/);
  for (const x of db.prepare('SELECT id FROM routines').all() as any[]) unscheduleRoutine(x.id);
  db.prepare('DELETE FROM routines').run();
});

test('timed runs respect the minimum interval even for older, faster routines', () => {
  const id = addRoutine(b1.id, '*/5 * * * *', 1, Date.now() - 5 * 60_000);
  assert.deepEqual(runRoutine(id, 'schedule'), { ok: false, reason: 'routines run at most every 15 minutes' });
  db.prepare('UPDATE routines SET last_run_at=? WHERE id=?').run(Date.now() - 16 * 60_000, id);
  assert.equal(runRoutine(id, 'schedule').ok, true);
  assert.equal(enqueued.at(-1)?.t.routineId, id);
});

test('a run is skipped while the same routine\'s previous run is still going', async () => {
  const id = addRoutine(b2.id);
  let release!: () => void;
  const busy = runInBotQueue(b2.id, () => new Promise<void>((r) => { release = r; }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(runRoutine(id, 'manual').ok, true);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(runRoutine(id, 'manual'), { ok: false, reason: 'its previous run is still going' });
  release();
  await busy;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(runRoutine(id, 'manual').ok, true, 'runs again once the previous turn finished');
});

test('event bursts are combined: one run per routine per 60 s', () => {
  const id = addRoutine(b1.id, 'event:SLACK_RECEIVE_MESSAGE', 1, Date.now() - 10_000);
  assert.deepEqual(checkRoutineRun(routine(id), 'event'), { ok: false, reason: 'events within 60 seconds of the last run are combined into it' });
  db.prepare('UPDATE routines SET last_run_at=? WHERE id=?').run(Date.now() - 61_000, id);
  assert.equal(checkRoutineRun(routine(id), 'event').ok, true);
});

test('an account gets at most N routine runs per 24 hours, across all its routines and run kinds', async () => {
  const used = (db.prepare("SELECT COUNT(*) n FROM routine_runs WHERE user_id='u1' AND at>?").get(Date.now() - DAY) as any).n;
  for (let i = used; i < 5; i++) { const id = addRoutine(b1.id, '0 9 * * *', 1); assert.equal(checkRoutineRun(routine(id), 'manual').ok, true); }
  const id = addRoutine(b1.id);
  assert.deepEqual(checkRoutineRun(routine(id), 'schedule'), { ok: false, reason: 'this account reached its limit of 5 routine runs in 24 hours' });
  const r = await req(`/routines/${id}/run`, { method: 'POST' });
  assert.equal(r.status, 429);
  assert.match((await r.json()).error, /limit of 5 routine runs/);
});

test('routines of an account idle for 30 days are paused, and resume when the user is back', () => {
  const id = addRoutine(idleBot.id, '0 9 * * *', 1);
  assert.match((checkRoutineRun(routine(id), 'schedule') as any).reason, /no message from you in 30 days/);
  appendRow(idleBot.id, 'message', { role: 'user', text: 'I\'m back' } as any);
  assert.equal(checkRoutineRun(routine(id), 'schedule').ok, true);
});

test('a skipped run is noted in the Bot\'s chat once per routine and reason per day', () => {
  const id = addRoutine(b2.id, '*/5 * * * *', 1, Date.now());
  const count = () => (db.prepare("SELECT COUNT(*) n FROM rows WHERE bot_id=? AND kind='event' AND body LIKE '%skipped%'").get(b2.id) as any).n;
  const before = count();
  runRoutine(id, 'schedule');
  runRoutine(id, 'schedule');
  assert.equal(count(), before + 1);
});
