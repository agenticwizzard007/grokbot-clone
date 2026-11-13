import { recordModelUsage, withUsage } from '../usage.js';
import { selectedCli } from '../cli/store.js';
import { withNativeTools, type NativeToolHandler } from '../cli/native-tools.js';
import { llmClient, llmProvider, modelFor, withFast, modelInfo, prepareInput, textOnlyInput, providerFields, serverTools, tagOutput } from '../lib/llm.js';
import { db, now } from '../db.js';
import { env } from '../env.js';
import { newId, sha256 } from '../lib/ids.js';
import { hub } from '../lib/hub.js';
import { appendHistory, appendRow, emitBot, getBotRow, getRow, loadHistory, setLive, updateRow } from '../store.js';
import type { MessageBody, ToolCallBody } from '../types.js';
import { composioTools } from '../composio.js';
import { appName } from '../tool-activity.js';
import { systemPrompt } from './prompt.js';
import { deduplicateBrowserSnapshots, repairHistory } from './history.js';
import { maybeCompact, noteUsage } from './memory.js';
import { activityFor, allowedDuringSetup, executionPolicyFor, functionSchemas, humanizeSlug, runComposioTool, toolMap, type ToolCtx, type ToolResult } from './tools.js';
import { isConfiguring } from '../bot-setup.js';
import { mcpSchemas, runMcpTool } from '../mcp/client.js';
import { findMcpTool } from '../mcp/store.js';
import { latency } from '../lib/latency.js';
import { localAccess } from '../computers/local-access.js';
import { currentComputerRevision, executionAudience } from '../usage-context.js';
import { approvalBinding } from '../security/approval.js';
import { acceptJob, beginJob, finishJob, recoverJobs, beginTool, finishTool } from './jobs.js';
import { BrowserRecovery } from './browser-recovery.js';
import { assembleToolCatalog, resolveToolCall, validateToolArguments } from './tool-catalog.js';
import { runProgram, isProgramResumable, recoverPrograms, cancelProgram } from './programs.js';
import { configureWorkflowRuntime, workflowPreTurn, checkWorkflowBudget, workflowToolGate, workflowAfterTurn, recoverWorkflows } from './workflows.js';
import { onJobStarted, onJobFinished, recoverDeliverables, drainDeliveries } from '../deliverables/index.js';
import {contextRevision} from './context-refresh.js';
import {recordJobCompletion,pendingJobCompletions,acknowledgeJobCompletion} from '../native/job-completions.js';
import { beforeForegroundTurn, onLearningTurn, learningForegroundEpoch, learningSourceSnapshot } from './learning.js';
import { configureCoordinationRuntime, recordCoordinationJobOutcome, enqueueInternalMessage, onCoordinationJobFinished, coordinationPreTurn } from '../coordination/index.js';
import { prepareDeliveryAction } from '../deliverables/approval.js';

// A native CLI generation can span the entire agent workflow, including tool
// calls. Let it finish or be cancelled; an API request keeps its own deadline.
const llm = () => llmClient(360_000, { subscriptionTimeoutMs: 0 });

export type Trigger = (
  /** channel: where the user wrote it (a text channel via the messaging bridge; absent = the web app). */
  | { type: 'user'; text: string; channel?: 'imessage' | 'sms' | 'whatsapp'; images?: string[]; voice?: boolean; quote?: string; voiceAssignment?: boolean }
  | { type: 'routine'; routineId: string; routineRunId?: string; name: string; prompt: string }
  | { type: 'bot'; fromBotId: string; fromName: string; text: string; depth: number }
  | { type: 'system'; text: string; connectionCardSeq?: number }
  | { type: 'native-tool'; name: 'SWARM_APPS_EXECUTE'; args: Record<string, unknown>; callId: string; requireApproval?: boolean; readOnly?: boolean }
  | { type: 'resume' }) & { parentJobId?: string; audience?: 'internal'; coordinationRequestId?:string; coordinationWakeId?:string; workflowId?:string;taskId?:string;goalId?:string;proactiveSlotKey?:string;coordinationReportPeriod?:string };

interface PendingState {
  /** A native voice invocation resumes the exact tool without asking a text model to re-plan it. */
  native?: boolean;
  nativeRequireApproval?: boolean;
  nativeReadOnly?: boolean;
  /** A browser recovery invalidates any sibling actions planned on the old page. */
  replan?: boolean;
  jobId?: string;
  /** Keep paused approvals bound to the computer on which this batch was planned. */
  computerRevision?: number;
  /** function_call items still to process, in order. */
  calls: { call_id: string; name: string; arguments: string; rowSeq: number }[];
  /** outputs already produced for this batch. */
  outputs: any[];
  approvalId: string;
  depth: number;
}

// Rotate native CLI generations so replay caches and model context stay bounded.
// This is a checkpoint interval, not a limit on the task's total tool calls.
const CLI_TOOL_CHECKPOINT_INTERVAL = 60;
const KEEP_IMAGES = 3;

// ---------- per-bot serial queue ----------

const queues = new Map<string, Promise<void>>();
const aborts = new Map<string, AbortController>();
const running = new Map<string, Trigger>();
const activeJobs = new Map<string, string>();
const completions = new Map<string, {status:string;finalText:string;iterations:number;generation:number;model:string;provider:string;messagesSnapshot:any[];systemPrompt?:string;contextWindow?:number;temporary:boolean;foregroundEpoch:number;sourceSnapshot:ReturnType<typeof learningSourceSnapshot>}>();
const modelSnapshots = new WeakMap<ToolCtx,{systemPrompt:string;contextWindow?:number;model:string;provider:string;contextRevision:string}>();
const userQueues = new Map<string, Promise<void>>();
const scheduledJobs = new Set<string>();
/** Drain accepted work before orderly shutdown or test storage teardown. */
export async function settleAgentJobs() { while (queues.size) await Promise.allSettled([...queues.values()]); }


/** The trigger of the turn a Bot is running right now (rows it writes during the turn belong to it). */
export const currentTrigger = (botId: string): Trigger | undefined => running.get(botId);

