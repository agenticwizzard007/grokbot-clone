import assert from 'node:assert/strict';
import { realAgentFixture, loopSpec, pollLoop } from './e2e/fixture.mjs';
import { goals, mockIterationProvider } from './mock-iter.mjs';

const started = Date.now();
const watchdog = setTimeout(() => { console.error('Real loop E2E exceeded 55 seconds.'); process.exit(1); }, 55000);
const provider = await mockIterationProvider();
let server;
try {
  server = await realAgentFixture(provider.base);
  for (const [mode, status, reason] of [['converge', 'succeeded', 'passed'], ['cap', 'capped', 'max_iterations']]) {
    const fixture = server.seed();
    const created = await fixture.request('/loops', { spec: loopSpec(fixture, goals[mode]), start: true, idempotencyKey: mode });
    const done = await pollLoop(fixture, created.id);
    assert.equal(done.status, status, JSON.stringify(done));
    assert.equal(done.stopReason, reason);
    assert.equal(done.iteration, 3);
    assert.equal(done.steps.length, 6);
    assert.equal(done.verdicts.length, 3);
    assert.equal(done.events.filter(event => event.type === 'loop.verdict').length, 3);
    assert.ok(done.steps.every(step => step.status === 'completed' && step.outputId && step.jobId));
    const receipts = server.db.prepare('SELECT job_id,call_id FROM handoff_tool_receipts WHERE user_id=?').all(fixture.userId);
    assert.equal(receipts.length, 6, 'Every maker and checker declares its output through a real tool call');
    assert.ok(receipts.every(receipt => provider.calls.some(call => call.call_id === receipt.call_id)));
    console.log(`PASS ${mode}: ${done.status}, ${done.stopReason}, ${done.iteration} passes, 3 verdicts, 6 output receipts`);
  }
  console.log(`Real loop E2E: 2/2 scenarios passed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
} finally {
  await server?.close();
  await provider.close();
  clearTimeout(watchdog);
}
