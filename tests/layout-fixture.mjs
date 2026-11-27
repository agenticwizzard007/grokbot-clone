import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export async function layoutServer({ root = path.resolve(new URL('..', import.meta.url).pathname), customization = false } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-layout-'));
  async function port() { const s = net.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
  const apiPort = await port(), uiPort = await port(), base = `http://127.0.0.1:${uiPort}`;
  const fixtureFile = path.join(temp, 'fixture.json');
  // Never inherit database paths, provider keys, or hosted service credentials.
  const env = { PATH: process.env.PATH, NODE_ENV: 'test', UI_CUSTOMIZATION: customization ? 'on' : 'off', PHONE_QA_FIXTURE_FILE: fixtureFile,
    DB_PATH: path.join(temp, 'app.db'), FILES_DIR: path.join(temp, 'files'), CLI_PROFILES_DIR: path.join(temp, 'profiles'),
    SWARM_ROLE: 'standalone', SWARM_NO_SCHEDULER: '1', SESSION_SECRET: 'layout-test', COMPUTER_PROVIDER: 'local',
    INKBOX_TUNNEL: '0', DEV_LOGIN: '1', PORT: String(apiPort), APP_URL: base, SERVER_URL: base, WHATSAPP_DISABLED: '1' };
  const children = [], logs = [];
  const preload = path.join(temp, 'offline.mjs');
  fs.writeFileSync(preload, `const fetchLocal = globalThis.fetch; globalThis.fetch = (input, init) => { const u = new URL(input instanceof Request ? input.url : input); if (['127.0.0.1', 'localhost'].includes(u.hostname)) return fetchLocal(input, init); return Promise.resolve(Response.json({ data: [], items: [] })); };`);
  function start(args, cwd = root, extra = {}) {
    const p = spawn(process.execPath, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(p); for (const s of [p.stdout, p.stderr]) s.on('data', d => logs.push(String(d))); return p;
  }
  async function ready(url, process) {
    for (let i = 0; i < 300; i++) {
      assert.equal(process.exitCode, null, logs.join(''));
      if (await fetch(url).then(r => r.ok).catch(() => false)) return;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`Server timeout: ${logs.join('')}`);
  }
  const close = async () => { for (const c of children) c.kill(); await Promise.all(children.filter(c => c.exitCode === null).map(c => once(c, 'exit'))); fs.rmSync(temp, { recursive: true, force: true }); };
  try {
    const seed = start(['--import', 'tsx', path.resolve('tests/fixtures/layout.seed.mts')]);
    assert.equal((await once(seed, 'exit'))[0], 0, logs.join(''));
    await ready(`http://127.0.0.1:${apiPort}/api/health`, start(['--import', preload, '--import', 'tsx', 'server/src/index.ts']));
    await ready(base, start([path.join(root, 'web/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(root, 'web'), { SWARM_API: `http://127.0.0.1:${apiPort}` }));
    return { base, dbPath: env.DB_PATH, fixture: JSON.parse(fs.readFileSync(fixtureFile, 'utf8')), close };
  } catch (e) { await close(); throw e; }
}
