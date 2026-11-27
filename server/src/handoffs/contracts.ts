// server/src/handoffs/schema.ts (HO-A), shared with web via @shared/handoffs
export const OUTPUT_LIMITS = {
  summaryChars: 1200,        // always present, plain text
  bodyChars: 200_000,        // stored in run_output_parts kind 'text', paged on read
  filesMax: 20, dataMax: 5, dataBytesMax: 256 * 1024, linksMax: 30,
  inlineChars: 6000,         // max inline text inside one context packet
} as const;

export type OutputStatus = 'draft' | 'final' | 'superseded';
export type OutputSource = 'run' | 'task' | 'message' | 'routine' | 'loop_step';

export interface RunOutput {
  id: string;                      // out_<ulid>
  userId: string; botId: string;
  jobId: string | null;            // agent_jobs.id, UNIQUE when not null
  taskId: string | null;           // tasks.id when the output belongs to a task
  source: OutputSource;
  status: OutputStatus;            // draft while the run is working (agent declared), final when the run completes
  revision: number;                // starts 1, increments on agent redeclare before final
  title: string;                   // <= 120 chars, from task title, routine name, or first line
  summary: string;                 // <= 1200 chars
  parts: OutputPart[];             // manifest only, no bodies
  provenance: Provenance;
  contentHash: string;             // sha256 over canonical manifest and bodies, used for stall detection and idempotency
  createdAt: number; finalizedAt: number | null;
}
export type OutputPart =
  | { id: string; kind: 'text'; name: 'body'; chars: number; sha256: string }
  | { id: string; kind: 'file'; artifactId: string; filename: string; mime: string; size: number; sha256: string }   // artifactId = output_artifacts.id
  | { id: string; kind: 'data'; name: string; schema?: string; bytes: number; sha256: string }                       // JSON, validated and size capped
  | { id: string; kind: 'link'; url: string; title: string; relation: 'source' | 'result' | 'reference' };           // https only
export interface Provenance {
  producer: { botId: string; botName: string };       // names are for display, ids are authority
  jobId: string | null; trigger: 'user' | 'routine' | 'event' | 'internal' | 'loop' | 'handoff';
  model: string | null; effort: string | null;
  startedAt: number | null; finishedAt: number | null;
  consumed: string[];                                  // output ids that were given to this run through handoffs, max 10
  handoffId: string | null; loopId: string | null; iteration: number | null; stepId: string | null;
  tools: { name: string; count: number }[];            // top 8 tools used, names only
  declaredBy: 'auto' | 'agent';                        // auto = derived from final text, agent = submit_output tool
}

export interface LoopSpec {
  name: string;                                   // <= 80
  goal: string;                                   // <= 2000, what done looks like, shown to every step
  kind: 'pipeline' | 'maker_checker';
  steps: LoopStep[];                              // pipeline: 2..6 steps run in order; maker_checker: exactly [maker, checker]
  seed: { outputRef?: string; text?: string };    // starting input: an output or a brief typed in the sheet
  exit: ExitRule;
  limits: { maxIterations: number; maxMinutes: number; maxCostUsd?: number; maxTokens?: number; stepTimeoutMinutes: number };
  gate: { before: 'none' | 'first' | 'each'; onCap: 'stop' | 'ask' };   // default before 'first' for agent started loops, 'none' for user started
  roomId?: string;                                // post progress events into this room
  taskId?: string;                                // loop is working on this task, task state follows the loop
}
export interface LoopStep { id: string; botId: string; role: 'step' | 'maker' | 'checker'; instruction: string /* <= 1500 */ }
export type ExitRule =
  | { mode: 'verdict' }                                           // checker's verdict.pass ends the loop (maker_checker default)
  | { mode: 'checklist'; items: { id: string; text: string; required: boolean }[]; minScore?: number }   // checker answers each item
  | { mode: 'judge'; judgeBotId?: string; rubric: string }        // a separate judge Bot, default the checker
  | { mode: 'manual' };                                           // runs until maxIterations or user Stop, user marks done

