// Run: node tests/connected-apps-loading-ui.mjs
// QA SO L-09: local Vite app, real API/auth, temporary SQLite, mocked providers only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'connected-apps-loading-'));
const evidence = path.join(root, '.context/connected-apps-loading');
fs.mkdirSync(evidence, { recursive: true });
const children = [], logs = [];
let browser, db;
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
  SESSION_SECRET: 'apps-loading-test-only', DEV_LOGIN: '1', COMPUTER_PROVIDER: 'local',
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
// Reuse E-02's fully mocked backend, but only seed and read fake connections here.
try {
  start(['--import', 'tsx', 'tests/fixtures/settings-disconnect.server.mts']);
  await until(() => fetch(`${apiBase}/api/health`).then(r => r.ok, () => false), 'API startup');
  db = new Database(env.DB_PATH);
  start([path.join(root, 'web/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(root, 'web'));
  await until(() => fetch(base).then(r => r.ok, () => false), 'Vite startup');
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const width of [1280, 1024, 768, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const errors = [], mutations = [];
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== base) return route.abort();
      if (url.pathname.startsWith('/api/apps') && request.method() !== 'GET') {
        mutations.push(`${request.method()} ${url.pathname}`);
        return route.abort();
      }
      return route.continue();
    });
    const login = await context.request.post(`${base}/api/auth/dev`, { data: { email: `apps-loading-${width}@example.test`, name: 'Test account' } });
    assert.equal(login.status(), 200);
    const { user } = await (await context.request.get(`${base}/api/auth/me`)).json();
    // Warm the real catalog before opening Settings.
    assert.equal((await context.request.get(`${base}/api/apps?limit=1`)).status(), 200);
    const page = await context.newPage();
    const aborted = [];
    page.setDefaultTimeout(7000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('requestfailed', request => {
      if (request.failure()?.errorText === 'net::ERR_ABORTED') aborted.push(new URL(request.url()).pathname);
    });
    await page.goto(base);
    await page.waitForFunction(async () => !!(await import('/src/store.ts')).useStore.getState().user);
    // Compile and mount Settings before measuring its section load.
    const open = section => page.evaluate(async section => {
      (await import('/src/configStore.ts')).useConfigUI.getState().openAppSettings(section);
    }, section);
    await open('general');
    await page.getByRole('heading', { name: 'General', exact: true }).waitFor();
    const summary = page.locator('.access-apps-settings__summary strong');
    const retry = page.getByRole('button', { name: 'Retry refresh', exact: true });
    const bump = () => page.evaluate(async () => {
      const { useStore } = await import('/src/store.ts');
      useStore.getState().set({ connectionsVersion: useStore.getState().connectionsVersion + 1 });
    });
    const waitSummary = text => page.waitForFunction(text => document.querySelector('.access-apps-settings__summary strong')?.textContent === text, text);
    for (const populated of [false, true]) {
      if (populated) {
        for (const id of ['first', 'second']) db.prepare('INSERT INTO fixture_accounts VALUES (?, ?)').run(`${width}-${id}`, user.id);
      }
      const started = performance.now();
      await open('apps');
      await waitSummary(populated ? '1 app connected' : 'No apps connected yet');
      const elapsed = performance.now() - started;
      assert.ok(elapsed < 1500, `${width}px: warm catalog settles promptly (${Math.round(elapsed)} ms)`);
      await page.getByText(populated ? 'Gmail · Account 2' : 'No active accounts connected.', { exact: true }).waitFor();
      assert.equal(await page.getByRole('alert').count(), 0);
      console.log(`PASS ${width}px ${populated ? 'two accounts, one app' : 'empty'}: ${Math.round(elapsed)} ms`);
      await open('general');
    }

    // Neither stalled read may leave the section or its Retry button stuck.
    const held = [];
    const hold = route => { held.push(route); };
    const appsUrl = '**/api/apps?limit=1', accountsUrl = '**/api/apps/connections';
    await page.route(appsUrl, hold);
    await page.route(accountsUrl, hold);
    const started = performance.now();
    await open('apps');
    await waitSummary('Checking…');
    await waitSummary('Apps unavailable');
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= 4500 && elapsed < 6500, `timeout is bounded: ${Math.round(elapsed)} ms`);
    await until(() => retry.isEnabled(), 'Retry enabled after both timeouts');
    await until(() => aborted.includes('/api/apps') && aborted.includes('/api/apps/connections'), 'both timed out reads aborted');
    assert.equal(await page.getByRole('alert').filter({ hasText: 'The request took too long. Try again.' }).count(), 2);
    await page.getByText('Accounts unavailable', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(evidence, `timeout-${width}.png`), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.unroute(appsUrl, hold);
    await page.unroute(accountsUrl, hold);
    await retry.click();
    await waitSummary('1 app connected');
    await until(async () => await page.getByRole('alert').count() === 0, 'retry clears errors');
    // Late replies from the cancelled attempt cannot replace the recovered result.
    for (const route of held.splice(0)) await route.fulfill({ json: { connectedApps: [], connections: [] } }).catch(() => {});
    assert.equal(await summary.textContent(), '1 app connected');

    if (width === 1280) {
      // An account-only stall preserves the successful count and still offers Retry.
      await open('general');
      await page.route(accountsUrl, hold);
      await open('apps');
      await waitSummary('1 app connected');
      await page.getByText('Accounts unavailable', { exact: true }).waitFor();
      assert.equal(await summary.textContent(), '1 app connected');
      await until(() => retry.isEnabled(), 'Retry enabled after account timeout');
      await page.unroute(accountsUrl, hold);
      await retry.click();
      await until(async () => await page.getByRole('alert').count() === 0, 'account retry');

      // HTTP and malformed responses settle immediately instead of looking empty.
      for (const failure of [{ status: 503, json: { error: 'Fixture unavailable' } }, { json: {} }]) {
        const fail = route => route.fulfill(failure);
        await open('general');
        await page.route(appsUrl, fail);
        await open('apps');
        await waitSummary('Apps unavailable');
        await until(() => retry.isEnabled(), 'Retry enabled after invalid response');
        await page.unroute(appsUrl, fail);
        await retry.click();
        await waitSummary('1 app connected');
      }

      // A connection-version refresh cancels an older read without reporting a timeout.
      await page.route(appsUrl, hold);
      const before = held.length;
      await bump();
      await until(() => held.length > before, 'held refresh');
      await page.unroute(appsUrl, hold);
      const abortsBeforeRefresh = aborted.length;
      const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/apps');
      await bump();
      await (await response).finished();
      await until(() => aborted.length > abortsBeforeRefresh, 'obsolete refresh aborted');
      await waitSummary('1 app connected');
      await until(async () => await page.getByRole('alert').count() === 0, 'superseding refresh');
      for (const route of held.splice(0)) await route.fulfill({ json: { connectedApps: [], connections: [] } }).catch(() => {});
      assert.equal(await summary.textContent(), '1 app connected');

      // Leaving the section aborts its reads; reopening starts a clean request.
      await open('general');
      await page.route(appsUrl, hold);
      await open('apps');
      await waitSummary('Checking…');
      await until(() => held.length > 0, 'held section read');
      const abortsBeforeLeaving = aborted.length;
      await open('general');
      await until(() => aborted.length > abortsBeforeLeaving, 'unmounted section read aborted');
      await page.unroute(appsUrl, hold);
      await open('apps');
      await waitSummary('1 app connected');
    }
    for (const route of held.splice(0)) await route.abort().catch(() => {});
    assert.deepEqual(errors, [], 'no browser errors');
    assert.deepEqual(mutations, [], 'no app mutations');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM fixture_deletes').get().count, 0);
    await context.close();
    console.log(`PASS QA SO L-09 at ${width}px: bounded loading, clear errors, retry and stale response protection`);
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
  db?.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
