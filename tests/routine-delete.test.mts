// QA SO D-05: real standalone API, temporary SQLite, mocked backends, no scheduler.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';

const cwd = new URL('..', import.meta.url).pathname;
function testEnv(root: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH, NODE_ENV: 'test', SWARM_ROLE: 'standalone',
    DB_PATH: path.join(root, 'app.db'), FILES_DIR: path.join(root, 'files'),
    SESSION_SECRET: 'routine-delete-test-only', DEV_LOGIN: '1', SWARM_NO_SCHEDULER: '1',
    COMPUTER_PROVIDER: 'local', PORT: '0', LLM_PROVIDER: 'direct',
    DIRECT_API_KEY: 'mock-model', COMPOSIO_API_KEY: 'mock-toolkit',
  };
}

async function startApp(env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
    globalThis.fetch = async input => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === 'registry.npmjs.org') return Response.json({ version: '0.28.0' });
      if (url.hostname === 'telemetry.composio.dev') return Response.json({});
      console.error('UNEXPECTED_BACKEND_REQUEST', url.hostname);
      throw new Error('Model and toolkit requests are blocked in this test');
    };
    const { composio } = await import('./server/src/composio.ts');
    const triggers = composio().triggers;
    triggers.disable = async id => { console.log('MOCK_TRIGGER_DISABLED', id); };
    triggers.delete = async id => { console.log('MOCK_TRIGGER_DELETED', id); };
    triggers.subscribe = async () => { throw new Error('Scheduler must stay disabled'); };
    await import('./server/src/index.ts');
  `], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  const exited = new Promise<void>((resolve, reject) => {
    child.once('exit', () => resolve());
    child.once('error', reject);
  });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { await exited; } finally { clearTimeout(force); }
  };
  try {
    for (let attempt = 0; attempt < 300; attempt++) {
      const port = logs.match(/server on http:\/\/localhost:(\d+)/)?.[1];
      if (port) return { origin: `http://127.0.0.1:${port}`, stop, logs: () => logs };
      assert.equal(child.exitCode, null, logs);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Standalone app did not start: ${logs}`);
  } catch (error) { await stop(); throw error; }
}

test('D-05: fresh standalone app deletes routines with SWARM_NO_SCHEDULER=1', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-routine-delete-'));
  const env = testEnv(root);
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  let db: Database.Database | undefined;
  try {
    app = await startApp(env);
    const origin = app.origin;
    const login = async (email: string) => {
      const response = await fetch(`${origin}/api/auth/dev`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, name: 'Test account' }),
      });
      assert.equal(response.status, 200);
      const cookie = response.headers.getSetCookie().find(value => value.startsWith('swarm_session='))?.split(';')[0];
      assert.ok(cookie);
      return cookie;
    };
    const cookie = await login('routine-owner@example.test');
    const otherCookie = await login('routine-other@example.test');
    const bots = await fetch(`${origin}/api/bots`, { headers: { cookie } });
    assert.equal(bots.status, 200);
    const botId = (await bots.json()).bots[0].id;
    db = new Database(env.DB_PATH!);
    // Store fixtures directly so create_routine cannot register a cron timer.
    const insert = db.prepare('INSERT INTO routines(id,bot_id,name,prompt,schedule,created_at) VALUES (?,?,?,?,?,?)');
    insert.run('rt_cron', botId, 'Test routine', 'Test prompt', '0 9 * * *', Date.now());
    const remove = (id: string, session = cookie) => fetch(`${origin}/api/routines/${id}`, { method: 'DELETE', headers: { cookie: session } });
    assert.equal((await remove('rt_cron', otherCookie)).status, 404);
    assert.ok(db.prepare('SELECT id FROM routines WHERE id=?').get('rt_cron'));
    const deleted = await remove('rt_cron');
    assert.equal(deleted.status, 200, await deleted.clone().text());
    assert.deepEqual(await deleted.json(), { ok: true });
    assert.equal(db.prepare('SELECT id FROM routines WHERE id=?').get('rt_cron'), undefined);
    assert.equal((await remove('rt_cron')).status, 404);
    assert.doesNotMatch(app.logs(), /MOCK_TRIGGER_(DISABLED|DELETED)/, 'cron deletion needs no toolkit call');

    // Saved event routines still clean up their mocked provider trigger.
    insert.run('rt_event', botId, 'Event routine', 'Test prompt', 'event:TEST_EVENT', Date.now());
    db.prepare('UPDATE routines SET trigger_id=?,trigger_config=? WHERE id=?').run('trigger-test', '{"folder":"test"}', 'rt_event');
    assert.equal((await remove('rt_event')).status, 200);
    assert.equal(db.prepare('SELECT id FROM routines WHERE id=?').get('rt_event'), undefined);
    const listed = await fetch(`${origin}/api/bots/${botId}/routines`, { headers: { cookie } });
    assert.deepEqual((await listed.json()).routines, []);
    await app.stop();
    assert.match(app.logs(), /scheduler disabled \(SWARM_NO_SCHEDULER=1\)/);
    assert.match(app.logs(), /MOCK_TRIGGER_DISABLED trigger-test/);
    assert.match(app.logs(), /MOCK_TRIGGER_DELETED trigger-test/);
    assert.doesNotMatch(app.logs(), /\[routines\] scheduled|\[triggers\]|UNEXPECTED_BACKEND_REQUEST/);
  } finally {
    await app?.stop();
    db?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const missing of [[], ['trigger_id', 'trigger_config'], ['trigger_config']]) {
  test(`D-05: database startup preserves routines when missing columns are ${missing.join(',') || 'none'}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-routine-schema-'));
    const env = testEnv(root);
    let db: Database.Database | undefined;
    const initialize = () => {
      const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval',
        "const { db } = await import('./server/src/db.ts'); db.close();"], { cwd, env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    };
    try {
      initialize();
      db = new Database(env.DB_PATH!);
      const columns = () => (db!.prepare('PRAGMA table_info(routines)').all() as { name: string }[]).map(column => column.name);
      assert.ok(columns().includes('trigger_id'), 'schema is ready without importing triggers');
      assert.ok(columns().includes('trigger_config'));
      db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('owner', 'owner@example.test', 'Test account', 1);
      db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run('bot', 'owner', 'Test Bot', 1, 1);
      db.prepare('INSERT INTO routines(id,bot_id,name,prompt,schedule,created_at,trigger_id,trigger_config) VALUES (?,?,?,?,?,?,?,?)')
        .run('rt_saved', 'bot', 'Saved routine', 'Saved prompt', 'event:TEST_EVENT', 1, 'saved-trigger', '{"folder":"saved"}');
      for (const column of missing) db.exec(`ALTER TABLE routines DROP COLUMN ${column}`);
      const before = db.prepare('SELECT * FROM routines WHERE id=?').get('rt_saved');
      db.close(); db = undefined;
      initialize();
      initialize(); // Reopening the migrated database must be idempotent.
      db = new Database(env.DB_PATH!);
      assert.ok(columns().includes('trigger_id'));
      assert.ok(columns().includes('trigger_config'));
      assert.deepEqual(db.prepare('SELECT * FROM routines WHERE id=?').get('rt_saved'), {
        ...before as object, ...Object.fromEntries(missing.map(column => [column, null])),
      });
    } finally {
      db?.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
