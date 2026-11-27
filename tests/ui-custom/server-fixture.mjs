import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import Database from 'better-sqlite3';

// Reuses the layout fixture seed, with a private database and an explicit flag.
// Like layoutServer, no workspace credentials or database paths are inherited.
export async function serverFixture() {
  const root = path.resolve(new URL('../..', import.meta.url).pathname);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-server-'));
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`, fixtureFile = path.join(temp, 'fixture.json');
  const env = { PATH: process.env.PATH, NODE_ENV: 'test', DB_PATH: path.join(temp, 'app.db'),
    FILES_DIR: path.join(temp, 'files'), CLI_PROFILES_DIR: path.join(temp, 'profiles'),
    SWARM_ROLE: 'standalone', SWARM_NO_SCHEDULER: '1', SESSION_SECRET: 'ui-fixture', COMPUTER_PROVIDER: 'local',
    INKBOX_TUNNEL: '0', DEV_LOGIN: '1', PORT: String(port), APP_URL: base, SERVER_URL: base,
    WHATSAPP_DISABLED: '1', UI_CUSTOMIZATION: 'on', PHONE_QA_FIXTURE_FILE: fixtureFile };
  const logs = [], children = [];
  const preload = path.join(temp, 'offline.mjs');
  fs.writeFileSync(preload, `const local = globalThis.fetch; globalThis.fetch = (input, init) => { const u = new URL(input instanceof Request ? input.url : input); if (['127.0.0.1', 'localhost'].includes(u.hostname)) return local(input, init); return Promise.resolve(Response.json({ data: [], items: [] })); };`);
  const start = args => {
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child); for (const stream of [child.stdout, child.stderr]) stream.on('data', data => logs.push(String(data))); return child;
  };
  const close = async () => {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.filter(child => child.exitCode === null).map(child => once(child, 'exit')));
    fs.rmSync(temp, { recursive: true, force: true });
  };
  try {
    const seed = start(['--import', preload, '--import', 'tsx', 'tests/fixtures/layout.seed.mts']);
    assert.equal((await once(seed, 'exit'))[0], 0, logs.join(''));
    const serverArgs = ['--import', preload, '--import', 'tsx', 'server/src/index.ts'];
    let server = start(serverArgs);
    const waitReady = async () => {
      let ready = false;
      for (let i = 0; i < 300; i++) {
        assert.equal(server.exitCode, null, logs.join(''));
        if (await fetch(`${base}/api/health`).then(response => response.ok).catch(() => false)) { ready = true; break; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.ok(ready, logs.join(''));
    };
    await waitReady();
    const fixture = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
    const signIn = async label => {
      const response = await fetch(`${base}/api/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ email: `${label.toLowerCase()}@example.test`, name: label }) });
      assert.equal(response.status, 200); const cookie = response.headers.get('set-cookie').split(';')[0];
      const me = await fetch(`${base}/api/auth/me`, { headers: { cookie } }).then(response => response.json());
      return { cookie, userId: me.user.id };
    };
    const a = await signIn('QA-Temp-Alpha'), b = await signIn('QA-Temp-Beta');
    const db = new Database(env.DB_PATH);
    return { base, a, b, fixture, db, env, logs,
      setGlobalFlag: async flag => {
        assert.ok(['on', 'off'].includes(flag));
        server.kill(); await once(server, 'exit');
        env.UI_CUSTOMIZATION = flag; server = start(serverArgs); await waitReady();
      },
      close: async () => { db.close(); await close(); },
      request: async (account, method, route, input, revision, extra = {}) => {
        const headers = { cookie: account.cookie, origin: base, ...(input === undefined ? {} : { 'content-type': 'application/json' }),
          ...(revision === undefined ? {} : { 'If-Match': `"${revision}"` }), ...extra };
        const response = await fetch(`${base}/api/ui${route}`, { method, headers, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
        return { status: response.status, headers: response.headers, body: response.status === 304 ? null : await response.json() };
      } };
  } catch (error) { await close(); throw error; }
}
