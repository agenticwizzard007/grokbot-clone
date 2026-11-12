import './schema.js';
import { db, now } from '../db.js';
import { newId } from '../lib/ids.js';
import { ownBot, ownerAlive, ownerBirth, writeOwner } from './ownership.js';
import { DeliverableError, type RoutineRun, type RoutineRunStatus } from './types.js';
import { legacyWritableRows } from '../platform/legacy-database-fence.js';

interface RunRow {
  id: string; user_id: string; bot_id: string; routine_id: string; routine_name: string;
  job_id: string | null; kind: string; status: RoutineRunStatus; error: string | null;
  created_at: number; started_at: number | null; finished_at: number | null;
}
const view = (r: RunRow): RoutineRun => ({ id: r.id, botId: r.bot_id, routineId: r.routine_id,
  routineName: r.routine_name, jobId: r.job_id, kind: r.kind, status: r.status, error: r.error,
  createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at });

export function getRoutineRun(userId: string, runId: string): RoutineRun {
  const r = db.prepare('SELECT * FROM routine_executions WHERE id=? AND user_id=?').get(runId, userId) as RunRow | undefined;
  if (!r) throw new DeliverableError('Not found.', 404);
  ownBot(userId, r.bot_id);
  return view(r);
}
export function listRoutineRuns(userId: string, botId: string, routineId?: string, limit = 50): RoutineRun[] {
  ownBot(userId, botId);
  return (db.prepare('SELECT * FROM routine_executions WHERE user_id=? AND bot_id=? AND (? IS NULL OR routine_id=?) ORDER BY created_at DESC,id DESC LIMIT ?')
    .all(userId, botId, routineId ?? null, routineId ?? null, Math.max(1, Math.min(limit, 100))) as RunRow[]).map(view);
}

/** Called inside the same transaction as durable job acceptance; duplicate fire slots never enqueue. */
export function reserveRoutineRun(input: { userId: string; botId: string; routineId: string; name: string; kind: string; fireKey: string }) {
  writeOwner(input.userId, input.botId);
  if (!db.prepare('SELECT 1 FROM routines WHERE id=? AND bot_id=?').get(input.routineId, input.botId)) throw new DeliverableError('Routine not found.', 404);
  const existing = db.prepare('SELECT * FROM routine_executions WHERE routine_id=? AND fire_key=?').get(input.routineId, input.fireKey) as RunRow | undefined;
  if (existing) {
    if (existing.user_id !== input.userId || existing.bot_id !== input.botId) throw new DeliverableError('Not found.', 404);
    return { run: view(existing), created: false };
  }
  const active = db.prepare("SELECT 1 FROM routine_executions WHERE routine_id=? AND status IN ('queued','running','waiting')").get(input.routineId);
  if (active) throw new DeliverableError('its previous run is still going', 409);
  const id = newId('routine_run');
  db.prepare("INSERT INTO routine_executions(id,user_id,bot_id,routine_id,routine_name,fire_key,kind,status,created_at) VALUES(?,?,?,?,?,?,?,'queued',?)")
    .run(id, input.userId, input.botId, input.routineId, input.name, input.fireKey, input.kind, now());
  return { run: getRoutineRun(input.userId, id), created: true };
}

function jobOwner(jobId: string, botId: string) {
  const j = db.prepare('SELECT user_id,bot_id,trigger FROM agent_jobs WHERE id=? AND bot_id=?').get(jobId, botId) as { user_id: string; bot_id: string; trigger: string } | undefined;
  if (!j) throw new DeliverableError('Job not found.', 404);
  writeOwner(j.user_id, botId);
  return j;
}
export function bindRoutineJob(userId: string, runId: string, jobId: string) {
  const r = getRoutineRun(userId, runId);
  jobOwner(jobId, r.botId);
  const existing = db.prepare('SELECT run_id FROM routine_execution_jobs WHERE job_id=?').get(jobId) as { run_id: string } | undefined;
  if (existing && existing.run_id !== runId) throw new DeliverableError('Job belongs to another routine run.', 409);
  db.prepare('INSERT OR IGNORE INTO routine_execution_jobs(job_id,run_id) VALUES(?,?)').run(jobId, runId);
  db.prepare('UPDATE routine_executions SET job_id=COALESCE(job_id,?) WHERE id=?').run(jobId, runId);
}

