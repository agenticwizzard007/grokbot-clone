import { z } from 'zod';
import { db, now } from '../db.js';
import { newId } from '../lib/ids.js';
import { assertTenant } from '../deployment.js';
import { appendRow } from '../store.js';
import { legacyWritableRows } from '../platform/legacy-database-fence.js';
import { publishNativeEvent } from '../native/events.js';
import { assertLegacyWorkOpen } from '../security/legacy-work.js';
import { createSubagent, initSubagents } from './subagents.js';
import {
  WorkflowError, ownWorkflowBot, emitWorkflow, criterionSchema, evidenceSchema, normalizeCriteria,
  verifyCriteria, getGoal, listGoals, controlGoal, configureGoalEffects, goalBudgetReason,
  reserveGoalTurn, settleGoalTurn, observedTurnUsage, hasObservedTurnUsage, goalContext, usageCursor,
  type Criterion, type Evidence, type TurnUsage, type Goal,
} from './goals.js';

// Ports from NousResearch/hermes-agent f0e7b68 (central license notice owned by root):
// hermes_cli/kanban_db_graph.py:_validate_children_graph (Kahn cycle check),
// hermes_cli/kanban_db.py:_would_cycle/recompute_ready (dependency gates), and
// tools/delegation_output_schema.py (JSON extraction, ten errors, ONE correction).
// Swarm owns all persistence, scheduling, authorization and model execution.
type SystemTrigger = { type: 'system'; text: string; parentJobId?: string; audience?:'internal'; workflowId?:string;taskId?:string;goalId?:string };
interface Runtime { enqueue: (botId: string, trigger: SystemTrigger) => string; interrupt: (botId: string, expectedJobId?: string) => unknown }
let runtime: Runtime | undefined;
export function configureWorkflowRuntime(value: Runtime) { runtime = value; }
function requireRuntime() { if (!runtime) throw new WorkflowError('Workflow execution is not connected to the agent queue.', 409); return runtime; }

db.exec(`CREATE TABLE IF NOT EXISTS native_workflows (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
 goal_id TEXT REFERENCES native_goals(id) ON DELETE SET NULL, title TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('draft','active','paused','blocked','completed','cancelled')),
 reason TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS native_workflows_owner ON native_workflows(user_id,bot_id);
 CREATE TABLE IF NOT EXISTS native_workflow_tasks (
 task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
 workflow_id TEXT NOT NULL REFERENCES native_workflows(id) ON DELETE CASCADE,
 task_key TEXT NOT NULL, parent_task_id TEXT REFERENCES native_workflow_tasks(task_id),
 instructions TEXT NOT NULL,criteria TEXT NOT NULL,output_schema TEXT,
 status TEXT NOT NULL CHECK(status IN ('waiting','ready','queued','running','blocked','completed','cancelled')),
 assigned_bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL, delegate INTEGER NOT NULL DEFAULT 0,
 correction_count INTEGER NOT NULL DEFAULT 0, result_json TEXT, result_validated INTEGER NOT NULL DEFAULT 0,
 evidence TEXT NOT NULL DEFAULT '[]',reason TEXT NOT NULL DEFAULT '',active_job_id TEXT,
 UNIQUE(workflow_id,task_key));
 CREATE TABLE IF NOT EXISTS native_workflow_edges (
 task_id TEXT NOT NULL REFERENCES native_workflow_tasks(task_id) ON DELETE CASCADE,
 depends_on_id TEXT NOT NULL REFERENCES native_workflow_tasks(task_id) ON DELETE CASCADE,
 PRIMARY KEY(task_id,depends_on_id),CHECK(task_id!=depends_on_id));
 CREATE TABLE IF NOT EXISTS native_workflow_runs (
 job_id TEXT PRIMARY KEY REFERENCES agent_jobs(id) ON DELETE CASCADE,
 workflow_id TEXT REFERENCES native_workflows(id) ON DELETE CASCADE,
 task_id TEXT REFERENCES native_workflow_tasks(task_id) ON DELETE CASCADE,
 goal_id TEXT REFERENCES native_goals(id) ON DELETE CASCADE,
 bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
 parent_job_id TEXT,status TEXT NOT NULL,usage_start INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL,finished_at INTEGER);
 CREATE INDEX IF NOT EXISTS native_workflow_runs_task ON native_workflow_runs(task_id,status);
 CREATE TABLE IF NOT EXISTS native_workflow_delegations (
 task_id TEXT PRIMARY KEY REFERENCES native_workflow_tasks(task_id) ON DELETE CASCADE,
 parent_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
 child_bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL,
 parent_task_id TEXT REFERENCES native_workflow_tasks(task_id),created_at INTEGER NOT NULL);`);

// jobs.ts normally creates this before the loop loads workflows. Direct route/test
// imports also need its native tables; this import never imports the agent loop.
import './jobs.js';

if (!(db.prepare('PRAGMA table_info(native_workflow_tasks)').all() as any[]).some(c=>c.name==='worker_bot_id')) db.exec('ALTER TABLE native_workflow_tasks ADD COLUMN worker_bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL');

export function approvedWorkflowWorker(userId:string,botId:string) {
  const b=ownWorkflowBot(userId,botId);
  const setup=db.prepare('SELECT onboarding_status FROM bot_setups WHERE bot_id=?').get(botId) as any;
  if(b.hidden || b.parent_bot_id || setup?.onboarding_status!=='active')throw new WorkflowError('Worker must be an activated, visible permanent agent.',409);
  return b;
}

export const workflowTaskInputSchema = z.object({
  key: z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/), title: z.string().trim().min(1).max(500),
  instructions: z.string().trim().min(1).max(16_000),
  dependsOn: z.array(z.string().min(1).max(80)).max(100).default([]),
  parentKey: z.string().max(80).optional(),
  criteria: z.array(criterionSchema).min(1).max(30),
  outputSchema: z.record(z.string(), z.unknown()).optional(), workerBotId:z.string().min(1).optional(), delegate: z.boolean().default(false),
}).strict();
export const workflowInputSchema = z.object({ title: z.string().trim().min(1).max(500), goalId: z.string().optional(),
  tasks: z.array(workflowTaskInputSchema).min(1).max(100) }).strict();
