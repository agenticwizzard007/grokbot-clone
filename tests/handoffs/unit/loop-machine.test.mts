import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLoopState, isTerminal, nextAction, type LoopAction, type LoopMachineEvent } from '../../../server/src/handoffs/loop-machine.js';
import type { LoopSpec, StopReason } from '../../../server/src/handoffs/contracts.js';
import { loopSpec, random, verdict } from './fixtures.mts';
function driver(spec = loopSpec()) {
  let action: LoopAction = { type: 'noop', state: createLoopState(spec) }, serial = 0;
  return {
    get action() { return action; },
    send(data: Omit<LoopMachineEvent, 'id' | 'at'> | Record<string, unknown>, at = ++serial) { action = nextAction(action.state, { id: `event_${++serial}`, at, ...data } as LoopMachineEvent); return action; },
    complete(pass?: boolean, contentHash?: string) {
      assert.equal(action.type, 'startStep'); if (action.type !== 'startStep') throw Error('No step');
      const { iteration, step, nudge } = action;
      return this.send({ type: 'step_completed', iteration, stepId: step.id, nudged: nudge, outputId: `out_${step.id}_${iteration}`, contentHash: contentHash ?? `${step.id}_${iteration}`, ...(pass === undefined ? {} : { verdict: verdict(pass, `Feedback ${iteration}`) }) });
    },
  };
}
const scenarios: Record<StopReason, () => LoopAction> = {
  passed() { const d = driver(); d.send({ type: 'start' }); d.complete(); return d.complete(true); },
  max_iterations() { const spec = loopSpec(); spec.limits.maxIterations = 1; const d = driver(spec); d.send({ type: 'start' }); d.complete(); return d.complete(false); },
  max_minutes() { const d = driver(); d.send({ type: 'start' }, 0); return d.send({ type: 'tick' }, 30 * 60_000); },
  max_cost() { const spec = loopSpec(); spec.limits.maxCostUsd = 1; const d = driver(spec); d.send({ type: 'start' }); return d.send({ type: 'usage', costUsd: 1 }); },
  max_tokens() { const spec = loopSpec(); spec.limits.maxTokens = 100; const d = driver(spec); d.send({ type: 'start' }); return d.send({ type: 'usage', tokens: 100 }); },
  stalled() { const d = driver(); d.send({ type: 'start' }); d.complete(undefined, 'same'); d.complete(false); d.complete(undefined, 'same'); return d.complete(false); },
  step_failed() { const d = driver(); d.send({ type: 'start' }); return d.send({ type: 'step_failed', iteration: 1, stepId: 'maker' }); },
  no_verdict() { const d = driver(); d.send({ type: 'start' }); d.complete(); d.complete(); return d.complete(); },
  user_stopped() { const d = driver(); d.send({ type: 'start' }); return d.send({ type: 'stop' }); },
  declined() { const d = driver(loopSpec({ gate: { before: 'first', onCap: 'stop' } })); d.send({ type: 'start' }); return d.send({ type: 'decline' }); },
  gate_expired() { const d = driver(loopSpec({ gate: { before: 'first', onCap: 'stop' } })); d.send({ type: 'start' }, 0); return d.send({ type: 'tick' }, 86_400_000); },
};
for (const [reason, scenario] of Object.entries(scenarios)) test(`stop reason reachable: ${reason}`, () => { const action = scenario(); assert.equal(action.type, 'finish'); assert.equal(action.state.stopReason, reason); assert.ok(isTerminal(action.state.status)); assert.equal(action.state.active, false); });
test('three pass convergence selects the maker output and caps do not dispatch an extra step', () => {
  const d = driver(); const actions: string[] = []; actions.push(d.send({ type: 'start' }).type);
  for (let n = 1; n <= 3; n++) { actions.push(d.complete().type); actions.push(d.complete(n === 3).type); }
  assert.equal(d.action.state.iteration, 3); assert.equal(d.action.state.bestOutputId, 'out_maker_3'); assert.equal(actions.filter(a => a === 'startStep').length, 6);
});
test('pause handles in-flight completions without dispatch until resume', () => {
  const d = driver(); d.send({ type: 'start' }); d.send({ type: 'pause' });
  assert.equal(d.send({ type: 'step_completed', iteration: 1, stepId: 'maker', outputId: 'out_test', contentHash: 'test' }).type, 'noop');
  assert.equal(d.action.state.status, 'paused'); assert.equal(d.action.state.active, false);
  const action = d.send({ type: 'resume' }); assert.equal(action.type, 'startStep'); if (action.type === 'startStep') assert.equal(action.step.id, 'checker');
});
test('pause and resume an active step do not redispatch it', () => { const d = driver(); d.send({ type: 'start' }); d.send({ type: 'pause' }); assert.equal(d.send({ type: 'resume' }).type, 'noop'); assert.equal(d.action.state.active, true); });
test('first and each gates approve exactly one iteration, cap extension is once and at most ten', () => {
  const spec = loopSpec({ gate: { before: 'each', onCap: 'ask' } }); spec.limits.maxIterations = 1;
  const d = driver(spec); assert.equal(d.send({ type: 'start' }).type, 'waitGate'); d.send({ type: 'approve' }); d.complete();
  assert.equal(d.complete(false).type, 'waitGate'); assert.equal(d.action.state.gateReason, 'cap');
  assert.equal(d.send({ type: 'extend' }).type, 'startStep'); assert.equal(d.action.state.spec.limits.maxIterations, 3);
  d.complete(); d.complete(false); assert.equal(d.action.state.gateReason, 'each'); d.send({ type: 'approve' }); d.complete(); d.complete(false);
  assert.equal(d.send({ type: 'extend' }).type, 'noop'); assert.equal(d.send({ type: 'approve' }).state.stopReason, 'max_iterations');
  const s = createLoopState(loopSpec({ limits: { maxIterations: 9, maxMinutes: 30, stepTimeoutMinutes: 10 }, gate: { before: 'none', onCap: 'ask' } }));
  const atCap = { ...s, status: 'awaiting_approval' as const, iteration: 9, gateReason: 'cap' as const, capReason: 'max_iterations' as const, gateStartedAt: 0 };
  const extended = nextAction(atCap, { type: 'extend', id: 'extend', at: 1 }); assert.equal(extended.state.spec.limits.maxIterations, 10); assert.equal(extended.state.iteration, 10);
});
test('manual pipeline pauses for a human and explicit done succeeds', () => {
  const spec = loopSpec({ kind: 'pipeline', exit: { mode: 'manual' }, steps: [{ id: 'a', botId: 'bot_maker', role: 'step', instruction: '' }, { id: 'b', botId: 'bot_checker', role: 'step', instruction: '' }] });
  const d = driver(spec); d.send({ type: 'start' }); d.complete(); assert.equal(d.complete().type, 'waitGate'); assert.equal(d.action.state.gateReason, 'manual');
  assert.equal(d.send({ type: 'mark_done' }).state.stopReason, 'passed');
});
test('a separate judge runs after the checker and alone supplies the exit verdict', () => {
  const d = driver(loopSpec({ exit: { mode: 'judge', judgeBotId: 'bot_judge', rubric: 'Check accuracy' } }));
  d.send({ type: 'start' }); d.complete(); const action = d.complete(true); assert.equal(action.type, 'startStep'); if (action.type === 'startStep') assert.equal(action.step.botId, 'bot_judge');
  assert.equal(d.complete(true).state.stopReason, 'passed'); assert.equal(d.action.state.bestOutputId, 'out_maker_1');
});
test('step timeout stops even while paused, unmeasurable usage does not invent a cost', () => {
  const spec = loopSpec(); spec.limits.maxCostUsd = 1; const d = driver(spec); d.send({ type: 'start' }, 0); d.send({ type: 'pause' }, 1);
  assert.equal(d.send({ type: 'tick' }, 600_000).state.stopReason, 'step_failed'); assert.equal(d.action.state.costUsd, null);
});
test('checklist claimed pass cannot finish and missing verdict gets exactly one nudge', () => {
  const d = driver(loopSpec({ exit: { mode: 'checklist', items: [{ id: 'required', text: 'Required check', required: true }] } })); d.send({ type: 'start' }); d.complete();
  d.send({ type: 'step_completed', iteration: 1, stepId: 'checker', outputId: 'out_c', contentHash: 'c', verdict: { pass: true, checklist: [{ id: 'required', pass: false, note: 'Missing' }], feedback: 'Fix it' } });
  assert.equal(d.action.state.iteration, 2); assert.equal(d.action.state.status, 'running');
  const noVerdict = driver(); noVerdict.send({ type: 'start' }); noVerdict.complete(); const nudge = noVerdict.complete(); assert.equal(nudge.type, 'startStep'); if (nudge.type === 'startStep') assert.equal(nudge.nudge, true);
});
test('machine fuzz: 10000 seeded sequences maintain caps, replay idempotency, immutability and absorbing terminal states', () => {
  const rng = random(99), kinds = ['start', 'pause', 'resume', 'stop', 'approve', 'decline', 'extend', 'mark_done', 'tick', 'usage', 'step_completed', 'step_failed'] as const;
  for (let seq = 0; seq < 10000; seq++) {
    const spec = loopSpec({ gate: { before: seq % 3 === 0 ? 'each' : seq % 3 === 1 ? 'first' : 'none', onCap: seq % 2 ? 'ask' : 'stop' } }); spec.limits.maxIterations = 1 + seq % 10;
    let state = createLoopState(spec), at = 0;
    for (let n = 0; n < 35; n++) {
      at += Math.floor(rng() * 20_000);
      const type = n === 0 ? 'start' : kinds[Math.floor(rng() * kinds.length)];
      const event = { id: `seq${seq}_${n}`, at, type, iteration: state.iteration, stepId: state.spec.steps[state.stepIndex]?.id ?? 'maker', nudged: state.nudged,
        outputId: `out_${seq}_${n}`, contentHash: String(n % 5), verdict: verdict(rng() < 0.2, String(n)), costUsd: rng() * 4, tokens: n * 100 } as LoopMachineEvent;
      const before = JSON.stringify(state), action = nextAction(state, event);
      assert.equal(JSON.stringify(state), before); assert.ok(action.state.iteration <= action.state.spec.limits.maxIterations); assert.ok(action.state.iteration <= 10);
      assert.ok(!isTerminal(action.state.status) || !action.state.active);
      assert.deepEqual(nextAction(action.state, event), { type: 'noop', state: action.state });
      if (isTerminal(state.status)) assert.equal(action.state, state);
      if (action.type === 'startStep') { assert.equal(action.state.status, 'running'); assert.ok(action.step); assert.ok(action.iteration >= 1); }
      state = action.state;
    }
  }
});
