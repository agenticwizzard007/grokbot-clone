import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Hono } from 'hono';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-account-diagnostics-'));
Object.assign(process.env, { NODE_ENV: 'test', SWARM_ROLE: 'standalone', DB_PATH: path.join(root, 'db'), FILES_DIR: path.join(root, 'files'), SESSION_SECRET: 'fixture', SWARM_CLI_SERVER_LOGIN: '0' });
const { db } = await import('../server/src/db.js');
const { cliApi } = await import('../server/src/cli/routes.js');
const { withCliDiagnostics, cliDiagnostic } = await import('../server/src/cli/diagnostics.js');
const { recordCliRun, lastCliRun } = await import('../server/src/cli/run-diagnostics.js');
const app = new Hono().route('/cli', cliApi);
for (const id of ['owner', 'other']) {
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(id, `${id}@example.test`, 'Fixture', Date.now());
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(session_hash(?),?,?,?)').run(id, id, Date.now(), Date.now() + 3600000);
}
after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
const params = { provider: 'codex', prompt: 'private-message-sentinel', nativeTools: [{ name: 'SWARM_APPS_EXECUTE' }] };
const request = (id?: string, query = '') => app.request(`/cli${query}`, { headers: id ? { cookie: `swarm_session=${id}` } : {} });

test('last CLI run is persisted, account scoped, authenticated and contains no content or secrets', async () => {
  assert.equal((await request()).status, 401);
  await withCliDiagnostics(params, 'server', async () => {
    cliDiagnostic()?.({ event: 'tool', tool: 'SWARM_APPS_EXECUTE', admission: 'admitted' });
    cliDiagnostic()?.({ event: 'tool_result', tool: 'SWARM_APPS_EXECUTE', admission: 'pending_approval' });
    return {};
  }, undefined, recordCliRun('owner'));
  const response = await request('owner');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const { lastRun } = await response.json() as any;
  assert.equal(lastRun.result, 'pending_approval'); assert.equal(lastRun.toolsOffered, 1);
  assert.equal(lastRun.lastTool, 'SWARM_APPS_EXECUTE'); assert.equal(lastRun.errorCode, null);
  assert.deepEqual(Object.keys(lastRun).sort(), ['errorCode', 'lastTool', 'provider', 'result', 'runtime', 'startedAt', 'toolsOffered']);
  assert.doesNotMatch(JSON.stringify(lastRun), /sentinel|owner|generation/);
  assert.equal(((await (await request('other')).json()) as any).lastRun, null);
  assert.equal((await request('other', '?expectedUserId=owner')).status, 409);
  assert.equal(((await (await request('other', '?userId=owner')).json()) as any).lastRun, null);
  const reopened = new Database(process.env.DB_PATH!, { readonly: true });
  assert.equal((reopened.prepare('SELECT result FROM cli_last_runs WHERE user_id=?').get('owner') as any).result, 'pending_approval');
  reopened.close();
});

test('last CLI run sanitizes failures and distinguishes no call, denial and CLI rejection', async () => {
  for (const [message, code, result] of [
    ['Provider timeout private-secret-sentinel', 'timeout', 'error'],
    ['The user declined private-secret-sentinel', 'policy_denied', 'denied'],
    ['code-mode host is disabled private-secret-sentinel', 'cli_tool_host_disabled', 'rejected_by_cli'],
  ]) {
    await assert.rejects(withCliDiagnostics(params, 'server', async () => { throw new Error(message); }, undefined, recordCliRun('owner')));
    const run = lastCliRun('owner') as any;
    assert.equal(run.errorCode, code); assert.equal(run.result, result);
    assert.doesNotMatch(JSON.stringify(run), /sentinel/);
  }
  await withCliDiagnostics(params, 'server', async () => {
    cliDiagnostic()?.({ event: 'tool_result', tool: 'private-secret-sentinel', admission: 'refused', errorClass: 'private-secret-sentinel' });
    return {};
  }, undefined, recordCliRun('owner'));
  assert.equal((lastCliRun('owner') as any).lastTool, 'invalid_name');
  assert.equal((lastCliRun('owner') as any).errorCode, 'tool_or_runner_error');
  assert.doesNotMatch(JSON.stringify(lastCliRun('owner')), /sentinel/);
  await withCliDiagnostics(params, 'server', async () => ({}), undefined, recordCliRun('owner'));
  assert.equal((lastCliRun('owner') as any).result, 'no_tool_call');
});

test('an older concurrent run cannot replace the latest diagnostic or recreate a deleted account', async () => {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const old = withCliDiagnostics(params, 'server', async () => {
    await waiting;
    cliDiagnostic()?.({ event: 'tool_result', tool: 'private-secret-sentinel', admission: 'refused', errorClass: 'private-secret-sentinel' });
    return {};
  }, undefined, recordCliRun('owner'));
  await withCliDiagnostics({ ...params, provider: 'claude' }, 'bridge', async () => ({}), undefined, recordCliRun('owner'));
  const latest = lastCliRun('owner'); release(); await old;
  assert.deepEqual(lastCliRun('owner'), latest);
  db.prepare('DELETE FROM users WHERE id=?').run('owner');
  assert.equal(lastCliRun('owner'), null);
});