type TaskState = 'waiting' | 'ready' | 'queued' | 'running' | 'blocked' | 'completed' | 'cancelled';
export interface WorkflowTask {
  id: string; key: string; title: string; instructions: string; parentTaskId: string | null;
  dependsOn: string[]; status: TaskState; assignedBotId: string | null; workerBotId:string|null; delegate: boolean;
  criteria: Criterion[]; outputSchema: Record<string, unknown> | null; correctionCount: number;
  result: unknown; resultValidated: boolean; evidence: unknown[]; reason: string; activeJobId: string | null;
}
export interface Workflow {
  id: string; userId: string; botId: string; goalId: string | null; title: string;
  status: 'draft' | 'active' | 'paused' | 'blocked' | 'completed' | 'cancelled'; reason: string;
  createdAt: number; updatedAt: number; tasks: WorkflowTask[];
}

/** Fail closed on unsupported schema keywords, rather than silently weakening a contract. */
export function compileOutputSchema(schema: Record<string, unknown>) {
  // Bound the raw JSON graph before JSON.stringify too: constants/defaults and
  // enum values are data, but can otherwise conceal deep/cyclic object graphs.
  const rawPending=[{value:schema as unknown,depth:0}];let rawNodes=0;
  while(rawPending.length) {
    const entry=rawPending.pop()!;
    if(++rawNodes>2000 || entry.depth>32)throw new WorkflowError('Output schema JSON is too complex.');
    if(entry.value && typeof entry.value==='object')for(const child of Object.values(entry.value))rawPending.push({value:child,depth:entry.depth+1});
  }
  if (JSON.stringify(schema).length > 32_000) throw new WorkflowError('Output schema is too large.');
  const allowed = new Set(['type','properties','required','additionalProperties','items','minItems','maxItems','minLength','maxLength',
    'minimum','maximum','exclusiveMinimum','exclusiveMaximum','enum','const','anyOf','oneOf','allOf','description','title','default',
    '$schema','$defs','definitions','$ref','uniqueItems']);
  let count = 0;
  function visit(node: any, depth: number) {
    if (++count > 500 || depth > 12) throw new WorkflowError('Output schema is too complex.');
    if (typeof node === 'boolean') return;
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw new WorkflowError('Invalid JSON Schema.');
    for (const [k, value] of Object.entries(node)) {
      if (!allowed.has(k)) throw new WorkflowError(`Unsupported output schema keyword: ${k}.`);
      // A small source tree can reference itself or expand exponentially. A
      // node/depth limit on that tree does not bound reference expansion.
      if (k === '$ref') throw new WorkflowError('Schema references are not supported; inline a bounded acyclic schema.');
      if (['properties','$defs','definitions'].includes(k)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkflowError(`Invalid schema ${k}.`);
        for (const child of Object.values(value)) visit(child, depth + 1);
      } else if (['items','additionalProperties'].includes(k)) visit(value, depth + 1);
      else if (['anyOf','oneOf','allOf'].includes(k)) {
        if (!Array.isArray(value) || !value.length) throw new WorkflowError(`Invalid schema ${k}.`);
        value.forEach(c => visit(c, depth + 1));
      }
    }
  }
  visit(schema, 0);
  try { return z.fromJSONSchema(schema); }
  catch { throw new WorkflowError('Invalid or unsupported output schema.'); }
}
export function extractJsonCandidate(text: string) {
  let raw = text.trim();
  if (raw.startsWith('```')) raw = raw.slice(raw.indexOf('\n') + 1).replace(/```\s*$/, '').trim();
  const spans = [['{','}'], ['[',']']].flatMap(([a,b]) => {
    const start = raw.indexOf(a), end = raw.lastIndexOf(b);
    return start >= 0 && end > start ? [{ start, candidate: raw.slice(start, end + 1) }] : [];
  }).sort((a,b) => a.start - b.start);
  for (const { candidate } of spans) { try { JSON.parse(candidate); return candidate; } catch { /* next span */ } }
  return spans[0]?.candidate ?? raw;
}
export function validateChildResult(text: string, schema: Record<string, unknown>): { valid: boolean; value?: unknown; errors: string[] } {
  const validator = compileOutputSchema(schema);
  if (text.length > 128_000) return { valid: false, errors: ['$: Response exceeds 128 KiB.'] };
  let value: unknown;
  try { value = JSON.parse(extractJsonCandidate(text)); }
  catch { return { valid: false, errors: ['$: Response is not valid JSON.'] }; }
  // JSON.parse itself accepts very deep values. Bound the parsed graph with an
  // iterative walk before invoking recursive schema validators on model output.
  const pending=[{value,depth:0}];let nodes=0;
  while(pending.length) {
    const entry=pending.pop()!;
    if(++nodes>10_000 || entry.depth>32)return {valid:false,errors:['$: Response exceeds the maximum depth (32) or node count (10000).']};
    if(entry.value && typeof entry.value==='object')for(const child of Object.values(entry.value))pending.push({value:child,depth:entry.depth+1});
  }
  try {
    const result = validator.safeParse(value);
    return result.success ? { valid: true, value, errors: [] }
      : { valid: false, errors: result.error.issues.slice(0,10).map(e => `$${e.path.map(p => typeof p === 'number' ? `[${p}]` : `.${String(p)}`).join('')}: ${e.message}`) };
  } catch { return { valid: false, errors: ['$: Output does not satisfy the schema.'] }; }
}
export function validateDependencyGraph(tasks: Array<{ key: string; dependsOn: string[]; parentKey?: string }>) {
  const keys = new Set(tasks.map(t => t.key));
  if (keys.size !== tasks.length) throw new WorkflowError('Task keys must be unique.');
  const degree = new Map(tasks.map(t => [t.key, 0])), adjacent = new Map(tasks.map(t => [t.key, [] as string[]]));
  for (const t of tasks) {
    if (new Set(t.dependsOn).size !== t.dependsOn.length) throw new WorkflowError('Duplicate dependency.');
    for (const dep of t.dependsOn) {
      if (!keys.has(dep) || dep === t.key) throw new WorkflowError('Unknown dependency or self-dependency.');
      adjacent.get(dep)!.push(t.key); degree.set(t.key, degree.get(t.key)! + 1);
    }
    if (t.parentKey && (!keys.has(t.parentKey) || t.parentKey === t.key)) throw new WorkflowError('Invalid parent task.');
  }
  const queue = [...degree].filter(([,n]) => n === 0).map(([k]) => k); let seen = 0;
  while (queue.length) { seen++; for (const key of adjacent.get(queue.pop()!)!) { degree.set(key, degree.get(key)! - 1); if (degree.get(key) === 0) queue.push(key); } }
  if (seen !== tasks.length) throw new WorkflowError('Cyclic task dependency.');
  // Hierarchy is a separate relationship: validate its cycles as well.
  const parents = new Map(tasks.map(t => [t.key, t.parentKey]));
  for (const t of tasks) { const chain = new Set<string>(); let key: string | undefined = t.key;
    while (key) { if (chain.has(key)) throw new WorkflowError('Cyclic parent relationship.'); chain.add(key); key = parents.get(key); }
  }
}
export function getWorkflow(userId: string, id: string): Workflow {
  assertTenant(userId);
  const r = db.prepare('SELECT * FROM native_workflows WHERE id=? AND user_id=?').get(id, userId) as any;
  if (!r) throw new WorkflowError('Workflow not found.', 404);
  const tasks = db.prepare(`SELECT w.*,t.title FROM native_workflow_tasks w JOIN tasks t ON t.id=w.task_id WHERE workflow_id=? ORDER BY t.rowid`).all(id) as any[];
  return { id:r.id,userId:r.user_id,botId:r.bot_id,goalId:r.goal_id,title:r.title,status:r.status,reason:r.reason,createdAt:r.created_at,updatedAt:r.updated_at,
    tasks: tasks.map(t => ({ id:t.task_id,key:t.task_key,title:t.title,instructions:t.instructions,parentTaskId:t.parent_task_id,
      dependsOn:(db.prepare('SELECT depends_on_id FROM native_workflow_edges WHERE task_id=?').all(t.task_id) as any[]).map(e => e.depends_on_id),
      status:t.status,assignedBotId:t.assigned_bot_id,workerBotId:t.worker_bot_id??null,delegate:!!t.delegate,criteria:JSON.parse(t.criteria),outputSchema:t.output_schema ? JSON.parse(t.output_schema) : null,
      correctionCount:t.correction_count,result:t.result_json === null ? null : JSON.parse(t.result_json),resultValidated:!!t.result_validated,
      evidence:JSON.parse(t.evidence),reason:t.reason,activeJobId:t.active_job_id })) };
}
export function listWorkflows(userId: string, botId?: string) {
  assertTenant(userId); if (botId) ownWorkflowBot(userId,botId);
  const rows = botId ? db.prepare('SELECT id FROM native_workflows WHERE user_id=? AND bot_id=? ORDER BY created_at DESC').all(userId,botId)
    : db.prepare('SELECT id FROM native_workflows WHERE user_id=? ORDER BY created_at DESC').all(userId);
  return (rows as any[]).map(r => getWorkflow(userId,r.id));
}
export function createWorkflow(userId: string, botId: string, input: z.input<typeof workflowInputSchema>) {
  ownWorkflowBot(userId,botId); assertLegacyWorkOpen(userId); const a = workflowInputSchema.parse(input); validateDependencyGraph(a.tasks);
  if (a.goalId) { const goal = getGoal(userId,a.goalId); if (goal.botId !== botId || ['completed','cancelled'].includes(goal.status)) throw new WorkflowError('Goal is not available for this agent.'); }
  for (const t of a.tasks) { if(t.workerBotId)approvedWorkflowWorker(userId,t.workerBotId); normalizeCriteria(t.criteria); if (t.outputSchema) compileOutputSchema(t.outputSchema); }
  return db.transaction(() => {
    const id = newId('wf'), ids = new Map(a.tasks.map(t => [t.key,newId('task')]));
    db.prepare("INSERT INTO native_workflows(id,user_id,bot_id,goal_id,title,status,created_at,updated_at) VALUES(?,?,?,?,?,'draft',?,?)").run(id,userId,botId,a.goalId ?? null,a.title,now(),now());
    for (const t of a.tasks) {
      const tid = ids.get(t.key)!;
      db.prepare("INSERT INTO tasks(id,bot_id,title,state,note,created_at,updated_at) VALUES(?,?,?,'working',?,?,?)").run(tid,botId,t.title,'Workflow: waiting to start',now(),now());
      db.prepare(`INSERT INTO native_workflow_tasks(task_id,workflow_id,task_key,instructions,criteria,output_schema,status,delegate,worker_bot_id,assigned_bot_id)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(tid,id,t.key,t.instructions,JSON.stringify(normalizeCriteria(t.criteria)),t.outputSchema ? JSON.stringify(t.outputSchema) : null,t.dependsOn.length ? 'waiting' : 'ready',t.delegate || t.workerBotId ? 1 : 0,t.workerBotId??null,t.workerBotId??null);
    }
    for (const t of a.tasks) {
      if (t.parentKey) db.prepare('UPDATE native_workflow_tasks SET parent_task_id=? WHERE task_id=?').run(ids.get(t.parentKey),ids.get(t.key));
      for (const dep of t.dependsOn) db.prepare('INSERT INTO native_workflow_edges VALUES(?,?)').run(ids.get(t.key),ids.get(dep));
    }
    publishNativeEvent({userId,botId,kind:'workflow.created',sourceType:'workflow',sourceId:id,audience:'internal'});
    emitWorkflow(userId,botId); return getWorkflow(userId,id);
  })();
}
function taskOf(w: Workflow, id: string) { const t = w.tasks.find(t => t.id === id); if (!t) throw new WorkflowError('Task not found.',404); return t; }
function setTask(id: string, status: TaskState, reason = '') {
  db.prepare('UPDATE native_workflow_tasks SET status=?,reason=? WHERE task_id=?').run(status,reason.slice(0,2000),id);
  db.prepare('UPDATE tasks SET state=?,note=?,updated_at=? WHERE id=?').run(status === 'completed' ? 'done' : ['blocked','cancelled','waiting'].includes(status) ? 'needs_input' : 'working',reason || `Workflow: ${status}`,now(),id);
}
export function addWorkflowDependency(userId:string,workflowId:string,taskId:string,dependsOnId:string) {
  return db.transaction(() => {
    const w = getWorkflow(userId,workflowId), t = taskOf(w,taskId); taskOf(w,dependsOnId);
    if (!['waiting','ready','blocked'].includes(t.status) || ['completed','cancelled'].includes(w.status)) throw new WorkflowError('Cannot change dependencies of admitted or terminal work.',409);
    const mapped = w.tasks.map(t => ({ key:t.id,dependsOn:t.id === taskId ? [...new Set([...t.dependsOn,dependsOnId])] : t.dependsOn, parentKey:t.parentTaskId ?? undefined }));
    validateDependencyGraph(mapped);
    db.prepare('INSERT OR IGNORE INTO native_workflow_edges VALUES(?,?)').run(taskId,dependsOnId);
    recomputeReadiness(w); emitWorkflow(userId,w.botId); return getWorkflow(userId,workflowId);
  })();
}
function recomputeReadiness(w:Workflow) {
  const current = getWorkflow(w.userId,w.id);
  for (const t of current.tasks) {
    // Sticky explicit/schema/restart blocks require a deliberate resume, like Hermes.
    if (!['waiting','ready'].includes(t.status)) continue;
    const ready = t.dependsOn.every(id => taskOf(current,id).status === 'completed');
    if ((t.status === 'ready') !== ready) setTask(t.id,ready ? 'ready' : 'waiting',ready ? '' : 'Waiting for dependencies.');
  }
}
function outputContract(t:WorkflowTask) {
  return t.outputSchema ? `\nOUTPUT CONTRACT (machine-validated):\nYour FINAL response must be ONLY JSON matching this schema. One correction is permitted.\n${JSON.stringify(t.outputSchema)}` : '';
}
export function delegateWorkflowTask(userId:string,workflowId:string,taskId:string,workerBotId?:string) {
  assertLegacyWorkOpen(userId);
  const w = getWorkflow(userId,workflowId), t = taskOf(w,taskId); requireRuntime();
  if (!['ready','blocked'].includes(t.status) || ['completed','cancelled'].includes(w.status)) throw new WorkflowError('Task cannot be delegated now.',409);
  if(workerBotId) {
    approvedWorkflowWorker(userId,workerBotId);
    if(t.activeJobId && t.assignedBotId!==workerBotId)throw new WorkflowError('Cannot replace an admitted worker.',409);
    return db.transaction(()=>{
    db.prepare('UPDATE native_workflow_tasks SET worker_bot_id=?,assigned_bot_id=?,delegate=1 WHERE task_id=?').run(workerBotId,workerBotId,t.id);
    publishNativeEvent({userId,botId:w.botId,kind:'workflow.assigned',sourceType:'workflow',sourceId:w.id,audience:'internal',data:{taskId,workerBotId}});
    emitWorkflow(userId,w.botId);return workerBotId;
    })();
  }
  if (t.assignedBotId && t.assignedBotId !== w.botId) { ownWorkflowBot(userId,t.assignedBotId); return t.assignedBotId; }
  initSubagents();
  return db.transaction(() => {
    const child = createSubagent(w.botId,t.instructions,t.title,{ structured:true });
    db.prepare('UPDATE native_workflow_tasks SET assigned_bot_id=?,delegate=1 WHERE task_id=?').run(child.id,t.id);
    db.prepare('INSERT OR REPLACE INTO native_workflow_delegations VALUES(?,?,?,?,?)').run(t.id,w.botId,child.id,t.parentTaskId,now());
    emitWorkflow(userId,w.botId); return child.id;
  })();
}
function queueTask(w:Workflow,t:WorkflowTask,text?:string,parentJobId?:string) {
  return db.transaction(()=>{
  const rt = requireRuntime();
  const assigned = t.assignedBotId ?? (t.delegate ? delegateWorkflowTask(w.userId,w.id,t.id) : w.botId);
  assertLegacyWorkOpen(w.userId);
  ownWorkflowBot(w.userId,assigned);if(t.workerBotId)approvedWorkflowWorker(w.userId,t.workerBotId);
  const deps = t.dependsOn.map(id => { const dep = taskOf(w,id); return { taskId:id,title:dep.title,result:dep.result,evidence:dep.evidence }; });
  const prompt = text ?? `Execute native workflow ${w.id}, task ${t.id}: ${t.title}\n${t.instructions}\nVerified prerequisite results:\n${JSON.stringify(deps)}\nAcceptance criteria: ${JSON.stringify(t.criteria)}\nFor row/file evidence, call complete_workflow_task with concrete references. For result criteria, return the contracted JSON.${outputContract(t)}`;
  // enqueue schedules its promise microtask; binding commits before execution starts.
  const jobId = rt.enqueue(assigned,{ type:'system',text:prompt,audience:'internal',workflowId:w.id,taskId:t.id,...(w.goalId?{goalId:w.goalId}:{}),...(parentJobId ? {parentJobId} : {}) });
  db.prepare(`INSERT INTO native_workflow_runs(job_id,workflow_id,task_id,goal_id,bot_id,parent_job_id,status,usage_start,created_at)
    VALUES(?,?,?,?,?,?,'queued',?,?)`).run(jobId,w.id,t.id,w.goalId,assigned,parentJobId ?? null,usageCursor(),now());
  db.prepare('UPDATE native_workflow_tasks SET assigned_bot_id=?,active_job_id=? WHERE task_id=?').run(assigned,jobId,t.id);
  setTask(t.id,'queued');
  publishNativeEvent({userId:w.userId,botId:assigned,kind:'workflow.admitted',sourceType:'workflow',sourceId:w.id,jobId,audience:'internal',data:{taskId:t.id,goalId:w.goalId}});return jobId;
  })();
}
export function dispatchReadyWorkflow(userId:string,id:string) {
  let w = getWorkflow(userId,id); if (w.status !== 'active') return w;
  if (w.goalId && getGoal(userId,w.goalId).status !== 'active') return w;
  recomputeReadiness(w); w = getWorkflow(userId,id);
  for (const t of w.tasks.filter(t => t.status === 'ready')) {
    try { queueTask(w,t); }
    catch (e) { setTask(t.id,'blocked',e instanceof Error ? e.message : 'Could not queue task.'); }
  }
  emitWorkflow(userId,w.botId); return getWorkflow(userId,id);
}
export function startWorkflow(userId:string,id:string) {
  assertLegacyWorkOpen(userId);requireRuntime(); const w = getWorkflow(userId,id);
  if (['completed','cancelled'].includes(w.status)) throw new WorkflowError('Workflow is terminal.',409);
  if (w.goalId && getGoal(userId,w.goalId).status !== 'active') throw new WorkflowError('Resume the goal before starting its workflow.',409);
  db.prepare("UPDATE native_workflows SET status='active',reason='',updated_at=? WHERE id=?").run(now(),id);
  return dispatchReadyWorkflow(userId,id);
}
function cancelExactJob(userId:string,botId:string,jobId:string) {
  const job=db.prepare('SELECT state FROM agent_jobs WHERE id=? AND user_id=? AND bot_id=?').get(jobId,userId,botId) as any;
  if(!job)return;
  if(job.state==='queued') {
    db.prepare("UPDATE agent_jobs SET state='cancelled',finished_at=? WHERE id=? AND user_id=? AND bot_id=? AND state='queued'").run(now(),jobId,userId,botId);
    db.prepare("UPDATE native_workflow_runs SET status='cancelled',finished_at=? WHERE job_id=? AND status='queued'").run(now(),jobId);
    return; // Never interrupt the different job currently using this bot.
  }
  const run=db.prepare('SELECT status FROM native_workflow_runs WHERE job_id=? AND bot_id=?').get(jobId,botId) as any;
  const pending=db.prepare('SELECT state FROM pending_turns WHERE bot_id=?').get(botId) as any;
  let ownsPending=false;try{ownsPending=!!pending && JSON.parse(pending.state).jobId===jobId;}catch{/* Cannot prove ownership of malformed pending state. */}
  if(job.state==='running' || run?.status==='waiting' || ownsPending)runtime?.interrupt(botId,jobId);
  db.prepare("UPDATE native_workflow_runs SET status='cancelled',finished_at=? WHERE job_id=? AND status IN ('queued','waiting')").run(now(),jobId);
}
function stopTaskExecution(w:Workflow,t:WorkflowTask,cancel:boolean,reason:string) {
  if(t.activeJobId && t.assignedBotId)cancelExactJob(w.userId,t.assignedBotId,t.activeJobId);
  if(cancel) {
    // A child bot is not exclusive authority over all work on that bot. Follow
    // persisted job lineage, not parent_bot_id, to cancel only bound descendants.
    // UNION also terminates if a damaged database contains an ancestry cycle.
    const descendants=db.prepare(`WITH RECURSIVE bound(job_id) AS (
      SELECT job_id FROM native_workflow_runs WHERE task_id=?
      UNION SELECT r.job_id FROM native_workflow_runs r JOIN bound b ON r.parent_job_id=b.job_id)
      SELECT r.* FROM native_workflow_runs r JOIN bound b ON b.job_id=r.job_id
      JOIN agent_jobs j ON j.id=r.job_id WHERE j.user_id=? AND r.status IN ('queued','running','waiting')`).all(t.id,w.userId) as any[];
    for(const r of descendants) {
      if(r.workflow_id && r.workflow_id!==w.id) {
        const nested=getWorkflow(w.userId,r.workflow_id);
        if(!['completed','cancelled'].includes(nested.status))controlWorkflow(w.userId,nested.id,'stop',reason);
      }
      if(r.goal_id && r.goal_id!==w.goalId) {
        const nested=getGoal(w.userId,r.goal_id);
        if(!['completed','cancelled'].includes(nested.status))controlGoal(w.userId,nested.id,'stop',reason);
      }
      cancelExactJob(w.userId,r.bot_id,r.job_id);
    }
  }
  if (t.status !== 'completed' && t.status !== 'cancelled') setTask(t.id,cancel ? 'cancelled' : ['running','blocked'].includes(t.status) ? 'blocked' : 'ready',reason);
}
export function controlWorkflow(userId:string,id:string,action:'pause'|'resume'|'block'|'stop',reason='') {
  assertLegacyWorkOpen(userId);const w = getWorkflow(userId,id); if (['completed','cancelled'].includes(w.status)) throw new WorkflowError('Workflow is terminal.',409);
  if (action === 'resume') {
    for (const t of w.tasks.filter(t => t.status === 'blocked')) {
      const active = t.activeJobId && db.prepare("SELECT 1 FROM agent_jobs WHERE id=? AND state='running'").get(t.activeJobId);
      if (active) throw new WorkflowError('A previous worker is still stopping. Wait before resuming.',409);
      setTask(t.id,'waiting');
    }
    return startWorkflow(userId,id);
  }
  const state = action === 'stop' ? 'cancelled' : action === 'block' ? 'blocked' : 'paused';
  db.prepare('UPDATE native_workflows SET status=?,reason=?,updated_at=? WHERE id=?').run(state,reason.slice(0,2000),now(),id);
  for (const t of w.tasks) stopTaskExecution(w,t,action === 'stop',reason || `Workflow ${state}.`);
  emitWorkflow(userId,w.botId); return getWorkflow(userId,id);
}
configureGoalEffects({ control(goal,action) {
  const workflows = listWorkflows(goal.userId).filter(w => w.goalId === goal.id && !['completed','cancelled'].includes(w.status));
  for (const w of workflows) controlWorkflow(goal.userId,w.id,action as 'pause'|'resume'|'block'|'stop',goal.reason);
  if (action !== 'resume') {
    const runs = db.prepare(`SELECT r.job_id,r.bot_id FROM native_workflow_runs r WHERE r.goal_id=? AND r.status IN ('queued','running','waiting')`).all(goal.id) as any[];
    for (const r of runs) {
      cancelExactJob(goal.userId,r.bot_id,r.job_id);
    }
  } else if (!workflows.length) startGoalExecution(goal.userId,goal.id);
}, verified(goal) {
  const queued=db.prepare("SELECT job_id,bot_id FROM native_workflow_runs WHERE goal_id=? AND status IN ('queued','waiting')").all(goal.id) as any[];
  for(const r of queued) {
    cancelExactJob(goal.userId,r.bot_id,r.job_id);
  }
} });

