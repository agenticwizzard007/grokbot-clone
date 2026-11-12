/** Hermes-derived bounded RPC execution, adapted natively for Swarm.
 * Source: tools/code_execution_tool.py and code_execution_rpc.py at
 * f0e7b68e439f8c1962fcf9dcb0341aadf1e2a898, Nous Research, MIT (see notices).
 * Swarm additions: WASM isolation, durable step receipts, deterministic replay
 * across human approvals, and denial of uncertain action replay.
 */
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { db, now } from '../db.js';
import { PROGRAM_WORKER } from './program-worker.js';
import { validateToolArguments, type FunctionSchema } from './tool-catalog.js';
import type { ToolDef } from './tools.js';

db.exec(`CREATE TABLE IF NOT EXISTS code_runs (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, job_id TEXT, binding TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('running','waiting','completed','failed','cancelled','unknown')),
  elapsed_ms INTEGER NOT NULL DEFAULT 0, result TEXT, approval_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS code_steps (
  run_id TEXT NOT NULL REFERENCES code_runs(id) ON DELETE CASCADE, step INTEGER NOT NULL,
  call_id TEXT NOT NULL, tool TEXT NOT NULL, binding TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('dispatching','waiting','completed','failed','unknown')),
  output TEXT, PRIMARY KEY(run_id,step));`);

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const programSchema = z.object({
  code: z.string().min(1).max(64000), inputs: z.record(z.string(), z.unknown()).default({}),
  tools: z.array(z.string().min(1).max(200)).max(50).default([]),
  timeout_ms: z.number().int().min(1000).max(60000).default(15000),
  max_tool_calls: z.number().int().min(1).max(50).default(20),
}).strict();
type ProgramArgs = z.infer<typeof programSchema>;
export interface ProgramAction { callId: string; name: string; args: Record<string, unknown>; approvalId?: string; signal: AbortSignal }
export interface ProgramActionResult { paused?: boolean; approvalId?: string; output?: unknown; isError?: boolean }
export interface ProgramResult { run_id: string; status: 'completed' | 'waiting' | 'failed' | 'cancelled' | 'unknown'; result?: unknown; stdout?: string; error?: string; approval_id?: string; tool_calls?: number }

/** Recovery never executes scripts/actions. A waiting approval is still resumable. */
export function recoverPrograms() {
  db.prepare("UPDATE code_steps SET state='unknown' WHERE state='dispatching'").run();
  db.prepare("UPDATE code_runs SET state='unknown',updated_at=? WHERE state='running'").run(now());
}
export function cancelProgram(callId: string, botId: string) {
  db.prepare("UPDATE code_runs SET state='cancelled',updated_at=? WHERE id=? AND bot_id=? AND state IN ('running','waiting')").run(now(), callId, botId);
}
export function isProgramResumable(callId: string, botId: string) {
  return !!db.prepare("SELECT 1 FROM code_runs WHERE id=? AND bot_id=? AND state='waiting'").get(callId, botId);
}
function permittedProgramTool(name: string) {
  return name.startsWith('mcp_') || ['SWARM_APPS_SEARCH', 'SWARM_APPS_EXECUTE', 'save_file', 'read_skill', 'list_skills', 'search_skills', 'session_search', 'search_history', 'read_history', 'recall'].includes(name);
}

