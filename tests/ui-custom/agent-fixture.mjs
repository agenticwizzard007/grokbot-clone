import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

export async function agentFixture() {
  const root = path.resolve(new URL('../..', import.meta.url).pathname);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-agent-demo-'));
  async function port() { const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening'); const value = listener.address().port; await new Promise(resolve => listener.close(resolve)); return value; }
  const apiPort = await port(), uiPort = await port(), modelPort = await port();
  const base = `http://127.0.0.1:${uiPort}`, api = `http://127.0.0.1:${apiPort}`, model = `http://127.0.0.1:${modelPort}`;
  const fixtureFile = path.join(temp, 'fixture.json');
  // Same seed and isolated credential policy as tests/layout-fixture.mjs.
  const env = { PATH: process.env.PATH, NODE_ENV: 'test', PHONE_QA_FIXTURE_FILE: fixtureFile, DB_PATH: path.join(temp, 'app.db'), FILES_DIR: path.join(temp, 'files'), CLI_PROFILES_DIR: path.join(temp, 'profiles'), SWARM_ROLE: 'standalone', SWARM_NO_SCHEDULER: '1', SESSION_SECRET: 'ui-agent-fixture', COMPUTER_PROVIDER: 'local', INKBOX_TUNNEL: '0', DEV_LOGIN: '1', PORT: String(apiPort), APP_URL: base, SERVER_URL: base, WHATSAPP_DISABLED: '1', UI_CUSTOMIZATION: 'on', LLM_PROVIDER: 'direct', DIRECT_API_KEY: 'fixture-only', DIRECT_BASE_URL: `${model}/v1`, DIRECT_MODEL: 'gpt-4.1' };
  const preload = path.join(temp, 'offline.mjs');
  fs.writeFileSync(preload, `const local=globalThis.fetch;globalThis.fetch=(input,init)=>{const u=new URL(input instanceof Request?input.url:input);if(['localhost','127.0.0.1'].includes(u.hostname))return local(input,init);return Promise.resolve(Response.json({data:[],items:[]}));};`);
  const children = [], logs = [];
  const start = (args, cwd = root, extra = {}) => {
    const child = spawn(process.execPath, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child); for (const stream of [child.stdout, child.stderr]) stream.on('data', data => logs.push(String(data))); return child;
  };
  const ready = async (url, child) => { for (let i = 0; i < 300; i++) { assert.equal(child.exitCode, null, logs.join('')); if (await fetch(url).then(r => r.ok).catch(() => false)) return; await new Promise(r => setTimeout(r, 100)); } throw new Error(`Fixture did not start: ${logs.join('')}`); };
  const close = async () => { for (const child of children) if (child.exitCode === null) child.kill(); await Promise.all(children.filter(child => child.exitCode === null).map(child => once(child, 'exit'))); fs.rmSync(temp, { recursive: true, force: true }); };
  try {
    await ready(`${model}/_requests`, start(['tests/mock-provider.mjs', String(modelPort)]));
    const seed = start(['--import', preload, '--import', 'tsx', 'tests/fixtures/layout.seed.mts']);
    assert.equal((await once(seed, 'exit'))[0], 0, logs.join(''));
    await ready(`${api}/api/health`, start(['--import', preload, '--import', 'tsx', 'server/src/index.ts']));
    await ready(base, start([path.join(root, 'web/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(root, 'web'), { SWARM_API: api }));
    const fixture = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
    const db = new Database(env.DB_PATH);
    return { base, api, model, fixture, db, logs, close: async () => { db.close(); await close(); }, request: async (method, route, input, revision) => {
      const response = await fetch(`${api}/api${route}`, { method, headers: { cookie: 'swarm_session=layout-test-token', origin: base, ...(input === undefined ? {} : { 'content-type': 'application/json' }), ...(revision === undefined ? {} : { 'If-Match': `"${revision}"` }) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
      return { status: response.status, body: await response.json() };
    } };
  } catch (error) { await close(); throw error; }
}
