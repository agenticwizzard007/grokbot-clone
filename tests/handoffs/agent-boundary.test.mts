import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { defineHandoffTool } from '../../server/src/agent/handoff-tools.js';

const context = { userId: 'user_fixture', botId: 'bot_fixture', jobId: 'job_fixture', toolCallId: 'call_fixture', depth: 0, enqueueBotMessage() {} };
// These tests exercise the adapter boundary only. Stateful service behavior is
// covered separately against HO-A's MemoryHandoffService.
const policy = { enabled: () => true };
const expectedRefusals = {
  policy_denied: 'Agent handoffs are not allowed by the current policy. Return your result to the user.',
  cycle_detected: 'That would send the work back to an earlier agent. Use a bounded loop instead.',
  chain_too_long: 'This handoff chain has reached its limit. Return your result or propose a bounded loop.',
  rate_limited: 'The handoff rate limit has been reached. Return your result and wait before trying again.',
  target_not_allowed: 'That agent cannot receive this handoff. Choose an allowed active teammate.',
  not_in_loop: 'No review is waiting for you.',
  loop_nested: 'This run is part of a loop. Return your result; the loop passes it on.',
  size_limit: 'This output exceeds a size limit. Shorten the text or save large data as a file.',
  not_found: 'That output or handoff is not available to this agent. Use a reference addressed to you.',
  invalid_state: 'This result is already final or the review has already been submitted. It cannot be changed.',
};

for (const [code, output] of Object.entries(expectedRefusals)) {
  test(`reviewed refusal: ${code}`, async () => {
    const tool = defineHandoffTool('fixture', 'Fixture.', 'Fixture', z.object({}).strict(), () => policy,
      async () => { throw Object.assign(new Error('private exception details'), { code }); });
    assert.deepEqual(await tool.impl({}, context), { output, isError: true });
  });
}

test('the boundary copies identity exclusively from runtime context', async () => {
  let observed: unknown;
  const tool = defineHandoffTool('fixture', 'Fixture.', 'Fixture', z.object({ summary: z.string() }).strict(), () => policy,
    async (_, ctx) => { observed = ctx; return { output: 'Saved.' }; });
  assert.equal((await tool.impl({ summary: 'Placeholder.' }, { ...context, roomId: 'room_fixture' })).isError, undefined);
  assert.deepEqual(observed, { userId: context.userId, botId: context.botId, jobId: context.jobId, toolCallId: context.toolCallId });
  observed = undefined;
  assert.equal((await tool.impl({ summary: 'Placeholder.', userId: 'user_other' }, context)).isError, true);
  assert.equal(observed, undefined);
});

test('missing runtime identity or stable call id refuses before policy or service access', async () => {
  let calls = 0;
  const tool = defineHandoffTool('fixture', 'Fixture.', 'Fixture', z.object({}).strict(), () => { calls++; return policy; },
    async () => { calls++; return { output: 'Unexpected.' }; });
  for (const field of ['userId', 'botId', 'jobId', 'toolCallId']) {
    const result = await tool.impl({}, { ...context, [field]: undefined });
    assert.equal(result.isError, true);
    assert.match(result.output as string, /active run and a stable tool call id/);
  }
  assert.equal(calls, 0);
});

test('disabled policy and kill switch prevent the action', async () => {
  let calls = 0;
  const action = async () => { calls++; return { output: 'Unexpected.' }; };
  const disabled = defineHandoffTool('fixture', 'Fixture.', 'Fixture', z.object({}).strict(), () => ({ enabled: async () => false }), action);
  assert.deepEqual(await disabled.impl({}, context), { output: 'Handoffs are disabled. Continue with the current task.', isError: true });
  const prior = process.env.HANDOFFS_DISABLED;
  try {
    process.env.HANDOFFS_DISABLED = '1';
    const killed = defineHandoffTool('fixture', 'Fixture.', 'Fixture', z.object({}).strict(), () => policy, action);
    assert.deepEqual(await killed.impl({}, context), { output: 'Handoffs are disabled. Continue with the current task.', isError: true });
  } finally {
    if (prior === undefined) delete process.env.HANDOFFS_DISABLED;
    else process.env.HANDOFFS_DISABLED = prior;
  }
  assert.equal(calls, 0);
});

test('unknown, hostile and policy exceptions never throw or expose their contents', async () => {
  const hostile = Object.defineProperty({}, 'code', { get() { throw new Error('private getter'); } });
  for (const error of [new Error('private database path'), 'private string', null, undefined, { code: 'constructor' }, hostile]) {
    const tool = defineHandoffTool('fixture', 'Fixture.', 'Fixture', z.object({}).strict(), () => policy,
      async () => { throw error; });
    assert.deepEqual(await tool.impl({}, context), {
      output: 'The handoff operation could not finish. Inspect the current result before trying again.', isError: true,
    });
  }
  const tool = defineHandoffTool('fixture', 'Fixture.', 'Fixture', z.object({}).strict(),
    () => ({ enabled: async () => { throw new Error('private policy'); } }), async () => ({ output: 'Unexpected.' }));
  assert.equal((await tool.impl({}, context)).isError, true);
});