export function enqueue(botId: string, trigger: Trigger) {
  const admitted=db.transaction(()=>{
  // Questions and approvals end one run before their continuation starts. Preserve the
  // lineage so observers track the assignment instead of mistaking that pause for completion.
  let question: ReturnType<typeof getRow> = null;
  if (trigger.type === 'resume') {
    const pending = db.prepare('SELECT state FROM pending_turns WHERE bot_id=?').get(botId) as { state: string } | undefined;
    const parentJobId = pending ? (JSON.parse(pending.state) as PendingState).jobId : undefined;
    if (parentJobId) {
      const prior=db.prepare("SELECT id,user_id FROM agent_jobs WHERE bot_id=? AND json_extract(trigger,'$.parentJobId')=? AND json_extract(trigger,'$.type')='resume' AND state IN ('queued','running') ORDER BY created_at DESC LIMIT 1").get(botId,parentJobId) as {id:string;user_id:string}|undefined;
      if(prior)return {job:{id:prior.id,userId:prior.user_id},trigger:{...trigger,parentJobId}};
      trigger={...trigger,parentJobId};
    }
  } else if (trigger.type === 'user' && !trigger.voiceAssignment) {
    const bot = getBotRow(botId);
    const pending = bot && db.prepare("SELECT seq FROM rows WHERE bot_id=? AND generation=? AND kind='card' AND json_extract(body,'$.card')='question' AND json_extract(body,'$.status') IN ('pending','answered') AND json_extract(body,'$.jobId') IS NOT NULL AND json_extract(body,'$.answerJobId') IS NULL ORDER BY seq DESC LIMIT 1").get(botId, bot.generation) as { seq: number } | undefined;
    question = pending ? getRow(botId, pending.seq) : null;
    if (question?.body.type === 'card' && question.body.card === 'question' && question.body.jobId) trigger = { ...trigger, parentJobId: question.body.jobId };
  } else if (trigger.type === 'system' && !independentTrigger(trigger)) {
    const bot = getBotRow(botId);
    if (trigger.connectionCardSeq !== undefined) {
      const candidate = bot ? getRow(botId, trigger.connectionCardSeq) : null;
      if(candidate?.body.type==='card'&&candidate.body.card==='connect'&&candidate.body.answerJobId) {
        const prior=db.prepare('SELECT id,user_id,trigger FROM agent_jobs WHERE id=? AND bot_id=?').get(candidate.body.answerJobId,botId) as any;
        if(prior)return {job:{id:prior.id,userId:prior.user_id},trigger:JSON.parse(prior.trigger) as Trigger};
      }
      if (candidate?.body.type === 'card' && candidate.body.card === 'connect' && ['connected', 'skipped'].includes(candidate.body.status) && !candidate.body.answerJobId) question = candidate;
    } else {
      const resolved = bot && db.prepare("SELECT seq FROM rows WHERE bot_id=? AND generation=? AND kind='card' AND json_extract(body,'$.card')='connect' AND json_extract(body,'$.status') IN ('connected','skipped') AND json_extract(body,'$.jobId') IS NOT NULL AND json_extract(body,'$.answerJobId') IS NULL ORDER BY seq DESC LIMIT 1").get(botId, bot.generation) as { seq: number } | undefined;
      question = resolved ? getRow(botId, resolved.seq) : null;
    }
    if (question?.body.type === 'card' && question.body.card === 'connect' && question.body.jobId) trigger = { ...trigger, parentJobId: question.body.jobId };
  }
  if (trigger.parentJobId) {
    const parent = db.prepare('SELECT trigger FROM agent_jobs WHERE id=? AND bot_id=?').get(trigger.parentJobId,botId) as {trigger:string}|undefined;
    if (parent) { const t = JSON.parse(parent.trigger); trigger = { ...trigger, audience:t.audience, coordinationRequestId:t.coordinationRequestId, coordinationWakeId:t.coordinationWakeId,workflowId:t.workflowId,taskId:t.taskId,goalId:t.goalId,proactiveSlotKey:t.proactiveSlotKey,coordinationReportPeriod:t.coordinationReportPeriod }; }
  }
  const job = acceptJob(botId, trigger);
  void beforeForegroundTurn(job.userId,botId).catch(()=>console.error('[learning] foreground admission fence failed'));
  if (question?.body.type === 'card' && question.body.card === 'question' && trigger.type === 'user') {
    updateRow(botId, question.seq, { ...question.body, status: 'answered', answer: question.body.answer ?? trigger.text, answerJobId: job.id });
  } else if (question?.body.type === 'card' && question.body.card === 'connect' && trigger.type === 'system') {
    updateRow(botId, question.seq, { ...question.body, answerJobId: job.id });
  }
  return {job,trigger};
  })();
  scheduleJob(admitted.job.id,admitted.job.userId,botId,admitted.trigger);
  return admitted.job.id;
}

// Independent voice assignments and legacy native invocations share one durable FIFO.
// Answers, corrections and approval/connection continuations must be able to bypass it.
const independentJobSql = `(json_extract(trigger,'$.type') IN ('native-tool','bot','routine') OR
  (json_extract(trigger,'$.type')='system' AND (json_extract(trigger,'$.audience')='internal' OR json_extract(trigger,'$.workflowId') IS NOT NULL OR json_extract(trigger,'$.proactiveSlotKey') IS NOT NULL)) OR
  (json_extract(trigger,'$.type')='user' AND json_extract(trigger,'$.voiceAssignment')=1))`;
function independentTrigger(t:Trigger) { return !t.parentJobId && (t.type==='native-tool' || t.type==='bot' || t.type==='routine' || t.type==='user' && t.voiceAssignment===true || t.type==='system' && (t.audience==='internal' || !!t.workflowId || !!t.proactiveSlotKey)); }
function hasPendingDecision(botId: string) {
  // A card can resolve before its answer/callback runs; that continuation still
  // takes priority over independent work already scheduled on this bot.
  return !!db.prepare('SELECT 1 FROM pending_turns WHERE bot_id=?').get(botId)
    || !!db.prepare(`SELECT 1 FROM rows r JOIN bots b ON b.id=r.bot_id AND b.generation=r.generation
      WHERE r.bot_id=? AND r.kind='card' AND json_extract(r.body,'$.card') IN ('question','approval','connect')
      AND (json_extract(r.body,'$.status')='pending' OR EXISTS (
        SELECT 1 FROM agent_jobs j WHERE j.id=json_extract(r.body,'$.answerJobId')
        AND j.bot_id=r.bot_id AND j.state IN ('queued','running')
      )) LIMIT 1`).get(botId);
}

