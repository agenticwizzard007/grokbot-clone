import { db, now } from '../db.js';
import { newId } from '../lib/ids.js';
import { assertTenant } from '../deployment.js';
import { selectedCli } from '../cli/store.js';
import { legacyWritableRows } from '../platform/legacy-database-fence.js';
import { publishNativeEvent } from '../native/events.js';
import { appendRow, getBotRow, getRow, updateRow } from '../store.js';
import type { NoticeBody, RowBody } from '../types.js';
db.exec(`CREATE TABLE IF NOT EXISTS agent_jobs (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, trigger TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','running','completed','uncertain','cancelled')),
  created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER);
CREATE INDEX IF NOT EXISTS agent_jobs_pending ON agent_jobs(state,created_at);
CREATE INDEX IF NOT EXISTS agent_jobs_parent ON agent_jobs(json_extract(trigger,'$.parentJobId'));
CREATE INDEX IF NOT EXISTS agent_jobs_owner_type_state ON agent_jobs(user_id,json_extract(trigger,'$.type'),state,finished_at);
CREATE TABLE IF NOT EXISTS tool_dispatches (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, call_id TEXT NOT NULL,
  tool TEXT NOT NULL, arguments_hash TEXT NOT NULL, state TEXT NOT NULL,
  created_at INTEGER NOT NULL, finished_at INTEGER, PRIMARY KEY(bot_id,call_id));`);
export function acceptJob(botId: string, trigger: unknown) {
  return db.transaction(() => {
    const bot = db.prepare('SELECT user_id FROM bots WHERE id=?').get(botId) as { user_id: string } | undefined;
    if (!bot) throw new Error('Agent not found.'); assertTenant(bot.user_id);
    if (!selectedCli(bot.user_id)) {
      const n = (db.prepare("SELECT count(*) n FROM agent_jobs WHERE user_id=? AND state IN ('queued','running') AND json_extract(trigger,'$.type')!='learning-review'").get(bot.user_id) as { n: number }).n;
      if (n >= 64) throw new Error('Your task queue is full. Wait for running tasks to finish.');
    }
    const payload = JSON.stringify(trigger);
    if (Buffer.byteLength(payload) > 16 * 1024 * 1024) throw new Error('Task payload is too large.');
    const id = newId('job');
    db.prepare("INSERT INTO agent_jobs(id,user_id,bot_id,trigger,state,created_at) VALUES(?,?,?,?,'queued',?)").run(id, bot.user_id, botId, payload, now());
    publishNativeEvent({userId:bot.user_id,botId,jobId:id,kind:'job.admitted',sourceType:'job',sourceId:id,sourceRevision:'queued'});
    return { id, userId: bot.user_id };
  })();
}
export function beginJob(id: string) {
  return db.transaction(()=>{
    if(!db.prepare("UPDATE agent_jobs SET state='running',started_at=? WHERE id=? AND state='queued'").run(now(),id).changes)return false;
    const job=db.prepare('SELECT user_id,bot_id FROM agent_jobs WHERE id=?').get(id) as any;
    publishNativeEvent({userId:job.user_id,botId:job.bot_id,jobId:id,kind:'job.started',sourceType:'job',sourceId:id,sourceRevision:'running'});
    return true;
  })();
}
export function finishJob(id: string, successful: boolean) {
  db.transaction(()=>{
    const state=successful?'completed':'uncertain';
    if(!db.prepare("UPDATE agent_jobs SET state=?,finished_at=? WHERE id=? AND state='running'").run(state,now(),id).changes)return;
    const job=db.prepare('SELECT user_id,bot_id FROM agent_jobs WHERE id=?').get(id) as any;
    publishNativeEvent({userId:job.user_id,botId:job.bot_id,jobId:id,kind:'job.settled',sourceType:'job',sourceId:id,sourceRevision:state});
  })();
}
export function recoverJobs() {
  // Running work may have issued an external write. Never silently re-execute it on restart.
  const jobs = legacyWritableRows(db, 'agent_jobs'), dispatches = legacyWritableRows(db, 'tool_dispatches');
  return db.transaction(() => {
    const interrupted = db.prepare(`SELECT id,bot_id,trigger,started_at FROM agent_jobs WHERE state='running' AND json_extract(trigger,'$.type')!='learning-review' AND (${jobs})`).all() as InterruptedJob[];
    const recoveredAt = now();
    db.prepare(`UPDATE tool_dispatches SET state='uncertain',finished_at=? WHERE state='dispatching' AND (${dispatches})`).run(recoveredAt);
    for (const job of interrupted) recoverChat(job, recoveredAt);
    // Commit the notice and terminal states together, so another restart cannot lose or duplicate the notice.
    db.prepare(`UPDATE agent_jobs SET state='uncertain',finished_at=? WHERE state='running' AND json_extract(trigger,'$.type')!='learning-review' AND (${jobs})`).run(recoveredAt);
    return db.prepare(`SELECT id,user_id,bot_id,trigger FROM agent_jobs WHERE state='queued' AND json_extract(trigger,'$.type')!='learning-review' AND (${jobs}) ORDER BY created_at,id`).all() as { id: string; user_id: string; bot_id: string; trigger: string }[];
  })();
}

