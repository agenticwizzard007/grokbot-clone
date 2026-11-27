// Extends the layout fixture's seed/bootstrap pattern with mock chat and DB recovery access.
// tests/layout-fixture.mjs intentionally has a closed environment, so it cannot enable UC.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() {
  const socket = net.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const value = socket.address().port; await new Promise(resolve => socket.close(resolve)); return value;
}
export async function qualityServer({ extraSeed = true } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-uc-h-'));
  const [apiPort, uiPort, mockPort] = await Promise.all([port(), port(), port()]);
  const base = `http://127.0.0.1:${uiPort}`, backend = `http://127.0.0.1:${apiPort}`, mock = `http://127.0.0.1:${mockPort}`;
  const fixtureFile = path.join(temp, 'fixture.json'), database = path.join(temp, 'app.db');
  const children = [], logs = [], blocked = path.join(temp, 'blocked.jsonl');
  const preload = path.join(temp, 'offline.mjs');
  fs.writeFileSync(preload, `import fs from 'node:fs'; const original = globalThis.fetch; globalThis.fetch = (input, init) => {
    const u = new URL(input instanceof Request ? input.url : input);
    if (['127.0.0.1', 'localhost'].includes(u.hostname)) return original(input, init);
    fs.appendFileSync(${JSON.stringify(blocked)}, JSON.stringify({origin:u.origin})+'\\n');
    return Promise.resolve(Response.json({data:[],items:[]}));
  };`);
  const env = {
    PATH: process.env.PATH, NODE_ENV: 'test', PHONE_QA_FIXTURE_FILE: fixtureFile,
    DB_PATH: database, FILES_DIR: path.join(temp, 'files'), CLI_PROFILES_DIR: path.join(temp, 'profiles'),
    SWARM_ROLE: 'standalone', SWARM_NO_SCHEDULER: '1', SESSION_SECRET: 'uc-h-test-only', COMPUTER_PROVIDER: 'local',
    INKBOX_TUNNEL: '0', DEV_LOGIN: '1', PORT: String(apiPort), APP_URL: base, SERVER_URL: base, WHATSAPP_DISABLED: '1',
    MEMORY_CONSOLIDATE_IDLE_MINUTES: '0', UI_CUSTOMIZATION: 'on',
    DIRECT_API_KEY: 'mock-key', DIRECT_BASE_URL: `${mock}/v1`, OPENROUTER_BASE_URL: `${mock}/api/v1`, LLM_PROVIDER: 'direct',
  };
  function start(args, cwd = ROOT, extra = {}) {
    const child = spawn(process.execPath, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child); for (const stream of [child.stdout, child.stderr]) stream.on('data', d => logs.push(String(d)));
    return child;
  }
  async function ready(url, child) {
    for (let i = 0; i < 300; i++) {
      assert.equal(child.exitCode, null, logs.join(''));
      if (await fetch(url).then(r => r.ok).catch(() => false)) return;
      await delay(100);
    }
    throw new Error(`Fixture startup timeout: ${logs.join('')}`);
  }
  function withDb(fn) {
    // The only database capability exposed to tests is this freshly created fixture.
    assert.ok(database.startsWith(temp + path.sep));
    const db = new Database(database); try { return fn(db); } finally { db.close(); }
  }
  async function close() {
    for (const child of children.reverse()) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const stopped = once(child, 'exit'); child.kill();
      await Promise.race([stopped, delay(2000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await stopped;
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
  try {
    const seed = start(['--import', preload, '--import', 'tsx', 'tests/fixtures/layout.seed.mts']);
    assert.equal((await once(seed, 'exit'))[0], 0, logs.join(''));
    const fixture = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
    withDb(db => {
      db.prepare('UPDATE users SET name=?,email=? WHERE id=?').run('QA-Temp-A', 'qa-temp-a@example.test', fixture.userId);
      db.prepare("UPDATE bot_setups SET onboarding_status='active', confirmed_at=? WHERE bot_id IN (SELECT id FROM bots WHERE user_id=?)").run(Date.now(), fixture.userId);
      if (extraSeed) for (const [i, state] of ['working', 'needs_input', 'done'].entries()) db.prepare('INSERT INTO tasks(id,bot_id,title,state,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
        .run(`task_uc_h_${i}`, fixture.bot.id, `Fixture task ${i + 1}`, state, 'PRIVATE_FIXTURE_NOTE_A', Date.now(), Date.now());
    });
    await ready(`${mock}/_requests`, start(['tests/mock-provider.mjs', String(mockPort)]));
    await ready(`${backend}/api/health`, start(['--import', preload, '--import', 'tsx', 'server/src/index.ts']));
    await ready(base, start([path.join(ROOT, 'web/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(ROOT, 'web'), { SWARM_API: backend }));
    return { base, backend, mock, fixture, close, withDb, logs,
      blockedRequests: () => fs.existsSync(blocked) ? fs.readFileSync(blocked, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [],
    };
  } catch (error) { await close(); throw error; }
}
