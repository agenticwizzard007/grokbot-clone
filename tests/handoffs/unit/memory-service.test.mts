import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryHandoffService, type MemoryHandoffSeed } from '../../../server/src/handoffs/memory-service.js';
import type { HandoffContext, Loop } from '../../../server/src/handoffs/contracts.js';
import { loopSpec, output, verdict } from './fixtures.mts';
const context: HandoffContext = { userId: 'user_test', botId: 'bot_maker', jobId: 'job_test', toolCallId: 'call_test' };
const bots = [{ id: 'bot_maker', userId: 'user_test' }, { id: 'bot_checker', userId: 'user_test' }, { id: 'bot_other', userId: 'user_test' }, { id: 'bot_foreign', userId: 'user_other' }];
const service = (seed: MemoryHandoffSeed = {}) => new MemoryHandoffService({ bots, now: () => 1000, ...seed });
const rejects = (fn: () => Promise<unknown>, code: string) => assert.rejects(fn, (error: any) => error.code === code);

test('fake declarations replay once, revise drafts and never expose mutable storage', async () => {
  const s = service(); const one = await s.submitOutput(context, { summary: 'First report' }); one.summary = 'Mutated';
  const replay = await s.submitOutput(context, { summary: 'First report' }); assert.equal(replay.summary, 'First report'); assert.equal(replay.revision, 1);
  await rejects(() => s.submitOutput(context, { summary: 'Different call content' }), 'idempotency_conflict');
  const revised = await s.submitOutput({ ...context, toolCallId: 'call_second' }, { summary: 'Revised' }); assert.equal(revised.revision, 2); assert.equal(revised.id, replay.id);
});
test('fake final output is immutable and saved files must belong to the active run', async () => {
  const s = service({ outputs: [output()] }); await rejects(() => s.submitOutput(context, { summary: 'New' }), 'invalid_state');
  await rejects(() => service().submitOutput(context, { summary: 'Test', files: ['/other/run.txt'] }), 'not_found');
});
test('fake handoff is idempotent, grants addressed reads and rejects same-tenant strangers and foreign users', async () => {
  const s = service({ outputs: [output('A test body')], bodies: { out_fixture: { p_body: 'A test body' } } });
  const input = { toBotId: 'bot_checker', instruction: 'Review', outputRef: 'swarm://output/out_fixture' };
  const h = await s.handoffToAgent(context, input); assert.deepEqual(await s.handoffToAgent(context, input), h);
  await rejects(() => s.handoffToAgent(context, { ...input, instruction: 'Changed' }), 'idempotency_conflict');
  assert.equal((await s.listHandoffs(context, {})).length, 1);
  const receiver = { ...context, botId: 'bot_checker', jobId: 'job_check' };
  const page = await s.readHandoff(receiver, { handoffId: h.id, partId: 'p_body', offset: 2, limit: 4 }); assert.equal(page.text, 'test'); assert.equal(page.next, 6);
  for (const denied of [{ ...context, botId: 'bot_other' }, { ...context, userId: 'user_other', botId: 'bot_foreign' }]) {
    await rejects(() => s.readHandoff(denied, { ref: 'swarm://output/out_fixture' }), 'not_found'); await rejects(() => s.readHandoff(denied, { handoffId: h.id }), 'not_found');
  }
});
test('fake rate limit, policy, disabled flag and bad targets enforce tool refusal codes', async () => {
  const s = service();
  for (let i = 0; i < 20; i++) await s.handoffToAgent({ ...context, toolCallId: `call_${i}` }, { toBotId: 'bot_checker', instruction: 'Review' });
  await rejects(() => s.handoffToAgent({ ...context, toolCallId: 'call_over' }, { toBotId: 'bot_checker', instruction: 'Review' }), 'rate_limited');
  await rejects(() => service({ settings: { user_test: { enabled: true, agentHandoffs: 'off' } } }).handoffToAgent(context, { toBotId: 'bot_checker', instruction: 'Review' }), 'policy_denied');
  await rejects(() => service({ settings: { user_test: { enabled: false, agentHandoffs: 'team' } } }).listHandoffs(context, {}), 'disabled');
  await rejects(() => service().handoffToAgent(context, { toBotId: 'bot_foreign', instruction: 'Review' }), 'target_not_allowed');
});
test('fake agent loops always gate first unless the exact pair is explicitly auto approved', async () => {
  const s = service(), spec = loopSpec();
  const input = { goal: spec.goal, steps: spec.steps, exit: spec.exit, limits: spec.limits };
  const l = await s.startLoop(context, input); assert.equal(l.status, 'awaiting_approval'); assert.equal(l.iteration, 0);
  assert.deepEqual(await s.startLoop(context, input), l); await rejects(() => s.startLoop(context, { ...input, goal: 'Changed' }), 'idempotency_conflict');
  const auto = service({ links: [{ id: 'link_test', userId: 'user_test', fromBotId: 'bot_maker', toBotId: 'bot_checker', mode: 'suggest', trigger: 'any_run', template: '', autoApproveLoops: true, createdAt: 0, updatedAt: 0 }] });
  assert.equal((await auto.startLoop(context, input)).status, 'running');
  assert.equal(typeof (s as any).approve, 'undefined');
});
test('fake only active checker or judge jobs can submit an immutable verdict, loop jobs cannot spawn chains', async () => {
  const loop: Loop = { id: 'lp_test', userId: 'user_test', ownerBotId: 'bot_maker', spec: loopSpec(), status: 'running', stopReason: null, iteration: 1, bestOutputId: null, initiatedBy: 'user', idempotencyKey: 'test', revision: 1, startedAt: 0, finishedAt: null, createdAt: 0, updatedAt: 0 };
  const s = service({ loops: [loop], assignments: [{ loopId: 'lp_test', jobId: 'job_test', botId: 'bot_checker', iteration: 1, stepId: 'checker' }] });
  await rejects(() => s.submitVerdict(context, verdict(true)), 'not_in_loop');
  const checker = { ...context, botId: 'bot_checker' }; const v = await s.submitVerdict(checker, verdict(true)); assert.equal(v.pass, true);
  assert.deepEqual(await s.submitVerdict(checker, verdict(true)), v); await rejects(() => s.submitVerdict(checker, verdict(false)), 'invalid_state');
  await rejects(() => s.handoffToAgent(checker, { toBotId: 'bot_maker', instruction: 'Again' }), 'loop_nested');
  const spec = loopSpec(); await rejects(() => s.startLoop(checker, { goal: spec.goal, steps: spec.steps, exit: spec.exit, limits: spec.limits }), 'loop_nested');
});
test('concurrent fake snapshot handoffs commit one record and reject conflicting retries', async () => {
  const s = service(), input = { toBotId: 'bot_checker', instruction: 'Review' };
  const [a, b] = await Promise.all([s.handoffToAgent(context, input), s.handoffToAgent(context, input)]);
  assert.equal(a.id, b.id); assert.equal((await s.listHandoffs(context, {})).length, 1);
  const other = service();
  const results = await Promise.allSettled([other.handoffToAgent(context, input), other.handoffToAgent(context, { ...input, instruction: 'Different' })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason.code, 'idempotency_conflict');
});
