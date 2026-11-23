// Local Vite app, real DEV_LOGIN session in a temporary SQLite database, and mocked backends.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const root = await mkdtemp(path.join(os.tmpdir(), 'swarm-session-boot-'));
const evidence = new URL('../.context/session-boot/', import.meta.url);
await mkdir(evidence, { recursive: true });
const children = [];
let logs = '', browser;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
function start(args, env, cwd = new URL('..', import.meta.url)) {
  // Do not inherit provider credentials or an existing database from the workspace.
  const child = spawn(process.execPath, args, {
    cwd, env: { PATH: process.env.PATH, HOME: root, NODE_ENV: 'development', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  child.stdout.on('data', data => { logs += data; });
  child.stderr.on('data', data => { logs += data; });
  return child;
}
async function ready(url) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (children.some(child => child.exitCode !== null)) throw new Error(logs);
    if (await fetch(url).then(response => response.ok, () => false)) return;
    await delay(100);
  }
  throw new Error(`Local session test server did not start: ${logs}`);
}

try {
  const apiPort = await port(), mockPort = await port(), webPort = await port();
  const backend = `http://127.0.0.1:${apiPort}`, origin = `http://127.0.0.1:${webPort}`;
  start(['tests/mock-provider.mjs', String(mockPort)], {});
  start(['--import', 'tsx', 'server/src/index.ts'], {
    SWARM_ROLE: 'standalone', DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'),
    SESSION_SECRET: 'session-boot-test-only', DEV_LOGIN: '1', COMPUTER_PROVIDER: 'local',
    PORT: String(apiPort), APP_URL: origin, SERVER_URL: backend,
    DIRECT_API_KEY: 'mock-key', DIRECT_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
    OPENROUTER_BASE_URL: `http://127.0.0.1:${mockPort}/api/v1`, COMPOSIO_API_KEY: '',
    LLM_PROVIDER: 'direct', SWARM_NO_SCHEDULER: '1', WHATSAPP_DISABLED: '1',
    MEMORY_CONSOLIDATE_IDLE_MINUTES: '0', INKBOX_TUNNEL: '0',
  });
  start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'],
    { SWARM_API: backend }, new URL('../web', import.meta.url));
  await ready(`${backend}/api/health`);
  await ready(origin);
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });

  for (const width of [1280, 1024, 768, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
    page.setDefaultTimeout(10000);
    await page.clock.install();
    const unexpected = [];
    let mode = 'normal', sessionRequests = 0, held;
    page.on('pageerror', error => unexpected.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem('swarm.theme', 'light');
      window.EventSource = class {
        static CLOSED = 2;
        constructor() { setTimeout(() => this.onopen?.(), 0); }
        close() {}
      };
    });
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), endpoint = url.pathname;
      if (url.origin !== origin) { unexpected.push('External request attempted'); return route.abort(); }
      if (!endpoint.startsWith('/api/')) return route.continue();
      if (endpoint === '/api/auth/me' && request.method() === 'GET') {
        sessionRequests++;
        if (mode === 'normal') return route.continue();
        if (mode === 'network') return route.abort('failed');
        if (mode === 'held') { held = route; return; }
        return route.fulfill({ status: 500, json: { error: 'Internal diagnostic detail' } });
      }
      if (endpoint === '/api/auth/me' && request.method() === 'PATCH') return route.continue();
      if (request.method() !== 'GET') { unexpected.push(`${request.method()} ${endpoint}`); return route.abort(); }
      // Models, toolkits and the signed-in shell use synthetic responses only.
      const fixtures = {
        '/api/bots': { bots: [], live: [] },
        '/api/computer': { computer: { provider: 'local', status: 'absent', screens: [] } },
        '/api/models': { models: [], favourites: [], canFast: false },
        '/api/apps': { apps: [], connected: [], categories: [], total: 0 },
        '/api/settings': { settings: {}, computer: { provider: 'local' } },
        '/api/needs-you': { items: [] },
        '/api/tasks': { tasks: [] },
        '/api/voice/options': { voices: [], languages: [], speeds: [], configured: false },
        '/api/checkins/reports': { reports: [], nextCursor: null, hasMore: false },
        '/api/team/exchanges': { exchanges: [], nextBefore: null },
      };
      if (!(endpoint in fixtures)) unexpected.push(`Unexpected API ${endpoint}`);
      return route.fulfill({ json: fixtures[endpoint] ?? {} });
    });

    await page.goto(origin);
    await page.getByRole('heading', { name: 'Welcome to Swarm' }).waitFor();
    const login = await page.request.post(`${backend}/api/auth/dev`, { data: { email: `session-${width}@example.test`, name: 'Session QA' } });
    assert.equal(login.status(), 200);
    await page.reload();
    await page.locator('.app').waitFor();

    // P-09: a request that never responds must leave boot within five seconds.
    mode = 'held';
    held = undefined;
    await page.reload();
    for (let attempt = 0; !held && attempt < 100; attempt++) await delay(20);
    assert.ok(held, 'the initial session lookup is stalled');
    await page.clock.fastForward(5000);
    const timeoutRetry = page.getByRole('button', { name: 'Try again', exact: true });
    await timeoutRetry.waitFor();
    assert.equal(await timeoutRetry.isEnabled(), true);
    assert.equal(await page.locator('.signin, .app').count(), 0);
    await page.screenshot({ path: new URL(`${width}-timeout.png`, evidence).pathname });

    // A stalled retry has its own deadline and keeps recovery available.
    held = undefined;
    await timeoutRetry.click();
    for (let attempt = 0; !held && attempt < 100; attempt++) await delay(20);
    assert.ok(held, 'retry sends another session lookup');
    await page.clock.fastForward(5000);
    await timeoutRetry.waitFor();
    assert.equal(await timeoutRetry.isEnabled(), true);
    mode = 'normal';
    await timeoutRetry.click();
    await page.locator('.app').waitFor();
    assert.equal(await page.getByRole('alert').count(), 0, 'retry after timeout restores the existing session');

    const beforeFailure = sessionRequests;
    mode = 'server';
    await page.reload();
    const alert = page.getByRole('alert');
    await alert.getByRole('heading', { name: 'Unable to load your session' }).waitFor();
    assert.equal(sessionRequests, beforeFailure + 1, 'StrictMode does not duplicate the boot lookup');
    assert.equal(await page.locator('.signin, .app').count(), 0, 'failed boot is not a signed-out or signed-in screen');
    assert.doesNotMatch(await alert.innerText(), /Internal diagnostic detail/);
    const retry = page.getByRole('button', { name: 'Try again', exact: true });
    await retry.focus();
    assert.equal(await retry.evaluate(button => button === document.activeElement), true);
    const geometry = await retry.evaluate(button => {
      const box = button.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: innerWidth, height: innerHeight, scroll: document.documentElement.scrollWidth };
    });
    assert.ok(geometry.scroll <= width && geometry.left >= 0 && geometry.right <= width && geometry.top >= 0 && geometry.bottom <= geometry.height, 'error and retry fit the viewport');
    await page.screenshot({ path: new URL(`${width}-error.png`, evidence).pathname });

    mode = 'held';
    await page.keyboard.press('Enter');
    const checking = page.getByRole('button', { name: 'Checking session...', exact: true });
    await checking.waitFor();
    assert.equal(await checking.isDisabled(), true);
    assert.equal(await alert.isVisible(), true, 'retry retains the visible error');
    await page.getByRole('status').filter({ hasText: 'Checking your session...' }).waitFor();
    for (let attempt = 0; !held && attempt < 100; attempt++) await delay(20);
    assert.ok(held, 'retry sends a fresh session lookup');
    await held.fulfill({ status: 503, json: { error: 'Still unavailable' } });
    await retry.waitFor();
    assert.equal(await retry.isEnabled(), true, 'another failure leaves retry available');
    assert.equal(sessionRequests, beforeFailure + 2);

    mode = 'normal';
    await retry.click();
    await page.locator('.app').waitFor();
    assert.equal(await alert.count(), 0, 'successful retry clears the error without signing in again');

    mode = 'network';
    await page.reload();
    await retry.waitFor();
    assert.equal(await page.locator('.signin').count(), 0, 'network failure does not imply sign-out');
    mode = 'normal';
    await retry.click();
    await page.locator('.app').waitFor();

    mode = 'server';
    await page.reload();
    await retry.waitFor();
    const logout = await page.request.post(`${backend}/api/auth/logout`);
    assert.equal(logout.status(), 200);
    mode = 'normal';
    await retry.click();
    await page.getByRole('heading', { name: 'Welcome to Swarm' }).waitFor();
    assert.equal(await alert.count(), 0, 'confirmed sign-out clears the stale error');
    assert.equal(await page.getByRole('button', { name: 'Continue with email', exact: true }).isVisible(), true);
    assert.deepEqual(unexpected, [], 'no page errors, live requests, or unexpected API calls');
    await page.close();
  }
  console.log('PASS P-09: stalled boot and retry deadlines, successful recovery. PASS A-03: signed-in reload failure, visible error, keyboard retry, pending and repeated failure, recovery, network failure, confirmed sign-out at 1280, 1024, 768, 390px.');
} finally {
  await browser?.close();
  await Promise.all(children.map(child => new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill('SIGTERM');
  })));
  await rm(root, { recursive: true, force: true });
}
