import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Hono } from 'hono';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-runs-'));
Object.assign(process.env, { NODE_ENV: 'test', SWARM_ROLE: 'standalone', DB_PATH: path.join(root, 'db'), FILES_DIR: path.join(root, 'files'), SESSION_SECRET: 'fixture', SWARM_CLI_SERVER_LOGIN: '0' });
const { db } = await import('../server/src/db.js');
const { createBot } = await import('../server/src/bots.js');
const { acceptJob } = await import('../server/src/agent/jobs.js');
const { withUsage } = await import('../server/src/usage-context.js');
const { withApiRunDiagnostics, apiRunDiagnostic } = await import('../server/src/agent/run-diagnostics.js');
const { apiRuns, lastCliRun } = await import('../server/src/cli/run-diagnostics.js');
const { cliApi } = await import('../server/src/cli/routes.js');
const app = new Hono().route('/cli', cliApi);
after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

for (const provider of ['direct', 'openrouter']) test(`R16 WW ${provider} diagnostics retain decisions, bound records and isolate accounts without content`, async () => {
  const userId = provider;
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(userId, `${userId}@example.test`, 'Fixture', Date.now());
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(session_hash(?),?,?,?)').run(userId, userId, Date.now(), Date.now() + 3600000);
  const bot = createBot(userId, { name: 'Fixture' });
  const run = (type: string, work: () => Promise<void>) => withUsage({ userId, botId: bot.id, jobId: acceptJob(bot.id, { type }).id },
    () => withApiRunDiagnostics(userId, provider, new AbortController().signal, work));
  const tool = async (name = 'save_file') => apiRunDiagnostic({ event: 'tool_result', tool: name, admission: 'returned', manifestCount: 4 });
  const approve = async (id: string) => {
    db.prepare('INSERT INTO approvals(id,bot_id,row_seq,call_id,tool,status,created_at) VALUES(?,?,1,?,?,?,?)').run(id, bot.id, id, 'save_file', 'pending', Date.now());
    await run('user', async () => { apiRunDiagnostic({ event: 'tool_result', tool: 'save_file', admission: 'pending_approval', approvalId: id, manifestCount: 4 }); });
  };
  assert.deepEqual(apiRuns(userId), { latest: null, lastToolRun: null });
  await run('user', async () => { await tool('tool_search'); await tool('tool_describe'); });
  assert.equal(apiRuns(userId).latest?.result, 'no_tool_call');
  assert.equal(apiRuns(userId).lastToolRun, null, 'Catalog discovery is not a customer action');
  for (const decision of ['denied', 'allowed']) {
    const id = `${provider}-${decision}`;
    await approve(id);
    const pending = apiRuns(userId).lastToolRun;
    await run('system', () => tool('recall'));
    assert.deepEqual(apiRuns(userId).latest, pending, 'Background runs do not hide a pending card');
    db.prepare('UPDATE approvals SET status=?,resolved_at=? WHERE id=?').run(decision, Date.now(), id);
    assert.equal(apiRuns(userId).lastToolRun?.result, decision, 'Decision is visible before continuation');
    await run('resume', () => tool('recall'));
    assert.equal(apiRuns(userId).latest?.trigger, 'approval_decision');
    assert.equal(apiRuns(userId).lastToolRun?.result, decision, 'Reply keeps the decided tool');
    await run('user', async () => {});
    assert.equal(apiRuns(userId).lastToolRun?.result, decision, 'Text-only turns keep the decided tool');
    const reopened = new Database(process.env.DB_PATH!, { readonly: true });
    assert.equal((reopened.prepare('SELECT status FROM approvals WHERE id=?').get(id) as any).status, decision);
    reopened.close();
  }
  assert.equal((db.prepare('SELECT count(*) n FROM cli_approval_runs WHERE user_id=?').get(userId) as any).n, 1);
  await run('user', () => tool());
  assert.equal(apiRuns(userId).lastToolRun?.result, 'completed');
  assert.equal((db.prepare('SELECT count(*) n FROM cli_approval_runs WHERE user_id=?').get(userId) as any).n, 0);
  await approve(`${provider}-expire`);
  db.prepare("UPDATE approvals SET status='expired' WHERE id=?").run(`${provider}-expire`);
  assert.equal(apiRuns(userId).latest?.result, 'cancelled');
  assert.equal(apiRuns(userId).lastToolRun?.result, 'cancelled');
  await assert.rejects(run('user', async () => { throw Error('timeout private-content-sentinel'); }));
  assert.equal(apiRuns(userId).latest?.errorCode, 'timeout');
  assert.equal(lastCliRun(userId), null);
  assert.deepEqual(apiRuns('unrelated-account'), { latest: null, lastToolRun: null });
  assert.equal((await app.request('/cli')).status, 401);
  const response = await app.request('/cli', { headers: { cookie: `swarm_session=${userId}` } });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const status = await response.json() as any;
  assert.deepEqual(status.apiRuns, apiRuns(userId));
  assert.doesNotMatch(JSON.stringify(status.apiRuns), /sentinel|arguments|message|key|generation|botId/);
  db.prepare('DELETE FROM users WHERE id=?').run(userId);
  assert.deepEqual(apiRuns(userId), { latest: null, lastToolRun: null });
});

test('R16 WW decisions update both API panels before a continuation starts', async () => {
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run('decision', 'decision@example.test', 'Fixture', Date.now());
  const bot = createBot('decision', { name: 'Fixture' });
  for (const status of ['denied', 'allowed']) {
    db.prepare('INSERT INTO approvals(id,bot_id,row_seq,call_id,tool,status,created_at) VALUES(?,?,1,?,?,?,?)').run(status, bot.id, status, 'save_file', 'pending', Date.now());
    await withUsage({ userId: 'decision', botId: bot.id }, () => withApiRunDiagnostics('decision', 'direct', new AbortController().signal, async () => {
      apiRunDiagnostic({ event: 'tool_result', tool: 'save_file', admission: 'pending_approval', approvalId: status });
    }));
    db.prepare('UPDATE approvals SET status=?,resolved_at=? WHERE id=?').run(status, Date.now(), status);
    assert.equal(apiRuns('decision').latest?.result, status);
    assert.equal(apiRuns('decision').lastToolRun?.result, status);
  }
});