export function runIdForJob(jobId: string): string | null {
  return (db.prepare('SELECT run_id FROM routine_execution_jobs WHERE job_id=?').get(jobId) as { run_id: string } | undefined)?.run_id ?? null;
}

export function onJobStarted(input: { jobId: string; botId: string; trigger?: unknown }): RoutineRun | null {
  return db.transaction(() => {
    const j = jobOwner(input.jobId, input.botId);
    // Trust the durably accepted trigger, not a caller's replacement object.
    const t = JSON.parse(j.trigger) as { type?: string; routineId?: string; routineRunId?: string; parentJobId?: string; name?: string };
    let runId = runIdForJob(input.jobId);
    const previouslyBound = !!runId;
    if (!runId && t.parentJobId) runId = runIdForJob(t.parentJobId);
    if (!runId && t.type === 'routine' && t.routineId) {
      if (t.routineRunId) runId = t.routineRunId;
      else {
        const routine = db.prepare('SELECT name FROM routines WHERE id=? AND bot_id=?').get(t.routineId, input.botId) as { name: string } | undefined;
        if (!routine) throw new DeliverableError('Routine not found.', 404);
        runId = reserveRoutineRun({ userId: j.user_id, botId: input.botId, routineId: t.routineId, name: routine.name,
          kind: 'event', fireKey: `job:${input.jobId}` }).run.id;
      }
    }
    if (!runId) return null;
    const r = getRoutineRun(j.user_id, runId);
    if (r.botId !== input.botId || (t.type === 'routine' && r.routineId !== t.routineId)) throw new DeliverableError('Routine run does not belong to this job.', 404);
    if (r.status === 'unknown') throw new DeliverableError('Unknown routine work cannot be replayed.', 409);
    if (previouslyBound && !['queued', 'running', 'waiting'].includes(r.status)) return r;
    if (r.status === 'failed' || r.status === 'cancelled') throw new DeliverableError('Terminal routine work cannot be replayed.', 409);
    bindRoutineJob(j.user_id, runId, input.jobId);
    db.prepare("UPDATE routine_executions SET status='running',started_at=COALESCE(started_at,?),finished_at=NULL,error=NULL,owner_pid=?,owner_birth=? WHERE id=? AND status IN ('queued','running','waiting','completed')")
      .run(now(), process.pid, ownerBirth, runId);
    return getRoutineRun(j.user_id, runId);
  })();
}

const lineage = `WITH RECURSIVE lineage(id) AS (
  SELECT job_id FROM routine_execution_jobs WHERE run_id=?
  UNION SELECT j.id FROM agent_jobs j JOIN lineage l ON json_extract(j.trigger,'$.parentJobId')=l.id
    WHERE j.bot_id=? AND j.user_id=?
)`;
function pendingDecision(runId: string, botId: string, userId: string) {
  const pending = db.prepare('SELECT state FROM pending_turns WHERE bot_id=?').get(botId) as { state: string } | undefined;
  if (pending) {
    const id = JSON.parse(pending.state).jobId;
    if (id && db.prepare(`${lineage} SELECT 1 FROM lineage WHERE id=?`).get(runId, botId, userId, id)) return true;
  }
  return !!db.prepare(`${lineage} SELECT 1 FROM rows r JOIN bots b ON b.id=r.bot_id
    WHERE r.bot_id=? AND r.generation=b.generation AND r.kind='card'
      AND json_extract(r.body,'$.jobId') IN (SELECT id FROM lineage)
      AND json_extract(r.body,'$.answerJobId') IS NULL
      AND ((json_extract(r.body,'$.card')='question' AND json_extract(r.body,'$.status') IN ('pending','answered'))
        OR (json_extract(r.body,'$.card')='connect' AND json_extract(r.body,'$.status') IN ('pending','connecting','connected','skipped')))
    LIMIT 1`).get(runId, botId, userId, botId);
}
function descendantWork(runId: string, botId: string, userId: string, exceptJob?: string) {
  return db.prepare(`${lineage} SELECT j.state FROM agent_jobs j JOIN lineage l ON l.id=j.id
    WHERE j.id<>? AND j.state IN ('queued','running') ORDER BY (j.state='running') DESC LIMIT 1`)
    .get(runId, botId, userId, exceptJob ?? '') as { state: string } | undefined;
}

