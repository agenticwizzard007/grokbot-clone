// Recorded 4-pass, 12-step fixture for browser rendering measurements only.
import fs from 'node:fs';
import { db } from '../../../server/src/db.js';
import * as jobs from '../../../server/src/agent/jobs.js';
import * as requests from '../../../server/src/coordination/requests.js';
import * as loops from '../../../server/src/handoffs/loop-service.js';
import * as runner from '../../../server/src/handoffs/loop-runner.js';
import * as reconcile from '../../../server/src/handoffs/reconcile.js';
import * as hooks from '../../../server/src/handoffs/hooks.js';
const file = process.env.PHONE_QA_FIXTURE_FILE!, f = JSON.parse(fs.readFileSync(file, 'utf8'));
requests.configureCoordinationRuntime({ enqueue: (botId, trigger) => jobs.acceptJob(botId, trigger).id, interrupt() {} });
const loop = loops.createLoop(f.userId, { idempotencyKey: 'hoh-perf', start: true, spec: {
  name: 'Placeholder performance review', goal: 'Review the placeholder draft.', kind: 'pipeline',
  steps: [{ id: 'draft', botId: f.maker, role: 'step', instruction: 'Draft.' }, { id: 'edit', botId: f.empty, role: 'step', instruction: 'Edit.' }, { id: 'check', botId: f.checker, role: 'checker', instruction: 'Check.' }],
  seed: { text: 'Placeholder brief.' }, exit: { mode: 'verdict' }, limits: { maxIterations: 4, maxMinutes: 30, stepTimeoutMinutes: 10 }, gate: { before: 'none', onCap: 'stop' },
} }).loop;
for (let n = 0; n < 80; n++) {
  await new Promise(resolve => setImmediate(resolve)); reconcile.reconcileHandoffs(f.userId); runner.driveLoop(f.userId, loop.id);
  const current = loops.getLoop(f.userId, loop.id); if (loops.terminal(current.status)) break;
  const step = loops.loopSteps(f.userId, loop.id).find(step => step.jobId && !step.outputId)!;
  if (!step?.jobId) continue;
  jobs.beginJob(step.jobId);
  if (step.role === 'checker') loops.submitVerdict({ userId: f.userId, botId: step.botId, jobId: step.jobId, toolCallId: `perf-${n}` }, { pass: false, checklist: [], feedback: `Placeholder feedback ${current.iteration}.` });
  jobs.finishJob(step.jobId, true);
  const result = { userId: f.userId, botId: step.botId, jobId: step.jobId, status: 'completed', finalText: `Placeholder ${step.stepId} pass ${current.iteration}.` };
  requests.recordCoordinationJobOutcome(result); hooks.onJobFinished(result); requests.onInternalJobFinished(result);
}
if (loops.loopSteps(f.userId, loop.id).length !== 12) throw new Error('Performance fixture must have 12 steps.');
fs.writeFileSync(file, JSON.stringify({ ...f, perfLoop: loop.id }));
runner.stopLoopDeadlines(); reconcile.stopHandoffRecovery(); db.close();
