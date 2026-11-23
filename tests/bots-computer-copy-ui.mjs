// Run: node tests/bots-computer-copy-ui.mjs
// QA SO L-08: local Vite app, real API/auth, temporary SQLite, mocked providers only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bots-computer-copy-'));
const evidence = path.join(root, '.context/bots-computer-copy');
fs.mkdirSync(evidence, { recursive: true });
const children = [], logs = [];
let browser;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() {
  const server = net.createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
const apiPort = await port(), uiPort = await port();
const apiBase = `http://127.0.0.1:${apiPort}`, base = `http://127.0.0.1:${uiPort}`;
// Deliberately omit inherited provider credentials and deployment configuration.
const env = {
  PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test', SWARM_ROLE: 'standalone',
  DB_PATH: path.join(temp, 'app.db'), FILES_DIR: path.join(temp, 'files'),
  SESSION_SECRET: 'copy-test-only', DEV_LOGIN: '1', COMPUTER_PROVIDER: 'local',
  COMPOSIO_API_KEY: 'mock-toolkit-only', DIRECT_API_KEY: 'mock-model-only',
  DIRECT_BASE_URL: 'http://model.invalid/v1', LLM_PROVIDER: 'direct',
  SWARM_NO_SCHEDULER: '1', WHATSAPP_DISABLED: '1', INKBOX_TUNNEL: '0',
  PORT: String(apiPort), APP_URL: base, SERVER_URL: base, SWARM_API: apiBase,
};
function start(args, cwd = root) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => logs.push(String(data)));
}
async function until(predicate, label) {
  for (let attempt = 0; attempt < 200; attempt++) {
    assert.ok(children.every(child => child.exitCode === null), 'fixture process exited');
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`Timed out: ${label}`);
}
for (const [file, phrases] of [
  ['AppSettings.tsx', ["Bots' computer", "your Bots' computer.", "your Bots' browser."]],
  ['MessagingSettings.tsx', ["Your Bots' computer"]],
]) {
  const source = fs.readFileSync(path.join(root, 'web/src/components/config', file), 'utf8');
  for (const phrase of phrases) assert.ok(source.includes(phrase), `${file}: ${phrase}`);
  assert.doesNotMatch(source, /Bots[\u2018\u2019]/, file);
}
try {
  start(['--import', 'tsx', 'tests/fixtures/settings-disconnect.server.mts']);
  await until(() => fetch(`${apiBase}/api/health`).then(r => r.ok, () => false), 'API startup');
  start([path.join(root, 'web/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(root, 'web'));
  await until(() => fetch(base).then(r => r.ok, () => false), 'Vite startup');
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const width of [1280, 1024, 768, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    const login = await context.request.post(`${base}/api/auth/dev`, { data: { email: 'copy@example.test', name: 'Test account' } });
    assert.equal(login.status(), 200);

    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => console.error(error.message));
    await page.route('**/api/computer/details', route => route.fulfill({ json: {
      computer: { provider: 'fly', status: 'stopped', screens: [] },
      hibernation: { idleMinutes: 15 }, screens: [], bots: [],
    } }));
    await page.goto(`${base}/#settings/computer`);
    await page.getByRole('heading', { name: 'Connect your PC', exact: true }).waitFor();
    // Override the bootstrap's local computer state without changing any connection.
    await page.evaluate(async () => {
      const { useStore } = await import('/src/store.ts');
      useStore.setState({ computer: { provider: 'fly', status: 'stopped', screens: [] } });
    });
    const title = page.locator('.cloud-computer .cfg-row__title').first();
    await title.waitFor();
    assert.match(await title.textContent(), /^Bots' computer · /);
    assert.doesNotMatch(await title.textContent(), /[\u2018\u2019]/);
    await context.close();
    console.log(`PASS L-08 computer label at ${width}px`);
  }
} catch (error) {
  fs.writeFileSync(path.join(evidence, 'server.log'), logs.join(''));
  const page = browser?.contexts().flatMap(context => context.pages())[0];
  await page?.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  for (const child of children.reverse()) {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
  }
  fs.rmSync(temp, { recursive: true, force: true });
}
