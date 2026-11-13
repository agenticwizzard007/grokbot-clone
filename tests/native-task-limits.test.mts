import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { after, mock, test } from 'node:test';

const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-task-limits-'));
Object.assign(process.env, {
  SWARM_ROLE: 'standalone', SWARM_NO_SCHEDULER: '1', NODE_ENV: 'test',
  DB_PATH: path.join(storage, 'test.db'), FILES_DIR: path.join(storage, 'files'),
  SESSION_SECRET: 'task-limits-test', COMPUTER_PROVIDER: 'local',
  DIRECT_API_KEY: 'fixture', DIRECT_BASE_URL: 'http://127.0.0.1:9/v1',
  LLM_PROVIDER: 'direct', COMPOSIO_API_KEY: '', ADMIN_EMAILS: '', INKBOX_TUNNEL: '0',
});
mock.method(globalThis, 'fetch', async () => { throw new Error('No network in task-limit tests'); });
const { db } = await import('../server/src/db.js');
(await import('../server/src/agent/subagents.js')).initSubagents();
(await import('../server/src/agent/rooms.js')).initRooms();
const { createBot } = await import('../server/src/bots.js');
const { enqueue, settleAgentJobs, interrupt } = await import('../server/src/agent/loop.js');
const { acceptJob, beginJob } = await import('../server/src/agent/jobs.js');
const { createGoal, getGoal, reserveGoalTurn, settleGoalTurn, controlGoal, observedTurnUsage, usageCursor } = await import('../server/src/agent/goals.js');
const { workflowPreTurn, checkWorkflowBudget } = await import('../server/src/agent/workflows.js');
const { llmClient } = await import('../server/src/lib/llm.js');
const { withUsage, recordModelUsage } = await import('../server/src/usage.js');
const { closeMcpSessions } = await import('../server/src/mcp/client.js');

let generation: (body: any) => any[] = () => { throw new Error('Unexpected model generation'); };
const client = withUsage({ userId: 'fixture' }, () => llmClient(360000));
mock.method(client.responses, 'create', async (body: any) => {
  const output = generation(body);
  return (async function* () {
    for (const item of output) {
      yield { type: 'response.output_item.added', item };
      yield { type: 'response.output_item.done', item };
    }
    yield { type: 'response.completed', response: { output, usage: { input_tokens: 1, output_tokens: 1, cost: 0 } } };
  })();
});
after(async () => {
  await settleAgentJobs();
  await closeMcpSessions();
  mock.restoreAll();
  db.close();
  fs.rmSync(storage, { recursive: true, force: true });
});

