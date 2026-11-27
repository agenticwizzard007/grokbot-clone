import { Hono } from 'hono';
import { requireUser, type AuthVars } from '../lib/auth.js';
import { db, now } from '../db.js';
import { displayCoordinationText } from '../lib/redact.js';
import { redactOutputText } from './output.js';
import { newId } from '../lib/ids.js';
import { hub } from '../lib/hub.js';
import { transactionWithEffects } from '../lib/commit-effects.js';
import type { Task } from '../types.js';
import type { LoopSpec, LoopStatus, StopReason } from './contracts.js';

export interface TaskHandoffLink { loopId?: string; handoffId?: string; kind: 'receiver' | 'gate' | 'loop' }
const taskDisplay = (text: string) => displayCoordinationText(redactOutputText(text)).replace(/[\u2013\u2014]/g, '-');
type StoredTask = { id: string; bot_id: string; state: Task['state']; note: string };
const stopNotes: Record<StopReason, string> = {
  passed: 'All checks passed.', max_iterations: 'Pass limit reached.', max_minutes: 'Time limit reached.',
  max_cost: 'Cost limit reached.', max_tokens: 'Token limit reached.', stalled: 'No progress between the last two passes.',
  step_failed: 'A step failed. Review the loop.', no_verdict: 'The checker did not submit a verdict.',
  user_stopped: 'Stopped by you.', declined: 'Approval declined.', gate_expired: 'Approval expired.',
};

export function loopTaskState(status: LoopStatus, stopReason: StopReason | null): Task['state'] {
  if (status === 'succeeded' && stopReason === 'passed') return 'done';
  if (status === 'running' || status === 'draft' || status === 'paused') return 'working';
  return 'needs_input';
}

function ownTask(userId: string, taskId: string): StoredTask {
  const task = db.prepare('SELECT t.* FROM tasks t JOIN bots b ON b.id=t.bot_id WHERE t.id=? AND b.user_id=?').get(taskId, userId) as StoredTask | undefined;
  if (!task) throw new Error('Task not found.');
  return task;
}
function update(userId: string, task: StoredTask, state: Task['state'], note: string) {
  if (task.state === state && task.note === note) return;
  db.prepare('UPDATE tasks SET state=?, note=?, updated_at=? WHERE id=? AND bot_id IN (SELECT id FROM bots WHERE user_id=?)').run(state, note, now(), task.id, userId);
  hub.emit(userId, { type: 'tasks', botId: task.bot_id });
}
function linked(userId: string, id: string, kind: TaskHandoffLink['kind'], entity: 'loop' | 'handoff') {
  return db.prepare(`SELECT t.* FROM tasks t JOIN bots b ON b.id=t.bot_id JOIN handoff_task_links l ON l.task_id=t.id
    WHERE b.user_id=? AND l.${entity}_id=? AND l.kind=?`).all(userId, id, kind) as StoredTask[];
}
function ensure(userId: string, botId: string, id: string, kind: TaskHandoffLink['kind'], entity: 'loop' | 'handoff', title: string) {
  const existing = linked(userId, id, kind, entity)[0];
  if (existing) return existing;
  if (!db.prepare("SELECT 1 FROM bots WHERE id=? AND user_id=? AND COALESCE(kind,'agent')<>'room'").get(botId, userId)) throw new Error('Agent not found.');
  const taskId = newId('task');
  db.prepare("INSERT INTO tasks(id,bot_id,title,state,note,created_at,updated_at) VALUES(?,?,?,'working','',?,?)").run(taskId, botId, title, now(), now());
  db.prepare(`INSERT INTO handoff_task_links(task_id,${entity}_id,kind) VALUES(?,?,?)`).run(taskId, id, kind);
  hub.emit(userId, { type: 'tasks', botId });
  return ownTask(userId, taskId);
}

/** Call inside the service's transactionWithEffects after each durable loop transition, including recovery. */
export function syncLoopTasks(userId: string, loopId: string) {
  return transactionWithEffects(() => {
    const loop = db.prepare('SELECT * FROM loops WHERE id=? AND user_id=?').get(loopId, userId) as {
      owner_bot_id: string; spec: string; task_id: string | null; status: LoopStatus; stop_reason: StopReason | null;
    } | undefined;
    if (!loop) throw new Error('Loop not found.');
    const spec = JSON.parse(loop.spec) as LoopSpec;
    const state = loopTaskState(loop.status, loop.stop_reason);
    const note = loop.stop_reason ? stopNotes[loop.stop_reason] : loop.status === 'awaiting_approval' ? 'Loop needs your approval.' : loop.status === 'paused' ? 'Loop paused.' : 'Loop in progress.';
    const taskId = loop.task_id ?? spec.taskId;
    let task: StoredTask | undefined;
    if (taskId) {
      task = ownTask(userId, taskId);
      const previous = db.prepare('SELECT loop_id FROM handoff_task_links WHERE task_id=? AND kind=\'loop\'').get(taskId) as { loop_id: string } | undefined;
      if (previous && previous.loop_id !== loopId) throw new Error('Task already belongs to another loop.');
      db.prepare("INSERT OR IGNORE INTO handoff_task_links(task_id,loop_id,kind) VALUES(?,?,'loop')").run(taskId, loopId);
      update(userId, task, state, note);
    }
    // Reuse the starter's linked task at a gate, so one decision counts once.
    if (loop.status === 'awaiting_approval' && task?.bot_id !== loop.owner_bot_id) {
      const gate = ensure(userId, loop.owner_bot_id, loopId, 'gate', 'loop', 'Review loop approval');
      update(userId, gate, 'needs_input', note);
    } else {
      for (const gate of linked(userId, loopId, 'gate', 'loop')) update(userId, gate, 'done', loop.status === 'awaiting_approval' ? 'Approval is on the linked task.' : 'Loop approval resolved.');
    }
    return getTaskHandoffLinks(userId);
  });
}

