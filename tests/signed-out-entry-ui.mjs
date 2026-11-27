// QA P-12: real local auth and SQLite, Vite UI, mocked model/toolkit backends.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import Database from 'better-sqlite3';
import { deferredEntries, entryAssets, entryMeasurements, manifest } from './entry-assets.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'signed-out-entry-'));
const evidence = path.join(root, '.context/signed-out-entry');
await fs.mkdir(evidence, { recursive: true });
async function freePort() {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}
const apiPort = await freePort(), uiPort = await freePort(), modelPort = await freePort(), previewPort = await freePort();
const base = `http://127.0.0.1:${uiPort}`, apiBase = `http://127.0.0.1:${apiPort}`;
const modelBase = `http://127.0.0.1:${modelPort}`;
// Do not inherit provider credentials or database settings from the caller.
const env = {
  PATH: process.env.PATH, NODE_ENV: 'test', SWARM_ROLE: 'standalone', DEV_LOGIN: '1',
  DB_PATH: path.join(temp, 'app.db'), FILES_DIR: path.join(temp, 'files'),
  CLI_PROFILES_DIR: path.join(temp, 'profiles'), SESSION_SECRET: 'signed-out-entry-fixture',
  PORT: String(apiPort), APP_URL: base, SERVER_URL: base, COMPUTER_PROVIDER: 'local',
  SWARM_NO_SCHEDULER: '1', MEMORY_CONSOLIDATE_IDLE_MINUTES: '0', WHATSAPP_DISABLED: '1', INKBOX_TUNNEL: '0',
  LLM_PROVIDER: 'direct', DIRECT_API_KEY: 'fixture-only', DIRECT_BASE_URL: `${modelBase}/v1`,
  OPENROUTER_BASE_URL: `${modelBase}/v1`, COMPOSIO_API_KEY: 'fixture-only',
};
const preload = path.join(temp, 'mock-backends.mjs');
await fs.writeFile(preload, `
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init);
  if (url.hostname === 'backend.composio.dev') return Response.json({ items: [], next_cursor: null });
  if (url.hostname === 'openrouter.ai' && url.pathname.endsWith('/models')) return Response.json({ data: [] });
  throw new Error('Unexpected external request: ' + url.origin + url.pathname);
};
`);
const children = [], logs = [];
let browser;
function start(args, cwd = root, extra = {}) {
  const child = spawn(process.execPath, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => logs.push(String(data)));
  return child;
}
async function ready(url, child) {
  for (let attempt = 0; attempt < 300; attempt++) {
    assert.equal(child.exitCode, null, logs.join(''));
    if (await fetch(url).then(response => response.ok, () => false)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Local server did not start: ${logs.join('')}`);
}

try {
  await ready(`${modelBase}/v1/models`, start(['tests/mock-provider.mjs', String(modelPort)]));
  await ready(`${apiBase}/api/health`, start(['--import', preload, '--import', 'tsx', 'server/src/index.ts']));
  await ready(base, start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(root, 'web'), { SWARM_API: apiBase }));
  const preview = `http://127.0.0.1:${previewPort}`;
  await ready(preview, start(['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(previewPort), '--strictPort'], path.join(root, 'web'), { SWARM_API: apiBase }));
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const [mode, origin] of [['dev', base], ['built', preview]]) {
    for (const width of [390, 1280]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block', userAgent: 'Mozilla/5.0 SwarmNative/1.0 (iOS)' });
      const email = `entry-${mode}-${width}@example.test`;
      assert.equal((await context.request.post(`${origin}/api/auth/dev`, { data: { email, name: 'QA account' } })).status(), 200);
      const { user } = await (await context.request.get(`${origin}/api/auth/me`)).json();
      const botId = `entry-${mode}-${width}`;
      const db = new Database(env.DB_PATH), now = Date.now();
      try {
        db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(botId, user.id, 'Entry fixture Bot', now, now);
      } finally { db.close(); }
      await context.clearCookies();
      const page = await context.newPage(), errors = [], requests = [];
      page.setDefaultTimeout(10000);
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => requests.push(new URL(request.url()).pathname));
      await page.addInitScript(botId => {
        localStorage.setItem('swarm.selectedBot', botId);
        localStorage.setItem('swarm.theme', 'dark');
        window.EventSource = class { static CLOSED = 2; constructor() { setTimeout(() => this.onopen?.(), 0); } close() {} };
      }, botId);
      let holdAuth = true, heldAuth;
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) { errors.push('External browser request'); return route.abort(); }
        if (url.pathname === '/api/auth/me' && holdAuth) { heldAuth = route; return; }
        return route.continue();
      });
      const modulePath = key => mode === 'dev' ? `/${key}` : `/${manifest[key].file}`;
      const assertDeferred = keys => {
        for (const key of keys) assert.ok(!requests.includes(modulePath(key)), `${mode}: ${key} has not loaded`);
      };
      const assertAuthenticationOnly = () => {
        assertDeferred(deferredEntries);
        assert.ok(!requests.some(url => /^\/api\/(bots|tasks|models|apps|computer|voice)(\/|$)/.test(url)), 'No work API calls before authentication');
        if (mode === 'built') {
          for (const url of requests.filter(url => /\.(js|css)$/.test(url))) {
            assert.ok(entryAssets.has(url.slice(1)), `Signed-out request belongs to measured entry graph: ${url}`);
          }
        } else {
          assert.ok(!requests.some(url => /\/(Sidebar|Composer|Transcript)\.tsx$|\/voice\/(call|audio)\.ts$|\/styles\/(shell|chat|cards|details|tasks|paper-core)\.css$/.test(url)), 'No eager work components, voice runtime or work CSS');
        }
      };
      await page.goto(origin);
      await page.waitForFunction(() => typeof window.swarmStartMainVoice === 'function');
      assert.equal(await page.evaluate(() => window.swarmStartMainVoice('00000000-0000-0000-0000-000000000000')), 'loading');
      assertAuthenticationOnly();
      for (let attempt = 0; !heldAuth && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.ok(heldAuth, 'Session lookup is pending');
      await heldAuth.fulfill({ status: 503, json: { error: 'Fixture session failure' } });
      await page.getByRole('button', { name: 'Try again', exact: true }).waitFor();
      assertAuthenticationOnly();
      holdAuth = false;
      await page.getByRole('button', { name: 'Try again', exact: true }).click();
      await page.getByRole('heading', { name: 'Welcome', exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
      assert.equal(await page.evaluate(() => window.swarmStartMainVoice('00000000-0000-0000-0000-000000000000')), 'signin');
      assertAuthenticationOnly();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: path.join(evidence, `${mode}-${width}-signin.png`), fullPage: true });
      await page.getByRole('textbox', { name: 'Email', exact: true }).fill(email);
      await page.getByRole('button', { name: 'Continue with email', exact: true }).click();
      await page.locator('.app').waitFor();
      await page.evaluate(id => { location.hash = '#bot/' + encodeURIComponent(id); }, botId);
      await page.locator('.composer textarea').waitFor();
      assert.ok(requests.includes(modulePath(deferredEntries[0])), 'Successful sign-in loads the authenticated shell');
      assert.ok(requests.includes(modulePath(deferredEntries[1])), 'Opening chat loads the composer');
      assertDeferred(deferredEntries.slice(2));
      await page.evaluate(() => { location.hash = '#tasks'; });
      await page.locator('.tasks-view').waitFor();
      assert.ok(requests.includes(modulePath(deferredEntries[3])), 'Opening Tasks loads the work panel');
      assertDeferred([deferredEntries[2]]);
      await page.evaluate(id => { location.hash = '#bot/' + encodeURIComponent(id); }, botId);
      await page.getByRole('button', { name: 'Show details', exact: true }).click();
      await page.getByRole('complementary', { name: 'Conversation details' }).waitFor();
      assert.ok(requests.includes(modulePath(deferredEntries[2])), 'Opening details loads the details panel');
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`PASS P-12 ${mode} ${width}px: pending and failed session, sign-in, authenticated chat, Tasks and details load on demand`);
    }
    // A cold work deep link must still select and load its lazy destination.
    const context = await browser.newContext();
    assert.equal((await context.request.post(`${origin}/api/auth/dev`, { data: { email: `entry-${mode}-1280@example.test` } })).status(), 200);
    const page = await context.newPage();
    await page.goto(`${origin}/#tasks`);
    await page.locator('.tasks-view').waitFor();
    await context.close();
  }
  await fs.writeFile(path.join(evidence, 'bundle.json'), JSON.stringify(entryMeasurements, null, 2));
} finally {
  await browser?.close();
  for (const child of children.reverse()) {
    if (child.exitCode !== null) continue;
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
  await fs.rm(temp, { recursive: true, force: true });
}
