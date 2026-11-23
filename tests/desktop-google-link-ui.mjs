// P-03: local dev UI, temporary SQLite, DEV_LOGIN=1, and mocked Google/model/toolkits.
// Run: node tests/desktop-google-link-ui.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const root = process.cwd(), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-google-'));
const evidence = path.join(root, '.context/desktop-google');
fs.mkdirSync(evidence, { recursive: true });
const children = [], logs = [];
let browser;
async function port() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
async function ready(url) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await fetch(url).then(response => response.ok, () => false)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Local fixture did not start');
}
const apiPort = await port(), uiPort = await port(), modelPort = await port();
const apiBase = `http://127.0.0.1:${apiPort}`, base = `http://127.0.0.1:${uiPort}`;
const modelBase = `http://127.0.0.1:${modelPort}`;
const env = {
  PATH: process.env.PATH, HOME: process.env.HOME,
  DB_PATH: path.join(temp, 'app.db'), FILES_DIR: path.join(temp, 'files'),
  DESKTOP_GOOGLE_FIXTURE: path.join(temp, 'fixture.json'),
  SESSION_SECRET: 'desktop-google-test-only', SWARM_ROLE: 'standalone', NODE_ENV: 'test',
  DEV_LOGIN: '1', COMPUTER_PROVIDER: 'local', PORT: String(apiPort), APP_URL: base, SERVER_URL: base,
  GOOGLE_CLIENT_ID: 'desktop-fixture-client', GOOGLE_CLIENT_SECRET: 'desktop-fixture-only',
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

try {
  start(['tests/mock-provider.mjs', String(modelPort)]);
  await ready(`${modelBase}/v1/models`);
  start(['--import', 'tsx', 'tests/fixtures/desktop-google-server.mts']);
  await ready(`${apiBase}/api/health`);
  start([path.join(root, 'web/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(root, 'web'));
  await ready(base);
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const fixtures = JSON.parse(fs.readFileSync(env.DESKTOP_GOOGLE_FIXTURE, 'utf8'));
  for (const fixture of fixtures) {
    const context = await browser.newContext({ viewport: { width: fixture.width, height: 900 } });
    let outcome = 'denied', available = true, authorizations = 0;
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.fallback() : route.abort());
    // Intercept the local start response before the browser follows an external redirect.
    await context.route('**/api/auth/google/start*', async route => {
      const response = await route.fetch({ maxRedirects: 0 });
      const url = new URL(response.headers().location);
      if (url.hostname === 'accounts.google.com') {
        authorizations++;
        const callback = new URL(url.searchParams.get('redirect_uri'));
        assert.equal(callback.origin, base);
        callback.searchParams.set('state', url.searchParams.get('state'));
        if (outcome === 'denied') callback.searchParams.set('error', 'access_denied');
        else callback.searchParams.set('code', Buffer.from(JSON.stringify({
          nonce: url.searchParams.get('nonce'), fixture: fixture.width, verified: outcome === 'linked',
        })).toString('base64url'));
        return route.fulfill({ response, status: 302, headers: { ...response.headers(), location: callback.href }, body: '' });
      }
      assert.equal(url.origin, base);
      return route.fulfill({ response });
    });
    await context.route('**/api/auth/me', async route => {
      const response = await route.fetch();
      const body = await response.json();
      return route.fulfill({ response, json: { ...body, googleLogin: available } });
    });
    // A Gmail toolkit connection does not establish Google sign-in.
    await context.route('**/api/apps**', route => route.fulfill({ json: { apps: [], connected: ['gmail'], connectedApps: [{ slug: 'gmail' }], connections: [], categories: [] } }));
    await context.route('**/api/toolkits/**', route => route.fulfill({ json: { items: [] } }));
    await context.route('**/api/bots/*/suggested-apps', route => route.fulfill({ json: { suggestions: [], status: 'ready' } }));
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(15000);
    const me = async () => (await context.request.get(`${base}/api/auth/me`)).json();
    const bots = async () => (await (await context.request.get(`${base}/api/bots`)).json()).bots.map(bot => ({ id: bot.id })).sort((a, b) => a.id.localeCompare(b.id));
    const settings = async () => {
      await page.goto(`${base}/?fixture=${Date.now()}#settings/messaging`);
      await page.getByRole('heading', { name: 'Text your Bots', exact: true }).waitFor();
    };
    const connect = () => page.getByRole('link', { name: 'Connect Google', exact: true });
    const connected = () => page.getByText('Google connected', { exact: true });
    await page.goto(fixture.loginLink);
    assert.equal((await me()).user.id, fixture.id);
    assert.equal((await me()).googleLinked, false);
    assert.deepEqual(await bots(), fixture.bots);
    const obsolete = await context.request.put(`${base}/api/messaging/email`, { data: { email: `desktop-${fixture.width}@example.test` } });
    assert.equal(obsolete.status(), 410);
    assert.match((await obsolete.json()).error, /Connect Google/);
    assert.equal((await me()).googleLinked, false);

    available = false;
    await settings();
    await page.getByText('Google sign-in is unavailable on this server. You can still sign in with your phone.', { exact: true }).waitFor();
    assert.equal(await connect().count(), 0);
    available = true;
    await page.reload();
    await connect().waitFor();
    assert.equal(await page.getByLabel('Desktop sign-in email').count(), 0);
    await page.getByRole('button', { name: 'Manage Gmail', exact: true }).waitFor();
    assert.equal(await connected().count(), 0);
    await page.screenshot({ path: path.join(evidence, `unlinked-${fixture.width}.png`), fullPage: true, animations: 'disabled' });

    for (const failure of ['denied', 'unverified']) {
      outcome = failure;
      await connect().click();
      await page.getByRole('alert').filter({ hasText: failure === 'denied' ? 'Google did not approve access' : 'Google sign-in could not be verified' }).waitFor();
      assert.equal((await me()).user.id, fixture.id);
      assert.equal((await me()).googleLinked, false);
      await page.getByRole('link', { name: 'Review Google sign-in', exact: true }).click();
      await connect().waitFor();
      assert.equal(await connected().count(), 0);
    }
    outcome = 'linked';
    await connect().click();
    await page.waitForURL(url => url.origin === base && url.pathname === '/' && !url.hash);
    assert.equal((await me()).user.id, fixture.id);
    assert.equal((await me()).googleLinked, true);
    assert.deepEqual(await bots(), fixture.bots);
    await settings();
    await connected().waitFor();
    assert.equal(await connect().count(), 0);
    await page.screenshot({ path: path.join(evidence, `linked-${fixture.width}.png`), fullPage: true, animations: 'disabled' });

    // A fresh browser session signs in with Google to the original phone account.
    await context.clearCookies();
    await page.goto(`${base}/api/auth/google/start`);
    await page.waitForURL(url => url.origin === base && url.pathname === '/');
    assert.equal((await me()).user.id, fixture.id);
    assert.equal((await me()).googleLinked, true);
    assert.deepEqual(await bots(), fixture.bots);
    assert.equal(authorizations, 4);
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS P-03 at ${fixture.width}px: unavailable, denied, unverified, linked, and same Bots after fresh Google sign-in`);
  }
  // Keep the existing settings lifecycle coverage green against this local dev build.
  const access = spawn(process.execPath, ['tests/access-settings-ui.mjs'], { cwd: root, env: { ...env, ACCESS_UI_BASE: base }, stdio: 'inherit' });
  children.push(access);
  assert.equal(await new Promise(resolve => access.once('exit', resolve)), 0);
} catch (error) {
  fs.writeFileSync(path.join(evidence, 'server.log'), logs.join(''));
  const page = browser?.contexts().flatMap(context => context.pages()).at(-1);
  await page?.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true, animations: 'disabled' }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); });
  }
  fs.rmSync(temp, { recursive: true, force: true });
}
