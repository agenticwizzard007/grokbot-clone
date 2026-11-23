// QA SO L-10: real local auth and SQLite, Vite UI, mocked model/toolkit backends.
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
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'saved-reports-label-'));
const evidence = path.join(root, '.context/saved-reports-label');
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
  CLI_PROFILES_DIR: path.join(temp, 'profiles'), SESSION_SECRET: 'saved-reports-label-fixture',
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
  for (const width of [1280, 1024, 768, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    const login = await context.request.post(`${base}/api/auth/dev`, { data: { email: `reports-${width}@example.test`, name: 'QA account' } });
    assert.equal(login.status(), 200);
    const { bots } = await (await context.request.get(`${base}/api/bots`)).json();
    const bot = bots.find(item => item.isPrimary);
    assert.ok(bot, 'Local dev account has a Bot');
    const rename = await context.request.patch(`${base}/api/bots/${bot.id}`, { data: { name: 'Reports QA Bot' } });
    assert.equal(rename.status(), 200);
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== base) { errors.push(`External browser request: ${url.origin}`); return route.abort(); }
      return route.continue();
    });
    await page.addInitScript(botId => {
      localStorage.setItem('swarm.selectedBot', botId);
      localStorage.setItem('swarm.theme', 'light');
    }, bot.id);
    await page.goto(base);
    if (width <= 760) await page.locator('.pinned__tile').click();
    await page.getByRole('button', { name: 'Open Reports QA Bot details', exact: true }).click();
    const panel = page.getByRole('complementary', { name: 'Conversation details' });
    await panel.getByRole('navigation', { name: 'Conversation details sections' }).getByRole('button', { name: 'Files', exact: true }).click();
    const row = panel.locator('.details-page__row').filter({ has: page.locator('strong', { hasText: /^Saved reports$/ }) });
    await row.waitFor();
    assert.equal(await row.count(), 1, 'Exactly one saved reports row');
    assert.equal(await row.getByText('Saved reports', { exact: true }).count(), 1, 'The row label appears once');
    assert.equal(await row.getByRole('button', { name: 'Saved reports', exact: true }).count(), 0, 'The action does not duplicate the label');
    const action = row.getByRole('button', { name: 'View saved reports', exact: true });
    await action.scrollIntoViewIfNeeded();
    assert.ok(await action.isVisible(), 'Distinct reports action is visible');
    const geometry = await row.evaluate(element => {
      const title = element.querySelector('strong'), button = element.querySelector('button');
      const bounds = element.getBoundingClientRect(), label = title.getBoundingClientRect(), action = button.getBoundingClientRect();
      const range = document.createRange(); range.selectNodeContents(button);
      const text = range.getBoundingClientRect();
      return {
        fits: bounds.left >= 0 && bounds.right <= innerWidth && element.scrollWidth <= element.clientWidth,
        separate: label.right <= action.left,
        textFits: text.left >= action.left && text.right <= action.right && text.top >= action.top && text.bottom <= action.bottom,
      };
    });
    assert.deepEqual(geometry, { fits: true, separate: true, textFits: true }, `${width}px: row and action text fit without overlap`);
    await page.screenshot({ path: path.join(evidence, `${width}-files.png`) });
    const reportsLoaded = page.waitForResponse(response => new URL(response.url()).pathname === `/api/deliverables/bots/${bot.id}` && response.ok());
    await action.click();
    await reportsLoaded;
    await panel.getByRole('heading', { name: 'No saved reports yet', exact: true }).waitFor();
    await panel.getByRole('button', { name: 'Back to files', exact: true }).click();
    await action.waitFor();
    await panel.getByRole('region', { name: 'Computer files' }).waitFor();
    assert.equal(await row.getByText('Saved reports', { exact: true }).count(), 1, 'Returning to Files keeps one label');
    assert.deepEqual(errors, [], 'No page errors or external browser requests');
    await context.close();
    console.log(`PASS saved reports label ${width}px: distinct action, no clipping or overlap, reports open and Back to files works`);
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