interface InterruptedJob { id: string; bot_id: string; trigger: string; started_at: number }

function recoverChat(job: InterruptedJob, recoveredAt: number) {
  const trigger = JSON.parse(job.trigger);
  if (!['user', 'system', 'resume'].includes(trigger.type) || trigger.audience === 'internal'
    || trigger.roomId || trigger.workflowId || trigger.proactiveSlotKey) return;
  const bot = getBotRow(job.bot_id);
  if (!bot) return;
  const pending = db.prepare('SELECT state FROM pending_turns WHERE bot_id=?').get(bot.id) as { state: string } | undefined;
  const state = pending ? JSON.parse(pending.state) : undefined;
  const ownsPending = state && (state.jobId === job.id || trigger.type === 'resume' && state.jobId === trigger.parentJobId);
  const pendingSeqs: number[] = ownsPending ? state.calls.map((call: { rowSeq: number }) => call.rowSeq) : [];
  // Pre-upgrade ordinary rows had no job ID. A Bot runs turns serially, so
  // the running job's start bounds its untagged rows. Pending calls can predate a resume.
  const rows = db.prepare(`SELECT seq,body FROM rows WHERE bot_id=? AND generation=?
    AND COALESCE(json_extract(body,'$.audience'),'user')!='internal'
    AND (json_extract(body,'$.jobId')=? OR seq IN (SELECT value FROM json_each(?))
      OR (json_extract(body,'$.jobId') IS NULL AND created_at>=?)) ORDER BY seq`)
    .all(bot.id, bot.generation, job.id, JSON.stringify(pendingSeqs), job.started_at) as { seq: number; body: string }[];
  const activity: NonNullable<NoticeBody['recovery']>['activity'] = [];
  for (const row of rows) {
    let body = JSON.parse(row.body) as RowBody;
    if (body.type === 'message' && body.role === 'assistant' && body.streaming) {
      updateRow(bot.id, row.seq, { ...body, jobId: job.id, streaming: false, interrupted: true });
    }
    if (body.type !== 'tool-call') continue;
    if (['queued', 'running', 'awaiting-approval'].includes(body.status)) {
      const dispatch = db.prepare('SELECT state FROM tool_dispatches WHERE bot_id=? AND call_id=?').get(bot.id, body.callId) as { state: string } | undefined;
      const status = dispatch?.state === 'completed' ? 'done' : dispatch ? 'uncertain' : 'interrupted';
      body = { ...body, jobId: job.id, status, completedAt: recoveredAt, summary: status === 'uncertain'
        ? 'The external result is unknown. Review it before retrying.'
        : status === 'interrupted' ? 'Not dispatched before the restart.' : 'Completed before the restart.' };
      updateRow(bot.id, row.seq, body);
    }
    activity.push({ label: body.label, status: body.status, summary: body.summary });
  }
  if (ownsPending) {
    // A resumed batch can still reference its old approval. It must not replay an uncertain action.
    const approval = db.prepare("SELECT row_seq FROM approvals WHERE id=? AND bot_id=? AND status='pending'").get(state.approvalId, bot.id) as { row_seq: number } | undefined;
    if (approval) {
      db.prepare("UPDATE approvals SET status='expired',resolved_at=? WHERE id=?").run(recoveredAt, state.approvalId);
      const body = getRow(bot.id, approval.row_seq)?.body;
      if (body?.type === 'card' && body.card === 'approval') updateRow(bot.id, approval.row_seq, { ...body, status: 'expired' });
    }
    db.prepare('DELETE FROM pending_turns WHERE bot_id=?').run(bot.id);
  }
  const uncertain = activity.some(step => step.status === 'uncertain');
  appendRow(bot.id, 'notice', {
    type: 'notice', tone: 'warn', audience: 'user', jobId: job.id,
    text: uncertain
      ? 'This request was interrupted by a restart. An external action may have completed, but its result is unknown. Review the activity and check the affected app before retrying. Nothing was automatically retried.'
      : 'This request was interrupted by a restart and did not finish. Any partial reply is incomplete. Review the activity before sending a new request. Nothing was automatically retried.',
    recovery: { jobId: job.id, activity },
  });
}
export function beginTool(botId: string, callId: string, tool: string, binding: string) {
  return db.prepare("INSERT OR IGNORE INTO tool_dispatches(bot_id,call_id,tool,arguments_hash,state,created_at) VALUES(?,?,?,?,'dispatching',?)").run(botId, callId, tool, binding, now()).changes === 1;
}
export function finishTool(botId: string, callId: string, successful: boolean) {
  db.prepare("UPDATE tool_dispatches SET state=?,finished_at=? WHERE bot_id=? AND call_id=?").run(successful ? 'completed' : 'uncertain', now(), botId, callId);
}