type Boundary = 'tokens' | 'spend' | 'goal-pause' | 'user-stop';
for (const boundary of ['tokens', 'spend', 'goal-pause', 'user-stop'] as Boundary[]) {
  test(`late validation boundary fences ${boundary} before any business dispatch`, async () => {
    const userId = 'task-limit-' + boundary;
    db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)')
      .run(userId, userId + '@example.test', 'Original fixture name', Date.now());
    const bot = createBot(userId, { name: 'Quinn', isPrimary: true });
    const sibling = createBot(userId, { name: 'Worker' });
    const goal = createGoal(userId, bot.id, {
      title: 'Explicitly bounded fixture', criteria: [{ kind: 'row', description: 'Verified evidence' }],
      ...(boundary === 'tokens' ? { maxTokens: 100 } : {}),
      ...(boundary === 'spend' ? { maxSpendUsd: 0.5 } : {}),
    });
    assert.equal(goal.maxTurns, 0, 'The default turn count remains unlimited');
    // A real owned sibling job reserves the same goal before its usage arrives.
    // No model or external action is launched for this synthetic sibling.
    const child = acceptJob(sibling.id, { type: 'system', text: 'Sibling goal work' });
    beginJob(child.id);
    assert.equal(reserveGoalTurn(userId, goal.id, sibling.id, child.id).allowed, true);
    let injected = false, generations = 0, parentJobId = '';
    const originalEmit = Worker.prototype.emit;
    const validationHook = mock.method(Worker.prototype, 'emit', function(this: Worker, event: string, ...args: any[]) {
      if (event === 'message' && args[0]?.ok === true && !injected) {
        injected = true;
        // This is the real schema worker's success response, after the early
        // gate but before the awaited validation/permission path resumes.
        if (boundary === 'tokens' || boundary === 'spend') {
          db.prepare(`INSERT INTO usage_events(user_id,bot_id,job_id,kind,provider,model,input_tokens,output_tokens,
            token_fields,usage_status,cost_usd,cost_source,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(userId, sibling.id, child.id, 'chat', 'direct', 'fixture', boundary === 'tokens' ? 100 : 1, 1,
              '["input_tokens","output_tokens"]', 'complete', boundary === 'spend' ? 0.6 : 0, 'provider', Date.now());
        } else if (boundary === 'goal-pause') controlGoal(userId, goal.id, 'pause', 'User paused during validation');
        else interrupt(bot.id, parentJobId);
      }
      return originalEmit.call(this, event, ...args);
    });
    generation = () => {
      assert.equal(++generations, 1, 'An exhausted or cancelled task must not issue another model generation');
      return [{ type: 'function_call', call_id: 'stale-' + boundary, name: 'update_profile', arguments: JSON.stringify({ name: 'STALE ACTION ' + boundary }) }];
    };
    try {
      parentJobId = enqueue(bot.id, { type: 'user', text: 'Complete the authorized fixture within its budget.' });
      await settleAgentJobs();
      assert.ok(injected, 'The boundary change must occur inside real async schema validation');
      assert.equal(generations, 1);
      assert.equal((db.prepare('SELECT name FROM users WHERE id=?').get(userId) as any).name, 'Original fixture name', 'The rejected stale action must have no business effect');
      assert.equal((db.prepare('SELECT COUNT(*) n FROM tool_dispatches WHERE bot_id=?').get(bot.id) as any).n, 0, 'The rejected action must never reach beginTool');
      assert.equal((db.prepare('SELECT COUNT(*) n FROM approvals WHERE bot_id=?').get(bot.id) as any).n, 0);
      const receipt = db.prepare('SELECT payload FROM native_job_completions WHERE job_id=?').get(parentJobId) as any;
      const outcome = receipt && JSON.parse(receipt.payload).completion;
      assert.ok(outcome && ['interrupted', 'failed'].includes(outcome.status), 'Cancellation/budget exhaustion must not become a completed business outcome');
      if (boundary !== 'user-stop') assert.equal(getGoal(userId, goal.id).status, 'paused');
      if (boundary === 'tokens') assert.match(getGoal(userId, goal.id).reason, /Token budget exhausted/);
      if (boundary === 'spend') assert.match(getGoal(userId, goal.id).reason, /Spend budget exhausted/);
      if (boundary === 'goal-pause') assert.match(getGoal(userId, goal.id).reason, /User paused during validation/);
    } finally { validationHook.mock.restore(); }
  });
}

for (const capped of [true, false]) {
  test(`partial checkpoint usage retains observed values and ${capped ? 'pauses an explicit token cap' : 'permits uncapped continuation'}`, async () => {
    const userId = 'task-limit-partial-' + capped;
    db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)')
      .run(userId, userId + '@example.test', 'Partial usage fixture', Date.now());
    const bot = createBot(userId, { name: 'Quinn', isPrimary: true });
    const goal = createGoal(userId, bot.id, {
      title: 'Checkpoint accounting', criteria: [{ kind: 'row', description: 'Verified evidence' }],
      ...(capped ? { maxTokens: 100 } : {}),
    });
    const job = acceptJob(bot.id, { type: 'user', text: 'Complete the fixture' });
    beginJob(job.id);
    const context = { userId, botId: bot.id, jobId: job.id };
    assert.equal(workflowPreTurn(context).allowed, true);
    const cursor = usageCursor();
    // This is the production adapter shape for an intentionally stopped CLI
    // generation: both fields were observed, but they are a partial lower bound.
    await recordModelUsage({ ...context, kind: 'chat', model: 'claude/default', response: {
      billing: 'subscription', provider: 'claude-cli', usage_status: 'partial',
      usage: { input_tokens: 91, output_tokens: 7 },
    } });
    const row = db.prepare('SELECT * FROM usage_events WHERE job_id=?').get(job.id) as any;
    assert.equal(row.usage_status, 'partial');
    assert.equal(row.input_tokens, 91);
    assert.equal(row.output_tokens, 7);
    assert.deepEqual(JSON.parse(row.token_fields), ['input_tokens', 'output_tokens']);
    assert.equal(row.cost_usd, 0);
    assert.equal(row.cost_source, 'subscription');
    const measured = observedTurnUsage(userId, bot.id, cursor, job.id);
    assert.equal(measured.tokens, null, 'A partial lower bound cannot become exact finite-budget consumption');
    assert.equal(measured.costUsd, 0, 'Subscription cost attribution is preserved independently');
    const budget = checkWorkflowBudget(context);
    if (capped) {
      assert.equal(budget.allowed, false);
      assert.match(budget.reason!, /Token accounting unavailable/);
      assert.equal(getGoal(userId, goal.id).status, 'paused');
      assert.notEqual(budget.remainingTokens, 2, 'Do not advertise the remainder of a truncated generation as spendable tokens');
    } else {
      assert.equal(budget.allowed, true);
      assert.equal(budget.remainingTokens, undefined);
      settleGoalTurn(userId, job.id);
      const settled = getGoal(userId, goal.id);
      assert.equal(settled.status, 'active');
      assert.equal(settled.unknownTokenTurns, 1);
      const next = acceptJob(bot.id, { type: 'system', text: 'Continue uncapped work', parentJobId: job.id });
      beginJob(next.id);
      assert.equal(reserveGoalTurn(userId, goal.id, bot.id, next.id).allowed, true, 'Partial usage must not introduce an implicit cap');
    }
  });
}