function scheduleJob(jobId: string, userId: string, botId: string, trigger: Trigger) {
  if (scheduledJobs.has(jobId)) return;
  scheduledJobs.add(jobId);
  const queuedAt = performance.now();
  const prev = queues.get(botId) ?? Promise.resolve();
  const subscription = !!selectedCli(userId);
  const userPrev = subscription ? Promise.resolve() : userQueues.get(userId) ?? Promise.resolve();
  // Usage attribution: every model call in this turn (including compaction) is billed to this Bot and its owner.
  const next = Promise.all([prev, userPrev]).then(async () => {
    // Independent work cannot replace an unresolved approval or answer a question.
    // Release the serial queue while it waits so another agent or a follow-up can run.
    if (independentTrigger(trigger) && (
      hasPendingDecision(botId) ||
      db.prepare(`SELECT 1 FROM agent_jobs WHERE bot_id=? AND state='queued' AND ${independentJobSql}
        AND rowid < (SELECT rowid FROM agent_jobs WHERE id=?) LIMIT 1`).get(botId, jobId)
    )) return;
    if (!beginJob(jobId)) return;
    latency('queue', queuedAt, { botId });
    try {
      await beforeForegroundTurn(userId,botId);
      await withUsage({ userId,botId,jobId,reviewId:null,kind:'chat',audience:trigger.audience??(trigger.type==='bot'?'internal':'user') }, () => runTurn(botId,trigger,jobId));
      db.transaction(()=>{finishJob(jobId,true);const c=completions.get(jobId);if(c){recordCoordinationJobOutcome({userId,botId,jobId,status:c.status,finalText:c.finalText,trigger});recordJobCompletion({userId,botId,jobId,trigger,completion:c});}})();
    } catch { db.transaction(()=>{finishJob(jobId,false);const c=completions.get(jobId);if(c){recordCoordinationJobOutcome({userId,botId,jobId,status:c.status,finalText:c.finalText,trigger});recordJobCompletion({userId,botId,jobId,trigger,completion:c});}})(); }
    completions.delete(jobId);
    await dispatchJobCompletions(jobId);
  }).catch(() => { finishJob(jobId, false); });
  if (!subscription) userQueues.set(userId, next);
  queues.set(botId, next);
  next.finally(() => {
    scheduledJobs.delete(jobId);
    if (queues.get(botId) === next) queues.delete(botId);
    if (userQueues.get(userId) === next) userQueues.delete(userId);
    // Answers, resumes and connection callbacks release the next independent job
    // only after their own continuation has cleared every pending decision.
    if (!hasPendingDecision(botId)) {
      const waiting = db.prepare(`SELECT id,user_id,trigger FROM agent_jobs WHERE bot_id=? AND state='queued' AND ${independentJobSql} ORDER BY rowid`).all(botId) as { id: string; user_id: string; trigger: string }[];
      for (const job of waiting) scheduleJob(job.id, job.user_id, botId, JSON.parse(job.trigger));
    }
  });
}
export async function dispatchJobCompletions(jobId?:string) {
 for(const item of pendingJobCompletions(jobId)) {
  const {userId,botId,jobId:sourceJobId,trigger,completion}=item.input;
  if(!item.coordinationDone)try {
   await onCoordinationJobFinished({userId,botId,jobId:sourceJobId,status:completion.status,finalText:completion.finalText,trigger});
   acknowledgeJobCompletion(userId,sourceJobId,'coordination');
  }catch{console.error('[coordination] completion deferred for recovery');}
  if(!item.learningDone)try {
   await withUsage({userId,botId,jobId:sourceJobId,kind:'background_review'},()=>onLearningTurn({userId,botId,jobId:sourceJobId,triggerType:trigger.workflowId?'workflow':trigger.proactiveSlotKey?'checkin':trigger.type,depth:trigger.type==='bot'?trigger.depth:0,...completion} as Parameters<typeof onLearningTurn>[0]));
   acknowledgeJobCompletion(userId,sourceJobId,'learning');
  }catch{console.error('[learning] completion deferred for recovery');}
 }
}
let completionTimer:ReturnType<typeof setInterval>|undefined;
export function initDurableJobs() {
  recoverPrograms();
  recoverWorkflows();
  const jobs = recoverJobs();
  recoverDeliverables();
  void dispatchJobCompletions().catch(()=>console.error('[native] completion recovery deferred'));
  completionTimer ??= setInterval(()=>void dispatchJobCompletions().catch(()=>console.error('[native] completion recovery deferred')),2000);
  completionTimer.unref();
  void drainDeliveries().catch(() => console.error('[deliverables] pending delivery drain failed'));
  for (const job of jobs) scheduleJob(job.id, job.user_id, job.bot_id, JSON.parse(job.trigger));
}
configureWorkflowRuntime({ enqueue, interrupt });
configureCoordinationRuntime({ enqueue:(botId,t)=>{
  if(t.type==='bot'&&(!t.fromBotId||!t.fromName||t.depth===undefined))throw new Error('Internal sender identity is required.');
  return enqueue(botId,t as Trigger);
}, interrupt });

/** The running turn's abort signal (aborted when the user stops the Bot). */
export const turnSignal = (botId: string): AbortSignal | undefined => aborts.get(botId)?.signal;

export function interrupt(botId: string, expectedJobId?: string) {
  // Workflow controls target a durable job. Cancelling queued work must not
  // abort an unrelated chat that currently owns this Bot's serial queue.
  const matchesActive = expectedJobId === undefined || activeJobs.get(botId) === expectedJobId;
  if (matchesActive) aborts.get(botId)?.abort();
  if (!aborts.has(botId) || !matchesActive) {
    const pending = db.prepare('SELECT state FROM pending_turns WHERE bot_id=?').get(botId) as { state: string } | undefined;
    const bot = getBotRow(botId);
    const state = pending ? JSON.parse(pending.state) as PendingState : undefined;
    if (state && bot && (expectedJobId === undefined || state.jobId === expectedJobId)) {
      void finishPending({ userId: bot.user_id, botId, enqueueBotMessage, depth: 0 }, state, 'stopped')
        .catch(() => console.error('[agent] pending cancellation failed', botId));
      if (!aborts.has(botId)) setLive(botId, { isRunning: false, activity: null, awaiting: null, startedAt: null });
      emitBot(botId);
    }
  }
}

/** Run a job in the bot's serial queue, after any running turn (e.g. a manual compaction). */
export function runInBotQueue<T>(botId: string, job: () => Promise<T>): Promise<T> {
  const prev = queues.get(botId) ?? Promise.resolve();
  const result = prev.then(() => withUsage({ botId }, job));
  const next = result.then(() => {}, () => {});
  queues.set(botId, next);
  next.finally(() => { if (queues.get(botId) === next) queues.delete(botId); });
  return result;
}

export const isBotBusy = (botId: string) => queues.has(botId);

function enqueueBotMessage(fromBotId: string, toBotId: string, text: string, depth: number) {
  return enqueueInternalMessage(fromBotId,toBotId,text,depth);
}

// ---------- history helpers ----------

/** Keep only the most recent screenshots inline; older ones become a short caption. */
function pruneImages(items: any[]): any[] {
  let seen = 0;
  const out = [...items];
  for (let i = out.length - 1; i >= 0; i--) {
    const it = out[i];
    const content = it?.type === 'function_call_output' ? it.output : it?.role === 'user' ? it.content : null;
    if (!Array.isArray(content)) continue;
    if (!content.some((c: any) => c?.type === 'input_image')) continue;
    seen++;
    if (seen > KEEP_IMAGES) {
      const replaced = content.map((c: any) => (c?.type === 'input_image' ? { type: 'input_text', text: '[older screenshot omitted]' } : c));
      out[i] = it.type === 'function_call_output' ? { ...it, output: replaced } : { ...it, content: replaced };
    }
  }
  return out;
}

function triggerItem(t: Trigger): any | null {
  switch (t.type) {
    case 'user': {
      const label = t.channel === 'sms' ? 'SMS' : t.channel === 'whatsapp' ? 'WhatsApp' : 'iMessage';
      const text = t.channel ? `[via ${label}${t.voice ? ', voice note' : ''}] ${t.text}` : t.text;
      if (!t.images?.length) return { role: 'user', content: text };
      return { role: 'user', content: [{ type: 'input_text', text }, ...t.images.map((url) => ({ type: 'input_image', image_url: url, detail: 'auto' }))] };
    }
    case 'routine': return { role: 'user', content: `[Routine "${t.name}" is running now. Do this:]\n${t.prompt}` };
    case 'bot': return { role: 'user', content: `[Message from ${t.fromName}, another Bot on the team. Your final result is returned automatically to the originating request; do not create a redundant reply request.]\n${t.text}` };
    case 'system': return { role: 'user', content: `[System notice] ${t.text}` };
    case 'resume':
    case 'native-tool': return null;
  }
}

// ---------- the turn ----------

