import type { LoopSpec, LoopStatus, LoopStep, StopReason, Verdict } from './contracts.js';
import { loopSpecSchema } from './schema.js';
import { detectStall, recomputeVerdict, selectBestOutput, type IterationResult } from './verdict.js';
import { HandoffError } from './errors.js';
import { sha256 } from '../flow/hash.js';

export type GateReason = 'first' | 'each' | 'manual' | 'cap';
export interface LoopMachineState {
  spec: LoopSpec; status: LoopStatus; stopReason: StopReason | null; iteration: number;
  stepIndex: number; active: boolean; nudged: boolean; extended: boolean;
  startedAt: number | null; stepStartedAt: number | null; gateStartedAt: number | null; gateReason: GateReason | null;
  capReason: StopReason | null; seenEventIds: string[]; costUsd: number | null; tokens: number | null;
  history: IterationResult[]; currentOutput: { outputId: string; contentHash: string } | null;
  bestOutputId: string | null; warnings: string[];
}
export type LoopMachineEvent = { id: string; at: number } & (
  | { type: 'start' | 'pause' | 'resume' | 'stop' | 'approve' | 'decline' | 'extend' | 'mark_done' | 'tick' }
  | { type: 'usage'; costUsd?: number; tokens?: number }
  | { type: 'step_completed'; iteration: number; stepId: string; nudged?: boolean; outputId: string; contentHash: string; verdict?: Verdict; feedbackHash?: string; costUsd?: number; tokens?: number }
  | { type: 'step_failed'; iteration: number; stepId: string; nudged?: boolean }
);
export type LoopAction = { state: LoopMachineState } & (
  | { type: 'startStep'; iteration: number; step: LoopStep; nudge: boolean }
  | { type: 'waitGate'; reason: GateReason }
  | { type: 'finish'; reason: StopReason }
  | { type: 'noop' }
);
const terminal = new Set<LoopStatus>(['succeeded', 'capped', 'stalled', 'failed', 'cancelled']);
export const isTerminal = (status: LoopStatus): boolean => terminal.has(status);
export function createLoopState(spec: LoopSpec, options: { allowSameBotRoles?: boolean } = {}): LoopMachineState {
  const valid = loopSpecSchema.safeParse(spec);
  if (!valid.success) throw new HandoffError('invalid_input', valid.error.message);
  const maker = spec.steps.find(s => s.role === 'maker'), checker = spec.steps.find(s => s.role === 'checker');
  if (!options.allowSameBotRoles && maker && (maker.botId === checker?.botId || (spec.exit.mode === 'judge' && maker.botId === spec.exit.judgeBotId))) throw new HandoffError('same_bot_roles', 'Use different agents to make and check the work');
  if (spec.steps.some(s => s.id === '__judge')) throw new HandoffError('invalid_input', 'Reserved step id');
  return { spec: valid.data, status: 'draft', stopReason: null, iteration: 0, stepIndex: 0, active: false, nudged: false,
    extended: false, startedAt: null, stepStartedAt: null, gateStartedAt: null, gateReason: null, capReason: null,
    seenEventIds: [], costUsd: null, tokens: null, history: [], currentOutput: null, bestOutputId: null, warnings: [] };
}
function stepsFor(spec: LoopSpec): LoopStep[] {
  return spec.exit.mode === 'judge' && spec.exit.judgeBotId && spec.exit.judgeBotId !== spec.steps.at(-1)?.botId
    ? [...spec.steps, { id: '__judge', botId: spec.exit.judgeBotId, role: 'checker', instruction: spec.exit.rubric }] : spec.steps;
}
/** Persist action.state and dispatch atomically; supply unique event ids, replay them unchanged. */
export function nextAction(previous: LoopMachineState, event: LoopMachineEvent): LoopAction {
  if (isTerminal(previous.status) || previous.seenEventIds.includes(event.id) || !event.id || !Number.isFinite(event.at)) return { type: 'noop', state: previous };
  const state: LoopMachineState = { ...previous, seenEventIds: [...previous.seenEventIds, event.id], warnings: [...previous.warnings], history: [...previous.history] };
  const noop = (): LoopAction => ({ type: 'noop', state });
  const finish = (reason: StopReason): LoopAction => {
    state.stopReason = reason; state.active = false; state.stepStartedAt = null; state.gateReason = null; state.gateStartedAt = null;
    state.status = reason === 'passed' ? 'succeeded' : reason.startsWith('max_') ? 'capped' : reason === 'stalled' ? 'stalled'
      : ['user_stopped', 'declined', 'gate_expired'].includes(reason) ? 'cancelled' : 'failed';
    return { type: 'finish', reason, state };
  };
  const gate = (reason: GateReason): LoopAction => {
    state.status = 'awaiting_approval'; state.active = false; state.stepStartedAt = null; state.gateStartedAt = event.at; state.gateReason = reason;
    return { type: 'waitGate', reason, state };
  };
  const cap = (reason: StopReason): LoopAction => {
    state.capReason = reason;
    return state.spec.gate.onCap === 'ask' && state.status !== 'awaiting_approval' ? gate('cap') : finish(reason);
  };
  const budget = (): StopReason | null => {
    if (state.startedAt !== null && event.at - state.startedAt >= state.spec.limits.maxMinutes * 60_000) return 'max_minutes';
    if (state.spec.limits.maxCostUsd !== undefined && state.costUsd !== null && state.costUsd >= state.spec.limits.maxCostUsd) return 'max_cost';
    if (state.spec.limits.maxTokens !== undefined && state.tokens !== null && state.tokens >= state.spec.limits.maxTokens) return 'max_tokens';
    return null;
  };
  const startStep = (): LoopAction => {
    const limit = budget(); if (limit) return cap(limit);
    if (state.iteration > state.spec.limits.maxIterations || state.iteration > 10) return cap('max_iterations');
    if (state.status === 'paused') return noop();
    state.status = 'running'; state.active = true; state.stepStartedAt = event.at; state.gateReason = null; state.gateStartedAt = null;
    return { type: 'startStep', state, iteration: state.iteration, step: stepsFor(state.spec)[state.stepIndex], nudge: state.nudged };
  };
  const nextIteration = (): LoopAction => {
    const limit = budget(); if (limit) return cap(limit);
    if (state.iteration >= state.spec.limits.maxIterations) return cap('max_iterations');
    state.iteration++; state.stepIndex = 0; state.nudged = false; state.currentOutput = null;
    return startStep();
  };
  if (event.type === 'stop') return finish('user_stopped');
  if (event.type === 'decline' && state.status === 'awaiting_approval') return finish('declined');
  if (state.status === 'awaiting_approval' && state.gateStartedAt !== null && event.at - state.gateStartedAt >= 86_400_000) return finish('gate_expired');
  if (event.type === 'mark_done' && state.spec.exit.mode === 'manual' && state.iteration > 0 && !state.active) return finish('passed');
  if (event.type === 'usage') {
    if (event.costUsd !== undefined && Number.isFinite(event.costUsd) && event.costUsd >= 0) state.costUsd = Math.max(state.costUsd ?? 0, event.costUsd);
    if (event.tokens !== undefined && Number.isSafeInteger(event.tokens) && event.tokens >= 0) state.tokens = Math.max(state.tokens ?? 0, event.tokens);
  }
  // Cap gates retain their reason until a human declines or explicitly resolves the gate.
  if (state.status !== 'draft' && state.gateReason !== 'cap') { const limit = budget(); if (limit) return cap(limit); }
  if (event.type === 'start' && state.status === 'draft') {
    state.startedAt = event.at;
    if (state.spec.gate.before !== 'none') return gate('first');
    return nextIteration();
  }
  if (event.type === 'approve' && state.status === 'awaiting_approval') {
    if (state.gateReason === 'cap') return finish(state.capReason ?? 'max_iterations');
    state.status = 'running'; return nextIteration();
  }
  if (event.type === 'extend' && state.status === 'awaiting_approval' && state.gateReason === 'cap'
    && state.capReason === 'max_iterations' && !state.extended && state.spec.limits.maxIterations < 10) {
    state.extended = true; state.spec = { ...state.spec, limits: { ...state.spec.limits, maxIterations: Math.min(10, state.spec.limits.maxIterations + 2) } };
    state.status = 'running'; state.capReason = null; return nextIteration();
  }
  if (event.type === 'pause' && state.status === 'running') { state.status = 'paused'; return noop(); }
  if (event.type === 'resume' && state.status === 'paused') { state.status = 'running'; return state.active ? noop() : startStep(); }
  if (event.type === 'tick' && state.active && state.stepStartedAt !== null && event.at - state.stepStartedAt >= state.spec.limits.stepTimeoutMinutes * 60_000) return finish('step_failed');
  if ((event.type !== 'step_completed' && event.type !== 'step_failed') || !state.active || !['running', 'paused'].includes(state.status)) return noop();
  const steps = stepsFor(state.spec), step = steps[state.stepIndex];
  if (event.iteration !== state.iteration || event.stepId !== step.id || !!event.nudged !== state.nudged) return noop();
  if (event.type === 'step_failed') return finish('step_failed');
  state.active = false; state.stepStartedAt = null;
  if (event.costUsd !== undefined && Number.isFinite(event.costUsd) && event.costUsd >= 0) state.costUsd = Math.max(state.costUsd ?? 0, event.costUsd);
  if (event.tokens !== undefined && Number.isSafeInteger(event.tokens) && event.tokens >= 0) state.tokens = Math.max(state.tokens ?? 0, event.tokens);
  if (step.role !== 'checker') state.currentOutput = { outputId: event.outputId, contentHash: event.contentHash };
  if (state.stepIndex < steps.length - 1) {
    state.stepIndex++; state.nudged = false; return startStep();
  }
  let verdict: Verdict | undefined;
  if (state.spec.exit.mode !== 'manual') {
    if (!event.verdict) {
      if (state.nudged) return finish('no_verdict');
      state.nudged = true; return startStep();
    }
    try { verdict = recomputeVerdict(event.verdict, state.spec.exit); } catch { return finish('step_failed'); }
  }
  const output = state.currentOutput ?? { outputId: event.outputId, contentHash: event.contentHash };
  state.history.push({ iteration: state.iteration, ...output, feedbackHash: event.feedbackHash ?? (verdict ? sha256(verdict.feedback) : ''), verdict });
  state.bestOutputId = selectBestOutput(state.history, state.spec.exit)?.outputId ?? null;
  if (verdict?.pass) { state.bestOutputId = output.outputId; return finish('passed'); }
  const stalled = detectStall(state.history);
  if (stalled.scoreWarning) state.warnings.push('Score has not improved over two passes');
  if (stalled.stalled) return finish('stalled');
  const limit = budget(); if (limit) return cap(limit);
  if (state.iteration >= state.spec.limits.maxIterations) return cap('max_iterations');
  if (state.spec.gate.before === 'each') return gate('each');
  if (state.spec.exit.mode === 'manual') return gate('manual');
  return nextIteration();
}