export type HandoffStatus = 'pending_approval' | 'queued' | 'delivered' | 'running' | 'completed' | 'failed' | 'declined' | 'cancelled' | 'expired';
export type LoopStatus = 'draft' | 'awaiting_approval' | 'running' | 'paused' | 'succeeded' | 'capped' | 'stalled' | 'failed' | 'cancelled';
export type StopReason = 'passed' | 'max_iterations' | 'max_minutes' | 'max_cost' | 'max_tokens' | 'stalled' | 'step_failed' | 'no_verdict' | 'user_stopped' | 'declined' | 'gate_expired';
export interface Verdict { pass: boolean; score?: number; checklist: { id: string; pass: boolean; note: string }[]; feedback: string }
export interface CheckedVerdict extends Verdict { claimedPass: boolean; corrected: boolean }
export interface Handoff {
  id: string; userId: string; fromBotId: string; toBotId: string; sourceOutputId: string; resultOutputId: string | null;
  initiatedBy: 'user' | 'agent' | 'link' | 'loop'; instruction: string; priority: 'normal' | 'high';
  returnResult: boolean; createTask: boolean; status: HandoffStatus; reason: string;
  requestId: string | null; jobId: string | null; loopId: string | null; iteration: number | null; stepId: string | null;
  roomId: string | null; chainDepth: number; parentHandoffId: string | null; idempotencyKey: string;
  fingerprint: string; revision: number; createdAt: number; updatedAt: number;
}
export interface HandoffLink {
  id: string; userId: string; fromBotId: string; toBotId: string; mode: 'off' | 'suggest' | 'auto';
  trigger: 'any_run' | 'task_done' | `routine:${string}`; template: string; autoApproveLoops: boolean;
  createdAt: number; updatedAt: number;
}
export interface HandoffSettings { enabled: boolean; agentHandoffs: 'team' | 'links_only' | 'off' }
export interface Loop {
  id: string; userId: string; ownerBotId: string; spec: LoopSpec; status: LoopStatus; stopReason: StopReason | null;
  iteration: number; bestOutputId: string | null; initiatedBy: 'user' | 'agent'; idempotencyKey: string;
  revision: number; startedAt: number | null; finishedAt: number | null; createdAt: number; updatedAt: number;
}
/** Supplied by the runtime, never parsed from tool arguments. */
export interface HandoffContext { userId: string; botId: string; jobId: string; toolCallId: string }
export interface SubmitOutputInput {
  title?: string; summary: string; dataParts?: { name: string; schema?: string; json: unknown }[];
  links?: { url: string; title: string; relation: 'source' | 'result' | 'reference' }[]; files?: string[];
}
export interface AgentHandoffInput {
  toBotId: string; instruction: string; outputRef?: string; summary?: string; includeFiles?: string[];
  returnResult?: boolean; priority?: 'normal' | 'high'; reason?: string;
}
export interface ReadHandoffInput { ref?: string; handoffId?: string; partId?: string; offset?: number; limit?: number; materialize?: boolean }
export interface HandoffPage { output: RunOutput; part?: OutputPart; text?: string; next: number | null; sandboxPath?: string }
export interface ListHandoffsInput { direction?: 'sent' | 'received' | 'all'; status?: HandoffStatus; limit?: number }
export type StartLoopInput = Pick<LoopSpec, 'steps' | 'goal' | 'exit' | 'limits'> & Partial<Pick<LoopSpec, 'name' | 'kind' | 'seed' | 'roomId' | 'taskId'>>;
/** Service methods may reject with HandoffError. Tool adapters turn refusals into text. */
export interface HandoffService {
  enabled(userId: string): boolean | Promise<boolean>;
  submitOutput(context: HandoffContext, input: SubmitOutputInput): Promise<RunOutput>;
  handoffToAgent(context: HandoffContext, input: AgentHandoffInput): Promise<Handoff>;
  readHandoff(context: HandoffContext, input: ReadHandoffInput): Promise<HandoffPage>;
  listHandoffs(context: HandoffContext, input: ListHandoffsInput): Promise<Handoff[]>;
  submitVerdict(context: HandoffContext, input: Verdict): Promise<CheckedVerdict>;
  startLoop(context: HandoffContext, input: StartLoopInput): Promise<Loop>;
}
export interface FlowSummaryInput { steps: { label: string; detail?: string }[]; loopNote?: string }
export interface FlowStore {
  writeFlowSummary(context: HandoffContext, input: FlowSummaryInput): Promise<{ inputsHash: string }>;
}