async function runTurn(botId: string, trigger: Trigger, jobId: string) {
  const turnStart = performance.now();
  const bot = getBotRow(botId);
  if (!bot) return;
  const userId: string = bot.user_id;
  const ctrl = new AbortController();
  aborts.set(botId, ctrl);
  running.set(botId, trigger);
  activeJobs.set(botId, jobId);
  let depth = trigger.type === 'bot' ? trigger.depth : 0;
  const toolRows: number[] = [];
  let outcome: 'completed' | 'waiting' | 'interrupted' | 'failed' = 'completed';
  let finalText = '';
  let iterations = 0;
  const foregroundEpoch=learningForegroundEpoch(userId,botId);
  let admitted = false;
  let routineStarted = false;

  const ctx: ToolCtx = { userId, botId, jobId, enqueueBotMessage, depth, recovery: new BrowserRecovery() };
  ctx.availableTools = async () => [
    ...functionSchemas(botId), ...mcpSchemas(userId, botId), ...await composioTools(userId),
    ...(isConfiguring(botId) ? [] : serverTools()),
  ];
  setLive(botId, { isRunning: true, activity: { kind: 'thinking', since: now() }, awaiting: null, startedAt: now() });

  try {
    // Settle a superseded approval before adopting the new job into a goal.
    // The old run may block its goal; that must not capture the replacement chat.
    const pendingRow = db.prepare('SELECT state FROM pending_turns WHERE bot_id=?').get(botId) as any;
    if (pendingRow && trigger.type !== 'resume' && !independentTrigger(trigger)) {
      const st = JSON.parse(pendingRow.state) as PendingState;
      await finishPending(ctx, st, 'denied-by-new-message');
    }
    const authority = coordinationPreTurn({userId,botId,jobId,trigger});
    if (!authority.allowed) throw new Error(authority.reason??'Coordination authority changed.');
    const gate = workflowPreTurn({ userId, botId, jobId });
    if (!gate.allowed) throw new Error(gate.reason ?? 'Workflow cannot continue.');
    admitted = true;
    ctx.workflowPrompt = gate.prompt;
    ctx.remainingTokens = gate.remainingTokens;
    onJobStarted({ jobId, botId, trigger });
    routineStarted = true;
    if (trigger.type === 'resume') {
      if (!pendingRow) return;
      const st = JSON.parse(pendingRow.state) as PendingState;
      const pausedJobId=st.jobId;
      st.jobId = jobId;
      toolRows.push(...st.calls.map(c => c.rowSeq));
      if ((st.computerRevision ?? 0) !== localAccess(userId).revision) {
        outcome='interrupted';
        await finishPending(ctx, {...st,jobId:pausedJobId}, 'computer-changed');
        appendRow(botId, 'notice', { type: 'notice', text: 'Your selected computer changed. The previous approval and its remaining actions were cancelled. Send a new request to continue on the selected computer.', tone: 'info' });
        return;
      }
      depth = st.depth;
      ctx.depth=st.depth;
      ctx.readOnlyApps = st.nativeReadOnly;
      const paused = await processCalls(ctx, st);
      if (paused) return;
      if (st.native) { publishNativeResult(botId, st); return; }
      if (st.outputs.some((o: any) => o.__endTurn)) return;
    } else if (trigger.type === 'native-tool') {
      if (trigger.name !== 'SWARM_APPS_EXECUTE') throw new Error('Unsupported native app operation.');
      ctx.readOnlyApps = trigger.readOnly;
      const call = { type: 'function_call', call_id: trigger.callId, name: trigger.name, arguments: JSON.stringify(trigger.args) };
      appendHistory(botId, [call]);
      const activity = activityFor(call.name, trigger.args);
      const row = appendRow(botId, 'tool-call', { type: 'tool-call', callId: call.call_id, name: call.name, label: activity.label, status: 'queued', args: trigger.args });
      toolRows.push(row.seq);
      const st: PendingState = { native: true, nativeRequireApproval: trigger.requireApproval, nativeReadOnly: trigger.readOnly, jobId, computerRevision: currentComputerRevision() ?? localAccess(userId).revision, calls: [{ ...call, rowSeq: row.seq }], outputs: [], approvalId: '', depth: 0 };
      if (!await processCalls(ctx, st)) publishNativeResult(botId, st);
      return;
    } else {
      const item = triggerItem(trigger);
      if (item) appendHistory(botId, [item]);
    }

    const toolsStart = performance.now();
    const tools = (async () => {
      const schemas = await ctx.availableTools!();
      latency('tools_prepare', toolsStart, { botId });
      return schemas;
    })();

    while (true) {
      if (ctrl.signal.aborted) throw new Error('interrupted');
      const budget = checkWorkflowBudget({ userId, botId, jobId });
      if (!budget.allowed) throw new Error(budget.reason ?? 'Workflow budget exhausted.');
      ctx.remainingTokens = budget.remainingTokens;
      let nativeCount = 0;
      let nativeBoundary: 'approval' | 'end' | 'replan' | 'checkpoint' | undefined;
      const nativeCall: NativeToolHandler = async call => {
        ctrl.signal.throwIfAborted();
        if (nativeBoundary) return { output: 'This turn has paused. No further actions were executed.', stop: true };
        if(modelSnapshots.get(ctx)?.contextRevision!==contextRevision(userId,botId)){
          nativeBoundary='checkpoint';
          return {output:'Authorized knowledge or instructions changed. This action was not executed. Reload current context and choose the next action again.',isError:true,stop:true};
        }
        const available = await ctx.availableTools!();
        if (!available.some(tool => tool.type === 'function' && tool.name === call.name)) throw new Error('This tool is unavailable to the current agent.');
        nativeCount++;
        iterations++;
        ctx.learningIteration=iterations;
        // Never trust a runner-provided ID as a durable dispatch identifier.
        // The adapter deduplicates its IDs within this generation; Swarm owns
        // the history, journal and approval IDs across all generations.
        const item = { type: 'function_call', call_id: newId('cli'), name: call.name, arguments: JSON.stringify(call.arguments) };
        appendHistory(botId, [item]);
        const activity = activityFor(item.name, call.arguments);
        const row = appendRow(botId, 'tool-call', { type: 'tool-call', callId: item.call_id, name: item.name, label: activity.label, status: 'queued', args: call.arguments });
        toolRows.push(row.seq);
        const state: PendingState = { jobId, computerRevision: currentComputerRevision() ?? localAccess(userId).revision,
          calls: [{ ...item, rowSeq: row.seq }], outputs: [], approvalId: '', depth };
        const paused = await processCalls(ctx, state);
        const output = state.outputs.find(value => value.call_id === item.call_id)?.output;
        if (paused) nativeBoundary = 'approval';
        else if (state.outputs.some(value => value.__endTurn)) nativeBoundary = 'end';
        else if (state.replan) nativeBoundary = 'replan';
        else if (nativeCount >= CLI_TOOL_CHECKPOINT_INTERVAL) nativeBoundary = 'checkpoint';
        if (!nativeBoundary) setLive(botId, { activity: { kind: 'thinking', detail: selectedCli(userId) === 'claude' ? 'Waiting for Claude' : 'Waiting for Codex', since: now() } });
        return { output: output ?? 'Waiting for user approval. This action has not executed.',
          isError: getRow(botId, row.seq)?.body.type === 'tool-call' && ['error', 'denied'].includes((getRow(botId, row.seq)!.body as ToolCallBody).status),
          ...(nativeBoundary ? { stop: true } : {}) };
      };
      iterations++;
      ctx.learningIteration=iterations;
      const result = await withNativeTools(userId, nativeCall, () => callModel(ctx, tools, ctrl.signal));
      appendHistory(botId, result.output);
      finalText = result.output.filter((item: any) => item.type === 'message').flatMap((item: any) => item.content ?? []).filter((part: any) => part.type === 'output_text').map((part: any) => part.text).join('\n');
      if (nativeBoundary === 'approval' || nativeBoundary === 'end') return;
      // Tool results are already persisted. A fresh generation consumes them;
      // it never replays the completed calls just to continue the same job.
      if (nativeBoundary === 'replan' || nativeBoundary === 'checkpoint') continue;
      const calls = result.output.filter((o: any) => o.type === 'function_call');
      if (!calls.length) break;

      const st: PendingState = {
        jobId,
        computerRevision: currentComputerRevision() ?? localAccess(userId).revision,
        calls: calls.map((c: any) => {
          const args = safeParse(c.arguments);
          const act = activityFor(c.name, args);
          const row = appendRow(botId, 'tool-call', { type: 'tool-call', callId: c.call_id, name: c.name, label: act.label, status: 'queued', args } satisfies ToolCallBody);
          toolRows.push(row.seq);
          return { call_id: c.call_id, name: c.name, arguments: c.arguments, rowSeq: row.seq };
        }),
        outputs: [],
        approvalId: '',
        depth,
      };
      const paused = await processCalls(ctx, st);
      if (paused) return;
      if (st.outputs.some((o: any) => o.__endTurn)) break;
    }
  } catch (e: any) {
    outcome = ctrl.signal.aborted ? 'interrupted' : 'failed';
    const msg = ctrl.signal.aborted ? 'Stopped.' : `Something went wrong: ${e?.message ?? e}`;
    appendRow(botId, 'notice', { type: 'notice', text: msg, tone: ctrl.signal.aborted ? 'info' : 'error' });
    if (!ctrl.signal.aborted) console.error('[agent] turn failed', botId);
    throw new Error('Task did not complete. Review its activity before retrying.');
  } finally {
    latency('turn', turnStart, { botId });
    aborts.delete(botId);
    running.delete(botId);
    activeJobs.delete(botId);
    const stillPending = db.prepare('SELECT 1 FROM pending_turns WHERE bot_id=?').get(botId);
    const decisionPending = db.prepare(`SELECT 1 FROM rows WHERE bot_id=? AND generation=? AND kind='card'
      AND json_extract(body,'$.jobId')=? AND json_extract(body,'$.status')='pending'
      AND json_extract(body,'$.card') IN ('question','approval','connect') LIMIT 1`).get(botId, bot.generation, jobId);
    if (outcome === 'completed' && (stillPending || decisionPending)) outcome = 'waiting';
    try {
      try {
        if (admitted) await workflowAfterTurn({ userId, botId, jobId, status: outcome, finalText });
      } catch (error) {
        outcome = 'failed';
        throw error;
      } finally {
        if (routineStarted) onJobFinished({ jobId, botId, status: outcome === 'interrupted' ? 'cancelled' : outcome === 'failed' ? 'unknown' : outcome });
      }
    } finally {
      if (!stillPending) {
        for (const seq of toolRows) {
          const row = getRow(botId, seq);
          if (row?.body.type === 'tool-call' && ['queued', 'running'].includes(row.body.status)) {
            updateRow(botId, seq, { ...row.body, status: 'denied', summary: ctrl.signal.aborted ? 'Stopped' : 'Not executed', completedAt: now() });
          }
        }
        setLive(botId, { isRunning: false, activity: null, awaiting: null, startedAt: null });
      }
      completions.set(jobId,{status:outcome,finalText,iterations,generation:bot.generation,model:modelFor(bot.model),provider:llmProvider(),messagesSnapshot:loadHistory(botId),temporary:!!bot.parent_bot_id,foregroundEpoch,sourceSnapshot:learningSourceSnapshot(botId,bot.generation),...modelSnapshots.get(ctx)});
      emitBot(botId);
    }
  }
}

