// QA SO L-11: real local dev UI and SQLite, with model/toolkit responses mocked.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const root = new URL('..', import.meta.url);
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bird-picker-ui-'));
const evidence = new URL('../.context/bird-picker/', import.meta.url);
await fs.mkdir(evidence, { recursive: true });
async function freePort() {
  const socket = http.createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}
const apiPort = await freePort(), uiPort = await freePort();
const api = `http://127.0.0.1:${apiPort}`, origin = `http://127.0.0.1:${uiPort}`;
// Do not inherit provider credentials or a database location from the workspace.
const env = {
  ...Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
  DB_PATH: path.join(temp, 'app.db'), FILES_DIR: path.join(temp, 'files'),
  NODE_ENV: 'test', SWARM_ROLE: 'standalone', DEV_LOGIN: '1', SESSION_SECRET: 'bird-picker-test-only',
  SWARM_NO_SCHEDULER: '1', WHATSAPP_DISABLED: '1', INKBOX_TUNNEL: '0', COMPUTER_PROVIDER: 'local',
  PORT: String(apiPort), APP_URL: origin, SERVER_URL: origin, SWARM_API: api,
  OPENROUTER_BASE_URL: `${api}/unused-model-backend`, DIRECT_BASE_URL: `${api}/unused-model-backend`,
};
const children = [];
let logs = '', browser;
function start(args, cwd = root) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
}
async function ready(url) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (children.some(child => child.exitCode !== null)) throw new Error('Local fixture exited before becoming ready');
    if (await fetch(url).then(response => response.ok, () => false)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Local fixture did not become ready: ${url}`);
}
const names = ['Flock', 'Solo', 'Soar', 'Glide', 'Pair', 'Rise', 'Arc', 'Vee', 'Diamond', 'Cascade'];
try {
  start(['--import', 'tsx', 'server/src/index.ts']);
  await ready(`${api}/api/health`);
  start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], new URL('../web', import.meta.url));
  await ready(origin);
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const width of [1280, 1024, 768, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 960 }, hasTouch: width === 390, reducedMotion: 'reduce' });
    const errors = [];
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { errors.push(`Unexpected external request: ${url.origin}`); return route.abort(); }
      if (['/api/models', '/api/settings/models'].includes(url.pathname)) return route.fulfill({ json: { provider: 'direct', models: [], favourites: [], canFast: false } });
      if (url.pathname === '/api/toolkits') return route.fulfill({ json: { toolkits: [] } });
      if (url.pathname.endsWith('/suggested-apps')) return route.fulfill({ json: { suggestions: [] } });
      return route.continue();
    });
    const login = await context.request.post(`${origin}/api/auth/dev`, { data: { email: `bird-picker-${width}@example.test` } });
    assert.ok(login.ok(), 'temporary account can use DEV_LOGIN');
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.getByRole('button', { name: 'New Bot', exact: true }).click();
    const form = page.getByRole('main', { name: 'Create a Bot', exact: true });
    const picker = form.getByRole('radiogroup', { name: 'Character shape' });
    const radio = name => picker.getByRole('radio', { name, exact: true });
    const choice = name => picker.locator('.bird-picker__choice').filter({ has: page.getByRole('radio', { name, exact: true }) });
    const selected = async name => assert.deepEqual(
      await picker.locator('input:checked').evaluateAll(elements => elements.map(element => element.value)),
      [`bird-${name.toLowerCase()}`], `${width}px: only ${name} is selected`,
    );
    await picker.waitFor();

    // Enter and leave the group with Tab, and retain native arrow-key selection/focus.
    await form.getByRole('textbox', { name: 'Bot name' }).focus();
    await page.keyboard.press('Tab');
    assert.ok(await radio('Flock').evaluate(element => element === document.activeElement));
    for (const [key, name] of [['ArrowRight', 'Solo'], ['ArrowDown', 'Soar'], ['ArrowLeft', 'Solo'], ['ArrowUp', 'Flock'], ['ArrowLeft', 'Cascade']]) {
      await page.keyboard.press(key);
      await selected(name);
      assert.ok(await radio(name).evaluate(element => element === document.activeElement && element.matches(':focus-visible')));
      assert.ok(await choice(name).evaluate(element => parseFloat(getComputedStyle(element).outlineWidth) >= 2), 'keyboard selection has a visible focus outline');
    }
    await page.keyboard.press('Tab');
    assert.ok(await form.getByRole('combobox', { name: 'Color' }).evaluate(element => element === document.activeElement));
    await page.keyboard.press('Shift+Tab');
    assert.ok(await radio('Cascade').evaluate(element => element === document.activeElement));
    await radio('Solo').focus();
    await page.keyboard.press('Space');
    await selected('Solo');

    for (const [index, name] of names.entries()) {
      const cell = choice(name);
      // Locator clicks must reach the actual drawing and name without force or radio.check().
      await cell.getByRole('img').click();
      await selected(name);
      const next = names[(index + 1) % names.length];
      await choice(next).locator('.bird-picker__label').click();
      await selected(next);
      if (width === 390) {
        await cell.getByRole('img').tap();
        await selected(name);
        await choice(next).locator('.bird-picker__label').tap();
        await selected(next);
      }
      // Check both sides of every cell with real coordinates, including row boundaries.
      await cell.scrollIntoViewIfNeeded();
      const box = await cell.boundingBox();
      assert.ok(box.width >= 44 && box.height >= 44, `${name} retains its label touch target`);
      for (const [x, y] of [[box.x + 5, box.y + 5], [box.x + box.width - 5, box.y + box.height - 5]]) {
        await page.mouse.click(x, y);
        await selected(name);
      }
    }
    // Empty space between columns or rows must not activate an overflowing radio.
    await picker.scrollIntoViewIfNeeded();
    const first = await choice('Flock').boundingBox(), second = await choice('Solo').boundingBox(), lower = await choice('Rise').boundingBox();
    await page.mouse.click((first.x + first.width + second.x) / 2, first.y + first.height / 2);
    await selected('Cascade');
    await page.mouse.click(first.x + first.width / 2, (first.y + first.height + lower.y) / 2);
    await selected('Cascade');
    assert.deepEqual(errors, []);
    await form.screenshot({ path: new URL(`create-${width}.png`, evidence).pathname });
    await form.getByRole('textbox', { name: 'Bot name' }).fill(`Picker fixture ${width}`);
    await choice('Diamond').locator('.bird-picker__label').click();
    const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/bots' && response.request().method() === 'POST');
    await form.getByRole('button', { name: 'Create', exact: true }).click();
    const response = await created;
    assert.ok(response.ok(), 'isolated Bot creation succeeds');
    assert.equal((await response.json()).bot.avatarShape, 'bird-diamond', 'the visible name selection is saved');
    await context.close();
    console.log(`PASS L-11 ${width}px: every bird drawing/name, cell edges, gaps, touch targets, and native keyboard navigation`);
  }
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  await browser?.close();
  await Promise.all(children.map(async child => {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  }));
  await fs.rm(temp, { recursive: true, force: true });
}
