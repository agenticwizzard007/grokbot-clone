import type { FlowModel, LoopSpec, RunOutput, Verdict } from '../../../server/src/handoffs/index.js';
import { buildOutputContent } from '../../../server/src/handoffs/output.js';
export function output(body = 'A placeholder report.', overrides: Partial<RunOutput> = {}): RunOutput {
  const content = buildOutputContent(body);
  return { id: 'out_fixture', userId: 'user_test', botId: 'bot_maker', jobId: 'job_test', taskId: null, source: 'run', status: 'final', revision: 1,
    title: 'Placeholder report', summary: content.summary, parts: content.parts, contentHash: content.contentHash,
    provenance: { producer: { botId: 'bot_maker', botName: 'Maker' }, jobId: 'job_test', trigger: 'user', model: 'test-model', effort: null, startedAt: 0, finishedAt: 1000, consumed: [], handoffId: null, loopId: null, iteration: null, stepId: null, tools: [], declaredBy: 'auto' },
    createdAt: 0, finalizedAt: 1000, ...overrides };
}
export function loopSpec(overrides: Partial<LoopSpec> = {}): LoopSpec {
  return { name: 'Placeholder loop', goal: 'Prepare a complete test report', kind: 'maker_checker',
    steps: [{ id: 'maker', botId: 'bot_maker', role: 'maker', instruction: 'Draft the report' }, { id: 'checker', botId: 'bot_checker', role: 'checker', instruction: 'Review the report' }],
    seed: { text: 'Test brief' }, exit: { mode: 'verdict' }, limits: { maxIterations: 4, maxMinutes: 30, stepTimeoutMinutes: 10 }, gate: { before: 'none', onCap: 'stop' }, ...overrides };
}
export const verdict = (pass = false, feedback = 'Add the missing section'): Verdict => ({ pass, feedback, checklist: [] });
export function flow(): FlowModel {
  return { v: 1, botId: 'bot_maker', version: 1, inputsHash: 'fixture', generatedAt: 0, source: 'auto',
    lanes: [
      { id: 'triggers', label: 'Triggers', nodes: [{ id: 'triggers:message', kind: 'message', label: 'You message me', target: { hash: '#bot/bot_maker' }, state: 'ok' }], more: 0 },
      { id: 'inputs', label: 'Inputs', nodes: [], more: 0 },
      { id: 'steps', label: 'Steps', nodes: [{ id: 'steps:1', kind: 'step', label: 'Draft a test report', target: { hash: '#bot/bot_maker/details/setup/responsibilities' }, state: 'ok' }], more: 0 },
      { id: 'outputs', label: 'Outputs', nodes: [{ id: 'outputs:report', kind: 'report', label: 'Reports', target: { hash: '#bot/bot_maker/details/files/reports' }, state: 'ok' }], more: 0 },
      { id: 'handoffs', label: 'Handoffs', nodes: [{ id: 'handoffs:checker', kind: 'handoff_to', label: 'Checker', badge: 'Suggest', target: { hash: '#bot/bot_maker/details/flow?link=test' }, state: 'ok' }], more: 0 },
    ], loopBack: { kind: 'waits', label: 'Waits for the next trigger' }, warnings: [] };
}
export function random(seed = 123456) { return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }; }
export function shuffle<T>(rows: readonly T[], rng: () => number): T[] { const result = [...rows]; for (let i = result.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [result[i], result[j]] = [result[j], result[i]]; } return result; }
