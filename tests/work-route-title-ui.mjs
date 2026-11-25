// QA T-title: real local auth and SQLite, Vite UI, mocked model/toolkit backends.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'work-route-title-'));
const evidence = path.join(root, '.context/work-route-title');
await fs.mkdir(evidence, { recursive: true });
async function freePort() {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}
const apiPort = await freePort(), uiPort = await freePort(), modelPort = await freePort();
const base = `http://127.0.0.1:${uiPort}`, apiBase = `http://127.0.0.1:${apiPort}`;
const modelBase = `http://127.0.0.1:${modelPort}`;
// Do not inherit provider credentials or database settings from the caller.
const env = {
  PATH: process.env.PATH, NODE_ENV: 'test', SWARM_ROLE: 'standalone', DEV_LOGIN: '1',
  DB_PATH: path.join(temp, 'app.db'), FILES_DIR: path.join(temp, 'files'),
  CLI_PROFILES_DIR: path.join(temp, 'profiles'), SESSION_SECRET: 'work-route-title-fixture',
  PORT: String(apiPort), APP_URL: base, SERVER_URL: base, COMPUTER_PROVIDER: 'local',
  SWARM_NO_SCHEDULER: '1', MEMORY_CONSOLIDATE_IDLE_MINUTES: '0', WHATSAPP_DISABLED: '1', INKBOX_TUNNEL: '0',
  LLM_PROVIDER: 'direct', DIRECT_API_KEY: 'fixture-only', DIRECT_BASE_URL: `${modelBase}/v1`,
  OPENROUTER_BASE_URL: `${modelBase}/v1`, COMPOSIO_API_KEY: 'fixture-only',
};
const preload = path.join(temp, 'mock-backends.mjs');
await fs.writeFile(preload, `
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init);
  if (url.hostname === 'backend.composio.dev') return Response.json({ items: [], next_cursor: null });
  if (url.hostname === 'openrouter.ai' && url.pathname.endsWith('/models')) return Response.json({ data: [] });
  throw new Error('Unexpected external request: ' + url.origin + url.pathname);
};
`);
const children = [], logs = [];
let browser;
function start(args, cwd = root, extra = {}) {
  const child = spawn(process.execPath, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => logs.push(String(data)));
  return child;
}
async function ready(url, child) {
  for (let attempt = 0; attempt < 300; attempt++) {
    assert.equal(child.exitCode, null, logs.join(''));
    if (await fetch(url).then(response => response.ok, () => false)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Local server did not start: ${logs.join('')}`);
}

try {
  await ready(`${modelBase}/v1/models`, start(['tests/mock-provider.mjs', String(modelPort)]));
  await ready(`${apiBase}/api/health`, start(['--import', preload, '--import', 'tsx', 'server/src/index.ts']));
  await ready(base, start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(root, 'web'), { SWARM_API: apiBase }));
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const width of [390, 768, 1280, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const login = await context.request.post(`${base}/api/auth/dev`, { data: { email: `title-${width}@example.test`, name: 'QA account' } });
    assert.equal(login.status(), 200);
    const { bots } = await (await context.request.get(`${base}/api/bots`)).json();
    const bot = bots.find(item => item.isPrimary);
    assert.ok(bot);
    assert.equal((await context.request.patch(`${base}/api/bots/${bot.id}`, { data: { name: 'Reports QA Bot' } })).status(), 200);
    const { botSlug } = await import('../web/src/lib/userRoutes.ts');
    const slug = botSlug({ ...bot, name: 'Reports QA Bot' });
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      // Capture every title assignment, including changes within one render cycle.
      window.titleHistory = [];
      const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'title');
      Object.defineProperty(document, 'title', {
        get() { return descriptor.get.call(this); },
        set(value) { window.titleHistory.push(value); descriptor.set.call(this, value); },
      });
      // Keep roster delivery controlled by the held HTTP response.
      window.EventSource = class {
        constructor() { setTimeout(() => this.onopen?.(), 0); }
        close() {}
      };
    });
    let holdRoster = false;
    const held = [];
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== base) { errors.push(`External browser request: ${url.origin}`); return route.abort(); }
      if (url.pathname === '/api/bots' && holdRoster) { held.push(route); return; }
      return route.continue();
    });
    for (const tab of ['Reports', 'Tasks', 'Team', 'Goals']) {
      for (const exists of [true, false]) {
        holdRoster = false;
        const reference = exists ? slug : 'missing-qa-bot';
        await page.goto(`${base}/#bot/${reference}/${tab.toLowerCase()}`);
        // Reload also clears an empty roster retained by the preceding recovery case.
        await page.reload();
        const expected = `${exists ? 'Reports QA Bot' : 'Bot unavailable'} · ${tab}`;
        await page.waitForFunction(title => document.title === `${title} · Swarm`, expected);
        holdRoster = true;
        await page.reload();
        const heading = page.locator('#tasks-heading');
        await heading.waitFor({ state: 'visible' });
        for (let attempt = 0; !held.length && attempt < 100; attempt++) await page.waitForTimeout(20);
        assert.ok(held.length, 'Reload requests the roster');
        await page.waitForTimeout(2200);
        assert.equal(await page.title(), `${tab} · Swarm`, 'Loading title is neutral');
        assert.equal(await heading.innerText(), tab, 'Loading heading is neutral');
        await page.locator('.tasks-view').getByText('Loading Bots...', { exact: true }).waitFor();
        assert.equal(await page.locator('.tasks-view').getByText(/Bot unavailable|This Bot is no longer available/).count(), 0, 'No missing Bot content while loading');
        assert.ok(!(await page.evaluate(() => window.titleHistory)).some(title => title.includes('Bot unavailable')), 'No unavailable title during the entire loading window');
        holdRoster = false;
        for (const route of held.splice(0)) await route.fulfill({ response: await route.fetch() });
        await page.waitForFunction(title => document.title === `${title} · Swarm`, expected);
        await page.waitForFunction(title => document.querySelector('#tasks-heading')?.textContent === title, expected);
        assert.equal(await heading.isVisible(), true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Work route fits the viewport');
        console.log(`PASS ${width}px ${tab}: neutral during reload, ${exists ? 'Bot name' : 'unavailable'} after roster`);
      }
      for (const empty of [false, true]) {
        holdRoster = true;
        await page.goto(`${base}/#bot/${slug}/${tab.toLowerCase()}`);
        await page.reload();
        const work = page.locator('.tasks-view');
        const retry = work.getByRole('button', { name: 'Retry Bots', exact: true });
        await work.getByText('Loading Bots...', { exact: true }).waitFor();
        for (let attempt = 0; !held.length && attempt < 100; attempt++) await page.waitForTimeout(20);
        assert.ok(held.length, 'Failure scenario requests the roster');
        if (tab === 'Reports' && !empty) await page.screenshot({ path: path.join(evidence, `pending-${width}.png`) });
        for (const route of held.splice(0)) await route.fulfill({ status: 503, json: { error: 'Fixture unavailable' } });
        await retry.waitFor();
        await work.getByRole('alert').getByText("Couldn't load your Bots. Check your connection and try again.", { exact: true }).waitFor();
        assert.equal(await page.title(), `${tab} · Swarm`, 'Failure does not confirm a missing Bot');
        assert.equal(await page.locator('#tasks-heading').innerText(), tab);
        await retry.click();
        await work.getByText('Retrying...', { exact: true }).waitFor();
        assert.equal(await retry.isDisabled(), true, 'Pending retry cannot be submitted twice');
        for (let attempt = 0; !held.length && attempt < 100; attempt++) await page.waitForTimeout(20);
        assert.ok(held.length, 'Retry requests the roster');
        assert.equal(await page.title(), `${tab} · Swarm`, 'Pending retry keeps the neutral title');
        assert.equal(await page.locator('#tasks-heading').innerText(), tab);
        assert.ok(!(await page.evaluate(() => window.titleHistory)).some(title => title.includes('Bot unavailable')), 'Failure and retry never claim the Bot is missing');
        assert.equal(await work.getByText(/Bot unavailable|This Bot is no longer available/).count(), 0);
        holdRoster = false;
        for (const route of held.splice(0)) {
          if (empty) await route.fulfill({ json: { bots: [], live: [] } });
          else await route.fulfill({ response: await route.fetch() });
        }
        const expected = `${empty ? 'Bot unavailable' : 'Reports QA Bot'} · ${tab}`;
        await page.waitForFunction(title => document.title === `${title} · Swarm` && document.querySelector('#tasks-heading')?.textContent === title, expected);
        assert.equal(await page.locator('#tasks-heading').isVisible(), true);
        assert.equal(await work.locator('.load-feedback').count(), 0, 'Successful roster clears recovery feedback, including empty success');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        console.log(`PASS ${width}px ${tab}: failure and pending retry stay neutral, recover to ${empty ? 'empty' : 'populated'} roster`);
      }
    }
    assert.deepEqual(errors, [], 'No page errors or external browser requests');
    await context.close();
  }
} catch (error) {
  await fs.writeFile(path.join(evidence, 'server.log'), logs.join(''));
  throw error;
} finally {
  await browser?.close();
  for (const child of children.reverse()) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
    }
  }
  await fs.rm(temp, { recursive: true, force: true });
}
