import type { AgentHandoffInput, CheckedVerdict, Handoff, HandoffContext, HandoffLink, HandoffPage, HandoffService, HandoffSettings, ListHandoffsInput, Loop, OutputPart, ReadHandoffInput, RunOutput, StartLoopInput, SubmitOutputInput, Verdict } from './contracts.js';
import { HandoffError } from './errors.js';
import { assertHandoffAllowed, checkChain, type TargetBot } from './chain.js';
import { buildOutputContent, outputRef, parseReference, redactOutputText } from './output.js';
import { createLoopState, nextAction } from './loop-machine.js';
import { recomputeVerdict } from './verdict.js';
import { hashValue } from '../flow/hash.js';
import { submitOutputSchema } from './schema.js';

export interface MemoryBot extends TargetBot { name?: string }
export interface MemoryLoopAssignment { jobId: string; loopId: string; iteration: number; stepId: string; botId: string }
export interface MemorySavedFile { userId: string; botId: string; jobId: string; path: string; part: Extract<OutputPart, { kind: 'file' }> }
export interface MemoryHandoffSeed {
  bots?: MemoryBot[]; outputs?: RunOutput[]; bodies?: Record<string, Record<string, string>>;
  handoffs?: Handoff[]; loops?: Loop[]; assignments?: MemoryLoopAssignment[]; links?: HandoffLink[];
  settings?: Record<string, HandoffSettings>; savedFiles?: MemorySavedFile[];
  jobText?: Record<string, string>; now?: () => number;
}
const clone = <T>(value: T): T => structuredClone(value);
/** Test fake only. No provider, filesystem, database, task dispatch or gate approval surface. */
export class MemoryHandoffService implements HandoffService {
  private readonly bots = new Map<string, MemoryBot>();
  private readonly outputs = new Map<string, RunOutput>();
  private readonly bodies = new Map<string, Record<string, string>>();
  private readonly handoffs = new Map<string, Handoff>();
  private readonly loops = new Map<string, Loop>();
  private readonly assignments = new Map<string, MemoryLoopAssignment>();
  private readonly verdicts = new Map<string, { fingerprint: string; verdict: CheckedVerdict }>();
  private readonly declarations = new Map<string, { fingerprint: string; output: RunOutput }>();
  private readonly settings: Record<string, HandoffSettings>;
  private readonly links: HandoffLink[];
  private readonly files: MemorySavedFile[];
  private readonly jobText: Record<string, string>;
  private readonly now: () => number;
  private serial = 0;
  constructor(seed: MemoryHandoffSeed = {}) {
    for (const bot of seed.bots ?? []) this.bots.set(bot.id, clone(bot));
    for (const output of seed.outputs ?? []) this.outputs.set(output.id, clone(output));
    for (const [id, bodies] of Object.entries(seed.bodies ?? {})) this.bodies.set(id, clone(bodies));
    for (const handoff of seed.handoffs ?? []) this.handoffs.set(handoff.id, clone(handoff));
    for (const loop of seed.loops ?? []) this.loops.set(loop.id, clone(loop));
    for (const assignment of seed.assignments ?? []) this.assignments.set(assignment.jobId, clone(assignment));
    this.settings = clone(seed.settings ?? {}); this.links = clone(seed.links ?? []); this.files = clone(seed.savedFiles ?? []);
    this.jobText = clone(seed.jobText ?? {}); this.now = seed.now ?? (() => 0);
  }
  private id(prefix: string): string {
    let id: string;
    do { id = `${prefix}_memory_${++this.serial}`; } while (this.outputs.has(id) || this.handoffs.has(id) || this.loops.has(id));
    return id;
  }
  enabled(userId: string): boolean { return this.settings[userId]?.enabled ?? true; }
  private policy(userId: string): HandoffSettings { return this.settings[userId] ?? { enabled: true, agentHandoffs: 'team' }; }
  private check(context: HandoffContext): MemoryBot {
    if (!this.enabled(context.userId)) throw new HandoffError('disabled', 'Handoffs are disabled');
    const bot = this.bots.get(context.botId);
    if (!bot || bot.userId !== context.userId) throw new HandoffError('not_found', 'Not found');
    return bot;
  }
  private assignment(context: HandoffContext): MemoryLoopAssignment | undefined {
    const assignment = this.assignments.get(context.jobId);
    return assignment?.botId === context.botId && this.loops.get(assignment.loopId)?.userId === context.userId ? assignment : undefined;
  }
  private canRead(context: HandoffContext, output: RunOutput): boolean {
    if (output.userId !== context.userId) return false;
    if (output.botId === context.botId) return true;
    if ([...this.handoffs.values()].some(h => h.userId === context.userId &&
      ((h.toBotId === context.botId && h.sourceOutputId === output.id) || (h.fromBotId === context.botId && h.returnResult && h.resultOutputId === output.id)))) return true;
    const assignment = this.assignment(context);
    return !!assignment && (output.provenance.loopId === assignment.loopId || this.loops.get(assignment.loopId)?.spec.seed.outputRef === outputRef(output.id));
  }
  async submitOutput(context: HandoffContext, input: SubmitOutputInput): Promise<RunOutput> {
    const bot = this.check(context), valid = submitOutputSchema.safeParse(input);
    if (!valid.success) throw new HandoffError('invalid_input', valid.error.message);
    const key = hashValue([context.userId, context.jobId, context.toolCallId]), fingerprint = hashValue(input), replay = this.declarations.get(key);
    if (replay) {
      if (replay.fingerprint !== fingerprint) throw new HandoffError('idempotency_conflict', 'This call was already used with different content');
      return clone(replay.output);
    }
    const prior = [...this.outputs.values()].find(o => o.userId === context.userId && o.botId === context.botId && o.jobId === context.jobId);
    if (prior && prior.status !== 'draft') throw new HandoffError('invalid_state', 'A final output cannot be changed');
    const files = (input.files ?? []).map(path => {
      const file = this.files.find(f => f.userId === context.userId && f.botId === context.botId && f.jobId === context.jobId && f.path === path);
      if (!file) throw new HandoffError('not_found', 'Saved file not found'); return file.part;
    });
    const content = buildOutputContent(this.jobText[context.jobId] ?? '', input, files), now = this.now(), assignment = this.assignment(context);
    const output: RunOutput = {
      id: prior?.id ?? this.id('out'), userId: context.userId, botId: context.botId, jobId: context.jobId, taskId: null,
      source: assignment ? 'loop_step' : 'run', status: 'draft', revision: (prior?.revision ?? 0) + 1,
      title: content.title, summary: content.summary, parts: content.parts, contentHash: content.contentHash, createdAt: prior?.createdAt ?? now, finalizedAt: null,
      provenance: { producer: { botId: context.botId, botName: bot.name ?? 'Test agent' }, jobId: context.jobId, trigger: assignment ? 'loop' : 'user',
        model: null, effort: null, startedAt: now, finishedAt: null, consumed: prior?.provenance.consumed ?? [], handoffId: null,
        loopId: assignment?.loopId ?? null, iteration: assignment?.iteration ?? null, stepId: assignment?.stepId ?? null, tools: [], declaredBy: 'agent' },
    };
    this.outputs.set(output.id, clone(output)); this.bodies.set(output.id, content.bodies); this.declarations.set(key, { fingerprint, output: clone(output) });
    return clone(output);
  }
  async handoffToAgent(context: HandoffContext, input: AgentHandoffInput): Promise<Handoff> {
    this.check(context);
    if (!input.instruction || input.instruction.length > 2000) throw new HandoffError('invalid_input', 'Use an instruction of 1 to 2000 characters');
    const key = hashValue([context.userId, context.jobId, context.toolCallId]), fingerprint = hashValue(input);
    const prior = [...this.handoffs.values()].find(h => h.userId === context.userId && h.idempotencyKey === key);
    if (prior) { if (prior.fingerprint !== fingerprint) throw new HandoffError('idempotency_conflict', 'This call was already used with different content'); return clone(prior); }
    const now = this.now(), own = [...this.handoffs.values()].filter(h => h.userId === context.userId && h.initiatedBy === 'agent');
    assertHandoffAllowed({ userId: context.userId, fromBotId: context.botId, target: this.bots.get(input.toBotId), settings: this.policy(context.userId), links: this.links.filter(l => l.userId === context.userId), initiatedBy: 'agent', inLoop: !!this.assignment(context),
      botHourlyCount: own.filter(h => h.fromBotId === context.botId && h.createdAt > now - 3_600_000).length, userDailyCount: own.filter(h => h.createdAt > now - 86_400_000).length });
    let output: RunOutput;
    if (input.outputRef) {
      const ref = parseReference(input.outputRef);
      const found = ref.kind === 'output' ? this.outputs.get(ref.outputId) : undefined;
      if (!found || !this.canRead(context, found)) throw new HandoffError('not_found', 'Not found');
      output = found;
    } else {
      const existing = [...this.outputs.values()].find(o => o.userId === context.userId && o.botId === context.botId && o.jobId === context.jobId);
      output = existing ?? await this.submitOutput({ ...context, toolCallId: `${context.toolCallId}:snapshot` }, { summary: input.summary ?? 'Work in progress' });
    }
    if (input.includeFiles?.some(id => !output.parts.some(p => p.kind === 'file' && (p.id === id || p.artifactId === id)))) throw new HandoffError('not_found', 'Output file not found');
    const chain = checkChain(output, input.toBotId, [...this.outputs.values()]);
    const handoff: Handoff = { id: this.id('ho'), userId: context.userId, fromBotId: context.botId, toBotId: input.toBotId,
      sourceOutputId: output.id, resultOutputId: null, initiatedBy: 'agent', instruction: input.instruction, priority: input.priority ?? 'normal', returnResult: input.returnResult ?? true, createTask: true,
      status: 'queued', reason: input.reason ?? '', requestId: null, jobId: null, loopId: null, iteration: null, stepId: null, roomId: null,
      chainDepth: Math.min(5, chain.length), parentHandoffId: output.provenance.handoffId, idempotencyKey: key, fingerprint, revision: 1, createdAt: now, updatedAt: now };
    this.handoffs.set(handoff.id, clone(handoff)); return clone(handoff);
  }
  async readHandoff(context: HandoffContext, input: ReadHandoffInput): Promise<HandoffPage> {
    this.check(context);
    if (!!input.ref === !!input.handoffId) throw new HandoffError('invalid_input', 'Supply a reference or a handoff id');
    const ref = input.ref ? parseReference(input.ref) : { kind: 'handoff' as const, handoffId: input.handoffId! };
    let output: RunOutput | undefined;
    if (ref.kind === 'handoff') {
      const h = this.handoffs.get(ref.handoffId);
      if (!h || h.userId !== context.userId || (h.fromBotId !== context.botId && h.toBotId !== context.botId)) throw new HandoffError('not_found', 'Not found');
      output = this.outputs.get(h.sourceOutputId);
    } else output = this.outputs.get(ref.outputId);
    if (!output || !this.canRead(context, output)) throw new HandoffError('not_found', 'Not found');
    const partId = input.partId ?? (ref.kind === 'output' ? ref.partId : undefined);
    const offset = input.offset ?? (ref.kind === 'output' ? ref.offset : undefined) ?? 0, limit = input.limit ?? (ref.kind === 'output' ? ref.limit : undefined) ?? 8000;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 8000) throw new HandoffError('invalid_input', 'Invalid page range');
    if (!partId) return { output: clone(output), next: null };
    const part = output.parts.find(p => p.id === partId);
    if (!part) throw new HandoffError('not_found', 'Not found');
    const body = part.kind === 'text' || part.kind === 'data' ? this.bodies.get(output.id)?.[partId] : part.kind === 'link' ? `${part.title}\n${part.url}` : undefined;
    const display = body === undefined ? undefined : redactOutputText(body);
    return { output: clone(output), part: clone(part), ...(display === undefined ? {} : { text: display.slice(offset, offset + limit) }), next: display && offset + limit < display.length ? offset + limit : null };
  }
  async listHandoffs(context: HandoffContext, input: ListHandoffsInput): Promise<Handoff[]> {
    this.check(context);
    if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 20)) throw new HandoffError('invalid_input', 'List at most 20 handoffs');
    return clone([...this.handoffs.values()].filter(h => h.userId === context.userId &&
      (input.direction === 'sent' ? h.fromBotId === context.botId : input.direction === 'received' ? h.toBotId === context.botId : h.fromBotId === context.botId || h.toBotId === context.botId)
      && (!input.status || h.status === input.status)).sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1)).slice(0, input.limit ?? 20));
  }
  async submitVerdict(context: HandoffContext, input: Verdict): Promise<CheckedVerdict> {
    this.check(context); const assignment = this.assignment(context), loop = assignment && this.loops.get(assignment.loopId);
    const step = loop?.spec.steps.find(s => s.id === assignment?.stepId);
    const judge = loop?.spec.exit.mode === 'judge' ? loop.spec.exit.judgeBotId ?? loop.spec.steps.at(-1)?.botId : undefined;
    if (!assignment || !loop || loop.status !== 'running' || loop.iteration !== assignment.iteration || (judge ? context.botId !== judge : step?.role !== 'checker')) throw new HandoffError('not_in_loop', 'No review is waiting for you.');
    const key = `${loop.id}:${assignment.iteration}`, fingerprint = hashValue(input), previous = this.verdicts.get(key);
    if (previous) { if (previous.fingerprint !== fingerprint) throw new HandoffError('invalid_state', 'A submitted verdict cannot be changed'); return clone(previous.verdict); }
    const verdict = recomputeVerdict(input, loop.spec.exit); this.verdicts.set(key, { fingerprint, verdict: clone(verdict) }); return clone(verdict);
  }
  async startLoop(context: HandoffContext, input: StartLoopInput): Promise<Loop> {
    this.check(context);
    if (this.assignment(context)) throw new HandoffError('loop_nested', 'This run is part of a loop. Return your result; the loop passes it on.');
    const key = hashValue([context.userId, context.jobId, context.toolCallId]);
    const prior = [...this.loops.values()].find(l => l.userId === context.userId && l.idempotencyKey === key);
    const now = this.now(), owned = [...this.loops.values()].filter(l => l.userId === context.userId);
    const autoApproved = input.steps.length === 2 && this.links.some(l => l.userId === context.userId && l.fromBotId === input.steps[0].botId && l.toBotId === input.steps[1].botId && l.autoApproveLoops && l.mode !== 'off');
    const spec = { name: input.name ?? 'Agent loop', kind: input.kind ?? 'maker_checker' as const, seed: input.seed ?? {}, goal: input.goal, steps: input.steps, exit: input.exit, limits: input.limits,
      gate: { before: autoApproved ? 'none' as const : 'first' as const, onCap: 'stop' as const }, ...(input.roomId ? { roomId: input.roomId } : {}), ...(input.taskId ? { taskId: input.taskId } : {}) };
    const state = createLoopState(spec);
    if (prior) { if (hashValue(prior.spec) !== hashValue(state.spec)) throw new HandoffError('idempotency_conflict', 'This call was already used with different content'); return clone(prior); }
    if (owned.filter(l => ['running', 'awaiting_approval', 'paused'].includes(l.status)).length >= 3 || owned.filter(l => l.createdAt > now - 86_400_000).length >= 20) throw new HandoffError('rate_limited', 'Loop limit reached. Try again later.');
    for (const botId of [...new Set([...spec.steps.map(s => s.botId), ...(spec.exit.mode === 'judge' && spec.exit.judgeBotId ? [spec.exit.judgeBotId] : [])])]) {
      const bot = this.bots.get(botId);
      if (!bot || bot.userId !== context.userId || bot.kind === 'room' || bot.hidden || bot.isConfiguring || bot.active === false) throw new HandoffError('target_not_allowed', 'Choose an active agent on your team that has finished setup');
    }
    if (spec.seed.outputRef) {
      const ref = parseReference(spec.seed.outputRef), output = ref.kind === 'output' && this.outputs.get(ref.outputId);
      if (!output || !this.canRead(context, output)) throw new HandoffError('not_found', 'Not found');
    }
    const started = nextAction(state, { id: 'start', type: 'start', at: now }).state;
    const loop: Loop = { id: this.id('lp'), userId: context.userId, ownerBotId: context.botId, spec: started.spec, status: started.status, stopReason: null,
      iteration: started.iteration, bestOutputId: null, initiatedBy: 'agent', idempotencyKey: key, revision: 1, startedAt: now, finishedAt: null, createdAt: now, updatedAt: now };
    this.loops.set(loop.id, clone(loop)); return clone(loop);
  }
}