/** Run function calls in order. Returns true if the turn paused for approval. */
async function processCalls(ctx: ToolCtx, st: PendingState, options: { nested?: boolean; signal?: AbortSignal; onPause?: (state: PendingState) => void } = {}): Promise<boolean> {
  const { botId, userId } = ctx;
  const assertTurnCanContinue = () => {
    turnSignal(botId)?.throwIfAborted();
    options.signal?.throwIfAborted();
    if (ctx.jobId) {
      const authority = coordinationPreTurn({ userId, botId, jobId: ctx.jobId, trigger: currentTrigger(botId) });
      if (!authority.allowed) throw new Error(authority.reason ?? 'Coordination authority changed.');
      const budget = checkWorkflowBudget({ userId, botId, jobId: ctx.jobId });
      if (!budget.allowed) throw new Error(budget.reason ?? 'Workflow cannot continue.');
    }
  };
  const invalidateStaleContext=()=>{
    const loadedContext=modelSnapshots.get(ctx);
    if(loadedContext&&loadedContext.contextRevision!==contextRevision(userId,botId)){
      st.replan=true;
      for(const remaining of st.calls.splice(0)){
        const previous=getRow(botId,remaining.rowSeq);
        if(previous)updateRow(botId,remaining.rowSeq,{...(previous.body as ToolCallBody),status:'denied',summary:'Context changed; replan required'});
        st.outputs.push({type:'function_call_output',call_id:remaining.call_id,output:'Not executed: authorized knowledge or instructions changed. Inspect current context before choosing the next action.'});
      }
      return true;
    }
    return false;
  };
  while (st.calls.length) {
    assertTurnCanContinue();
    if(invalidateStaleContext())break;
    let c = st.calls[0];
    let args = safeParse(c.arguments) ?? {};
    const row = getRow(botId, c.rowSeq);
    let body = (row?.body ?? {}) as ToolCallBody;
    try {
      if (c.name === 'tool_call') {
        const resolved = await resolveToolCall(await ctx.availableTools!(), args);
        c = { ...c, name: resolved.name, arguments: JSON.stringify(resolved.args) };
        args = resolved.args;
        body = { ...body, name: c.name, args };
      }
      if (ctx.availableTools) {
        const definition = (await ctx.availableTools()).find(t => t.type === 'function' && t.name === c.name);
        if (!definition) throw new Error('This tool is no longer available to this Bot.');
        await validateToolArguments(definition, args);
      }
      turnSignal(botId)?.throwIfAborted();
      options.signal?.throwIfAborted();
      const workflowGate = workflowToolGate(ctx, c.name);
      if (!workflowGate.allowed) throw new Error(workflowGate.reason ?? 'This action is outside the current workflow.');
      if (c.name === 'deliver_artifact' || c.name === 'retry_delivery') {
        args = await prepareDeliveryAction(userId, botId, c.name, args);
        c = { ...c, arguments: JSON.stringify(args) };
        st.calls[0] = c;
        body = { ...body, name: c.name, args };
      }
    } catch (error: any) {
        updateRow(botId, c.rowSeq, { ...body, status: 'denied', summary: String(error.message).slice(0, 200) });
        st.outputs.push({ type: 'function_call_output', call_id: c.call_id, output: `Tool not executed: ${error.message}` });
        st.approvalId = '';
        st.calls.shift(); continue;
    }

    // Enforce the interview boundary even if a model fabricates a tool call or an old
    // pending call is resumed. Configuring an agent must not launch operational work.
    if (!allowedDuringSetup(botId, c.name)) {
      updateRow(botId, c.rowSeq, { ...body, status: 'denied', summary: 'Complete agent setup first' });
      st.outputs.push({ type: 'function_call_output', call_id: c.call_id, output: 'This agent is still being configured. Continue the interview with ask_user and save_agent_setup. Native connection discovery, authorization and provider-verified read-only access checks are available; operational tools become available after the user activates the specification in Configuration.' });
      st.calls.shift();
      continue;
    }

    // Was this call just approved/denied?
    const ap = st.approvalId ? (db.prepare('SELECT * FROM approvals WHERE id=?').get(st.approvalId) as any) : null;
    const pol = await executionPolicyFor(userId, c.name, args, botId);
    // A sibling can spend the shared budget or revoke authority while tool
    // discovery, validation or policy lookup is awaiting. Fence the actual
    // approval/dispatch boundary with the current durable state.
    assertTurnCanContinue();
    if(invalidateStaleContext())break;
    let decision = pol.decision;
    if (st.nativeRequireApproval && decision === 'allow') decision = 'ask';
    if (ap && ap.call_id === c.call_id) {
      if (ap.status === 'pending') return true;
      decision = ap.bot_id === botId && ['allowed', 'always'].includes(ap.status)
        && ap.binding_hash === approvalBinding(userId, botId, c.call_id, c.name, args)
        && decision !== 'block' ? 'allow' : 'block';
      st.approvalId = '';
    } else if (decision === 'ask') {
      const approvalId = newId('apr');
      const mcp = c.name.startsWith('mcp_') ? findMcpTool(userId, c.name, botId) : undefined;
      const card = appendRow(botId, 'card', {
        type: 'card', card: 'approval', approvalId, jobId: ctx.jobId, title: `Allow ${getBotRow(botId).name} to ${pol.title.split(': ')[1] ?? pol.title}?`,
        detail: describeArgs(args), tool: pol.key, toolkit: pol.toolkit, toolkitName: mcp?.server.config.name ?? appName(pol.toolkit), args, status: 'pending',
      });
      db.prepare('INSERT INTO approvals(id,bot_id,row_seq,call_id,tool,status,created_at,binding_hash) VALUES (?,?,?,?,?,?,?,?)').run(approvalId, botId, card.seq, c.call_id, pol.key, 'pending', now(), approvalBinding(userId, botId, c.call_id, c.name, args));
      updateRow(botId, c.rowSeq, { ...body, status: 'awaiting-approval' });
      st.approvalId = approvalId;
      if (options.onPause) options.onPause(st);
      else db.prepare('INSERT OR REPLACE INTO pending_turns(bot_id,state) VALUES (?,?)').run(botId, JSON.stringify(st));
      setLive(botId, { isRunning: false, activity: { kind: 'waiting_for_you', since: now() }, awaiting: { reason: humanizeSlug(pol.key), since: now() } });
      hub.emit(userId, { type: 'tasks', botId });
      return true;
    }

    let res: ToolResult;
    if (decision === 'block') {
      res = { output: 'The user declined this action. Do not retry it. Find another way, or tell the user what you could not do.', summary: 'Not allowed' };
      updateRow(botId, c.rowSeq, { ...body, status: 'denied', summary: 'Not allowed' });
    } else {
      const act = activityFor(c.name, args);
      const detail = c.name === 'send_to_bot' ? String(args.bot_name ?? '') : act.kind === 'connecting_service' ? act.label : undefined;
      body = { ...body, label: act.label, status: 'running', startedAt: now() };
      updateRow(botId, c.rowSeq, body);
      setLive(botId, { isRunning: true, activity: { kind: c.name === 'send_to_bot' ? 'messaging_named' : act.kind, detail, since: now() }, awaiting: null });
      const toolStart = performance.now();
      try {
        if (!beginTool(botId, c.call_id, c.name, approvalBinding(userId, botId, c.call_id, c.name, args))
          && !(c.name === 'execute_code' && isProgramResumable(c.call_id, botId))) throw new Error('This action has already been dispatched. Reconcile its outcome before requesting another action.');
        const impl = toolMap.get(c.name);
        if (c.name === 'execute_code') {
          const program = await runProgram({ userId, botId, jobId: ctx.jobId, callId: c.call_id, args,
            catalog: ctx.availableTools!, signal: turnSignal(botId), dispatch: async action => {
              const existing = db.prepare("SELECT seq FROM rows WHERE bot_id=? AND generation=? AND kind='tool-call' AND json_extract(body,'$.callId')=? ORDER BY seq DESC LIMIT 1").get(botId, getBotRow(botId).generation, action.callId) as { seq: number } | undefined;
              const innerRow = existing ?? appendRow(botId, 'tool-call', { type: 'tool-call', callId: action.callId, name: action.name, args: action.args, label: activityFor(action.name, action.args).label, status: 'queued' });
              const inner: PendingState = { jobId: ctx.jobId, computerRevision: st.computerRevision, calls: [{ call_id: action.callId, name: action.name, arguments: JSON.stringify(action.args), rowSeq: innerRow.seq }], outputs: [], approvalId: action.approvalId ?? '', depth: st.depth };
              const paused = await processCalls(ctx, inner, { nested: true, signal: action.signal, onPause: pending => {
                st.approvalId = pending.approvalId;
                db.prepare('INSERT OR REPLACE INTO pending_turns(bot_id,state) VALUES (?,?)').run(botId, JSON.stringify(st));
              } });
              const status = (getRow(botId, innerRow.seq)?.body as ToolCallBody)?.status;
              return { paused, approvalId: inner.approvalId, output: inner.outputs[0]?.output, isError: status === 'error' || status === 'denied' };
            } });
          if (program.status === 'waiting') {
            st.approvalId = program.approval_id ?? '';
            db.prepare('INSERT OR REPLACE INTO pending_turns(bot_id,state) VALUES (?,?)').run(botId, JSON.stringify(st));
            updateRow(botId, c.rowSeq, { ...body, status: 'awaiting-approval', summary: 'Program paused for an action approval' });
            return true;
          }
          st.approvalId = '';
          res = { output: JSON.stringify(program), summary: program.status === 'completed' ? 'Data processed' : program.status, isError: program.status !== 'completed' };
        } else res = impl ? await impl.impl(args, { ...ctx, depth: st.depth })
          : c.name.startsWith('mcp_') ? await runMcpTool(userId, botId, c.name, args)
          : await runComposioTool({ ...ctx, readOnlyApps: ctx.readOnlyApps === true || pol.readOnlyApps }, c.name, args);
        const successful = res.isError !== true && res.summary !== 'failed';
        finishTool(botId, c.call_id, successful);
        updateRow(botId, c.rowSeq, { ...body, status: successful ? 'done' : 'error', summary: res.summary, completedAt: now() });
      } catch (e: any) {
        finishTool(botId, c.call_id, false);
        res = { output: `Tool error: ${e?.message ?? e}`, replan: /^(?:browser_|computer_|open_browser$|wait_for_browser_access$)/.test(c.name) };
        updateRow(botId, c.rowSeq, { ...body, status: 'error', summary: String(e?.message ?? e).slice(0, 200), completedAt: now() });
      } finally {
        latency('tool', toolStart, { botId, tool: c.name });
      }
    }
    const out: any = { type: 'function_call_output', call_id: c.call_id, output: res.output };
    st.outputs.push(res.endTurn ? { ...out, __endTurn: true } : out);
    st.calls.shift();
    // These calls were planned against the old page or before a request to wait. Never run
    // a stale click/submission after a login redirect, dialog, failed action or human handoff.
    if (res.replan || res.endTurn || turnSignal(botId)?.aborted) {
      if (res.replan) st.replan = true;
      const reason = res.endTurn || turnSignal(botId)?.aborted
        ? 'Skipped because this turn stopped or is waiting for the user. Continue only after their reply.'
        : 'Skipped because the preceding result requires a fresh plan. Inspect that result and current screen before choosing the next action.';
      for (const remaining of st.calls.splice(0)) {
        const pending = getRow(botId, remaining.rowSeq);
        if (pending) updateRow(botId, remaining.rowSeq, { ...(pending.body as ToolCallBody), status: 'denied', summary: 'Skipped remaining planned action' });
        st.outputs.push({ type: 'function_call_output', call_id: remaining.call_id, output: reason });
      }
    }
  }
  // Batch complete: persist outputs (strip internal markers).
  if (!options.nested) {
    appendHistory(botId, st.outputs.map(({ __endTurn, ...o }: any) => o));
    db.prepare('DELETE FROM pending_turns WHERE bot_id=?').run(botId);
  }
  setLive(botId, { isRunning: true, activity: { kind: 'thinking', since: now() }, awaiting: null });
  return false;
}