export function onJobFinished(input: { jobId: string; botId: string; status: 'waiting' | 'completed' | 'failed' | 'unknown' | 'cancelled'; error?: string }): RoutineRun | null {
  const j = jobOwner(input.jobId, input.botId);
  const id = runIdForJob(input.jobId);
  if (!id) return null;
  const r = getRoutineRun(j.user_id, id);
  if (r.botId !== input.botId) throw new DeliverableError('Not found.', 404);
  const descendant = input.status === 'completed' ? descendantWork(id, input.botId, j.user_id, input.jobId) : undefined;
  if (input.status === 'waiting' || input.status === 'completed' && (pendingDecision(id, input.botId, j.user_id) || descendant)) {
    db.prepare("UPDATE routine_executions SET status=?,finished_at=NULL WHERE id=? AND status IN ('queued','running','waiting')")
      .run(descendant?.state === 'running' ? 'running' : 'waiting', id);
    return getRoutineRun(j.user_id, id);
  }
  db.prepare("UPDATE routine_executions SET status=?,error=?,finished_at=? WHERE id=? AND status IN ('queued','running','waiting')")
    .run(input.status, input.error?.slice(0, 500) ?? null, now(), id);
  return getRoutineRun(j.user_id, id);
}

export function recoverRoutineRuns() {
  let count = 0;
  const writable = legacyWritableRows(db, 'routine_executions');
  for (const r of db.prepare(`SELECT id,user_id,bot_id,job_id,status,owner_pid,owner_birth FROM routine_executions WHERE status IN ('queued','running','waiting') AND ${writable}`).all() as { id: string; user_id: string; bot_id: string; job_id: string | null; status: string; owner_pid: number | null; owner_birth: string | null }[]) {
    const job = r.job_id ? db.prepare('SELECT state FROM agent_jobs WHERE id=?').get(r.job_id) as { state: string } | undefined : undefined;
    const unknown = db.prepare(`${lineage} SELECT 1 FROM agent_jobs j JOIN lineage l ON l.id=j.id WHERE j.state='uncertain' LIMIT 1`).get(r.id, r.bot_id, r.user_id);
    if (!unknown && (pendingDecision(r.id, r.bot_id, r.user_id) || r.status === 'waiting' && descendantWork(r.id, r.bot_id, r.user_id))) {
      db.prepare(`UPDATE routine_executions SET status='waiting',finished_at=NULL WHERE id=? AND ${writable}`).run(r.id);
      continue;
    }
    if (r.status === 'running' && ownerAlive(r.owner_pid, r.owner_birth) && job?.state !== 'uncertain') continue;
    if (r.status === 'queued' && job?.state === 'queued') continue;
    // No re-enqueue: after a crash, an external action may already have happened.
    count += db.prepare(`UPDATE routine_executions SET status='unknown',error='Execution owner was lost; work was not replayed.',finished_at=? WHERE id=? AND status IN ('queued','running','waiting') AND ${writable}`).run(now(), r.id).changes;
  }
  return count;
}
