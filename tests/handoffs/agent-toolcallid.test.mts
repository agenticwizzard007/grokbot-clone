import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { realAgentFixture, loopSpec } from './fix4/fixture.mjs';

const server = await realAgentFixture();
const { db, agent } = server;
const { llmClient } = await import('../../server/src/lib/llm.js');
const { withUsage } = await import('../../server/src/usage.js');
const { toolMap } = await import('../../server/src/agent/tools.js');
const { toolSchemaHash } = await import('../../server/src/agent/tool-catalog.js');
const { saveAccountPreferences } = await import('../../server/src/settings.js');
const { approvalBinding } = await import('../../server/src/security/approval.js');
const { updateRow } = await import('../../server/src/store.js');
import type { ToolCtx } from '../../server/src/agent/tools.js';

let model: (body: any) => any[] = () => [];
const client = withUsage({ userId: 'fixture' }, () => llmClient(360000));
mock.method(client.responses, 'create', async (body: any) => {
  const output = model(body);
  return (async function* () {
    for (const item of output) {
      yield { type: 'response.output_item.added', item };
      if (item.type === 'message') yield { type: 'response.output_text.delta', delta: item.content[0].text };
      yield { type: 'response.output_item.done', item };
    }
    yield { type: 'response.completed', response: { output, usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 } } };
  })();
});
after(async () => { await server.close(); mock.restoreAll(); });

const verdict = {
  pass: true, feedback: 'All checks passed.',
  checklist: ['version', 'short', 'action'].map(id => ({ id, pass: true, note: 'Verified.' })),
};
const output = { summary: 'Version 3.0 is ready. Try the release.' };
const message = (text: string) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
const call = (name: string, args: unknown, id: string) => ({ type: 'function_call', name, call_id: id, arguments: JSON.stringify(args) });
const wrapped = (name: string, args: unknown) => ({ tool_name: name, arguments: args,
  schema_hash: toolSchemaHash({ type: 'function', ...toolMap.get(name)! }) });

for (const route of ['direct', 'wrapper', 'program', 'approval', 'program-approval', 'legacy-wrapper'] as const) {
  test(`real checker dispatch: ${route} preserves identity and replays without duplicate effects`, { timeout: 15000 }, async t => {
    const fixture = server.seed();
    const approvals = ['approval', 'program-approval', 'legacy-wrapper'].includes(route);
    if (approvals) saveAccountPreferences(fixture.userId, { apiApprovalLevel: 'every_action' });
    const prefix = `${fixture.userId}-${route}`;
    const seen: { name: string; args: any; ctx: ToolCtx; result: any; replay: any }[] = [];
    for (const name of ['submit_output', 'submit_verdict']) {
      const tool = toolMap.get(name)!;
      const original = tool.impl;
      t.mock.method(tool, 'impl', async (args: any, ctx: ToolCtx) => {
        // Replay at the real service boundary while this exact job is active.
        const result = await original(args, ctx);
        const replay = await original(args, ctx);
        seen.push({ name, args, ctx, result, replay });
        return result;
      });
    }
    const programContexts: ToolCtx[] = [];
    if (route.startsWith('program')) {
      const tool = toolMap.get('save_file')!, original = tool.impl;
      t.mock.method(tool, 'impl', async (args: any, ctx: ToolCtx) => {
        programContexts.push(ctx);
        return original(args, ctx);
      });
    }
    let planned = false, programPlanned = false;
    model = body => {
      const user = body.input.findLast((item: any) => item.role === 'user');
      if (!JSON.stringify(user?.content).includes('Submit your verdict with submit_verdict.')) return [message(output.summary)];
      if (route.startsWith('program') && !programPlanned) {
        programPlanned = true;
        // Programs intentionally exclude handoff tools. Verify their shared
        // dispatch context with an allowed action, then submit the review.
        return [call('execute_code', {
          tools: ['save_file'], code: 'return tools.call("save_file", {filename:"review.txt",content:"Verified release notes."});',
        }, `${prefix}-program`)];
      }
      if (planned) return [message('Review complete.')];
      planned = true;
      const calls = [call('submit_output', output, `${prefix}-output`), call('submit_verdict', verdict, `${prefix}-verdict`)];
      if (route === 'wrapper' || route === 'legacy-wrapper') return calls.map(item => call('tool_call', wrapped(item.name, JSON.parse(item.arguments)), item.call_id));
      // The durable dispatch journal must also suppress a repeated provider call.
      return route === 'direct' ? [calls[0], calls[0], calls[1], calls[1]] : calls;
    };
    const created = await fixture.request('/loops', { spec: loopSpec(fixture, 'Verify a release note.'), start: true, idempotencyKey: prefix });
    const pendingSnapshots: any[] = [];
    let upgraded = false, done: any;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      await agent.settleAgentJobs();
      const approval = db.prepare("SELECT * FROM approvals WHERE bot_id=? AND status='pending' ORDER BY rowid LIMIT 1").get(fixture.checker.id) as any;
      if (approval) {
        assert.ok(approvals, 'Standard dispatch needs no approval');
        const pending = JSON.parse((db.prepare('SELECT state FROM pending_turns WHERE bot_id=?').get(fixture.checker.id) as any).state);
        pendingSnapshots.push(structuredClone(pending));
        if (route === 'legacy-wrapper' && !upgraded) {
          // Recreate an older server's already-dispatched generic wrapper.
          const first = pending.calls[0];
          const args = wrapped(first.name, JSON.parse(first.arguments));
          first.name = 'tool_call';
          first.arguments = JSON.stringify(args);
          delete first.schemaHash;
          pending.approvedWrappers = [first.call_id];
          updateRow(fixture.checker.id, first.rowSeq, { type: 'tool-call', callId: first.call_id, name: 'tool_call', args, label: 'Calling tool', status: 'awaiting-approval' });
          db.prepare('UPDATE approvals SET tool=?,binding_hash=? WHERE id=?').run('api_max:tool_call', approvalBinding(fixture.userId, fixture.checker.id, first.call_id, 'tool_call', args), approval.id);
          db.prepare('UPDATE pending_turns SET state=? WHERE bot_id=?').run(JSON.stringify(pending), fixture.checker.id);
          upgraded = true;
        }
        await fixture.request(`/approvals/${approval.id}`, { decision: 'allow' });
      }
      done = await fixture.request(`/loops/${created.id}`);
      if (['succeeded', 'capped', 'failed', 'stalled', 'cancelled'].includes(done.status)) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const diagnostic = JSON.stringify({ status: done.status, reason: done.stopReason,
      tools: db.prepare("SELECT body FROM rows WHERE bot_id=? AND kind='tool-call'").all(fixture.checker.id),
      programs: db.prepare('SELECT result FROM code_runs WHERE bot_id=?').all(fixture.checker.id) });
    assert.equal(done.status, 'succeeded', diagnostic);
    assert.equal(done.stopReason, 'passed');
    assert.equal(done.verdicts.length, 1);
    assert.equal(done.events.filter((event: any) => event.type === 'loop.verdict').length, 1);
    assert.deepEqual(seen.map(entry => entry.name), ['submit_output', 'submit_verdict'], diagnostic);
    for (const entry of seen) {
      assert.equal(entry.result.isError, undefined, JSON.stringify(entry.result));
      assert.deepEqual(entry.replay, entry.result, 'Same job and call id return the recorded result');
      assert.equal(entry.ctx.userId, fixture.userId);
      assert.equal(entry.ctx.botId, fixture.checker.id);
      assert.ok(entry.ctx.jobId);
      assert.ok(entry.ctx.toolCallId);
      const job = db.prepare('SELECT user_id,bot_id,trigger FROM agent_jobs WHERE id=?').get(entry.ctx.jobId) as any;
      assert.equal(job.user_id, fixture.userId);
      assert.equal(job.bot_id, fixture.checker.id);
      if (approvals) assert.equal(JSON.parse(job.trigger).type, 'resume');
    }
    const receipt = db.prepare('SELECT * FROM handoff_tool_receipts WHERE user_id=?').all(fixture.userId) as any[];
    assert.equal(receipt.length, 1);
    assert.equal(receipt[0].call_id, seen[0].ctx.toolCallId);
    assert.equal(receipt[0].job_id, seen[0].ctx.jobId);
    const storedOutput = db.prepare('SELECT revision FROM run_outputs WHERE id=?').get(receipt[0].output_id) as any;
    // One declaration and finalization at most; the replay cannot revise the output.
    assert.ok(storedOutput.revision <= 2);
    if (route.startsWith('program')) {
      const steps = db.prepare('SELECT call_id FROM code_steps WHERE run_id=? ORDER BY step').all(`${prefix}-program`) as any[];
      assert.equal(programContexts.length, 1, 'The program action executes once across resumes');
      assert.deepEqual(programContexts.map(ctx => ctx.toolCallId), steps.map(step => step.call_id));
      assert.ok(programContexts[0].jobId);
      if (approvals) assert.ok(pendingSnapshots.length >= 4, 'Program, file action and both review actions resume separately');
    }
    assert.equal(seen[0].ctx.toolCallId, `${prefix}-output${route === 'legacy-wrapper' ? ':resolved' : ''}`);
    assert.equal(seen[1].ctx.toolCallId, `${prefix}-verdict`);
    if (approvals) assert.equal(pendingSnapshots[0].calls[0].call_id, `${prefix}-${route === 'program-approval' ? 'program' : 'output'}`);
  });
}