/** When a new message arrives while an approval is pending, close the batch with denials. */
async function finishPending(ctx: ToolCtx, st: PendingState, reason: string) {
  const { botId } = ctx;
  if (st.approvalId) {
    const ap = db.prepare('SELECT * FROM approvals WHERE id=?').get(st.approvalId) as any;
    if (ap && (ap.status === 'pending' || reason === 'computer-changed')) {
      db.prepare("UPDATE approvals SET status='expired', resolved_at=? WHERE id=?").run(now(), ap.id);
      const card = getRow(botId, ap.row_seq);
      if (card && card.body.type === 'card' && card.body.card === 'approval') updateRow(botId, ap.row_seq, { ...card.body, status: 'expired' });
    }
  }
  for (const c of st.calls) {
    cancelProgram(c.call_id, botId);
    st.outputs.push({ type: 'function_call_output', call_id: c.call_id, output: reason === 'computer-changed'
      ? 'Skipped: the selected computer changed after these actions were planned. Do not retry unless the user sends a new request.'
      : reason === 'stopped' ? 'Skipped: the user stopped this work. Do not retry unless they ask.'
      : 'Skipped: the user sent a new message before approving this. Do not retry unless they ask.' });
    const row = getRow(botId, c.rowSeq);
    if (row) updateRow(botId, c.rowSeq, { ...(row.body as ToolCallBody), status: 'denied', summary: 'Skipped' });
  }
  db.transaction(()=>{
    appendHistory(botId, st.outputs.map(({ __endTurn, ...o }: any) => o));
    db.prepare("DELETE FROM pending_turns WHERE bot_id=? AND (? IS NULL OR json_extract(state,'$.jobId')=?)").run(botId,st.jobId??null,st.jobId??null);
    if(st.jobId)recordCoordinationJobOutcome({userId:ctx.userId,botId,jobId:st.jobId,status:'interrupted',finalText:''});
  })();
  if (st.jobId) {
    await workflowAfterTurn({ userId: ctx.userId, botId, jobId: st.jobId, status: 'interrupted' });
    onJobFinished({ jobId: st.jobId, botId, status: 'cancelled' });
    const origin=db.prepare('SELECT trigger FROM agent_jobs WHERE id=? AND bot_id=?').get(st.jobId,botId) as {trigger:string}|undefined;
    if(origin) onCoordinationJobFinished({userId:ctx.userId,botId,jobId:st.jobId,status:'interrupted',finalText:'',trigger:JSON.parse(origin.trigger)});
  }
}

