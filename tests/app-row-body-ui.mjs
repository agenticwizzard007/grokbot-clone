// QA SO L-04: local dev app, disposable SQLite, and mocked model/toolkit backends.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const root = new URL('..', import.meta.url);
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-app-row-body-'));
const evidence = new URL('../.context/app-row-body/', import.meta.url);
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
  SESSION_SECRET: 'app-row-body-local-fixture', COMPUTER_PROVIDER: 'local', SWARM_NO_SCHEDULER: '1',
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
const apps = [
  { slug: 'github', name: 'GitHub', description: 'Review code and track issues across your projects.', connected: false },
  { slug: 'gmail', name: 'Gmail', description: 'Search messages and organize your inbox.', connected: true },
  { slug: 'builtin', name: 'Built-in toolkit', description: 'Tools available without connecting an account.', connected: false, noAuth: true },
].map(app => ({ categories: [], ...app }));

async function appearance(row) {
  return row.evaluate(element => [element, ...element.querySelectorAll('.app-row__text, .app-row__name, .app-row__desc')].map(node => {
    const style = getComputedStyle(node);
    return {
      cursor: style.cursor, background: style.backgroundColor, shadow: style.boxShadow,
      transform: style.transform, color: style.color, opacity: style.opacity,
      height: node.getBoundingClientRect().height,
    };
  }));
}

