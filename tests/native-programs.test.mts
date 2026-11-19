import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-native-programs-'));
Object.assign(process.env, { SWARM_ROLE: 'standalone', DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'), SESSION_SECRET: 'program-test', COMPUTER_PROVIDER: 'local' });
const { db } = await import('../server/src/db.js');
const { createBot } = await import('../server/src/bots.js');
const { runProgram, recoverPrograms } = await import('../server/src/agent/programs.js');
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('owner', 'owner@test.invalid', 'Owner', Date.now());
const bot = createBot('owner', { name: 'Analyst', isPrimary: true });
const schema = (name: string) => ({ type: 'function', name, parameters: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false } });
const catalog = async () => [schema('mcp_read'), schema('mcp_write')];
const base = { userId: 'owner', botId: bot.id, catalog, dispatch: async () => ({ output: '{}' }) };
after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('bulk data is processed in the guest without Node, network, filesystem or imports', async () => {
  const result = await runProgram({ ...base, callId: 'pure', args: { inputs: { rows: [{ amount: 3 }, { amount: 5 }] }, code: 'print("two rows"); return {total: inputs.rows.reduce((n,r)=>n+r.amount,0), process:typeof process, require:typeof require, fetch:typeof fetch};' } });
  assert.equal(result.status, 'completed', result.error);
  assert.deepEqual(result.result, { total: 8, process: 'undefined', require: 'undefined', fetch: 'undefined' });
  assert.match(result.stdout!, /two rows/);
});

test('an empty program allowlist denies calls, and validation happens before dispatch', async () => {
  let calls = 0;
  const dispatch = async () => { calls++; return { output: '{}' }; };
  const denied = await runProgram({ ...base, dispatch, callId: 'empty', args: { code: 'return tools.call("mcp_read",{value:1});' } });
  assert.equal(denied.status, 'failed'); assert.equal(calls, 0);
  const invalid = await runProgram({ ...base, dispatch, callId: 'invalid', args: { tools: ['mcp_read'], code: 'return tools.call("mcp_read",{value:"invalid"});' } });
  assert.equal(invalid.status, 'failed'); assert.equal(calls, 0);
});

test('approval resume replays the recorded read and performs the approved write once', async () => {
  let reads = 0, writes = 0, approved = false;
  const args = { tools: ['mcp_read', 'mcp_write'], code: 'const a=tools.call("mcp_read",{value:2}); return tools.call("mcp_write",{value:a.value+1});' };
  const dispatch = async (call: any) => {
    if (call.name === 'mcp_read') { reads++; return { output: JSON.stringify({ value: 10 }) }; }
    if (!approved) return { paused: true, approvalId: 'approval-1' };
    assert.equal(call.approvalId, 'approval-1'); assert.deepEqual(call.args, { value: 11 });
    writes++; return { output: '{"saved":true}' };
  };
  const first = await runProgram({ ...base, callId: 'paused', args, dispatch });
  assert.equal(first.status, 'waiting'); assert.equal(reads, 1); assert.equal(writes, 0);
  recoverPrograms(); approved = true;
  const second = await runProgram({ ...base, callId: 'paused', args, dispatch });
  assert.equal(second.status, 'completed', second.error); assert.deepEqual(second.result, { saved: true });
  assert.equal(reads, 1); assert.equal(writes, 1);
  await runProgram({ ...base, callId: 'paused', args, dispatch });
  assert.equal(writes, 1, 'same completed run returns its receipt');
});

test('revocation is rechecked on resume and changed program content is refused', async () => {
  const args = { tools: ['mcp_write'], code: 'return tools.call("mcp_write",{value:1});' };
  await runProgram({ ...base, callId: 'revoked', args, dispatch: async () => ({ paused: true, approvalId: 'approval-2' }) });
  await assert.rejects(() => runProgram({ ...base, callId: 'revoked', args: { ...args, code: 'return 9' } }), /changed/);
  const result = await runProgram({ ...base, callId: 'revoked', args, catalog: async () => [], dispatch: async () => { throw new Error('must not dispatch'); } });
  assert.equal(result.status, 'failed'); assert.match(result.error!, /no longer available/);
});

test('a lost action outcome is never replayed', async () => {
  let calls = 0;
  const args = { tools: ['mcp_write'], code: 'return tools.call("mcp_write",{value:1});' };
  const first = await runProgram({ ...base, callId: 'uncertain', args, dispatch: async () => { calls++; throw new Error('connection lost after send'); } });
  assert.equal(first.status, 'failed');
  const second = await runProgram({ ...base, callId: 'uncertain', args, dispatch: async () => { calls++; return {}; } });
  assert.notEqual(second.status, 'completed'); assert.equal(calls, 1);
});

test('infinite loops and excessive output are bounded', async () => {
  const started = Date.now();
  const loop = await runProgram({ ...base, callId: 'infinite', args: { code: 'while(true){}', timeout_ms: 1000 } });
  assert.equal(loop.status, 'failed'); assert.ok(Date.now() - started < 7000);
  const huge = await runProgram({ ...base, callId: 'huge', args: { code: 'print("x".repeat(40000));' } });
  assert.equal(huge.status, 'failed');
});

test('cancellation stops the worker and fences future calls', async () => {
  const controller = new AbortController();
  const pending = runProgram({ ...base, callId: 'cancelled', signal: controller.signal, args: { code: 'while(true){}', timeout_ms: 10000 } });
  setTimeout(() => controller.abort(), 100);
  const result = await pending;
  assert.equal(result.status, 'cancelled');
});

test('a delayed catalog cannot dispatch a new action after the program deadline', async () => {
  let dispatched = 0;
  const result = await runProgram({ ...base, callId: 'late-catalog', args: { tools: ['mcp_write'], code: 'return tools.call("mcp_write",{value:1});', timeout_ms: 1000 },
    catalog: async () => { await new Promise(r => setTimeout(r, 1200)); return catalog(); },
    dispatch: async () => { dispatched++; return {}; } });
  assert.equal(result.status, 'failed'); assert.equal(dispatched, 0);
});

test('deadline fences a dispatcher waiting for permission metadata before its external action', async () => {
  let writes = 0;
  const result = await runProgram({ ...base, callId: 'late-policy', args: { tools: ['mcp_write'], code: 'return tools.call("mcp_write",{value:1});', timeout_ms: 1000 },
    dispatch: async action => { await new Promise(r => setTimeout(r, 1200)); action.signal.throwIfAborted(); writes++; return {}; } });
  assert.equal(result.status, 'failed'); assert.equal(writes, 0);
});