/** Publish native execution results to the normal transcript and live voice feed. */
function publishNativeResult(botId: string, state: PendingState) {
  const results = state.outputs.map((item: any) => ({ callId: item.call_id, output: item.output }));
  appendRow(botId, 'message', { type: 'message', role: 'assistant', text: `Connected app result (inspect the returned data for success or failure):\n${JSON.stringify(results).slice(0, 60000)}` });
}

// ---------- model call with streaming into a message row ----------

const imageWarnings = new WeakSet<ToolCtx>();
async function callModel(ctx: ToolCtx, toolsPromise: Promise<any[]>, signal: AbortSignal, refreshes=0): Promise<{ output: any[] }> {
  const { botId, userId } = ctx;
  const bot = getBotRow(botId);
  const prepareStart = performance.now();
  const preparedRevision=contextRevision(userId,botId);
  const model = modelFor(bot.model);
  const checkModelBudget = () => {
    signal.throwIfAborted();
    if (ctx.jobId) {
      const authority=coordinationPreTurn({userId,botId,jobId:ctx.jobId,trigger:currentTrigger(botId)});
      if(!authority.allowed) throw new Error(authority.reason??'Coordination authority changed.');
      const budget = checkWorkflowBudget({ userId, botId, jobId: ctx.jobId });
      if (!budget.allowed) throw new Error(budget.reason ?? 'Workflow budget exhausted.');
      ctx.remainingTokens = budget.remainingTokens;
    }
    return ctx.remainingTokens;
  };
  setLive(botId, { activity: { kind: 'thinking', detail: 'Preparing model context', since: now() } });
  // Runs inside the bot's serial queue, so compaction can't race a turn.
  const [history, prompt, info, allTools] = await Promise.all([
    maybeCompact(botId, loadHistory(botId), { beforeModel: checkModelBudget }).catch(() => loadHistory(botId)),
    systemPrompt(userId, botId, ctx.jobId),
    modelInfo(model, bot.model === model, signal),
    ctx.availableTools?.() ?? toolsPromise,
  ]);
  // Compaction can consume the remaining budget. Its usage is persisted before
  // returning, so check again before issuing the primary model request.
  checkModelBudget();
  if(preparedRevision!==contextRevision(userId,botId)){
    if(refreshes>=3)throw new Error('Knowledge changed repeatedly while preparing context. Retry with the latest version.');
    return callModel(ctx,toolsPromise,signal,refreshes+1);
  }
  modelSnapshots.set(ctx,{systemPrompt:prompt,contextWindow:info?.context,model,provider:llmProvider(),contextRevision:preparedRevision});
  const { tools, manifest } = assembleToolCatalog(allTools);
  // The model is only called when no approval is pending, so every orphaned call can be repaired.
  let input = [{ role: 'system', content: prompt + (ctx.workflowPrompt ? `\n\n${ctx.workflowPrompt}` : '') + (manifest ? `\n\n## Available tools\n${manifest}` : '') }, ...prepareInput(pruneImages(deduplicateBrowserSnapshots(repairHistory(history))), model)];

  const discloseImages = (omitted: number) => {
    if (omitted && !imageWarnings.has(ctx)) {
      imageWarnings.add(ctx);
      appendRow(botId, 'notice', { type: 'notice', text: 'Earlier images were omitted for this text-only model endpoint. Their text is preserved. Choose a model with image support to inspect those images.', tone: 'warn' });
    }
  };
  if (info?.vision === false) {
    const prepared = textOnlyInput(input);
    input = prepared.input; discloseImages(prepared.omitted);
  }

  const body: any = {
    model: withFast(model, !!bot.fast),
    input,
    tools,
    store: false,
    stream: true,
    ...(ctx.remainingTokens !== undefined ? { max_output_tokens: Math.max(1, ctx.remainingTokens) } : {}),
    ...providerFields({
      effort: bot.effort ?? 'medium',
      reasoning: info?.reasoning ?? true,
      efforts: info ? info.efforts : undefined,
      cacheKey: `swarm:${botId}:${bot.generation}`,
      safetyId: sha256(userId).slice(0, 32),
    }),
  };
  latency('model_prepare', prepareStart, { botId, model });

  const modelStart = performance.now();
  const cli = selectedCli(userId);
  setLive(botId, { activity: { kind: 'thinking', detail: cli === 'claude' ? 'Waiting for Claude' : cli === 'codex' ? 'Waiting for Codex' : 'Waiting for model response', since: now() } });
  let receivedText = false;
  let stream: any;
  try {
    stream = await llm().responses.create(body, { signal });
  } catch (e: any) {
    if (e?.status === 404 && /image input/i.test(e?.message ?? '')) {
      const prepared = textOnlyInput(body.input);
      if (!prepared.omitted) throw new Error('The selected API model has no endpoint available for image input. Choose another image-capable model or connect your plan in Settings → Subscriptions. No fallback was used.');
      body.input = prepared.input;
      discloseImages(prepared.omitted);
      // Same selected model/provider. Never reroute a plan request to an API.
      stream = await llm().responses.create(body, { signal });
    } else if (e?.status === 400 && tools.some(t => t.name?.startsWith('mcp_'))) {
      console.warn('[agent] 400 with custom MCP tools, retrying without those schemas');
      appendRow(botId, 'notice', { type: 'notice', text: 'The model rejected the request with custom MCP tools. Retrying without those tools; native connected-app tools remain available.', tone: 'warn' });
      body.tools = tools.filter(t => !t.name?.startsWith('mcp_'));
      stream = await llm().responses.create(body, { signal });
    } else throw e;
  }

  let msgSeq: number | null = null;
  let text = '';
  let lastFlush = 0;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let flushError: unknown;
  let final: any = null;
  const flush = (streaming: boolean) => {
    clearTimeout(flushTimer);
    flushTimer = undefined;
    const b: MessageBody = { type: 'message', role: 'assistant', text, streaming };
    if (msgSeq === null) msgSeq = appendRow(botId, 'message', b).seq;
    else updateRow(botId, msgSeq, b);
    lastFlush = Date.now();
  };

  try {
    for await (const ev of stream as AsyncIterable<any>) {
      if (flushError) throw flushError;
      switch (ev.type) {
        case 'response.output_text.delta':
          if (!receivedText) { latency('model_first_text', modelStart, { botId, model }); receivedText = true; }
          text += ev.delta;
          if (msgSeq === null || Date.now() - lastFlush >= 75) flush(true);
          else if (!flushTimer) flushTimer = setTimeout(() => {
            try { flush(true); } catch (e) { flushError = e; stream.controller?.abort(); }
          }, 75 - (Date.now() - lastFlush));
          break;
        case 'response.output_item.added':
          if (ev.item?.type === 'web_search_call' || (ev.item?.type !== 'x_search_call' && /search/.test(String(ev.item?.type ?? '')))) setLive(botId, { activity: { kind: 'searching_web', since: now() } });
          if (ev.item?.type === 'x_search_call') setLive(botId, { activity: { kind: 'searching_web', detail: 'X', since: now() } });
          if (ev.item?.type === 'message') setLive(botId, { activity: { kind: 'working', since: now() } });
          break;
        case 'response.output_item.done':
          if (ev.item?.type === 'message' && msgSeq !== null) {
            clearTimeout(flushTimer);
            flushTimer = undefined;
            // finalize this message; a later message in the same response gets its own row
            const citations = (ev.item.content ?? []).flatMap((c: any) => (c.annotations ?? []).filter((a: any) => a.url).map((a: any) => ({ url: a.url, title: a.title })));
            updateRow(botId, msgSeq, { type: 'message', role: 'assistant', text, streaming: false, citations: citations.length ? citations : undefined });
            if(executionAudience(botId)!=='internal')db.prepare('UPDATE bots SET unread = unread + 1 WHERE id=?').run(botId);
            msgSeq = null;
            text = '';
          }
          break;
        case 'response.completed':
        case 'response.incomplete':
          final = ev.response;
          break;
        case 'response.failed':
        case 'error':
          throw new Error(ev.response?.error?.message ?? ev.message ?? 'model error');
      }
    }
  } finally {
    clearTimeout(flushTimer);
    if (msgSeq !== null) flush(false);
  }
  if (flushError) throw flushError;
  if (!final) throw new Error('model stream ended without a response');
  latency('model_complete', modelStart, { botId, model });
  if (final.usage?.input_tokens) noteUsage(botId, final.usage.input_tokens, history.length);
  await recordModelUsage({ userId, botId, kind: 'chat', model, response: final });
  return { output: tagOutput(final.output ?? [], model) };
}

