// QA P-18: real local auth and SQLite, Vite UI, mocked model/toolkit backends.
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

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'menu-escape-focus-'));
const evidence = path.join(root, '.context/menu-escape-focus');
await fs.mkdir(evidence, { recursive: true });
async function freePort() {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}
const apiPort = await freePort(), uiPort = await freePort(), modelPort = await freePort();
const base = `http://127.0.0.1:${uiPort}`, apiBase = `http://127.0.0.1:${apiPort}`;
const modelBase = `http://127.0.0.1:${modelPort}`;
// Do not inherit provider credentials or database settings from the caller.
const env = {
  PATH: process.env.PATH, NODE_ENV: 'test', SWARM_ROLE: 'standalone', DEV_LOGIN: '1',
  DB_PATH: path.join(temp, 'app.db'), FILES_DIR: path.join(temp, 'files'),
  CLI_PROFILES_DIR: path.join(temp, 'profiles'), SESSION_SECRET: 'menu-escape-focus-fixture',
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

function seed(owner) {
  const db = new Database(env.DB_PATH);
  const bot = { id: 'menu-focus-bot', name: 'Menu QA Bot' };
  const now = Date.now();
  try {
    db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)')
      .run(bot.id, owner, bot.name, now, now);
  } finally { db.close(); }
  return bot;
}

try {
  await ready(`${modelBase}/v1/models`, start(['tests/mock-provider.mjs', String(modelPort)]));
  await ready(`${apiBase}/api/health`, start(['--import', preload, '--import', 'tsx', 'server/src/index.ts']));
  await ready(base, start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(root, 'web'), { SWARM_API: apiBase }));
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const login = await context.request.post(`${base}/api/auth/dev`, { data: { email: 'menu-focus@example.test', name: 'QA account' } });
  assert.equal(login.status(), 200);
  const { user } = await (await context.request.get(`${base}/api/auth/me`)).json();
  const bot = seed(user.id);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== base) { errors.push(`External browser request: ${url.origin}`); return route.abort(); }
    return route.continue();
  });
  await page.addInitScript(botId => localStorage.setItem('swarm.selectedBot', botId), bot.id);
  await page.goto(base);
  await page.locator('.chat__pill').waitFor();
  for (const selector of ['.chat__pill', '.account__btn', '.composer__plus-anchor > button']) {
    const trigger = page.locator(selector);
    for (const opening of ['Enter', 'Space', 'click']) {
      await trigger.focus();
      if (opening === 'click') await trigger.click();
      else await trigger.press(opening);
      const menu = page.getByRole('menu');
      await menu.waitFor();
      assert.equal(await menu.evaluate(el => el === document.activeElement), true);
      // Exercise both container focus and arrow-key item focus before dismissal.
      if (opening !== 'Enter') {
        await page.keyboard.press('ArrowDown');
        assert.equal(await menu.getByRole('menuitem').first().evaluate(el => el === document.activeElement), true);
      }
      await page.keyboard.press('Escape');
      await menu.waitFor({ state: 'detached' });
      assert.equal(await trigger.evaluate(el => el === document.activeElement), true, `${selector}: ${opening} then Escape restores trigger focus`);
      assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    }
  }
  // Outside dismissal must preserve the clicked destination's focus.
  await page.locator('.chat__pill').click();
  const composer = page.getByRole('textbox', { name: `Message ${bot.name}`, exact: true });
  await composer.click();
  await page.getByRole('menu').waitFor({ state: 'detached' });
  assert.equal(await composer.evaluate(el => el === document.activeElement), true);
  // Selecting details must allow the newly opened panel to take focus.
  await page.locator('.chat__pill').click();
  await page.getByRole('menuitem', { name: 'Show details' }).click();
  await page.waitForFunction(() => document.querySelector('#bot-details')?.contains(document.activeElement));
  await page.keyboard.press('Escape');
  await page.locator('#bot-details').waitFor({ state: 'detached' });
  await page.locator('.account__btn').click();
  await page.getByRole('menuitem', { name: 'Connect apps' }).click();
  await page.getByRole('dialog', { name: 'Connect Apps', exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.contains(document.activeElement));
  assert.deepEqual(errors, []);
  console.log('PASS P-18: Escape restores all menu triggers; outside clicks, details and dialogs retain destination focus');
  await context.close();
} catch (error) {
  await fs.writeFile(path.join(evidence, 'server.log'), logs.join(''));
  throw error;
} finally {
  await browser?.close();
  for (const child of children.reverse()) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
    }
  }
  await fs.rm(temp, { recursive: true, force: true });
}
