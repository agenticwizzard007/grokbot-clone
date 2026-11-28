// QA P-20: authored entry and Bot import copy uses straight apostrophes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-setup-apostrophes-'));
const evidence = path.join(root, '.context/entry-setup-apostrophes');
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
  SESSION_SECRET: 'entry-setup-apostrophes-test-only', SWARM_ROLE: 'standalone', NODE_ENV: 'test',
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

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.fallback() : route.abort());
  await context.route('**/api/bots/*/suggested-apps', route => route.fulfill({ json: { suggestions: [], status: 'ready' } }));
  await context.route('**/api/apps**', route => route.fulfill({ json: { apps: [], connected: [], connectedApps: [], connections: [], categories: [] } }));
  await context.route('**/api/toolkits/**', route => route.fulfill({ json: { items: [] } }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(15000);
  const copy = async (locator, expected) => {
    await locator.waitFor();
    const actual = await locator.innerText();
    assert.equal(actual, expected);
    assert.doesNotMatch(actual, /[\u2018\u2019\u2013\u2014]/);
  };
  await page.goto(base);
  await copy(page.locator('.signin__sub'), "Choose how you'd like to sign in.");
  await copy(page.locator('.phone-auth__signup p'), "If signup is available, we'll create your account.");
  const login = await context.request.post(`${base}/api/auth/dev`, { data: { email: 'copy-fixture@example.test' } });
  assert.equal(login.status(), 200);
  await page.reload();
  await page.getByRole('button', { name: 'Create a Bot', exact: true }).click();
  await page.locator('.setup-create .pb-disclosure > summary').click();
  await page.getByRole('button', { name: 'Import saved setup', exact: true }).click();
  const upload = page.getByRole('main', { name: 'Import a saved setup', exact: true });
  await copy(upload.locator('.setup-create__description p'), 'Review the imported setup before activation.');
  assert.deepEqual(errors, []);
  console.log('PASS P-20: sign-in, phone signup, and Bot import copy use straight apostrophes.');
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