// ---------- misc ----------

function safeParse(s: string) {
  try { return JSON.parse(s); } catch { return undefined; }
}

function describeArgs(args: any): string {
  if (!args || typeof args !== 'object') return '';
  if (typeof args.tool_slug === 'string' && args.arguments && typeof args.arguments === 'object') {
    return `Account: ${String(args.connectionId)}\nTool: ${args.tool_slug}\n${JSON.stringify(args.arguments, null, 2)}`.slice(0, 4000);
  }
  const inner = Array.isArray(args.tools) ? args.tools.map((t: any) => t.arguments ?? t.args ?? t) : [args];
  const flat = inner.map((a: any) => Object.entries(a ?? {}).filter(([, v]) => typeof v !== 'object' || v === null).slice(0, 6).map(([k, v]) => `${k}: ${String(v).slice(0, 160)}`).join('\n'));
  return flat.join('\n\n').slice(0, 1200);
}

/** Resolve an approval card from the UI. */
export function resolveApproval(userId: string, approvalId: string, decision: 'allow' | 'always' | 'deny') {
  return db.transaction(()=>{
  if(!['allow','always','deny'].includes(decision))throw new Error('Invalid approval decision.');
  const ap = db.prepare('SELECT a.*, b.user_id FROM approvals a JOIN bots b ON b.id=a.bot_id WHERE a.id=?').get(approvalId) as any;
  if (!ap || ap.user_id !== userId) throw new Error('not found');
  if (ap.status !== 'pending') return;
  const status = decision === 'deny' ? 'denied' : decision === 'always' ? 'always' : 'allowed';
  db.prepare('UPDATE approvals SET status=?, resolved_at=? WHERE id=?').run(status, now(), approvalId);
  if (decision === 'always') db.prepare("INSERT OR REPLACE INTO policies(user_id,tool,mode) VALUES (?,?,'always_allow')").run(userId, ap.tool);
  const card = getRow(ap.bot_id, ap.row_seq);
  if (card && card.body.type === 'card' && card.body.card === 'approval') updateRow(ap.bot_id, ap.row_seq, { ...card.body, status });
  enqueue(ap.bot_id, { type: 'resume' });
  })();
}
