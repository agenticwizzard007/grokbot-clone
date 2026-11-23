import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import Database from 'better-sqlite3';

async function until<T>(check: () => T | Promise<T>, timeout = 20_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result as NonNullable<T>;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Local fixture timed out.');
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { await exited; } finally { clearTimeout(force); }
}

test('local dev runtime processes a retained burst once after restart using mocked backends', { timeout: 60_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-event-runtime-'));
  const portServer = net.createServer();
  await new Promise<void>(resolve => portServer.listen(0, '127.0.0.1', resolve));
  const modelPort = (portServer.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => portServer.close(() => resolve()));
  const model = spawn(process.execPath, ['tests/mock-provider.mjs', String(modelPort)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let modelReady = false;
  model.stdout.on('data', chunk => { if (String(chunk).includes('listening')) modelReady = true; });
  model.stderr.resume();
  const env = {
    PATH: process.env.PATH, NODE_ENV: 'test', SWARM_ROLE: 'standalone', DEV_LOGIN: '1',
    DB_PATH: path.join(root, 'app.db'), FILES_DIR: path.join(root, 'files'),
    SESSION_SECRET: 'event-runtime-test-only', COMPUTER_PROVIDER: 'local', PORT: '0',
    APP_URL: 'http://localhost:5173', LLM_PROVIDER: 'direct', DIRECT_API_KEY: 'mock-model',
    DIRECT_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, COMPOSIO_API_KEY: 'mock-toolkit',
    ROUTINE_EVENT_MIN_GAP_SEC: '60', MEMORY_CONSOLIDATE_IDLE_MINUTES: '0',
  };
  let app: ChildProcess | undefined, db: Database.Database | undefined, logs = '';
  async function start() {
    logs = '';
    app = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
      const networkFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.hostname === '127.0.0.1') return networkFetch(input, init);
        if (url.hostname === 'registry.npmjs.org') return Response.json({version:'0.28.0'});
        if (url.hostname === 'telemetry.composio.dev') return Response.json({});
        throw Error('Unmocked backend request refused.');
      };
      const {composio} = await import('./server/src/composio.ts');
      const toolkit = composio();
      toolkit.triggers.subscribe = async () => {};
      toolkit.connectedAccounts.list = async () => ({items:[]});
      toolkit.create = async () => ({sessionId:'mock-session',tools:async () => []});
      const {onTrigger} = await import('./server/src/triggers.ts');
      process.on('message', message => {
        for (const event of message.events) onTrigger(event.data, event.id);
        process.send({retained:true});
      });
      await import('./server/src/index.ts');
    `], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    app.stdout!.on('data', chunk => { logs += chunk; });
    app.stderr!.on('data', chunk => { logs += chunk; });
    const port = await until(() => {
      assert.equal(app!.exitCode, null, logs);
      return logs.match(/server on http:\/\/localhost:(\d+)/)?.[1];
    });
    return `http://127.0.0.1:${port}`;
  }
  async function deliver(ids: string[]) {
    const accepted = new Promise(resolve => app!.once('message', resolve));
    app!.send({ events: ids.map(id => ({ id, data: { id: 'fixture-trigger', payload: { messageId: id } } })) });
    await accepted;
  }
  try {
    await until(() => modelReady);
    const origin = await start();
    const login = await fetch(`${origin}/api/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'event-fixture@example.test', name: 'Fixture' }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.getSetCookie().find(value => value.startsWith('swarm_session='))!.split(';')[0];
    const bots = await (await fetch(`${origin}/api/bots`, { headers: { cookie } })).json();
    const bot = bots.bots[0].id;
    db = new Database(env.DB_PATH);
    db.prepare("INSERT INTO routines(id,bot_id,name,prompt,schedule,created_at,trigger_id) VALUES('fixture-routine',?,'Event fixture','Process every supplied event. mock-delay:1200','event:TEST_EVENT',?,'fixture-trigger')")
      .run(bot, Date.now());
    const jobs = () => db!.prepare("SELECT * FROM agent_jobs WHERE json_extract(trigger,'$.routineId')='fixture-routine' ORDER BY rowid").all() as any[];
    const requests = async () => await (await fetch(`http://127.0.0.1:${modelPort}/_requests`)).json() as any[];
    await deliver(['first']);
    await until(async () => (await requests()).length > 0);
    assert.equal(jobs()[0].state, 'running');
    await deliver(['second', 'third', 'second']);
    assert.equal((db.prepare('SELECT count(*) n FROM routine_event_receipts WHERE job_id IS NULL').get() as any).n, 2);
    await until(() => jobs()[0].state === 'completed');
    assert.equal(jobs().length, 1);
    await stop(app!);
    db.prepare("UPDATE routines SET last_run_at=? WHERE id='fixture-routine'").run(Date.now() - 61_000);
    await start();
    await until(() => jobs().length === 2 && jobs()[1].state === 'completed');
    await deliver(['first', 'second', 'third']);
    assert.equal(jobs().length, 2);
    const prompts = (await requests()).map(request => JSON.stringify([...request.body.input].reverse().find((item: any) => item.role === 'user')?.content))
      .filter(prompt => prompt?.includes('[Event: TEST_EVENT]'));
    assert.equal(prompts.length, 2, JSON.stringify(prompts));
    assert.ok(prompts[0].includes('first'));
    assert.ok(!prompts[0].includes('second'));
    assert.ok(prompts[1].includes('second') && prompts[1].includes('third'));
    assert.ok(!prompts[1].includes('first'));
    assert.equal((db.prepare('SELECT count(*) n FROM routine_event_receipts WHERE job_id IS NULL').get() as any).n, 0);
    assert.equal((db.prepare('SELECT count(*) n FROM routine_runs').get() as any).n, 2);
  } catch (error) {
    throw new Error(`${(error as Error).message}\n${logs}`, { cause: error });
  } finally {
    if (app) await stop(app);
    await stop(model); db?.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});
