// P-19: segmented radio keyboard behavior with isolated data and mocked backends.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'segmented-keyboard-'));
const evidence = path.join(root, '.context/segmented-keyboard');
fs.mkdirSync(evidence, { recursive: true });
const children = [], logs = [];
let browser;
async function port() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const value = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return value;
}
async function until(check, label) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
const apiPort = await port(), uiPort = await port(), modelPort = await port();
const apiBase = `http://127.0.0.1:${apiPort}`, base = `http://127.0.0.1:${uiPort}`;
const modelBase = `http://127.0.0.1:${modelPort}`;
// Deliberately exclude inherited provider credentials and deployment settings.
const env = {
  PATH: process.env.PATH, HOME: process.env.HOME,
  DB_PATH: path.join(temp, 'app.db'), FILES_DIR: path.join(temp, 'files'),
  SESSION_SECRET: 'segmented-keyboard-test-only', SWARM_ROLE: 'standalone', NODE_ENV: 'test',
  DEV_LOGIN: '1', COMPUTER_PROVIDER: 'local', PORT: String(apiPort), APP_URL: base, SERVER_URL: base,
  DIRECT_API_KEY: 'mock-key', DIRECT_BASE_URL: `${modelBase}/v1`, LLM_PROVIDER: 'direct',
  OPENROUTER_API_KEY: '', OPENROUTER_BASE_URL: `${modelBase}/api/v1`,
  COMPOSIO_API_KEY: '', INKBOX_TUNNEL: '0', WHATSAPP_DISABLED: '1',
  SWARM_NO_SCHEDULER: '1', MEMORY_CONSOLIDATE_IDLE_MINUTES: '0', SWARM_API: apiBase,
};
function start(args, cwd = root) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => logs.push(String(data)));
  return child;
}
const healthy = url => fetch(url).then(response => response.ok, () => false);
try {
  start(['tests/mock-provider.mjs', String(modelPort)]);
  await until(() => healthy(`${modelBase}/v1/models`), 'mock model');
  start(['--import', 'tsx', 'server/src/index.ts']);
  await until(() => healthy(`${apiBase}/api/health`), 'isolated API');
  start([path.join(root, 'web/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(root, 'web'));
  await until(() => healthy(base), 'local dev frontend');
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });

  for (const width of [1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.fallback() : route.abort());
    // No toolkit discovery, account connections, or external artwork are needed for keyboard checks.
    await context.route('**/api/bots/*/suggested-apps', route => route.fulfill({ json: { suggestions: [], status: 'ready' } }));
    await context.route('**/api/apps**', route => route.fulfill({ json: { apps: [], connected: [], connectedApps: [], connections: [], categories: [] } }));
    await context.route('**/api/toolkits/**', route => route.fulfill({ json: { items: [] } }));
    const login = await context.request.post(`${base}/api/auth/dev`, { data: { email: `segmented-keyboard-${width}@example.test` } });
    assert.equal(login.status(), 200);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/#settings/general`);
    const group = page.getByRole('radiogroup', { name: 'Theme', exact: true });
    const radios = group.getByRole('radio');
    await group.waitFor();
    const state = async (selected, focused = true) => {
      await until(async () => await radios.nth(selected).getAttribute('aria-checked') === 'true', 'selection update');
      assert.deepEqual(await radios.evaluateAll(elements => elements.map(element => element.tabIndex)),
        [0, 1, 2].map(index => index === selected ? 0 : -1), 'Only the selected option is tabbable');
      assert.deepEqual(await radios.evaluateAll(elements => elements.map(element => element.getAttribute('aria-checked'))),
        [0, 1, 2].map(index => index === selected ? 'true' : 'false'));
      if (focused) assert.equal(await radios.nth(selected).evaluate(element => element === document.activeElement), true);
    };
    await state(0, false);
    // Enter from the preceding control and leave in both directions using real Tab presses.
    await radios.nth(0).focus();
    await page.keyboard.press('Shift+Tab');
    assert.equal(await group.evaluate(element => element.contains(document.activeElement)), false);
    await page.keyboard.press('Tab');
    await state(0);
    for (const [key, selected] of [
      ['ArrowRight', 1], ['ArrowDown', 2], ['ArrowRight', 0],
      ['ArrowLeft', 2], ['ArrowUp', 1], ['ArrowUp', 0], ['ArrowUp', 2],
    ]) {
      await page.keyboard.press(key);
      await state(selected);
    }
    await page.keyboard.press('Tab');
    assert.equal(await group.evaluate(element => element.contains(document.activeElement)), false);
    await page.keyboard.press('Shift+Tab');
    await state(2);
    await page.keyboard.press('Shift+Tab');
    assert.equal(await group.evaluate(element => element.contains(document.activeElement)), false);
    await page.keyboard.press('Tab');
    await state(2);
    await radios.nth(1).click();
    await state(1);
    // Space retains native button activation, including a programmatically focused option.
    await radios.nth(0).focus();
    await page.keyboard.press('Space');
    await state(0);
    await page.keyboard.press('Enter');
    await state(0);
    await page.keyboard.press('x');
    await state(0);
    assert.deepEqual(errors, []);
    await context.close();
    console.log('PASS P-19: single Tab stop, arrow selection and wrapping, focus, click, Space and Enter');
  }
} catch (error) {
  fs.writeFileSync(path.join(evidence, 'server.log'), logs.join(''));
  const page = browser?.contexts().flatMap(context => context.pages()).at(-1);
  await page?.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); });
  }
  fs.rmSync(temp, { recursive: true, force: true });
}
