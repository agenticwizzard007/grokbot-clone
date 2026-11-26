import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-decided-runs-'));
Object.assign(process.env, { NODE_ENV: 'test', SWARM_ROLE: 'standalone', DB_PATH: path.join(root, 'db'), FILES_DIR: path.join(root, 'files'), SESSION_SECRET: 'fixture' });
const { db } = await import('../server/src/db.js');
const { createBot } = await import('../server/src/bots.js');
const { acceptJob } = await import('../server/src/agent/jobs.js');
const { withUsage } = await import('../server/src/usage-context.js');
const { withCliDiagnostics, cliDiagnostic } = await import('../server/src/cli/diagnostics.js');
const { recordCliRun, cliRunsByProvider } = await import('../server/src/cli/run-diagnostics.js');
after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

for (const provider of ['codex', 'claude']) for (const decision of ['denied', 'allowed', 'always']) {
  test(`R14 ${provider} ${decision}: decided tool survives incidental work until a later user turn uses tools`, async () => {
    const userId = `${provider}-${decision}`;
    db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(userId, `${userId}@example.test`, 'Fixture', Date.now());
    const bot = createBot(userId, { name: 'Fixture' });
    const params = { provider, nativeTools: [{ name: 'SWARM_APPS_EXECUTE' }, { name: 'read_team_job' }, { name: 'create_task' }] };
    const job = (type: string, extra = {}) => acceptJob(bot.id, { type, ...extra }).id;
    const run = (jobId: string, tool?: string, gate = Promise.resolve()) => withUsage({ botId: bot.id, jobId }, () => withCliDiagnostics(params, 'server', async () => {
      if (tool) cliDiagnostic()?.({ event: 'tool_result', tool, admission: 'returned' });
      await gate;
      return {};
    }, undefined, recordCliRun(userId)));
    const read = () => (cliRunsByProvider(userId) as any)[provider];
    const approvalId = userId;
    db.prepare('INSERT INTO approvals(id,bot_id,row_seq,call_id,tool,status,created_at) VALUES(?,?,1,?,?,?,?)').run(approvalId, bot.id, approvalId, 'SWARM_APPS_EXECUTE', 'pending', Date.now());
    await withUsage({ botId: bot.id, jobId: job('user') }, () => withCliDiagnostics(params, 'server', async () => {
      cliDiagnostic()?.({ event: 'tool_result', tool: 'SWARM_APPS_EXECUTE', admission: 'pending_approval', approvalId });
      return {};
    }, undefined, recordCliRun(userId)));
    const pending = read().lastToolRun;
    const older = job('user');
    db.prepare('UPDATE agent_jobs SET created_at=? WHERE id=?').run(Date.now() - 1000, older);
    let release!: () => void;
    const oldWork = run(older, 'create_task', new Promise<void>(resolve => { release = resolve; }));
    await new Promise(resolve => setImmediate(resolve));
    db.prepare('UPDATE approvals SET status=?,resolved_at=? WHERE id=?').run(decision, Date.now(), approvalId);
    const expected = { ...pending, result: decision === 'denied' ? 'denied' : 'allowed' };
    assert.deepEqual(read().lastToolRun, expected, 'Decision is visible before the reply starts');
    release(); await oldWork;
    assert.deepEqual(read().lastToolRun, expected, 'An earlier user request cannot release the decision');
    await run(job('resume'), 'read_team_job');
    assert.equal(read().latest.trigger, 'approval_decision');
    assert.equal(read().latest.lastTool, 'read_team_job');
    assert.equal(read().latest.result, 'completed');
    assert.deepEqual(read().lastToolRun, expected);
    for (const source of ['system', 'routine', 'bot']) {
      await run(job(source), 'read_team_job');
      assert.deepEqual(read().lastToolRun, expected, source);
    }
    await run(job('user', { audience: 'internal' }), 'read_team_job');
    await run(job('user'));
    assert.deepEqual(read().lastToolRun, expected, 'Internal and text-only user turns preserve the decision');
    const reopened = new Database(process.env.DB_PATH!, { readonly: true });
    assert.equal((reopened.prepare('SELECT a.status FROM cli_approval_runs r JOIN approvals a ON a.id=r.approval_id WHERE r.user_id=?').get(userId) as any).status, decision);
    reopened.close();
    assert.equal((cliRunsByProvider(userId) as any)[provider === 'codex' ? 'claude' : 'codex'].lastToolRun, null);
    await run(job('user'), 'create_task');
    assert.equal(read().lastToolRun.lastTool, 'create_task');
    assert.equal(read().lastToolRun.result, 'completed');
    assert.equal((db.prepare('SELECT count(*) n FROM cli_approval_runs WHERE user_id=?').get(userId) as any).n, 0);
  });
}

test('R14 diagnostic retention keeps one latest decision per provider and all pending cards', async () => {
  const userId = 'bounded-decisions';
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(userId, 'bounded@example.test', 'Fixture', Date.now());
  const bot = createBot(userId, { name: 'Fixture' });
  for (const provider of ['codex', 'claude']) {
    for (let index = 0; index < 3; index++) {
      const approvalId = `${provider}-${index}`;
      db.prepare('INSERT INTO approvals(id,bot_id,row_seq,call_id,tool,status,created_at) VALUES(?,?,1,?,?,?,?)').run(approvalId, bot.id, approvalId, 'SWARM_APPS_EXECUTE', 'pending', Date.now());
      await withUsage({ botId: bot.id }, () => withCliDiagnostics({ provider, nativeTools: [{ name: 'SWARM_APPS_EXECUTE' }] }, 'server', async () => {
        cliDiagnostic()?.({ event: 'tool_result', tool: 'SWARM_APPS_EXECUTE', admission: 'pending_approval', approvalId });
        return {};
      }, undefined, recordCliRun(userId)));
    }
    // Decisions may arrive in a different order from the requesting runs.
    db.prepare("UPDATE approvals SET status='allowed',resolved_at=10 WHERE id=?").run(`${provider}-1`);
    db.prepare("UPDATE approvals SET status='denied',resolved_at=20 WHERE id=?").run(`${provider}-0`);
    const runs = cliRunsByProvider(userId) as any;
    assert.equal(runs[provider].lastToolRun.result, 'pending_approval');
    assert.equal((db.prepare('SELECT count(*) n FROM cli_approval_runs WHERE user_id=? AND provider=?').get(userId, provider) as any).n, 2);
    db.prepare("UPDATE approvals SET status='expired' WHERE id=?").run(`${provider}-2`);
    assert.equal((cliRunsByProvider(userId) as any)[provider].lastToolRun.result, 'denied');
  }
  db.prepare('DELETE FROM users WHERE id=?').run(userId);
  assert.equal((db.prepare('SELECT count(*) n FROM cli_approval_runs WHERE user_id=?').get(userId) as any).n, 0);
});
