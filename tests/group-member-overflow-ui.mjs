// QA N03: local Vite UI, temporary SQLite, DEV_LOGIN, and mocked backends.
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
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'group-member-overflow-'));
const evidence = path.join(root, '.context/group-member-overflow');
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
  CLI_PROFILES_DIR: path.join(temp, 'profiles'), SESSION_SECRET: 'group-member-overflow-fixture',
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

const longName = 'W'.repeat(60);
const results = [], failures = [];
try {
  await ready(`${modelBase}/v1/models`, start(['tests/mock-provider.mjs', String(modelPort)]));
  await ready(`${apiBase}/api/health`, start(['--import', preload, '--import', 'tsx', 'server/src/index.ts']));
  await ready(base, start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(root, 'web'), { SWARM_API: apiBase }));
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const width of [390, 768, 1024, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    const login = await context.request.post(`${base}/api/auth/dev`, { data: { email: `group-${width}@example.test`, name: 'QA account' } });
    assert.equal(login.status(), 200);
    const { bots } = await (await context.request.get(`${base}/api/bots`)).json();
    const bot = bots.find(item => item.isPrimary);
    assert.ok(bot, 'The temporary account has a primary Bot');
    const rename = await context.request.patch(`${base}/api/bots/${bot.id}`, { data: { name: longName } });
    assert.equal(rename.status(), 200);
    const page = await context.newPage(), errors = [], groupWrites = [];
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== base) { errors.push(`External browser request: ${url.origin}`); return route.abort(); }
      if (url.pathname === '/api/rooms' && request.method() === 'POST') {
        groupWrites.push(url.pathname);
        return route.abort();
      }
      return route.continue();
    });
    await page.addInitScript(() => localStorage.setItem('swarm.theme', 'light'));
    await page.goto(base);
    await page.evaluate(() => { location.hash = '#new-bot'; });
    await page.getByRole('button', { name: 'Start a room instead', exact: true }).click();
    const form = page.getByRole('main', { name: 'New room', exact: true });
    const row = form.locator('.group-create__member').filter({ has: page.locator('strong', { hasText: longName }) });
    await row.waitFor();
    await page.evaluate(() => document.fonts.ready);
    await row.scrollIntoViewIfNeeded();
    assert.equal(await row.locator('strong').textContent(), longName, 'All 60 characters remain available');
    const geometry = await row.evaluate(element => {
      const title = element.querySelector('strong');
      const bounds = node => {
        const { left, right, top, bottom, width, height } = node.getBoundingClientRect();
        return { left, right, top, bottom, width, height };
      };
      const range = document.createRange();
      range.selectNodeContents(title);
      return {
        column: bounds(title.parentElement), checkbox: bounds(element.querySelector('input')),
        row: bounds(element), viewport: innerWidth,
        scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
        lines: [...range.getClientRects()].map(({ left, right, top, bottom }) => ({ left, right, top, bottom })),
      };
    });
    const check = (ok, message) => { if (!ok) failures.push(`${width}px: ${message}`); };
    check(geometry.lines.length > 1, 'The long name wraps onto multiple lines');
    for (const line of geometry.lines) {
      check(line.left >= geometry.column.left - 0.5 && line.right <= geometry.column.right + 0.5, 'Painted name stays inside its text column');
      check(line.right < geometry.checkbox.left, 'Painted name stays clear of the checkbox');
      check(line.top >= geometry.row.top && line.bottom <= geometry.row.bottom, 'The row contains every line vertically');
    }
    check(geometry.row.left >= 0 && geometry.row.right <= width, 'The member row fits the viewport');
    check(geometry.scrollWidth <= geometry.clientWidth, 'The member row has no horizontal overflow');
    check(geometry.checkbox.width === 28 && geometry.checkbox.height === 28, 'The checkbox retains its dimensions');
    const checkbox = row.getByRole('checkbox', { name: longName, exact: true });
    await checkbox.check();
    assert.ok(await checkbox.isChecked(), 'The checkbox can be clicked');
    await checkbox.focus();
    await page.keyboard.press('Space');
    assert.equal(await checkbox.isChecked(), false, 'Keyboard selection still works');
    await row.locator('strong').click();
    assert.ok(await checkbox.isChecked(), 'The wrapped name remains a clickable label');
    await page.screenshot({ path: path.join(evidence, `${width}.png`) });
    assert.deepEqual(groupWrites, [], 'Opening and selecting members never creates a group');
    assert.deepEqual(errors, [], 'No browser errors or external requests');
    results.push({ width, ...geometry });
    await context.close();
    console.log(`Checked N03 at ${width}px: text bounds, checkbox size, mouse and keyboard selection`);
  }
  await fs.writeFile(path.join(evidence, 'verification.json'), JSON.stringify({ results, failures }, null, 2) + '\n');
  assert.deepEqual(failures, [], 'Group member names must remain inside their column');
  console.log('PASS N03: 60-character member names fit at all four widths');
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
