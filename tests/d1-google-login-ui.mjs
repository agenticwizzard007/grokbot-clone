// Local Google start/callback routes, isolated database, no external OAuth or user data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
const root = process.cwd(), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'd1-ui-'));
const phase = process.env.D1_SHOT_PHASE || 'after';
const shots = '/workspace/swarm-qa/livewalk-fix/shots';
fs.mkdirSync(shots, { recursive: true });
const children = [], logs = [], failures = [];
let browser;
async function port() { const s = net.createServer().listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
const apiPort = await port(), uiPort = await port(), base = `http://127.0.0.1:${uiPort}`;
const env = { PATH: process.env.PATH, HOME: temp, NODE_ENV: 'test', SWARM_ROLE: 'standalone',
  DB_PATH: path.join(temp, 'db'), FILES_DIR: path.join(temp, 'files'), SESSION_SECRET: 'd1-ui-test-only',
  COMPUTER_PROVIDER: 'local', DEV_LOGIN: '0', SWARM_NO_SCHEDULER: '1', INKBOX_TUNNEL: '0', WHATSAPP_DISABLED: '1',
  GOOGLE_CLIENT_ID: 'd1-fixture', GOOGLE_CLIENT_SECRET: 'd1-fixture-only', PORT: String(apiPort),
  APP_URL: base, SERVER_URL: base, SWARM_API: `http://127.0.0.1:${apiPort}` };
const preload = path.join(temp, 'offline.mjs');
fs.writeFileSync(preload, "globalThis.fetch = async () => { throw new Error('D1 fixture forbids external requests'); };\n");
function start(args, cwd = root) { const c = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(c); for (const s of [c.stdout, c.stderr]) s.on('data', b => logs.push(String(b))); }
async function ready(url) { for (let n = 0; n < 300; n++) { if (await fetch(url).then(r => r.ok, () => false)) return; await new Promise(r => setTimeout(r, 100)); } throw Error(logs.join('')); }
try {
  start(['--import', preload, '--import', 'tsx', 'server/src/index.ts']);
  await ready(`http://127.0.0.1:${apiPort}/api/health`);
  start([path.join(root, 'web/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(root, 'web'));
  await ready(base);
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
    await context.addInitScript(() => localStorage.setItem('swarm.theme', 'light'));
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    const states = [];
    await context.route('**/api/auth/google/start', async route => {
      const response = await route.fetch({ maxRedirects: 0 });
      const google = new URL(response.headers().location);
      assert.equal(google.origin, 'https://accounts.google.com');
      assert.equal(google.searchParams.get('scope'), 'openid email profile');
      states.push(google.searchParams.get('state'));
      const callback = new URL(google.searchParams.get('redirect_uri'));
      callback.searchParams.set('state', states.at(-1));
      callback.searchParams.set('status', 'failed');
      callback.searchParams.set('error', 'connection is no longer awaiting completion. Link session has expired');
      await route.fulfill({ response, status: 302, headers: { ...response.headers(), location: callback.href }, body: '' });
    });
    const page = await context.newPage();
    await page.goto(base);
    await page.getByRole('link', { name: 'Continue with Google', exact: true }).waitFor();
    assert.equal(states.length, 0, 'page load must not generate authorization links');
    await page.getByRole('link', { name: 'Continue with Google', exact: true }).click();
    await page.getByRole('alert').waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `${shots}/D1-${phase}-${width}.png`, fullPage: true });
    try {
      assert.equal(await page.getByRole('alert').innerText(), 'That sign-in link expired. Please try again.');
      assert.equal(await page.getByRole('button', { name: 'Back', exact: true }).count(), 1);
      const back = await page.getByRole('button', { name: 'Back', exact: true }).boundingBox();
      assert.ok(back && back.height >= 44);
      const retry = page.getByRole('link', { name: 'Try again', exact: true });
      const box = await retry.boundingBox();
      const provider = await page.getByRole('link', { name: 'Continue with Google', exact: true }).boundingBox();
      assert.ok(box && box.height >= 44 && box.width === provider.width, 'retry matches full-width provider controls');
      assert.ok(await page.getByRole('alert').evaluate(el => parseFloat(getComputedStyle(el).fontSize) >= 13));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await retry.click();
      await page.getByRole('alert').waitFor();
      assert.equal(states.length, 2);
      assert.notEqual(states[0], states[1]);
      assert.equal(new URL(page.url()).origin, base);
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      assert.equal(await page.getByRole('alert').count(), 0);
      assert.equal(states.length, 2, 'Back dismisses recovery without starting authorization');
      console.log(`PASS D1 recovery, fresh click-time authorization, scopes, and layout at ${width}px light`);
    } catch (error) { failures.push(`${width}: ${error.message}`); }
    await context.close();
  }
  assert.deepEqual(failures, []);
} finally {
  await browser?.close();
  for (const c of children.reverse()) if (c.exitCode === null && c.signalCode === null) { c.kill(); await once(c, 'exit'); }
  fs.rmSync(temp, { recursive: true, force: true });
}
