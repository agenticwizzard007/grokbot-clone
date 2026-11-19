import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-program-aggregate-'));
Object.assign(process.env, {
  SWARM_ROLE: 'standalone', SWARM_NO_SCHEDULER: '1', NODE_ENV: 'test',
  DB_PATH: path.join(storage, 'test.db'), FILES_DIR: path.join(storage, 'files'),
  SESSION_SECRET: 'program-aggregate-test', COMPUTER_PROVIDER: 'local',
});
const { db } = await import('../server/src/db.js');
const { createBot } = await import('../server/src/bots.js');
const { runProgram, recoverPrograms } = await import('../server/src/agent/programs.js');
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)')
  .run('aggregate-owner', 'aggregate@example.test', 'Aggregate owner', Date.now());
const bot = createBot('aggregate-owner', { name: 'Analyst', isPrimary: true });
const catalog = async () => ['mcp_read', 'mcp_write'].map(name => ({
  type: 'function', name,
  parameters: { type: 'object', properties: { payload: { type: 'string' } }, required: ['payload'], additionalProperties: false },
}));
const base = { userId: 'aggregate-owner', botId: bot.id, catalog };
after(() => { db.close(); fs.rmSync(storage, { recursive: true, force: true }); });
const aggregateFailure = (result: Awaited<ReturnType<typeof runProgram>>) => {
  assert.equal(result.status, 'failed', result.error);
  assert.match(result.error!, /Aggregate program input\/output limit exceeded/);
};

test('individually valid outputs share one budget and no later action runs after overflow', async () => {
  const output = 'x'.repeat(700000);
  assert.ok(Buffer.byteLength(JSON.stringify(output)) < 1000000);
  let calls = 0;
  const dispatch = async () => { calls++; return { output }; };
  const under = await runProgram({ ...base, dispatch, callId: 'under-aggregate', args: {
    tools: ['mcp_read'], code: 'for(let i=0;i<5;i++) tools.call("mcp_read",{payload:""}); return "within budget";',
  } });
  assert.equal(under.status, 'completed', under.error);
  assert.equal(under.result, 'within budget');
  assert.equal(calls, 5);
  calls = 0;
  const over = await runProgram({ ...base, dispatch, callId: 'over-aggregate-output', args: {
    tools: ['mcp_read'], code: 'for(let i=0;i<7;i++) tools.call("mcp_read",{payload:""}); return "must not finish";',
  } });
  aggregateFailure(over);
  assert.equal(calls, 6, 'The seventh action must never dispatch after the sixth result exhausts the shared budget');
  await runProgram({ ...base, dispatch, callId: 'over-aggregate-output', args: {
    tools: ['mcp_read'], code: 'for(let i=0;i<7;i++) tools.call("mcp_read",{payload:""}); return "must not finish";',
  } });
  assert.equal(calls, 6, 'A failed run must not replay business actions');
});

test('initial inputs, tool arguments and tool results all consume the same 4 MB budget', async () => {
  let calls = 0;
  const result = await runProgram({ ...base, callId: 'aggregate-all-directions', args: {
    inputs: { seed: 's'.repeat(900000) }, tools: ['mcp_read'],
    code: 'for(let i=0;i<6;i++) tools.call("mcp_read",{payload:"a".repeat(600000)}); return true;',
  }, dispatch: async () => { calls++; return { output: 'r'.repeat(100000) }; } });
  aggregateFailure(result);
  assert.equal(calls, 4, 'The fifth arguments exceed the shared budget before dispatch');
  assert.equal((db.prepare('SELECT COUNT(*) n FROM code_steps WHERE run_id=?').get('aggregate-all-directions') as any).n, 4);
});

test('aggregate accounting measures UTF-8 bytes rather than JavaScript string length', async () => {
  let calls = 0;
  const result = await runProgram({ ...base, callId: 'aggregate-utf8', args: {
    tools: ['mcp_write'], code: 'for(let i=0;i<6;i++) tools.call("mcp_write",{payload:"€".repeat(300000)}); return true;',
  }, dispatch: async () => { calls++; return { output: '{}' }; } });
  aggregateFailure(result);
  assert.equal(calls, 4, 'Each legal 300k-character argument consumes approximately 900k bytes');
});

test('approval replay charges recorded results again without repeating reads or resetting the budget', async () => {
  let reads = 0, writes = 0, approved = false;
  const args = {
    inputs: { seed: 's'.repeat(900000) }, tools: ['mcp_read', 'mcp_write'],
    code: 'for(let i=0;i<4;i++) tools.call("mcp_read",{payload:""}); tools.call("mcp_write",{payload:"approved"}); return tools.call("mcp_write",{payload:"must not execute"});',
  };
  const dispatch = async (action: any) => {
    if (action.name === 'mcp_read') { reads++; return { output: 'r'.repeat(700000) }; }
    if (!approved) return { paused: true, approvalId: 'aggregate-approval' };
    assert.equal(action.approvalId, 'aggregate-approval');
    assert.equal(action.args.payload, 'approved');
    writes++;
    return { output: 'w'.repeat(700000) };
  };
  const first = await runProgram({ ...base, callId: 'aggregate-resume', args, dispatch });
  assert.equal(first.status, 'waiting', first.error);
  assert.equal(reads, 4);
  assert.equal(writes, 0);
  recoverPrograms();
  approved = true;
  const resumed = await runProgram({ ...base, callId: 'aggregate-resume', args, dispatch });
  aggregateFailure(resumed);
  assert.equal(reads, 4, 'Recorded reads must be counted but not dispatched again');
  assert.equal(writes, 1, 'The result of the approved write exhausts the aggregate budget before the next write');
  assert.equal((db.prepare('SELECT COUNT(*) n FROM code_steps WHERE run_id=?').get('aggregate-resume') as any).n, 5);
});
