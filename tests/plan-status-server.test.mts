import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';

const temp = await mkdtemp(join(tmpdir(), 'plan-status-server-'));
Object.assign(process.env, { DB_PATH: join(temp, 'test.db'), FILES_DIR: join(temp, 'files'), CLI_PROFILES_DIR: join(temp, 'profiles'), SESSION_SECRET: 'local-status-test', SWARM_CLI_SERVER_LOGIN: '1' });
const cli = join(temp, 'fake-cli');
await writeFile(cli, `#!${process.execPath}\nif (process.argv.includes('--json')) setInterval(() => {}, 1000); else console.log('Logged in using ChatGPT');`, { mode: 0o700 });
process.env.SWARM_CLI_CODEX_PATH = cli;
process.env.SWARM_CLI_CLAUDE_PATH = cli;
const { db } = await import('../server/src/db.js');
const { cliApi } = await import('../server/src/cli/routes.js');
const { savePlanStatus, storedPlanStatus } = await import('../server/src/cli/status-history.js');
const { hostedStatus, profilePath, deleteHostedProfile } = await import('../server/src/cli/hosted.js');
const { selectCli } = await import('../server/src/cli/store.js');
const app = new Hono().route('/api/cli', cliApi);
const ready = { installed: true, authenticated: true, subscription: true };

test('cold status route responds before slow probes with persisted display health and bounded failure', async t => {
  t.after(async () => { db.close(); await rm(temp, { recursive: true, force: true }); });
  for (const id of ['status-a', 'status-b']) {
    db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(id, `${id}@example.test`, 'Local account', Date.now());
    db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (session_hash(?),?,?,?)').run(id, id, Date.now(), Date.now() + 60_000);
    const dir = join(profilePath(id), '.claude');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '.credentials.json'), '{}');
  }
  savePlanStatus('status-a', { codex: ready, claude: ready });
  selectCli('status-a', 'codex');
  assert.equal(hostedStatus('status-a').connected, false, 'display history must not authorize CLI work');
  const read = async (id: string) => {
    const response = await app.request('/api/cli', { headers: { cookie: `swarm_session=${id}` } });
    assert.equal(response.status, 200);
    return response.json();
  };
  const start = performance.now();
  const a = await read('status-a');
  assert.ok(performance.now() - start < 600, 'response does not wait for either provider');
  assert.equal(a.statusChecking, true);
  assert.equal(a.providers.codex.subscription, true);
  const b = await read('status-b');
  assert.equal(b.statusChecking, true);
  assert.equal(b.providers.codex.subscription, false, 'another account cannot inherit history');
  await new Promise(resolve => setTimeout(resolve, 2400));
  const checked = await read('status-a');
  assert.equal(checked.statusChecking, undefined);
  assert.equal(checked.providers.codex.subscription, true, 'fast Codex result survives slow Claude');
  assert.match(checked.providers.claude.error, /timed out/i);
  assert.equal(storedPlanStatus('status-a')?.claude.subscription, true, 'failure retains last-known history');
  await deleteHostedProfile('status-a');
  assert.equal(storedPlanStatus('status-a'), undefined, 'reset removes display history');
});
