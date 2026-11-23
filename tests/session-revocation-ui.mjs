// QA SO A-01: real local sessions and SSE, temporary SQLite, no live accounts/providers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-session-ui-'));
const children = [], logs = [];
let browser;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
// Do not inherit provider credentials from the workspace.
function start(args, env = {}) {
  const child = spawn(process.execPath, args, {
    env: { PATH: process.env.PATH, HOME: root, NODE_ENV: 'development', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => logs.push(String(data)));
  return child;
}
async function until(check) {
  for (let attempt = 0; attempt < 200; attempt++) { if (await check()) return; await sleep(100); }
  throw new Error('Timed out waiting for session fixture');
}
const apiPort = await port(), mockPort = await port(), webPort = await port();
const backend = `http://127.0.0.1:${apiPort}`, base = `http://127.0.0.1:${webPort}`;
fs.mkdirSync('.context/session-revocation', { recursive: true });
try {
  start(['tests/mock-provider.mjs', String(mockPort)]);
  start(['--import', 'tsx', 'server/src/index.ts'], {
    SWARM_ROLE: 'standalone', DB_PATH: path.join(root, 'app.db'), FILES_DIR: path.join(root, 'files'),
    SESSION_SECRET: 'session-ui-fixture-only', COMPUTER_PROVIDER: 'local', DEV_LOGIN: '1', PORT: String(apiPort),
    APP_URL: base, SERVER_URL: backend, DIRECT_API_KEY: 'mock-key', DIRECT_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
    LLM_PROVIDER: 'direct', SWARM_NO_SCHEDULER: '1', WHATSAPP_DISABLED: '1', MEMORY_CONSOLIDATE_IDLE_MINUTES: '0', INKBOX_TUNNEL: '0',
  });
  start(['web/node_modules/vite/bin/vite.js', 'web', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], { SWARM_API: backend });
  await until(() => fetch(`${backend}/api/health`).then(response => response.ok, () => false));
  await until(() => fetch(base).then(response => response.ok, () => false));
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });

  async function fixture(width, scenario, { silentStream = false } = {}) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    // Toolkit calls are empty fixtures; block external assets and provider requests.
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    await context.route('**/api/apps?*', route => route.fulfill({ json: { apps: [], connected: [], connectedApps: [], categories: [], total: 0 } }));
    if (silentStream) await context.addInitScript(() => {
      window.EventSource = class { close() {} }; // Isolate API expiry from the SSE signal.
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const email = `session-${scenario}-${width}@example.test`;
    await page.goto(base);
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByRole('button', { name: 'Continue with email', exact: true }).click();
    await page.locator('.app').waitFor();
    const api = async (url, method = 'GET', data) => {
      const response = await context.request.fetch(`${base}/api${url}`, { method, data });
      assert.ok(response.ok(), `Local fixture ${method} ${url}: ${response.status()}`);
      return response.json();
    };
    const bot = (await api('/bots')).bots.find(item => item.isPrimary);
    const marker = `Private session fixture ${scenario} ${width}`;
    await api(`/bots/${bot.id}/messages`, 'POST', { text: `mock: say ${marker}` });
    await until(async () => (await api(`/bots/${bot.id}/rows`)).rows.some(row => row.body?.role === 'assistant' && row.body.text === marker));
    await page.evaluate(async id => {
      const store = (await import('/src/store.ts')).useStore;
      await store.getState().loadBots();
      await store.getState().loadRows(id);
      store.getState().selectBot(id);
    }, bot.id);
    await page.getByText(marker, { exact: true }).waitFor();
    if (!silentStream) await page.waitForFunction(async () => (await import('/src/store.ts')).useStore.getState().sseConnected);
    const signedOut = async () => {
      await page.locator('.signin').waitFor();
      await until(async () => new URL(page.url()).hash === '');
      assert.equal(await page.locator('.app, .sidebar, .composer__input').count(), 0);
      assert.equal(await page.getByText(marker, { exact: true }).count(), 0);
      const state = await page.evaluate(async () => {
        const s = (await import('/src/store.ts')).useStore.getState();
        return { user: s.user, bots: s.bots, transcripts: s.transcripts, live: s.live, routines: s.routines, computer: s.computer };
      });
      assert.deepEqual(state, { user: null, bots: [], transcripts: {}, live: {}, routines: {}, computer: null });
      assert.deepEqual(errors, []);
    };
    return { context, page, api, bot, marker, email, signedOut };
  }

  for (const width of [1440, 1280, 1024, 768, 390]) {
    const f = await fixture(width, 'remote');
    await f.page.evaluate(() => { history.pushState(null, '', '#session-fixture'); });
    const current = (await f.api('/auth/sessions')).sessions.find(session => session.current);
    // Another real local session revokes the browser without any user action in the stale tab.
    const other = await browser.newContext();
    assert.ok((await other.request.post(`${base}/api/auth/dev`, { data: { email: f.email } })).ok());
    assert.ok((await other.request.delete(`${base}/api/auth/sessions/${current.id}`)).ok());
    await f.signedOut();
    await f.page.screenshot({ path: `.context/session-revocation/signed-out-${width}.png` });
    // Returning through browser history must not bring back the private shell.
    await f.page.goBack();
    assert.equal(new URL(f.page.url()).origin, base);
    await f.signedOut();
    await other.close(); await f.context.close();
  }

  for (const action of ['current-session', 'account-signout']) {
    const f = await fixture(1280, action);
    await f.page.evaluate(() => { location.hash = 'settings/account'; });
    await f.page.getByRole('heading', { name: 'Your account', exact: true }).waitFor();
    if (action === 'current-session') {
      await f.page.getByRole('button', { name: 'Sign out here', exact: true }).click();
      await f.page.getByRole('button', { name: 'Confirm sign-out', exact: true }).click();
    } else await f.page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await f.signedOut();
    await f.context.close();
  }

  const f = await fixture(1280, 'api-401', { silentStream: true });
  await f.api('/auth/logout', 'POST');
  await f.page.evaluate(async () => { await (await import('/src/store.ts')).useStore.getState().loadComputer().catch(() => {}); });
  await f.signedOut();
  await f.context.close();

  const recovery = await fixture(1280, 'recovery');
  let probes = 0;
  const unavailable = route => { probes++; return route.fulfill({ status: 503, json: { error: 'Fixture temporarily unavailable' } }); };
  const disconnected = route => route.abort();
  await recovery.page.route('**/api/auth/me', unavailable);
  await recovery.page.route('**/api/events', disconnected);
  await recovery.page.evaluate(() => window.dispatchEvent(new Event('swarm:resume')));
  await until(() => probes > 0);
  assert.equal(await recovery.page.locator('.signin').count(), 0);
  assert.ok(await recovery.page.getByText(recovery.marker, { exact: true }).isVisible());
  await recovery.page.unroute('**/api/auth/me', unavailable);
  await recovery.page.unroute('**/api/events', disconnected);
  await recovery.page.waitForFunction(async () => (await import('/src/store.ts')).useStore.getState().sseConnected);
  assert.ok(await recovery.page.getByText(recovery.marker, { exact: true }).isVisible());
  await recovery.context.close();
  console.log('PASS A-01: remote revocation at 1440/1280/1024/768/390, history, current-session revocation, Account sign-out, API 401 cleanup, stream recovery.');
} catch (error) {
  console.error(logs.join('').slice(-4000));
  throw error;
} finally {
  await browser?.close();
  for (const child of children) child.kill();
  await sleep(300);
  fs.rmSync(root, { recursive: true, force: true });
}