test('handoff tools still refuse missing runtime identity and caller-selected identity', async () => {
  const fixture = server.seed();
  const base = { userId: fixture.userId, botId: fixture.checker.id, jobId: 'not-a-job', depth: 0, enqueueBotMessage() {} };
  for (const [name, args] of [['submit_output', output], ['submit_verdict', verdict]] as const) {
    const tool = toolMap.get(name)!;
    for (const ctx of [base, { ...base, jobId: undefined, toolCallId: 'no-run' }]) {
      const result = await tool.impl(args, ctx);
      assert.equal(result.isError, true);
      assert.match(String(result.output), /active run and a stable tool call id/);
    }
    const forged = await tool.impl({ ...args, toolCallId: 'forged', jobId: 'forged' }, base);
    assert.equal(forged.isError, true);
    assert.match(String(forged.output), /Invalid arguments/);
  }
  assert.equal((db.prepare('SELECT count(*) n FROM handoff_tool_receipts WHERE user_id=?').get(fixture.userId) as any).n, 0);
});

test('programs retain their handoff exclusion even when an active run is supplied', async () => {
  const fixture = server.seed();
  const { runProgram } = await import('../../server/src/agent/programs.js');
  const { acceptJob } = await import('../../server/src/agent/jobs.js');
  const job = acceptJob(fixture.checker.id, { type: 'user', text: 'Program boundary fixture.' });
  let dispatched = false;
  for (const name of ['submit_output', 'submit_verdict', 'handoff_to_agent', 'start_loop', 'read_handoff', 'list_handoffs']) {
    await assert.rejects(runProgram({
      userId: fixture.userId, botId: fixture.checker.id, jobId: job.id, callId: `denied-${name}`,
      args: { tools: [name], code: `return tools.call("${name}", {});` },
      catalog: async () => [{ type: 'function', ...toolMap.get(name)! }],
      dispatch: async () => { dispatched = true; return {}; },
    }), /Programs may use only explicitly listed/);
  }
  assert.equal(dispatched, false);
});