export function startGoalExecution(userId:string,goalId:string,parentJobId?:string) {
  return db.transaction(()=>{
  const rt=requireRuntime(),goal=getGoal(userId,goalId);
  if(goal.status!=='active')throw new WorkflowError('Goal is not active.',409);
  if(goalBudgetReason(goal))throw new WorkflowError(goalBudgetReason(goal)!,409);
  const active=db.prepare("SELECT job_id FROM native_workflow_runs WHERE goal_id=? AND status IN ('queued','running','waiting')").get(goalId) as any;
  if(active)return active.job_id as string;
  const jobId=rt.enqueue(goal.botId,{type:'system',text:`Work toward this native persistent goal.\n${goalContext(goal)}`,...(parentJobId ? {parentJobId} : {})});
  db.prepare(`INSERT INTO native_workflow_runs(job_id,goal_id,bot_id,parent_job_id,status,usage_start,created_at) VALUES(?,?,?,?,'queued',?,?)`)
    .run(jobId,goal.id,goal.botId,parentJobId ?? null,usageCursor(),now());
  return jobId;
  })();
}

export function completeWorkflowTask(userId:string,workflowId:string,taskId:string,evidence:Evidence[],actorBotId?:string) {
  assertLegacyWorkOpen(userId);let w = getWorkflow(userId,workflowId),t = taskOf(w,taskId);
  if (actorBotId && actorBotId !== w.botId && actorBotId !== t.assignedBotId) throw new WorkflowError('Only the parent or assigned worker can complete this task.',404);
  if (t.status === 'completed') return w;
  if (t.status === 'cancelled' || ['cancelled','paused'].includes(w.status)) throw new WorkflowError('Task is not accepting completion.',409);
  if (!t.dependsOn.every(id => taskOf(w,id).status === 'completed')) throw new WorkflowError('Task dependencies are not verified complete.',409);
  if (t.outputSchema && !t.resultValidated) throw new WorkflowError('A schema-validated child result is required.',409);
  const receipts = verifyCriteria(userId,w.botId,t.criteria,evidence);
  db.transaction(() => {
    db.prepare('UPDATE native_workflow_tasks SET evidence=? WHERE task_id=?').run(JSON.stringify(receipts),taskId); setTask(taskId,'completed','Acceptance evidence verified.');
    const pending = db.prepare("SELECT 1 FROM native_workflow_tasks WHERE workflow_id=? AND status!='completed' LIMIT 1").get(workflowId);
    if (!pending) db.prepare("UPDATE native_workflows SET status='completed',reason='',updated_at=? WHERE id=?").run(now(),workflowId);
    else if(!db.prepare("SELECT 1 FROM native_workflow_tasks WHERE workflow_id=? AND status='blocked'").get(workflowId)) {
      db.prepare("UPDATE native_workflows SET status='active',reason='',updated_at=? WHERE id=? AND status='blocked' AND reason='Task acceptance needs review.'").run(now(),workflowId);
    }
    publishNativeEvent({userId,botId:t.assignedBotId??w.botId,kind:'workflow.verified',sourceType:'workflow',sourceId:workflowId,jobId:t.activeJobId??undefined,audience:'internal',data:{taskId,evidence:receipts}});
  })();
  w = getWorkflow(userId,workflowId);
  if (t.assignedBotId && t.assignedBotId !== w.botId && !t.workerBotId) {
    appendRow(w.botId,'message',{type:'message',role:'assistant',text:`Delegated task verified: ${t.title}\n${JSON.stringify({taskId,result:t.result,evidence:receipts})}`});
  }
  emitWorkflow(userId,w.botId); if (w.status === 'active') dispatchReadyWorkflow(userId,workflowId);
  return getWorkflow(userId,workflowId);
}

