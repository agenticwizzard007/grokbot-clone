// QA SO E-01: local dev app, disposable SQLite, and mocked model/toolkit backends.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const root = new URL('..', import.meta.url);
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-connect-popup-'));
const evidence = new URL('../.context/connect-popup/', import.meta.url);
await fs.mkdir(evidence, { recursive: true });
const freePort = () => new Promise(resolve => {
  const server = http.createServer().listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});
const apiPort = await freePort(), uiPort = await freePort(), modelPort = await freePort();
const origin = `http://127.0.0.1:${uiPort}`;
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const modelOrigin = `http://127.0.0.1:${modelPort}`;
// Do not inherit credentials, deployment settings, or data locations from the workspace.
const env = {
  PATH: process.env.PATH, NODE_ENV: 'test', SWARM_ROLE: 'standalone', DEV_LOGIN: '1',
  PORT: String(apiPort), APP_URL: origin, SERVER_URL: apiOrigin, SWARM_API: apiOrigin,
  DB_PATH: path.join(temp, 'app.db'), FILES_DIR: path.join(temp, 'files'), CLI_PROFILES_DIR: path.join(temp, 'profiles'),
  SESSION_SECRET: 'connect-popup-local-fixture', COMPUTER_PROVIDER: 'local', SWARM_NO_SCHEDULER: '1',
  MEMORY_CONSOLIDATE_IDLE_MINUTES: '0', WHATSAPP_DISABLED: '1', INKBOX_TUNNEL: '0',
  DIRECT_API_KEY: 'mock-key', DIRECT_BASE_URL: `${modelOrigin}/v1`, LLM_PROVIDER: 'direct',
  OPENROUTER_BASE_URL: `${modelOrigin}/api/v1`,
};
const children = [];
let log = '', browser;
function start(args, cwd = root) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { log += data; });
  return child;
}
async function ready(url) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (children.some(child => child.exitCode !== null)) throw new Error(log);
    if (await fetch(url).then(response => response.ok, () => false)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Local server did not start: ${log}`);
}
const github = { slug: 'github', name: 'GitHub', description: 'Review code and track issues.', categories: ['developer tools'], connected: false, noAuth: false, managedAuth: true };
const waiting = 'Finish authorizing in the provider window, then refresh.';

try {
  start(['tests/mock-provider.mjs', String(modelPort)]);
  start(['--import', 'tsx', 'server/src/index.ts']);
  start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], new URL('../web', import.meta.url));
  await Promise.all([ready(`${apiOrigin}/api/health`), ready(`${modelOrigin}/v1/models`), ready(origin)]);
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const { width, native } of [...[1280, 1024, 768, 390].map(width => ({ width, native: false })), { width: 390, native: true }]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block', ...(native ? { userAgent: 'SwarmNative/1.0' } : {}) });
    const errors = [], connects = [];
    // This login creates only a synthetic account in this test's temporary database.
    assert.equal((await context.request.post(`${origin}/api/auth/dev`, { data: { email: `popup-${width}@example.test`, name: 'QA account' } })).status(), 200);
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { errors.push(`External request: ${url.origin}`); return route.abort(); }
      if (url.pathname === '/fixture-authorize') return route.fulfill({ contentType: 'text/html', body: '<title>Mock provider authorization</title>' });
      if (url.pathname === '/api/apps') return route.fulfill({ json: { apps: [github], connected: [], connectedApps: [], categories: ['developer tools'], total: 1 } });
      if (url.pathname === '/api/apps/github/connect' && request.method() === 'POST') {
        connects.push(request.postDataJSON());
        return route.fulfill({ json: { redirectUrl: `${origin}/fixture-authorize` } });
      }
      if (url.pathname.startsWith('/api/apps/')) { errors.push(`Unexpected toolkit request: ${url.pathname}`); return route.abort(); }
      if (url.pathname === '/api/auth/me' && request.method() === 'PATCH') {
        assert.deepEqual(Object.keys(request.postDataJSON()), ['timezone'], 'only automatic timezone detection may update the temporary account');
        return route.continue();
      }
      if (request.method() !== 'GET') { errors.push(`Unexpected write: ${request.method()} ${url.pathname}`); return route.abort(); }
      return route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem('swarm.theme', 'light');
      const open = window.open.bind(window);
      window.popupMode = 'blocked';
      window.popupCalls = [];
      window.open = (...args) => {
        window.popupCalls.push(args[0]);
        if (window.popupMode === 'blocked') return null;
        if (args[0] === 'about:blank') {
          if (window.popupMode === 'fallback') return null;
          if (window.popupMode === 'closed') return { closed: true, close() {} };
        }
        return open(...args);
      };
    });
    await page.goto(origin);
    await page.getByRole('button', { name: 'Connect apps', exact: true }).click();
    const modal = page.getByRole('dialog', { name: 'Connect Apps', exact: true });
    await modal.getByLabel('Search apps', { exact: true }).fill('GitHub');
    const row = modal.locator('.app-row').filter({ hasText: 'GitHub' });
    const connect = row.getByRole('button', { name: 'Connect GitHub', exact: true });
    await connect.waitFor();
    await page.setViewportSize({ width, height: 900 });

    const assertBlocked = async () => {
      await row.getByRole('alert').filter({ hasText: 'Allow pop-ups and try again.' }).waitFor();
      assert.equal(await connect.isEnabled(), true, 'Connect is available for retry after allowing popups');
      assert.equal(await row.getByText(waiting, { exact: true }).count(), 0, 'blocked popups never show the authorization waiting message');
      assert.equal(await row.getByRole('button', { name: 'Refresh status', exact: true }).count(), 0, 'blocked popups have no pending-only controls');
      assert.equal(await row.getByRole('button', { name: 'Try again', exact: true }).count(), 0);
      assert.equal(context.pages().length, 1, 'no provider window opened');
    };
    await connect.click();
    if (native) {
      // WKWebView opens the final URL in the system browser and returns null.
      await row.getByText(waiting, { exact: true }).waitFor();
      assert.equal(await row.getByRole('alert').count(), 0, 'native handoff is not reported as a blocked popup');
      assert.deepEqual(await page.evaluate(() => window.popupCalls), [`${origin}/fixture-authorize`]);
      assert.equal(connects.length, 1);
      assert.deepEqual(errors, []);
      await context.close();
      console.log('PASS Connect popup native: final URL handoff preserves the waiting state');
      continue;
    }
    await assertBlocked();
    assert.equal(connects.length, 1, 'the mocked connect endpoint succeeds once');
    assert.deepEqual(await page.evaluate(() => window.popupCalls), ['about:blank', `${origin}/fixture-authorize`], 'both popup attempts were blocked');
    await page.screenshot({ path: new URL(`blocked-${width}.png`, evidence).pathname });

    const authorize = async (mode) => {
      await page.evaluate(mode => { window.popupMode = mode; }, mode);
      const popupEvent = page.waitForEvent('popup');
      await connect.click();
      const popup = await popupEvent;
      await popup.waitForURL(`${origin}/fixture-authorize`);
      await row.getByText(waiting, { exact: true }).waitFor();
      assert.equal(await row.getByRole('alert').count(), 0, 'a successful retry clears the popup error');
      assert.equal(await row.getByRole('button', { name: 'Refresh status', exact: true }).isEnabled(), true);
      await popup.close();
    };
    const blockRetry = async () => {
      await page.evaluate(() => { window.popupMode = 'blocked'; });
      await row.getByRole('button', { name: 'Try again', exact: true }).click();
      await assertBlocked();
    };
    await authorize('allowed');
    await blockRetry();
    if (width === 1280) {
      // An unavailable or closed initial window can still recover through the fallback.
      await authorize('fallback');
      await blockRetry();
      await authorize('closed');
      await blockRetry();
    }
    assert.deepEqual(errors, [], 'no browser errors, external providers, or unexpected writes');
    await context.close();
    console.log(`PASS Connect popup ${width}px: blocked error, successful retry, blocked retry clears waiting state`);
  }
} finally {
  await browser?.close();
  await Promise.all(children.map(async child => {
    if (child.exitCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }));
  await fs.rm(temp, { recursive: true, force: true });
}
