import { register } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
register('tsx/esm', import.meta.url);
const { buildPacket, PACKET_LIMIT, createLoopState, nextAction, layoutFlow, layoutRunGraph } = await import('../../server/src/handoffs/index.ts');
const { packetCases } = await import('./unit/packet-cases.mts');
const { loopSpec, flow, verdict } = await import('./unit/fixtures.mts');
const destination = path.resolve('.context/handoffs/demo-a');
mkdirSync(destination, { recursive: true });
const lines = [];
const print = line => { lines.push(String(line)); console.log(line); };
const packet = buildPacket(packetCases().long);
assert.ok(packet.length <= PACKET_LIMIT);
assert.match(packet, /HEAD/); assert.match(packet, /TAIL/);
print(`PACKET ${packet.length}/${PACKET_LIMIT} characters`); print(packet);
function trace(name, passAt, maxIterations) {
  const spec = loopSpec(); spec.limits.maxIterations = maxIterations;
  let serial = 0, action = nextAction(createLoopState(spec), { type: 'start', id: 'start', at: 0 });
  const events = [], steps = [];
  while (action.type === 'startStep') {
    const { iteration, step } = action;
    print(`${name}: iteration ${iteration}, ${step.role}, ${step.botId}${action.nudge ? ', verdict nudge' : ''}`);
    steps.push({ iteration, stepId: step.id });
    events.push({ seq: serial, createdAt: serial, type: 'loop.step_dispatched', data: { iteration, stepId: step.id, botId: step.botId, role: step.role, title: `Test draft ${iteration}` } });
    action = nextAction(action.state, { id: `finished_${++serial}`, at: serial * 1000, type: 'step_completed', iteration, stepId: step.id,
      outputId: `out_${step.id}_${iteration}`, contentHash: `content_${step.id}_${iteration}`, ...(step.role === 'checker' ? { verdict: verdict(iteration === passAt, `Feedback for pass ${iteration}`) } : {}) });
  }
  assert.equal(action.type, 'finish');
  assert.equal(action.reason, passAt <= maxIterations ? 'passed' : 'max_iterations');
  assert.equal(steps.length, Math.min(passAt, maxIterations) * 2);
  print(`${name}: ${action.state.status}, reason=${action.reason}, passes=${action.state.iteration}, best=${action.state.bestOutputId}`);
  return { status: action.state.status, reason: action.reason, passes: action.state.iteration, bestOutputId: action.state.bestOutputId, steps, events };
}
const converging = trace('CONVERGING', 3, 4), capped = trace('CAPPED', 99, 4);
const plans = {};
for (const width of [390, 1280]) {
  plans[width] = { flow: layoutFlow(flow(), width), runGraph: layoutRunGraph(converging.events, width) };
  print(`FLOW PLAN ${width}`); print(JSON.stringify(plans[width].flow, null, 2));
  writeFileSync(path.join(destination, `plans-${width}.json`), JSON.stringify(plans[width], null, 2) + '\n');
}
writeFileSync(path.join(destination, 'trace.json'), JSON.stringify({ converging, capped }, null, 2) + '\n');
print('PASS demo-a: 1 bounded long packet, 2 loop traces, 2 flow plans, 2 run graph plans');
print(`Evidence: ${destination}`);
writeFileSync(path.join(destination, 'demo.txt'), lines.join('\n') + '\n');