export interface TurnHook { userId:string;botId:string;jobId:string }
/** Product dispatch must call this after resolving tool_call to its actual name. */
export function workflowScope(ctx:{userId:string;botId:string;jobId?:string}) {
  ownWorkflowBot(ctx.userId,ctx.botId);if(!ctx.jobId)return null;
  const row=db.prepare(`SELECT r.*,j.user_id AS owner_id FROM native_workflow_runs r JOIN agent_jobs j ON j.id=r.job_id WHERE r.job_id=?`).get(ctx.jobId) as any;
  if(!row)return null;
  if(row.owner_id!==ctx.userId || row.bot_id!==ctx.botId)throw new WorkflowError('Native workflow job scope changed.',404);
  return {goalId:row.goal_id as string|null,workflowId:row.workflow_id as string|null,taskId:row.task_id as string|null};
}
export function workflowToolGate(ctx:{userId:string;botId:string;jobId?:string},name:string):{allowed:boolean;reason?:string} {
  let scope:ReturnType<typeof workflowScope>;
  try{scope=workflowScope(ctx);}catch(e){return {allowed:false,reason:e instanceof Error?e.message:'Invalid native workflow scope.'};}
  if(!scope)return {allowed:true};
  if(['spawn_subagent','message_subagent','send_to_bot','post_to_group'].includes(name))return {allowed:false,reason:'This native goal/workflow run cannot enqueue untracked legacy delegation. Use structured workflow tasks and delegate_workflow_task so child work shares the goal budget and stop lifecycle.'};
  if(name==='create_goal')return {allowed:false,reason:'This native run already belongs to a goal/workflow. Use its existing goal and structured task graph; do not mint an independent budget.'};
  return {allowed:true};
}
function ownedRun(ctx:TurnHook) {
  ownWorkflowBot(ctx.userId,ctx.botId);
  const job = db.prepare('SELECT user_id,bot_id,trigger,state FROM agent_jobs WHERE id=?').get(ctx.jobId) as any;
  if (!job || job.user_id !== ctx.userId || job.bot_id !== ctx.botId) throw new WorkflowError('Job not found.',404);
  return { job,run:db.prepare('SELECT * FROM native_workflow_runs WHERE job_id=? AND bot_id=?').get(ctx.jobId,ctx.botId) as any };
}
export function workflowPreTurn(ctx:TurnHook):{allowed:boolean;reason?:string;prompt?:string;remainingTokens?:number} {
  let {job,run} = ownedRun(ctx);
  if (job.state === 'cancelled') return {allowed:false,reason:'Job cancelled.'};
  // Native approval/question continuation inherits its task and goal binding.
  if (!run) {
    const parentJobId = JSON.parse(job.trigger).parentJobId;
    const prior = parentJobId && db.prepare("SELECT * FROM native_workflow_runs WHERE job_id=? AND bot_id=? AND status='waiting'").get(parentJobId,ctx.botId) as any;
    if (prior) {
      db.prepare(`INSERT INTO native_workflow_runs(job_id,workflow_id,task_id,goal_id,bot_id,parent_job_id,status,usage_start,created_at)
        VALUES(?,?,?,?,?,?,'queued',?,?)`).run(ctx.jobId,prior.workflow_id,prior.task_id,prior.goal_id,ctx.botId,parentJobId,usageCursor(),now());
      if (prior.task_id) db.prepare('UPDATE native_workflow_tasks SET active_job_id=? WHERE task_id=?').run(ctx.jobId,prior.task_id);
      db.prepare("UPDATE native_workflow_runs SET status='continued' WHERE job_id=? AND status='waiting'").run(parentJobId);
      run = ownedRun(ctx).run;
    }
  }
  if (!run) {
    // Adopt ordinary turns only for an explicitly active standalone goal; a
    // workflow's parent chat must not accidentally consume its execution budget.
    const goal = listGoals(ctx.userId,ctx.botId).find(g => g.status === 'active' && !db.prepare("SELECT 1 FROM native_workflows WHERE goal_id=? AND status NOT IN ('completed','cancelled')").get(g.id));
    if (!goal) return {allowed:true};
    db.prepare(`INSERT INTO native_workflow_runs(job_id,goal_id,bot_id,status,usage_start,created_at) VALUES(?,?,?,'queued',?,?)`).run(ctx.jobId,goal.id,ctx.botId,usageCursor(),now());
    run = ownedRun(ctx).run;
  }
  if (['completed','failed','interrupted','cancelled'].includes(run.status)) return {allowed:false,reason:'This run already settled.'};
  let w:Workflow|undefined,t:WorkflowTask|undefined;
  if (run.workflow_id) {
    w = getWorkflow(ctx.userId,run.workflow_id); t = taskOf(w,run.task_id);
    if (w.status !== 'active' || !['queued','running'].includes(t.status) || t.activeJobId !== ctx.jobId) return {allowed:false,reason:'Workflow is paused, blocked or superseded.'};
    if (!t.dependsOn.every(id => taskOf(w!,id).status === 'completed')) return {allowed:false,reason:'Dependencies are not complete.'};
  }
  let goal:Goal|undefined;
  if (run.goal_id) {
    const decision = reserveGoalTurn(ctx.userId,run.goal_id,ctx.botId,ctx.jobId); goal = decision.goal;
    if (!decision.allowed) return {allowed:false,reason:goal.reason || 'Goal is not active.'};
  }
  db.prepare("UPDATE native_workflow_runs SET status='running' WHERE job_id=?").run(ctx.jobId);
  if (t) setTask(t.id,'running');
  if (w) emitWorkflow(ctx.userId,w.botId);
  return {allowed:true,prompt:[goal && goalContext(goal),t && `Assigned workflow task ${t.id}: ${t.instructions}${outputContract(t)}`].filter(Boolean).join('\n\n'),
    ...(goal?.maxTokens !== null && goal?.maxTokens !== undefined ? {remainingTokens:Math.max(0,goal.maxTokens-goal.tokensUsed)} : {})};
}
export function checkWorkflowBudget(ctx:TurnHook):{allowed:boolean;reason?:string;remainingTokens?:number} {
  const {job,run}=ownedRun(ctx); if(job.state==='cancelled') return {allowed:false,reason:'Job cancelled.'};
  if (!run) return {allowed:true};
  if(run.workflow_id && getWorkflow(ctx.userId,run.workflow_id).status!=='active') return {allowed:false,reason:'Workflow is not active.'};
  if(!run.goal_id) return {allowed:true};
  const g=getGoal(ctx.userId,run.goal_id); if(g.status!=='active')return {allowed:false,reason:g.reason || 'Goal is not active.'};
  // Check all live children against the shared goal budget. Usage recording must
  // be awaited by the loop before this hook; empty pre-call accounting is zero,
  // while a recorded unavailable/estimated value fails closed for a finite cap.
  let liveTokens=0,liveSpend=0,unknownTokens=!!g.unknownTokenTurns,unknownSpend=!!g.unknownSpendTurns;
  const liveTurns=db.prepare("SELECT job_id,bot_id,usage_start FROM native_goal_turns WHERE goal_id=? AND status='running'").all(g.id) as any[];
  for(const turn of liveTurns) {
    if(!hasObservedTurnUsage(ctx.userId,turn.bot_id,turn.usage_start,turn.job_id))continue;
    const live=observedTurnUsage(ctx.userId,turn.bot_id,turn.usage_start,turn.job_id);
    if(live.tokens===null)unknownTokens=true;else liveTokens+=live.tokens;
    if(live.costUsd===null)unknownSpend=true;else liveSpend+=live.costUsd;
  }
  // The current reserved turn may finish even when it is the final allowed turn.
  const reason = g.maxTokens!==null && unknownTokens ? 'Token accounting unavailable; finite budget cannot be enforced.'
    : g.maxSpendUsd!==null && unknownSpend ? 'Spend accounting unavailable; finite budget cannot be enforced.'
    : g.maxTokens!==null && g.tokensUsed+liveTokens>=g.maxTokens ? 'Token budget exhausted.'
    : g.maxSpendUsd!==null && g.spendUsd+liveSpend>=g.maxSpendUsd ? 'Spend budget exhausted.' : null;
  if(reason) { controlGoal(ctx.userId,g.id,'pause',reason); return {allowed:false,reason}; }
  return {allowed:true,...(g.maxTokens!==null ? {remainingTokens:Math.max(0,g.maxTokens-g.tokensUsed-liveTokens)} : {})};
}
export async function workflowAfterTurn(ctx:TurnHook & {status:'completed'|'waiting'|'interrupted'|'failed';finalText?:string;usage?:TurnUsage}) {
  const {run}=ownedRun(ctx);
  const finishingWait=run?.status==='waiting' && ['interrupted','failed'].includes(ctx.status);
  if(!run || !['running','queued'].includes(run.status) && !finishingWait)return;
  // finishPending may settle an approval wait after its original turn already
  // accounted usage. settleGoalTurn is idempotent and never charges it twice.
  const goal=run.goal_id ? settleGoalTurn(ctx.userId,ctx.jobId,ctx.usage) : null;
  db.prepare('UPDATE native_workflow_runs SET status=?,finished_at=? WHERE job_id=?').run(ctx.status,now(),ctx.jobId);
  if(ctx.status==='waiting') {
    if(run.task_id) { setTask(run.task_id,'queued','Waiting for a user decision.'); emitWorkflow(ctx.userId,getWorkflow(ctx.userId,run.workflow_id).botId); }
    return;
  }
  if(run.workflow_id) {
    let w=getWorkflow(ctx.userId,run.workflow_id),t=taskOf(w,run.task_id);
    if(t.activeJobId!==ctx.jobId || ['completed','cancelled'].includes(t.status) || w.status==='cancelled')return;
    if(ctx.status!=='completed') {
      setTask(t.id,'blocked',ctx.status==='interrupted' ? 'Execution interrupted; review possible side effects before resuming.' : 'Execution failed; review before retrying.');
      db.prepare("UPDATE native_workflows SET status='blocked',reason=?,updated_at=? WHERE id=? AND status='active'").run('Task execution needs review.',now(),w.id);
    } else if(w.status!=='active') { setTask(t.id,'blocked','Workflow was paused during execution.'); }
    else if(t.outputSchema) {
      const v=validateChildResult(ctx.finalText ?? '',t.outputSchema);
      if(!v.valid) {
        if(t.correctionCount<1 && (!goal || goal.status==='active' && !goalBudgetReason(goal))) {
          db.prepare('UPDATE native_workflow_tasks SET correction_count=correction_count+1 WHERE task_id=?').run(t.id);
          setTask(t.id,'ready'); t=taskOf(getWorkflow(ctx.userId,w.id),t.id);
          try { queueTask(w,t,`Your previous final response failed the output contract. Validation errors:\n${v.errors.map(e=>`- ${e}`).join('\n')}\nReply ONLY with corrected JSON. This is the single correction attempt.${outputContract(t)}`,ctx.jobId); }
          catch(e) { setTask(t.id,'blocked',e instanceof Error ? e.message : 'Could not schedule correction.'); }
        } else setTask(t.id,'blocked',`Output schema validation failed after the permitted attempt: ${v.errors.join('; ')}`);
      } else {
        db.prepare('UPDATE native_workflow_tasks SET result_json=?,result_validated=1 WHERE task_id=?').run(JSON.stringify(v.value),t.id);
        if(t.criteria.every(c=>c.kind==='result')) {
          try { completeWorkflowTask(ctx.userId,w.id,t.id,t.criteria.map(c=>({criterionId:c.id,kind:'result' as const,taskId:t.id}))); }
          catch(e) { setTask(t.id,'blocked',e instanceof Error ? e.message : 'Acceptance failed.'); }
        } else setTask(t.id,'blocked','Result validated. Concrete evidence is still required for remaining acceptance criteria.');
      }
    } else setTask(t.id,'blocked','Turn ended without verified acceptance evidence. Inspect the output and submit concrete evidence.');
    const updated=getWorkflow(ctx.userId,w.id);
    if(updated.status==='active' && updated.tasks.some(t=>t.status==='blocked') && !updated.tasks.some(t=>['ready','queued','running'].includes(t.status))) {
      db.prepare("UPDATE native_workflows SET status='blocked',reason='Task acceptance needs review.',updated_at=? WHERE id=?").run(now(),w.id);
    }
    emitWorkflow(ctx.userId,w.botId);
  } else if(goal && goal.status==='active') {
    if(ctx.status!=='completed') controlGoal(ctx.userId,goal.id,'block','Execution interrupted or failed; review side effects before resuming.');
    else {
      const reason=goalBudgetReason(goal);
      if(reason)controlGoal(ctx.userId,goal.id,'pause',reason);
      else if(runtime && !db.prepare("SELECT 1 FROM native_workflows WHERE goal_id=? AND status NOT IN ('completed','cancelled')").get(goal.id)) {
        try { startGoalExecution(ctx.userId,goal.id,ctx.jobId); }
        catch(e) { controlGoal(ctx.userId,goal.id,'block',`Could not queue goal continuation: ${e instanceof Error ? e.message : 'Queue unavailable.'}`); }
      }
    }
  }
  if(goal && goal.status==='active' && goalBudgetReason(getGoal(ctx.userId,goal.id))) controlGoal(ctx.userId,goal.id,'pause',goalBudgetReason(getGoal(ctx.userId,goal.id))!);
}
export function recoverWorkflows() {
  // Select only writable owner/FK scopes before settling usage or changing any
  // workflow state. The immediate transaction keeps a new migration hold from
  // racing this selection; the SQL ownership fences remain the final guard.
  return db.transaction(() => {
  const writable=legacyWritableRows(db,'native_workflow_runs');
  const lost=db.prepare(`SELECT native_workflow_runs.* FROM native_workflow_runs
    JOIN agent_jobs j ON j.id=native_workflow_runs.job_id
    WHERE (native_workflow_runs.status='running' OR native_workflow_runs.status='queued' AND j.state IN ('running','uncertain'))
    AND (${writable})`).all() as any[];
  const goals=new Set<string>();
  for(const r of lost) {
    const bot=db.prepare('SELECT user_id FROM bots WHERE id=?').get(r.bot_id) as any; if(!bot)continue;
    if(r.goal_id) { settleGoalTurn(bot.user_id,r.job_id); goals.add(r.goal_id); }
    db.prepare("UPDATE native_workflow_runs SET status='interrupted',finished_at=? WHERE job_id=?").run(now(),r.job_id);
    if(r.task_id) {
      const w=getWorkflow(bot.user_id,r.workflow_id); if(w.status==='cancelled')continue;
      setTask(r.task_id,'blocked','Worker restarted with an uncertain outcome; inspect side effects before resuming.');
      db.prepare("UPDATE native_workflows SET status='blocked',reason='Worker restarted; execution outcome uncertain.',updated_at=? WHERE id=? AND status NOT IN ('completed','cancelled')").run(now(),w.id);
      emitWorkflow(bot.user_id,w.botId);
    }
  }
  for(const id of goals) { const r=db.prepare('SELECT user_id FROM native_goals WHERE id=?').get(id) as any;
    if(r && !['completed','cancelled'].includes(getGoal(r.user_id,id).status))controlGoal(r.user_id,id,'block','Worker restarted; inspect the uncertain execution before continuing.'); }
  return {interruptedRuns:lost.length,blockedGoals:goals.size};
  }).immediate();
}
