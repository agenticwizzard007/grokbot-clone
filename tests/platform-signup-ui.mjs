// SO D-03: local standalone server, disposable SQLite and mocked provider backends.
// Run: npm run build -w web && node tests/platform-signup-ui.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
await fs.access(path.join(root, 'web/dist/index.html'));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'signup-settings-'));
const evidence = path.join(root, '.context/platform-signup');
await fs.mkdir(evidence, { recursive: true });
const children = [], logs = [], unexpected = [];
let browser;
async function port() {
  const server = net.createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
const apiPort = await port(), uiPort = await port();
const apiBase = `http://127.0.0.1:${apiPort}`, base = `http://127.0.0.1:${uiPort}`;
const env = {
  PATH: process.env.PATH, NODE_ENV: 'test', SWARM_ROLE: 'standalone', DEV_LOGIN: '1',
  DB_PATH: path.join(temp, 'app.db'), FILES_DIR: path.join(temp, 'files'),
  CLI_PROFILES_DIR: path.join(temp, 'cli'), SESSION_SECRET: 'signup-settings-test-only',
  PORT: String(apiPort), APP_URL: base, SERVER_URL: base, COMPUTER_PROVIDER: 'local',
  SWARM_NO_SCHEDULER: '1', INKBOX_TUNNEL: '0', WHATSAPP_DISABLED: '1',
  LLM_PROVIDER: 'direct', DIRECT_API_KEY: 'fixture-model-key', DIRECT_BASE_URL: 'https://model-fixture.example/v1',
  COMPOSIO_API_KEY: '',
};
function start(args, cwd = root, extra = {}) {
  const child = spawn(process.execPath, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => logs.push(String(data)));
  return child;
}
async function ready(url) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await fetch(url).then(response => response.ok, () => false)) return;
    if (children.some(child => child.exitCode !== null)) throw new Error(logs.join(''));
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Local fixture did not start: ${url}`);
}

try {
  // Mock model/catalog reads in the server process and reject other outbound fetches.
  const preload = path.join(temp, 'providers.mjs');
  await fs.writeFile(preload, `globalThis.fetch = async input => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin === 'https://model-fixture.example' && url.pathname === '/v1/models') return Response.json({ data: [] });
    if (url.hostname === 'backend.composio.dev') return Response.json({ items: [], next_cursor: null });
    throw new Error('Unexpected fixture backend request: ' + url.origin + url.pathname);
  };`);
  start(['--import', preload, '--import', 'tsx', 'server/src/index.ts']);
  await ready(`${apiBase}/api/health`);
  start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(root, 'web'), { SWARM_API: apiBase });
  await ready(base);
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const settings = { mode: 'invite', signupsPerDay: 10, memberInvites: 2, revision: 'fixture-revision' };
  for (const width of [390, 768, 1280, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const login = await context.request.post(`${base}/api/auth/dev`, { data: { email: `messaging-${width}@example.test`, name: 'QA account' } });
    assert.ok(login.ok(), 'local development login succeeds');
    const messaging = await context.request.get(`${base}/api/messaging`);
    assert.equal((await messaging.json()).owner, undefined, 'ordinary standalone account exercises platform discovery');
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => unexpected.push(error.message));
    let scenario = 'standalone', adminReads = 0, visits = 0;
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== base) { unexpected.push(`External browser request: ${url.origin}`); return route.abort(); }
      // Expose Google linking without configuring or contacting a live OAuth provider.
      if (url.pathname === '/api/auth/me') {
        const response = await route.fetch();
        return route.fulfill({ response, json: { ...await response.json(), googleLogin: true } });
      }
      // Toolkit results are fixtures; account, messaging and standalone fallback use the real local server.
      if (url.pathname === '/api/apps') return route.fulfill({ json: { apps: [], connected: [], connectedApps: [], categories: [], total: 0 } });
      if (url.pathname === '/api/platform/signup' && scenario !== 'standalone') {
        if (scenario === 'missing') return route.fulfill({ status: 404, body: 'Not Found' });
        if (scenario === 'unavailable') return route.fulfill({ status: 503, json: { error: 'Signup administration is unavailable.' } });
        return route.fulfill({ json: scenario === 'admin' ? { admin: true, settings } : { admin: false } });
      }
      if (url.pathname === '/api/messaging/invites' || url.pathname === '/api/messaging/waitlist') {
        adminReads++;
        return route.fulfill({ json: url.pathname.endsWith('/invites') ? { invites: [], next: null } : { waitlist: [], next: null } });
      }
      return route.continue();
    });
    const open = async () => {
      const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/platform/signup');
      await page.goto(`${base}/?signup-fixture=${++visits}#settings/messaging`);
      const result = await response;
      await result.finished();
      await page.getByRole('heading', { name: 'Text your Bots', exact: true }).waitFor();
      const connectGoogle = page.getByRole('link', { name: 'Connect Google', exact: true });
      await connectGoogle.waitFor({ state: 'visible' });
      assert.equal(await connectGoogle.getAttribute('href'), '/api/auth/google/start?intent=link');
      assert.equal(await connectGoogle.getAttribute('aria-disabled'), 'false');
      await page.getByText('Checking signup access…', { exact: true }).waitFor({ state: 'detached' });
      return result;
    };
    const noAdmin = async () => {
      assert.equal(await page.getByText(/Could not load signup administration/).count(), 0);
      assert.equal(await page.getByText('Signup administration', { exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Save signup settings', exact: true }).count(), 0);
      assert.equal(adminReads, 0, 'unavailable administration never loads invites or waitlist');
    };
    const standalone = await open();
    assert.equal(standalone.status(), 200);
    assert.match(standalone.headers()['content-type'], /text\/html/, 'exercise the real standalone SPA fallback');
    await noAdmin();
    await page.screenshot({ path: path.join(evidence, `standalone-${width}.png`), fullPage: true });
    scenario = 'missing';
    await open();
    await noAdmin();
    scenario = 'non-admin';
    await open();
    await noAdmin();
    scenario = 'unavailable';
    await open();
    await page.getByRole('alert').filter({ hasText: 'Could not load signup administration: Signup administration is unavailable.' }).waitFor();
    assert.equal(adminReads, 0);
    scenario = 'admin';
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.getByRole('button', { name: 'Save signup settings', exact: true }).waitFor();
    await page.getByText('Nobody is waiting.', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Who can join by phone').inputValue(), 'invite');
    assert.equal(await page.getByRole('button', { name: 'Create invite', exact: true }).count(), 1);
    assert.equal(adminReads, 2, 'platform admin loads both admin lists');
    assert.equal(await page.getByText(/Could not load signup administration/).count(), 0);
    await context.close();
    console.log(`PASS SO D-03 at ${width}px: standalone HTML, missing route, non-admin, service failure and admin retry`);
  }
  assert.deepEqual(unexpected, []);
} catch (error) {
  await fs.writeFile(path.join(evidence, 'server.log'), logs.join(''));
  const page = browser?.contexts().flatMap(context => context.pages())[0];
  await page?.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
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