export async function runProgram(options: {
  userId: string; botId: string; jobId?: string; callId: string; args: unknown;
  catalog: () => Promise<any[]>; dispatch: (action: ProgramAction) => Promise<ProgramActionResult>;
  signal?: AbortSignal;
}): Promise<ProgramResult> {
  const args: ProgramArgs = programSchema.parse(options.args);
  if (Buffer.byteLength(JSON.stringify(args.inputs)) > 1_000_000) throw new Error('Program input exceeds 1 MB.');
  if (!db.prepare('SELECT 1 FROM bots WHERE id=? AND user_id=?').get(options.botId, options.userId)) throw new Error('Bot not found.');
  const binding = hash([args.code, args.inputs, args.tools, args.timeout_ms, args.max_tool_calls]);
  const previous = db.prepare('SELECT * FROM code_runs WHERE id=?').get(options.callId) as any;
  if (previous && (previous.user_id !== options.userId || previous.bot_id !== options.botId || previous.binding !== binding)) throw new Error('Program identity or content changed.');
  if (previous && !['waiting', 'completed'].includes(previous.state)) return { run_id: options.callId, status: previous.state === 'running' ? 'unknown' : previous.state, error: 'This execution cannot be replayed. Inspect its recorded actions before starting new work.' };
  if (previous?.state === 'completed') return JSON.parse(previous.result);
  const createdAt = previous?.created_at ?? now();
  const elapsed = previous?.elapsed_ms ?? 0;
  const remaining = args.timeout_ms - elapsed;
  if (remaining <= 0) return { run_id: options.callId, status: 'failed', error: 'Program execution budget exhausted.' };
  if (options.signal?.aborted) return { run_id: options.callId, status: 'cancelled', error: 'Stopped.' };
  const allowed = new Set(args.tools);
  if (args.tools.some(t => !permittedProgramTool(t))) throw new Error('Programs may use only explicitly listed app, MCP, knowledge and save_file tools.');
  db.prepare(`INSERT INTO code_runs(id,user_id,bot_id,job_id,binding,state,created_at,updated_at) VALUES(?,?,?,?,?,'running',?,?)
    ON CONFLICT(id) DO UPDATE SET state='running',updated_at=excluded.updated_at`).run(options.callId, options.userId, options.botId, options.jobId ?? null, binding, createdAt, now());
  const started = performance.now();
  const dispatchController = new AbortController();
  const worker = new Worker(PROGRAM_WORKER, { eval: true, workerData: { ...args, timeoutMs: remaining, maxCalls: args.max_tool_calls, createdAt, seed: parseInt(hash(options.callId).slice(0, 8), 16) },
    resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } });
  let stdout = '', nextStep = 0, closed = false;
  const checkDispatch = () => {
    options.signal?.throwIfAborted();
    if (closed || performance.now() - started >= remaining) throw new Error('Program stopped before this action could be dispatched.');
  };
  const active = new Set<Promise<void>>();
  let timer: ReturnType<typeof setTimeout>;
  let abort: () => void = () => {};
  const result = await new Promise<ProgramResult>(resolve => {
    const finish = (r: Omit<ProgramResult, 'run_id'>) => { if (!closed) { closed = true; dispatchController.abort(); resolve({ run_id: options.callId, stdout, tool_calls: nextStep, ...r }); } };
    timer = setTimeout(() => finish({ status: 'failed', error: 'Program time limit exceeded.' }), remaining);
    abort = () => finish({ status: 'cancelled', error: 'Stopped. Completed action receipts are retained.' });
    options.signal?.addEventListener('abort', abort, { once: true });
    worker.on('error', e => finish({ status: 'failed', error: String(e.message).slice(0, 1000) }));
    worker.on('exit', code => { if (!closed) finish({ status: 'failed', error: `Program worker exited (${code}).` }); });
    worker.on('message', message => {
      if (closed) return;
      if (message.type === 'stdout') {
        stdout += String(message.text).slice(0, 32000) + '\n';
        if (Buffer.byteLength(stdout) > 32000) finish({ status: 'failed', error: 'Program output limit exceeded.' });
        return;
      }
      if (message.type === 'result') { finish({ status: 'completed', result: message.value }); return; }
      if (message.type === 'error') { finish({ status: 'failed', error: String(message.error).slice(0, 2000) }); return; }
      if (message.type !== 'call' || message.id !== nextStep || nextStep >= args.max_tool_calls) { finish({ status: 'failed', error: 'Invalid program RPC sequence.' }); return; }
      const step = nextStep++;
      const task = (async () => {
        options.signal?.throwIfAborted();
        if (!allowed.has(message.name)) throw new Error('This tool was not included in the program allowlist.');
        const callArgs = JSON.parse(message.args);
        const definition = (await options.catalog()).find((t: FunctionSchema) => t.type === 'function' && t.name === message.name);
        checkDispatch();
        if (!definition) throw new Error('This tool is no longer available to this Bot.');
        await validateToolArguments(definition, callArgs);
        checkDispatch();
        const stepBinding = hash([message.name, callArgs]);
        const stored = db.prepare('SELECT * FROM code_steps WHERE run_id=? AND step=?').get(options.callId, step) as any;
        if (stored && stored.binding !== stepBinding) throw new Error('Program replay diverged from its recorded actions. No further actions ran.');
        if (stored && ['dispatching', 'unknown', 'failed'].includes(stored.state)) throw new Error('A prior program action has an uncertain or failed outcome and cannot be replayed.');
        if (stored?.state === 'completed') {
          if (!closed) worker.postMessage({ id: step, value: stored.output });
          return;
        }
        const callId = stored?.call_id ?? `code_${hash([options.callId, step]).slice(0, 32)}`;
        checkDispatch();
        db.prepare(`INSERT INTO code_steps(run_id,step,call_id,tool,binding,state) VALUES(?,?,?,?,?,'dispatching')
          ON CONFLICT(run_id,step) DO UPDATE SET state='dispatching'`).run(options.callId, step, callId, message.name, stepBinding);
        const outcome = await options.dispatch({ callId, name: message.name, args: callArgs, approvalId: previous?.approval_id ?? undefined, signal: dispatchController.signal });
        if (outcome.paused) {
          db.prepare("UPDATE code_steps SET state='waiting' WHERE run_id=? AND step=?").run(options.callId, step);
          db.prepare("UPDATE code_runs SET approval_id=? WHERE id=?").run(outcome.approvalId ?? null, options.callId);
          finish({ status: 'waiting', approval_id: outcome.approvalId });
          return;
        }
        let value = outcome.output;
        if (typeof value === 'string') { try { value = JSON.parse(value); } catch { /* plain tool text */ } }
        const output = JSON.stringify(value ?? null);
        if (Buffer.byteLength(output) > 1_000_000) throw new Error('Tool result exceeds the program limit.');
        db.prepare('UPDATE code_steps SET state=?,output=? WHERE run_id=? AND step=?').run(outcome.isError ? 'failed' : 'completed', output, options.callId, step);
        if (!closed) worker.postMessage(outcome.isError ? { id: step, error: `Tool failed: ${output.slice(0, 1000)}` } : { id: step, value: output });
      })().catch(e => {
        db.prepare("UPDATE code_steps SET state='unknown' WHERE run_id=? AND step=? AND state='dispatching'").run(options.callId, step);
        finish({ status: 'failed', error: String(e?.message ?? e).slice(0, 2000) });
      });
      active.add(task); void task.finally(() => active.delete(task));
    });
  });
  clearTimeout(timer!);
  options.signal?.removeEventListener('abort', abort);
  await worker.terminate();
  // Do not release the Bot queue while an already-started external action settles.
  await Promise.allSettled([...active]);
  const state = db.prepare('SELECT state FROM code_runs WHERE id=?').get(options.callId) as any;
  if (state?.state === 'cancelled') result.status = 'cancelled';
  db.prepare('UPDATE code_runs SET state=?,result=?,elapsed_ms=elapsed_ms+?,updated_at=? WHERE id=?').run(result.status, JSON.stringify(result), Math.ceil(performance.now() - started), now(), options.callId);
  return result;
}

export const PROGRAM_TOOLS: ToolDef[] = [{
  name: 'execute_code', activity: 'running_commands', label: 'Processing data',
  description: 'Run bounded JavaScript in an isolated interpreter with no filesystem, network, imports or process access. Use inputs for JSON data, print for concise progress, and return a JSON result. tools.call(name,args) is synchronous and goes through normal permissions; list each exact tool in tools (empty means none). Only app/MCP, knowledge reads and save_file are allowed. Intermediate data stays out of the model context. Execution pauses for approval and replays recorded results without repeating completed actions. Save large outputs with tools.call("save_file", ...).',
  parameters: (() => { const { $schema, ...schema } = z.toJSONSchema(programSchema, { io: 'input' }); return schema; })(),
  impl: async () => { throw new Error('Programs must run through the permission-aware agent dispatcher.'); },
}];
