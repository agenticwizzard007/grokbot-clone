import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-pending-runs-'));
Object.assign(process.env, { NODE_ENV: 'test', SWARM_ROLE: 'standalone', DB_PATH: path.join(root, 'db'), FILES_DIR: path.join(root, 'files'), SESSION_SECRET: 'fixture' });
const { db } = await import('../server/src/db.js');
const { createBot } = await import('../server/src/bots.js');
const { acceptJob } = await import('../server/src/agent/jobs.js');
const { withUsage } = await import('../server/src/usage-context.js');
const { withCliDiagnostics, cliDiagnostic } = await import('../server/src/cli/diagnostics.js');
const { recordCliRun, lastCliRun, cliRunsByProvider } = await import('../server/src/cli/run-diagnostics.js');
after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

for (const provider of ['codex', 'claude']) test(`R13 ${provider} pins unresolved approvals across generations, accounts, expiry and deletion`, async () => {
  const userId = provider;
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(userId, `${provider}@example.test`, 'Fixture', Date.now());
  const bot = createBot(userId, { name: 'Fixture' });
  const params = { provider, nativeTools: [{ name: 'tool_call' }, { name: 'read_team_job' }] };
  const run = (work: () => Promise<unknown>) => withUsage({ botId: bot.id, jobId: acceptJob(bot.id, { type: 'user' }).id }, () => withCliDiagnostics(params, 'server', work, undefined, recordCliRun(userId)));
  const approve = async (id: string, gate = Promise.resolve()) => {
    db.prepare('INSERT INTO approvals(id,bot_id,row_seq,call_id,tool,status,created_at) VALUES(?,?,1,?,?,?,?)').run(id, bot.id, id, 'SWARM_APPS_EXECUTE', 'pending', Date.now());
    return run(async () => {
      cliDiagnostic()?.({ event: 'tool_result', tool: 'tool_call', resolvedTool: 'SWARM_APPS_EXECUTE', admission: 'pending_approval', approvalId: id });
      await gate;
      return {};
    });
  };
  const internal = (fail = false) => run(async () => {
    cliDiagnostic()?.({ event: 'tool_result', tool: 'read_team_job', admission: 'returned' });
    if (fail) throw new Error('Provider timeout');
    return {};
  });
  let release!: () => void;
  const firstId = `${provider}-first`, secondId = `${provider}-second`;
  const waiting = approve(firstId, new Promise<void>(resolve => { release = resolve; }));
  try {
    await new Promise(resolve => setImmediate(resolve));
    const first = (cliRunsByProvider(userId) as any)[provider].latest;
    assert.equal(first.result, 'pending_approval', 'Visible before the CLI has finished');
    await internal();
    await assert.rejects(internal(true), /timeout/);
    assert.deepEqual(lastCliRun(userId), first);
    assert.deepEqual((cliRunsByProvider(userId) as any)[provider].lastToolRun, first);
    const otherProvider = provider === 'codex' ? 'claude' : 'codex';
    await withCliDiagnostics({ ...params, provider: otherProvider }, 'server', async () => ({}), undefined, recordCliRun(userId));
    assert.equal((cliRunsByProvider(userId) as any)[otherProvider].latest.result, 'no_tool_call');
    assert.deepEqual((cliRunsByProvider(userId) as any)[provider].latest, first);
    assert.deepEqual(lastCliRun(userId), first);
    const reopened = new Database(process.env.DB_PATH!, { readonly: true });
    assert.equal((reopened.prepare('SELECT approval_id FROM cli_approval_runs WHERE user_id=?').get(userId) as any).approval_id, firstId);
    reopened.close();
    assert.equal((db.prepare("SELECT last_tool FROM cli_provider_runs WHERE user_id=? AND provider=? AND slot='tools'").get(userId, provider) as any).last_tool, 'SWARM_APPS_EXECUTE');
    await approve(secondId);
    const second = (cliRunsByProvider(userId) as any)[provider].latest;
    assert.ok(second.startedAt > first.startedAt);
    await internal();
    db.prepare("UPDATE approvals SET status='denied',resolved_at=? WHERE id=?").run(Date.now(), secondId);
    assert.deepEqual((cliRunsByProvider(userId) as any)[provider].latest, first, 'Another pending card keeps its own requesting run');
    db.prepare("UPDATE approvals SET status='expired' WHERE id=?").run(firstId);
    assert.equal((lastCliRun(userId) as any).result, 'completed');
    await internal();
    assert.equal((cliRunsByProvider(userId) as any)[provider].lastToolRun.lastTool, 'read_team_job');
  } finally { release(); await waiting; }
  await approve(`${provider}-delete`);
  db.prepare('DELETE FROM users WHERE id=?').run(userId);
  assert.equal(lastCliRun(userId), null);
  assert.equal((db.prepare('SELECT count(*) n FROM cli_approval_runs WHERE user_id=?').get(userId) as any).n, 0);
});

test('R13 pending run links cannot cross an account or Bot boundary', async () => {
  for (const id of ['owner', 'other']) db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(id, `${id}@example.test`, 'Fixture', Date.now());
  const owner = createBot('owner', { name: 'Owner fixture' });
  const foreign = createBot('other', { name: 'Other fixture' });
  const sibling = createBot('owner', { name: 'Sibling fixture' });
  for (const bot of [foreign, sibling]) {
    db.prepare('INSERT INTO approvals(id,bot_id,row_seq,call_id,tool,status,created_at) VALUES(?,?,1,?,?,?,?)').run(bot.id, bot.id, bot.id, 'SWARM_APPS_EXECUTE', 'pending', Date.now());
    await withUsage({ botId: owner.id }, () => withCliDiagnostics({ provider: 'codex', nativeTools: [{ name: 'SWARM_APPS_EXECUTE' }] }, 'server', async () => {
      cliDiagnostic()?.({ event: 'tool_result', tool: 'SWARM_APPS_EXECUTE', admission: 'pending_approval', approvalId: bot.id });
      return {};
    }, undefined, recordCliRun('owner')));
  }
  assert.equal((db.prepare('SELECT count(*) n FROM cli_approval_runs').get() as any).n, 0);
  assert.equal(lastCliRun('other'), null);
});