/** Receiver questions use needsInput while the handoff itself remains running. */
export function syncHandoffTasks(userId: string, handoffId: string, { needsInput = false } = {}) {
  return transactionWithEffects(() => {
    const handoff = db.prepare('SELECT h.*, b.name AS sender_name FROM handoffs h JOIN bots b ON b.id=h.from_bot_id AND b.user_id=h.user_id WHERE h.id=? AND h.user_id=?').get(handoffId, userId) as {
      from_bot_id: string; to_bot_id: string; sender_name: string; instruction: string; create_task: number; status: string;
    } | undefined;
    if (!handoff) throw new Error('Handoff not found.');
    if (handoff.status === 'pending_approval') {
      update(userId, ensure(userId, handoff.from_bot_id, handoffId, 'gate', 'handoff', 'Review handoff approval'), 'needs_input', 'Handoff needs your approval.');
      return;
    }
    for (const gate of linked(userId, handoffId, 'gate', 'handoff')) update(userId, gate, 'done', 'Handoff approval resolved.');
    if (!handoff.create_task) return;
    // Declining an unsent handoff must not manufacture work for its recipient.
    const existing = linked(userId, handoffId, 'receiver', 'handoff')[0];
    if (!existing && ['declined', 'expired', 'cancelled'].includes(handoff.status)) return;
    const task = existing ?? ensure(userId, handoff.to_bot_id, handoffId, 'receiver', 'handoff', `From ${taskDisplay(handoff.sender_name)}: ${taskDisplay(handoff.instruction).slice(0, 60)}`);
    const state = handoff.status === 'completed' ? 'done' : needsInput || ['failed', 'declined', 'expired', 'cancelled'].includes(handoff.status) ? 'needs_input' : 'working';
    update(userId, task, state, state === 'done' ? 'Handoff completed.' : state === 'needs_input' ? 'Handoff needs your input.' : 'Handoff in progress.');
  });
}

/** Add to task responses in the owning route/store; task table stays unchanged. */
export function getTaskHandoffLinks(userId: string): Record<string, TaskHandoffLink> {
  const rows = db.prepare(`SELECT l.* FROM handoff_task_links l JOIN tasks t ON t.id=l.task_id JOIN bots b ON b.id=t.bot_id
    LEFT JOIN loops lp ON lp.id=l.loop_id AND lp.user_id=b.user_id LEFT JOIN handoffs h ON h.id=l.handoff_id AND h.user_id=b.user_id
    WHERE b.user_id=? AND (lp.id IS NOT NULL OR h.id IS NOT NULL) ORDER BY CASE l.kind WHEN 'loop' THEN 1 ELSE 0 END`).all(userId) as { task_id: string; loop_id: string | null; handoff_id: string | null; kind: TaskHandoffLink['kind'] }[];
  return Object.fromEntries(rows.map(row => [row.task_id, { kind: row.kind, ...(row.loop_id ? { loopId: row.loop_id } : {}), ...(row.handoff_id ? { handoffId: row.handoff_id } : {}) }]));
}

/** Called by update_task after setting done; never overwrites another task's output association. */
export function linkTaskOutput(userId: string, taskId: string, jobId: string) {
  const task = ownTask(userId, taskId);
  if (task.state !== 'done') return false;
  return db.prepare('UPDATE run_outputs SET task_id=? WHERE user_id=? AND bot_id=? AND job_id=? AND (task_id IS NULL OR task_id=?)').run(taskId, userId, task.bot_id, jobId, taskId).changes > 0;
}

/** HO-I mounts this alongside handoffsApi; no change to the existing task schema or serializer. */
export const handoffTasksApi = new Hono<AuthVars>();
handoffTasksApi.use('*', requireUser);
handoffTasksApi.get('/handoff-task-links', c => {
  const userId = c.get('user').id;
  const setting = db.prepare('SELECT enabled FROM handoff_user_settings WHERE user_id=?').get(userId) as { enabled: number } | undefined;
  c.header('Cache-Control', 'no-store');
  if (process.env.HANDOFFS_DISABLED === '1' || setting?.enabled === 0) return c.json({ error: 'Agent handoffs are disabled.', code: 'disabled' }, 503);
  return c.json({ links: getTaskHandoffLinks(userId) });
});
