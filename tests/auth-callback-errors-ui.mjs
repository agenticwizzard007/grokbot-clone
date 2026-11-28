// QA SO A-02: real local sessions, temporary SQLite, mocked providers and toolkits.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-auth-callback-ui-'));
const screenshots = '.context/auth-callback-errors';
fs.mkdirSync(screenshots, { recursive: true });
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
function start(args, env = {}) {
  // Only pass local fixture configuration, never workspace provider credentials.
  const child = spawn(process.execPath, args, {
    env: { PATH: process.env.PATH, HOME: root, NODE_ENV: 'development', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => logs.push(String(data)));
}
async function until(check) {
  for (let attempt = 0; attempt < 200; attempt++) { if (await check()) return; await sleep(100); }
  throw new Error('Timed out waiting for auth callback fixture');
}

const apiPort = await port(), mockPort = await port(), webPort = await port();
const backend = `http://127.0.0.1:${apiPort}`, base = `http://127.0.0.1:${webPort}`;
const cases = [
  { code: 'google_denied', provider: 'Google', message: 'Google sign-in was cancelled. You can try again or choose another sign-in option.' },
  { code: 'apple_denied', provider: 'Apple', message: 'Apple sign-in was cancelled. You can try again or choose another sign-in option.' },
  { code: 'openrouter_denied', provider: 'OpenRouter', message: 'OpenRouter authorization was cancelled. You can try again.' },
  { code: 'google_session', provider: 'Google', message: 'That sign-in link expired. Please try again.' },
  { code: 'apple_invalid', provider: 'Apple', message: 'Apple sign-in could not be verified. Please try again.' },
  { code: 'openrouter_session', provider: 'OpenRouter', message: 'This OpenRouter sign-in expired or does not match this browser. Please start again.' },
];

try {
  start(['tests/mock-provider.mjs', String(mockPort)]);
  start(['--import', 'tsx', 'server/src/index.ts'], {
    SWARM_ROLE: 'standalone', DB_PATH: path.join(root, 'app.db'), FILES_DIR: path.join(root, 'files'),
    SESSION_SECRET: 'auth-callback-fixture-only', COMPUTER_PROVIDER: 'local', DEV_LOGIN: '1', PORT: String(apiPort),
    APP_URL: base, SERVER_URL: backend, DIRECT_API_KEY: 'mock-key', DIRECT_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
    LLM_PROVIDER: 'direct', SWARM_NO_SCHEDULER: '1', WHATSAPP_DISABLED: '1', MEMORY_CONSOLIDATE_IDLE_MINUTES: '0', INKBOX_TUNNEL: '0',
  });
  start(['web/node_modules/vite/bin/vite.js', 'web', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], { SWARM_API: backend });
  await until(() => fetch(`${backend}/api/health`).then(response => response.ok, () => false));
  await until(() => fetch(base).then(response => response.ok, () => false));
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });

  for (const width of [1280, 1024, 768, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    await context.route('**/api/apps?*', route => route.fulfill({ json: { apps: [], connected: [], connectedApps: [], categories: [], total: 0 } }));
    // Expose retry controls without configuring any real OAuth provider.
    await context.route('**/api/auth/me', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), googleLogin: true, appleLogin: true } });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));

    // Preserve signed-out banners, expiry notice, retry destinations and URL cleanup.
    for (const test of cases) {
      await page.goto(`${base}/?keep=fixture&login=${test.code}`);
      await page.getByRole('alert').waitFor();
      assert.equal(await page.getByRole('alert').innerText(), test.message);
      assert.equal(await page.locator(`a[href="/api/auth/${test.provider.toLowerCase()}/start"]`).count(), test.provider === 'Google' ? 2 : 1);
      assert.equal(new URL(page.url()).search, '?keep=fixture');
    }
    await page.goto(`${base}/?login=expired`);
    await page.getByRole('status').filter({ hasText: 'That sign-in link has expired or was already used.' }).waitFor();
    await page.getByLabel('Email', { exact: true }).fill(`callback-${width}@example.test`);
    await page.getByRole('button', { name: 'Continue with email', exact: true }).click();
    await page.locator('.app').waitFor();
    const user = (await (await context.request.get(`${base}/api/auth/me`)).json()).user;
    assert.ok(user.id, 'use a real local session');

    for (const test of cases) {
      await page.goto(`${base}/?keep=fixture&login=${test.code}#settings/account`);
      const banner = page.locator('.auth-callback[role="alert"]');
      await banner.waitFor();
      await page.getByRole('heading', { name: 'Account', exact: true }).waitFor();
      assert.equal(await banner.locator('.auth-callback__message').innerText(), test.message);
      assert.ok(await page.locator('.app').isVisible(), 'keep the existing session shell');
      assert.equal(await page.locator('.signin').count(), 0);
      assert.equal(new URL(page.url()).search, '?keep=fixture');
      assert.equal(new URL(page.url()).hash, '#settings/account');
      const reviewGoogleLink = test.provider === 'Google';
      const retry = banner.getByRole('link', { name: reviewGoogleLink ? 'Review Google sign-in' : `Try ${test.provider} again`, exact: true });
      const retryPath = reviewGoogleLink ? '/#settings/messaging' : `/api/auth/${test.provider.toLowerCase()}/start`;
      assert.equal(await retry.getAttribute('href'), retryPath);
      const geometry = await banner.evaluate(el => {
        const rect = el.getBoundingClientRect(), shell = document.querySelector('.app').getBoundingClientRect(), settings = document.querySelector('.app-settings').getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, right: rect.right, shellTop: shell.top, shellBottom: shell.bottom, settingsTop: settings.top, width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth };
      });
      assert.ok(geometry.top >= 0 && geometry.right <= geometry.width && geometry.bottom <= geometry.height, 'banner fits in viewport');
      assert.ok(geometry.shellTop >= geometry.bottom && geometry.shellBottom <= geometry.height + 1, 'banner does not cover or push the shell offscreen');
      assert.ok(geometry.settingsTop >= geometry.bottom, 'portalled settings do not hide the banner');
      assert.ok(geometry.scrollWidth <= width, 'no horizontal overflow');
      for (const action of [retry, banner.getByRole('button')]) {
        const box = await action.boundingBox();
        assert.ok(box && box.x >= 0 && box.x + box.width <= width && box.height >= 44, 'retry and dismiss stay visible and tappable');
      }
      if (test.code.endsWith('_denied')) await page.screenshot({ path: `${screenshots}/${test.code}-${width}.png` });

      // Exercise retry navigation locally, returning another failure without leaving the fixture.
      if (reviewGoogleLink) {
        await retry.click();
        await page.getByRole('heading', { name: 'Messaging', exact: true }).waitFor();
        await page.locator('.access-messaging summary').filter({ hasText: 'Learn more' }).click();
        assert.equal(await page.getByRole('link', { name: 'Connect Google', exact: true }).getAttribute('href'), '/api/auth/google/start?intent=link');
        assert.equal(await banner.count(), 0);
        await page.goto(`${base}/?login=${test.code}`);
        await banner.waitFor();
      } else {
        let retries = 0;
        await context.route(`${base}${retryPath}`, route => {
          retries++;
          return route.fulfill({ status: 302, headers: { location: `${base}/?login=${test.code}` }, body: '' });
        });
        await retry.click();
        await page.waitForURL(base + '/');
        await banner.waitFor();
        assert.equal(retries, 1);
        assert.equal(await banner.locator('.auth-callback__message').innerText(), test.message);
        await context.unroute(`${base}${retryPath}`);
      }
      assert.equal((await (await context.request.get(`${base}/api/auth/me`)).json()).user.id, user.id);

      await banner.getByRole('button', { name: 'Dismiss sign-in error' }).click();
      assert.equal(await banner.count(), 0);
      assert.ok(await page.locator('.app').isVisible());
      await page.reload();
      await page.locator('.app').waitFor();
      assert.equal(await banner.count(), 0, 'consumed failures do not replay on reload');
    }

    for (const query of ['', '?login=unknown', '?login=constructor', '?signed_in=1']) {
      await page.goto(`${base}/${query}`);
      await page.locator('.app').waitFor();
      assert.equal(await page.locator('.auth-callback').count(), 0, 'ordinary or successful navigation has no error banner');
    }
    await page.evaluate(accountId => sessionStorage.setItem('swarm.resume', JSON.stringify({
      section: 'subscriptions', provider: 'codex', action: 'login', accountId, expiresAt: Date.now() + 600_000,
    })), user.id);
    await page.goto(`${base}/?login=google_denied`);
    await page.locator('.auth-callback').waitFor();
    assert.equal(await page.locator('.auth-callback').getByRole('link', { name: 'Try Google again', exact: true }).getAttribute('href'), '/api/auth/google/start');
    await page.locator('.subscription-reauth').getByText('Sign-in did not complete. Try again to continue.', { exact: true }).waitFor();
    assert.equal(await page.getByText(/You’re signed in again/).count(), 0, 'a failed callback must not become a successful reauthentication');
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS A-02 at ${width}: signed-in and signed-out provider errors, retry, dismiss, URL cleanup, session preservation and layout.`);
  }
} catch (error) {
  console.error(logs.join('').slice(-4000));
  throw error;
} finally {
  await browser?.close();
  for (const child of children) child.kill();
  await sleep(300);
  fs.rmSync(root, { recursive: true, force: true });
}