try {
  start(['tests/mock-provider.mjs', String(modelPort)]);
  start(['--import', 'tsx', 'server/src/index.ts']);
  start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], new URL('../web', import.meta.url));
  await Promise.all([ready(`${apiOrigin}/api/health`), ready(`${modelOrigin}/v1/models`), ready(origin)]);
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const width of [1280, 1024, 768, 390]) {
    for (const surface of ['modal', 'settings']) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
      const errors = [], mutations = [];
      let connected = true;
      assert.equal((await context.request.post(`${origin}/api/auth/dev`, { data: { email: 'app-row@example.test', name: 'QA account' } })).status(), 200);
      await context.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== origin) { errors.push(`External request: ${url.origin}`); return route.abort(); }
        if (url.pathname === '/api/apps') {
          const catalog = apps.map(app => app.slug === 'gmail' ? { ...app, connected } : app);
          return route.fulfill({ json: { apps: catalog, connected: connected ? ['gmail'] : [], connectedApps: catalog.filter(app => app.connected), categories: [], total: catalog.length } });
        }
        if (url.pathname === '/api/apps/connections') return route.fulfill({ json: { connections: [] } });
        if (url.pathname === '/api/apps/github/connect' && request.method() === 'POST') {
          mutations.push('connect');
          return route.fulfill({ json: { redirectUrl: `${origin}/fixture-authorize` } });
        }
        if (url.pathname === '/api/apps/gmail' && request.method() === 'DELETE') {
          mutations.push('disconnect'); connected = false;
          return route.fulfill({ json: { ok: true } });
        }
        if (url.pathname.startsWith('/api/apps/')) { errors.push(`Unexpected toolkit request: ${url.pathname}`); return route.abort(); }
        if (url.pathname === '/api/auth/me' && request.method() === 'PATCH') {
          assert.deepEqual(Object.keys(request.postDataJSON()), ['timezone']);
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
        window.popupCalls = [];
        window.open = url => {
          window.popupCalls.push(url);
          return { closed: false, location: { href: '' }, close() {} };
        };
      });
      await page.goto(surface === 'settings' ? `${origin}/#settings/apps` : origin);
      if (surface === 'settings') await page.getByRole('button', { name: 'Manage apps', exact: true }).click();
      else {
        // Open through the store so mobile sidebar visibility does not affect this row test.
        await page.waitForFunction(async () => !!(await import('/src/store.ts')).useStore.getState().user);
        await page.evaluate(async () => (await import('/src/store.ts')).useStore.getState().setModal('apps'));
      }
      const catalog = page.locator('.access-apps-catalog');
      await catalog.getByRole('button', { name: 'Connect GitHub', exact: true }).waitFor();
      const [response] = await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname === '/api/apps'),
        catalog.getByRole('button', { name: 'All', exact: true }).click(),
      ]);
      await response.finished();
      await catalog.getByRole('heading', { name: 'All apps', exact: true }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      const rowFor = name => catalog.locator('.app-row').filter({ has: page.locator('.app-row__name', { hasText: name }) });
      for (const app of apps) {
        const row = rowFor(app.name);
        await row.scrollIntoViewIfNeeded();
        await catalog.getByRole('heading', { name: 'Connect an app', exact: true }).hover();
        const rest = await appearance(row);
        assert.ok(rest.every(style => style.cursor === 'default'), 'row body uses a normal cursor');
        assert.equal(rest[3].opacity, '1', 'description is visible before hover');
        assert.ok(rest[3].height > 0);
        assert.equal(await row.locator('.app-row__text').evaluate(element => element.tabIndex), -1);
        assert.equal(await row.locator('.app-row__text :is(button, a, [role="button"], [tabindex])').count(), 0);
        for (const part of ['.app-row__name', '.app-row__desc']) {
          await row.locator(part).hover();
          assert.deepEqual(await appearance(row), rest, 'body hover has no visual affordance');
          await row.locator(part).click();
          assert.deepEqual(await appearance(row), rest, 'body click has no visual affordance');
        }
        assert.deepEqual(mutations, [], 'body clicks never connect or disconnect');
        assert.deepEqual(await page.evaluate(() => window.popupCalls), [], 'body clicks never open a provider window');
        const actions = row.getByRole('button');
        assert.equal(await actions.count(), app.noAuth ? 0 : 1, 'only the real action is a button');
        if (!app.noAuth) {
          const button = actions.first();
          const before = await button.evaluate(element => getComputedStyle(element).backgroundColor);
          await button.hover();
          assert.equal(await button.evaluate(element => getComputedStyle(element).cursor), 'pointer');
          await page.waitForFunction(({ element, before }) => getComputedStyle(element).backgroundColor !== before, { element: await button.elementHandle(), before });
          await button.focus();
          await page.keyboard.press('Shift+Tab');
          assert.equal(await row.evaluate(element => element.contains(document.activeElement)), false, 'body is skipped by keyboard navigation');
          await page.keyboard.press('Tab');
          assert.equal(await button.evaluate(element => element === document.activeElement), true, 'action is keyboard accessible');
        }
      }
      await rowFor('GitHub').locator('.app-row__name').hover();
      await page.screenshot({ path: new URL(`${surface}-${width}.png`, evidence).pathname });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await rowFor('GitHub').getByRole('button', { name: 'Connect GitHub', exact: true }).focus();
      await page.keyboard.press('Enter');
      await rowFor('GitHub').getByRole('button', { name: 'Refresh status', exact: true }).waitFor();
      assert.deepEqual(mutations, ['connect'], 'keyboard Connect invokes only the mocked endpoint');
      assert.deepEqual(await page.evaluate(() => window.popupCalls), ['about:blank']);
      await rowFor('Gmail').getByRole('button', { name: 'Disconnect Gmail', exact: true }).focus();
      await page.keyboard.press('Enter');
      await rowFor('Gmail').getByRole('button', { name: 'Confirm disconnect', exact: true }).waitFor();
      assert.deepEqual(mutations, ['connect'], 'disconnect still requires confirmation');
      await rowFor('Gmail').getByRole('button', { name: 'Cancel', exact: true }).click();
      await rowFor('Gmail').getByRole('button', { name: 'Disconnect Gmail', exact: true }).click();
      await rowFor('Gmail').getByRole('button', { name: 'Confirm disconnect', exact: true }).click();
      await rowFor('Gmail').getByRole('button', { name: 'Connect Gmail', exact: true }).waitFor();
      assert.deepEqual(mutations, ['connect', 'disconnect']);
      assert.deepEqual(errors, [], 'no browser errors, external providers, or unexpected writes');
      await context.close();
      console.log(`PASS L-04 ${surface} ${width}px: static bodies, visible descriptions, action hover, keyboard actions, mocked connect/disconnect`);
    }
  }
} catch (error) {
  await fs.writeFile(new URL('server.log', evidence), log);
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
