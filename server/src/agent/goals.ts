import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { db, now } from '../db.js';
import { env } from '../env.js';
import { assertTenant } from '../deployment.js';
import { newId } from '../lib/ids.js';
import { hub } from '../lib/hub.js';
import { openOwnedFile } from '../security/files.js';

// Native TypeScript port of Hermes f0e7b68 hermes_cli/goals.py
// GoalManager.evaluate_after_turn: deterministic gates precede completion and
// budget exhaustion pauses unfinished work. Swarm verifies persisted evidence
// directly instead of treating a model's `done` verdict as acceptance.
export class WorkflowError extends Error {
  constructor(message: string, public status: 400 | 404 | 409 = 400) { super(message); }
}
export function ownWorkflowBot(userId: string, botId: string) {
  assertTenant(userId);
  const bot = db.prepare('SELECT * FROM bots WHERE id=? AND user_id=?').get(botId, userId) as any;
  if (!bot || bot.kind === 'room') throw new WorkflowError('Agent not found.', 404);
  return bot;
}
export function emitWorkflow(userId: string, botId: string) {
  // Existing task events refresh the existing panel; no parallel event runtime.
  hub.emit(userId, { type: 'tasks', botId });
}
export const criterionSchema = z.object({
  id: z.string().min(1).max(100).optional(),
  description: z.string().trim().min(1).max(1000),
  kind: z.enum(['row', 'file', 'result']),
  contains: z.string().min(1).max(4000).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export const evidenceSchema = z.object({
  criterionId: z.string().min(1).max(100), kind: z.enum(['row', 'file', 'result']),
  botId: z.string().optional(), rowSeq: z.number().int().positive().optional(),
  generation: z.number().int().nonnegative().optional(),
  path: z.string().max(1000).optional(), taskId: z.string().optional(),
}).strict();
export const goalInputSchema = z.object({
  title: z.string().trim().min(1).max(500),
  criteria: z.array(criterionSchema).min(1).max(30),
  maxTurns: z.number().int().min(1).max(1000).default(10),
  maxTokens: z.number().int().min(1).max(1_000_000_000).nullable().optional(),
  maxSpendUsd: z.number().positive().max(1_000_000).nullable().optional(),
}).strict();
export type Criterion = Omit<z.infer<typeof criterionSchema>, 'id'> & { id: string };
export type Evidence = z.infer<typeof evidenceSchema>;
export type GoalStatus = 'active' | 'paused' | 'blocked' | 'completed' | 'cancelled';
export interface Goal {
  id: string; userId: string; botId: string; title: string; criteria: Criterion[];
  status: GoalStatus; reason: string; maxTurns: number; turnsUsed: number;
  maxTokens: number | null; tokensUsed: number; maxSpendUsd: number | null; spendUsd: number;
  unknownTokenTurns: number; unknownSpendTurns: number; evidence: unknown[];
  createdAt: number; updatedAt: number;
}

db.exec(`CREATE TABLE IF NOT EXISTS native_goals (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, title TEXT NOT NULL,
 criteria TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','paused','blocked','completed','cancelled')),
 reason TEXT NOT NULL DEFAULT '', max_turns INTEGER NOT NULL, turns_used INTEGER NOT NULL DEFAULT 0,
 max_tokens INTEGER, tokens_used INTEGER NOT NULL DEFAULT 0, max_spend_usd REAL, spend_usd REAL NOT NULL DEFAULT 0,
 unknown_token_turns INTEGER NOT NULL DEFAULT 0, unknown_spend_turns INTEGER NOT NULL DEFAULT 0,
 evidence TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS native_goals_owner ON native_goals(user_id,bot_id,status);
 CREATE TABLE IF NOT EXISTS native_goal_turns (
 job_id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES native_goals(id) ON DELETE CASCADE,
 bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, status TEXT NOT NULL,
 usage_start INTEGER NOT NULL DEFAULT 0, tokens INTEGER, cost_usd REAL,
 created_at INTEGER NOT NULL, finished_at INTEGER);`);

function goalView(r: any): Goal {
  return { id: r.id, userId: r.user_id, botId: r.bot_id, title: r.title, criteria: JSON.parse(r.criteria), status: r.status,
    reason: r.reason, maxTurns: r.max_turns, turnsUsed: r.turns_used, maxTokens: r.max_tokens, tokensUsed: r.tokens_used,
    maxSpendUsd: r.max_spend_usd, spendUsd: r.spend_usd, unknownTokenTurns: r.unknown_token_turns,
    unknownSpendTurns: r.unknown_spend_turns, evidence: JSON.parse(r.evidence), createdAt: r.created_at, updatedAt: r.updated_at };
}
export function normalizeCriteria(input: z.infer<typeof criterionSchema>[]): Criterion[] {
  const criteria = z.array(criterionSchema).min(1).max(30).parse(input).map((c, i) => ({ ...c, id: c.id ?? `criterion-${i + 1}` }));
  if (new Set(criteria.map(c => c.id)).size !== criteria.length) throw new WorkflowError('Acceptance criterion IDs must be unique.');
  return criteria;
}
export function createGoal(userId: string, botId: string, input: z.input<typeof goalInputSchema>) {
  ownWorkflowBot(userId, botId);
  const a = goalInputSchema.parse(input), criteria = normalizeCriteria(a.criteria), id = newId('goal');
  db.prepare(`INSERT INTO native_goals(id,user_id,bot_id,title,criteria,status,max_turns,max_tokens,max_spend_usd,created_at,updated_at)
    VALUES(?,?,?,?,?,'active',?,?,?,?,?)`).run(id, userId, botId, a.title, JSON.stringify(criteria), a.maxTurns, a.maxTokens ?? null, a.maxSpendUsd ?? null, now(), now());
  emitWorkflow(userId, botId); return getGoal(userId, id);
}
export function getGoal(userId: string, id: string): Goal {
  assertTenant(userId);
  const r = db.prepare('SELECT * FROM native_goals WHERE id=? AND user_id=?').get(id, userId);
  if (!r) throw new WorkflowError('Goal not found.', 404);
  return goalView(r);
}
export function listGoals(userId: string, botId?: string): Goal[] {
  assertTenant(userId); if (botId) ownWorkflowBot(userId, botId);
  return (botId ? db.prepare('SELECT * FROM native_goals WHERE user_id=? AND bot_id=? ORDER BY created_at DESC').all(userId, botId)
    : db.prepare('SELECT * FROM native_goals WHERE user_id=? ORDER BY created_at DESC').all(userId)).map(goalView);
}
let effects: { control?: (goal: Goal, action: string) => void; verified?: (goal: Goal) => void } = {};
export function configureGoalEffects(value: typeof effects) { effects = value; }
export function goalBudgetReason(g: Goal): string | null {
  if (g.turnsUsed >= g.maxTurns) return 'Turn budget exhausted.';
  if (g.maxTokens !== null && g.unknownTokenTurns) return 'Token accounting unavailable; review the budget before continuing.';
  if (g.maxSpendUsd !== null && g.unknownSpendTurns) return 'Spend accounting unavailable; review the budget before continuing.';
  if (g.maxTokens !== null && g.tokensUsed >= g.maxTokens) return 'Token budget exhausted.';
  if (g.maxSpendUsd !== null && g.spendUsd >= g.maxSpendUsd) return 'Spend budget exhausted.';
  return null;
}
export function controlGoal(userId: string, id: string, action: 'pause' | 'resume' | 'block' | 'stop', reason = '') {
  const g = getGoal(userId, id);
  if (g.status === 'completed' || g.status === 'cancelled') throw new WorkflowError('This goal is terminal.', 409);
  if (action === 'resume' && goalBudgetReason(g)) throw new WorkflowError(goalBudgetReason(g)!, 409);
  const state = { pause: 'paused', resume: 'active', block: 'blocked', stop: 'cancelled' }[action];
  db.prepare('UPDATE native_goals SET status=?,reason=?,updated_at=? WHERE id=? AND user_id=?').run(state, reason.slice(0, 2000), now(), id, userId);
  const result = getGoal(userId, id); effects.control?.(result, action); emitWorkflow(userId, g.botId); return result;
}

/** Resolve references, never URLs supplied by a model. No external requests or shell commands. */
export function verifyCriteria(userId: string, botId: string, criteria: Criterion[], rawEvidence: Evidence[]) {
  ownWorkflowBot(userId, botId);
  const evidence = z.array(evidenceSchema).min(1).max(30).parse(rawEvidence);
  if (new Set(evidence.map(e => e.criterionId)).size !== evidence.length || evidence.some(e => !criteria.some(c => c.id === e.criterionId))) {
    throw new WorkflowError('Provide exactly one evidence reference for each criterion.');
  }
  return criteria.map(c => {
    const e = evidence.find(e => e.criterionId === c.id);
    if (!e || e.kind !== c.kind) throw new WorkflowError(`Evidence missing or wrong kind for ${c.id}.`);
    let content: string, digestBytes: Buffer | undefined, source: Record<string, unknown>;
    if (e.kind === 'row') {
      const sourceBot = e.botId ?? botId, ownerBot = ownWorkflowBot(userId, sourceBot);
      const generation = e.generation ?? ownerBot.generation;
      const row = db.prepare('SELECT body,kind,generation FROM rows WHERE bot_id=? AND generation=? AND seq=?').get(sourceBot,generation,e.rowSeq ?? -1) as any;
      if (!row) throw new WorkflowError(`Source row for ${c.id} does not exist.`);
      const body = JSON.parse(row.body);
      source = { botId: sourceBot, rowSeq: e.rowSeq, generation: row.generation };
      if(row.kind==='message' && body.type==='message' && body.role==='assistant' && !body.streaming)content=String(body.text ?? '');
      else if(row.kind==='tool-call' && body.type==='tool-call' && body.status==='done') {
        const dispatch=db.prepare("SELECT 1 FROM tool_dispatches WHERE bot_id=? AND call_id=? AND tool=? AND state='completed'").get(sourceBot,body.callId,body.name);
        const output=db.prepare(`SELECT idx,item FROM llm_items WHERE bot_id=? AND generation=?
          AND json_extract(item,'$.type')='function_call_output' AND json_extract(item,'$.call_id')=? ORDER BY idx DESC LIMIT 1`).get(sourceBot,generation,body.callId) as any;
        if(!dispatch || !output)throw new WorkflowError('Tool evidence requires a completed dispatch and its persisted output.');
        const actual=JSON.parse(output.item).output;
        content=typeof actual==='string' ? actual : JSON.stringify(actual ?? '');source={...source,callId:body.callId,itemIndex:output.idx};
      } else throw new WorkflowError('Evidence must reference a finished assistant result or successfully completed tool output.');
    } else if (e.kind === 'file') {
      const sourceBot=e.botId ?? botId;ownWorkflowBot(userId,sourceBot);
      if (path.basename(sourceBot) !== sourceBot) throw new WorkflowError('Invalid agent storage.');
      let fd: number | undefined, rootFd:number|undefined;
      try {
        // Native save_file/deliverables live at filesDir/botId/Deliverables/...
        // Anchor the bot directory without following a symlink, then validate the
        // resolved file descriptor using Swarm's existing file boundary helper.
        rootFd=fs.openSync(path.join(env.filesDir,sourceBot),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
        fd = openOwnedFile(`/proc/self/fd/${rootFd}`, e.path ?? '');
        const size = fs.fstatSync(fd).size;
        if (size < 1 || size > 4 * 1024 * 1024) throw new WorkflowError('Evidence file must be nonempty and at most 4 MiB.');
        digestBytes=fs.readFileSync(fd);content=digestBytes.toString('utf8');source={botId:sourceBot,path:e.path,size};
      } catch (err) { throw err instanceof WorkflowError ? err : new WorkflowError(`Evidence file for ${c.id} is unavailable or outside your storage.`); }
      finally { if (fd !== undefined) fs.closeSync(fd);if(rootFd!==undefined)fs.closeSync(rootFd); }
    } else {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_workflow_tasks'").get()) throw new WorkflowError('No persisted task results exist.');
      const row = db.prepare(`SELECT t.result_json,t.result_validated,t.workflow_id FROM native_workflow_tasks t
        JOIN native_workflows w ON w.id=t.workflow_id WHERE t.task_id=? AND w.user_id=?`).get(e.taskId ?? '', userId) as any;
      if (!row?.result_validated || row.result_json === null) throw new WorkflowError('Evidence must reference a schema-validated persisted task result.');
      content = row.result_json; source = { taskId: e.taskId, workflowId: row.workflow_id };
    }
    if (!content.trim()) throw new WorkflowError(`Evidence for ${c.id} is empty.`);
    const digest = createHash('sha256').update(digestBytes ?? content).digest('hex');
    if (c.contains && !content.includes(c.contains)) throw new WorkflowError(`Evidence for ${c.id} does not contain the required text.`);
    if (c.sha256 && c.sha256 !== digest) throw new WorkflowError(`Evidence hash for ${c.id} does not match.`);
    return { criterionId: c.id, kind: c.kind, source, sha256: digest, verifiedAt: now() };
  });
}
export function verifyGoal(userId: string, id: string, evidence: Evidence[]) {
  const g = getGoal(userId, id);
  if (g.status === 'cancelled') throw new WorkflowError('Cancelled goals cannot complete.', 409);
  if (g.status === 'completed') return g;
  const receipts = verifyCriteria(userId, g.botId, g.criteria, evidence);
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='native_workflows'").get()) {
    const pending = db.prepare(`SELECT 1 FROM native_workflow_tasks t JOIN native_workflows w ON w.id=t.workflow_id
      WHERE w.goal_id=? AND w.user_id=? AND t.status!='completed' LIMIT 1`).get(id, userId);
    if (pending) throw new WorkflowError('Dependent workflow tasks are not all verified complete.', 409);
  }
  db.prepare("UPDATE native_goals SET status='completed',reason='',evidence=?,updated_at=? WHERE id=? AND user_id=?")
    .run(JSON.stringify(receipts), now(), id, userId);
  const result = getGoal(userId, id); effects.verified?.(result); emitWorkflow(userId, g.botId); return result;
}

export function usageCursor(): number {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='usage_events'").get()) return 0;
  return (db.prepare('SELECT COALESCE(MAX(id),0) id FROM usage_events').get() as any).id;
}
export interface TurnUsage { tokens: number | null; costUsd: number | null }
export function hasObservedTurnUsage(userId: string, botId: string, cursor: number) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='usage_events'").get() && !!db.prepare(`SELECT 1 FROM usage_events
    WHERE id>? AND user_id=? AND bot_id=? AND kind IN ('chat','compaction','memory','other') LIMIT 1`).get(cursor,userId,botId);
}
export function observedTurnUsage(userId: string, botId: string, cursor: number): TurnUsage {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='usage_events'").get()) return { tokens: null, costUsd: null };
  const rows = db.prepare(`SELECT input_tokens,output_tokens,token_fields,usage_status,cost_usd,cost_source FROM usage_events
    WHERE id>? AND user_id=? AND bot_id=? AND kind IN ('chat','compaction','memory','other')`).all(cursor, userId, botId) as any[];
  if (!rows.length) return { tokens: null, costUsd: null };
  let tokens = 0, costUsd = 0, knownTokens = true, knownSpend = true;
  for (const r of rows) {
    const fields = r.token_fields === null ? null : JSON.parse(r.token_fields) as string[];
    if (r.usage_status === 'unavailable' || fields && (!fields.includes('input_tokens') || !fields.includes('output_tokens'))) knownTokens = false;
    else tokens += r.input_tokens + r.output_tokens;
    // Estimates are useful reporting, but cannot be presented as actual spend enforcement.
    if (r.cost_usd === null || !['provider', 'subscription'].includes(r.cost_source)) knownSpend = false;
    else costUsd += r.cost_usd;
  }
  return { tokens: knownTokens ? tokens : null, costUsd: knownSpend ? costUsd : null };
}
export function reserveGoalTurn(userId: string, goalId: string, botId: string, jobId: string) {
  ownWorkflowBot(userId, botId);
  return db.transaction(() => {
    const g = getGoal(userId, goalId);
    const existing = db.prepare('SELECT * FROM native_goal_turns WHERE job_id=?').get(jobId) as any;
    if (existing) {
      if (existing.goal_id !== goalId || existing.bot_id !== botId) throw new WorkflowError('Job goal binding changed.', 409);
      return { allowed: g.status === 'active' && existing.status === 'running', goal: g };
    }
    const reason = goalBudgetReason(g);
    if (g.status !== 'active') return { allowed: false, goal: g };
    if (reason) {
      db.prepare("UPDATE native_goals SET status='paused',reason=?,updated_at=? WHERE id=?").run(reason, now(), goalId);
      emitWorkflow(userId, g.botId); return { allowed: false, goal: getGoal(userId, goalId) };
    }
    db.prepare("INSERT INTO native_goal_turns(job_id,goal_id,bot_id,status,usage_start,created_at) VALUES(?,?,?,'running',?,?)")
      .run(jobId, goalId, botId, usageCursor(), now());
    db.prepare('UPDATE native_goals SET turns_used=turns_used+1,updated_at=? WHERE id=?').run(now(), goalId);
    return { allowed: true, goal: getGoal(userId, goalId) };
  })();
}
export function settleGoalTurn(userId: string, jobId: string, usage?: TurnUsage) {
  return db.transaction(() => {
    const r = db.prepare(`SELECT t.* FROM native_goal_turns t JOIN native_goals g ON g.id=t.goal_id WHERE t.job_id=? AND g.user_id=?`).get(jobId, userId) as any;
    if (!r || r.status !== 'running') return r ? getGoal(userId, r.goal_id) : null;
    const u = usage ?? observedTurnUsage(userId, r.bot_id, r.usage_start);
    if (u.tokens !== null && (!Number.isSafeInteger(u.tokens) || u.tokens < 0) || u.costUsd !== null && (!Number.isFinite(u.costUsd) || u.costUsd < 0)) throw new WorkflowError('Invalid measured usage.');
    db.prepare("UPDATE native_goal_turns SET status='settled',tokens=?,cost_usd=?,finished_at=? WHERE job_id=? AND status='running'").run(u.tokens, u.costUsd, now(), jobId);
    db.prepare(`UPDATE native_goals SET tokens_used=tokens_used+?,spend_usd=spend_usd+?,
      unknown_token_turns=unknown_token_turns+?,unknown_spend_turns=unknown_spend_turns+?,updated_at=? WHERE id=?`)
      .run(u.tokens ?? 0, u.costUsd ?? 0, u.tokens === null ? 1 : 0, u.costUsd === null ? 1 : 0, now(), r.goal_id);
    const g = getGoal(userId, r.goal_id); emitWorkflow(userId, g.botId); return g;
  })();
}
export function goalContext(g: Goal) {
  return `Persistent goal ${g.id}: ${g.title}\nAcceptance criteria (must cite concrete evidence via verify_goal):\n${g.criteria.map(c => `${c.id}: ${c.description} [${c.kind}${c.contains ? `, contains ${JSON.stringify(c.contains)}` : ''}]`).join('\n')}\nBudget: ${g.turnsUsed}/${g.maxTurns} turns; ${g.tokensUsed}/${g.maxTokens ?? 'unlimited'} observed tokens; $${g.spendUsd}/${g.maxSpendUsd ?? 'unlimited'} actual spend. If blocked, report the reason; never assert completion without verified evidence.`;
}
