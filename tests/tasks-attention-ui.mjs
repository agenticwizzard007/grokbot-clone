// QA P-11: real local auth and SQLite, Vite UI, mocked model/toolkit backends.
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
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'tasks-attention-'));
const evidence = path.join(root, '.context/tasks-attention');
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
  CLI_PROFILES_DIR: path.join(temp, 'profiles'), SESSION_SECRET: 'tasks-attention-fixture',
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
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const login = await context.request.post(`${base}/api/auth/dev`, { data: { email: `attention-${width}@example.test`, name: 'QA account' } });
    assert.equal(login.status(), 200);
    const { bots } = await (await context.request.get(`${base}/api/bots`)).json();
    const bot = bots.find(item => item.isPrimary);
    assert.ok(bot);
    assert.equal((await context.request.patch(`${base}/api/bots/${bot.id}`, { data: { name: 'Attention QA Bot' } })).status(), 200);
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.EventSource = class {
        constructor() { setTimeout(() => this.onopen?.(), 0); }
        close() {}
      };
    });
    const task = { id: 'fixture-task', botId: bot.id, title: 'Local task in progress', state: 'working', note: 'Fixture work', updatedAt: Date.now() };
    const item = { id: 'fixture-question', botId: bot.id, botName: 'Attention QA Bot', type: 'question', title: 'Choose a fixture option', createdAt: Date.now(), seq: 1 };
    let tasks = [task], items = [], failing = false, taskFailing = false, holding = true;
    let reads = 0;
    const held = [];
    const answer = route => route.fulfill({ status: failing ? 503 : 200, json: failing ? { error: 'Fixture unavailable' } : { items } });
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== base) { errors.push(`External browser request: ${url.origin}`); return route.abort(); }
      if (url.pathname === '/api/needs-you') {
        reads++;
        if (holding) { held.push(route); return; }
        return answer(route);
      }
      if (url.pathname.endsWith('/tasks')) return route.fulfill({ status: taskFailing ? 503 : 200, json: taskFailing ? { error: 'Fixture unavailable' } : { tasks } });
      return route.continue();
    });
    const release = async () => { holding = false; for (const route of held.splice(0)) await answer(route); };
    const refresh = () => page.evaluate(botId => window.dispatchEvent(new CustomEvent('swarm:event', { detail: { type: 'tasks', botId } })), bot.id);
    const work = page.locator('.tasks-view');
    const pending = work.locator('.task-filter.is-needs_input');
    const all = work.locator('.task-filter.is-all');
    const alert = work.getByRole('alert').filter({ hasText: 'Pending input could not' });
    const retry = alert.getByRole('button', { name: 'Retry pending input', exact: true });
    const unknown = async () => {
      assert.equal(await pending.locator('.task-filter__count').innerText(), '?');
      assert.equal(await all.locator('.task-filter__count').innerText(), '?');
      assert.equal(await work.getByText(/all caught up|No tasks are waiting|No pending tasks|No tasks yet/).count(), 0);
    };
    await page.goto(base + '/#tasks');
    await work.getByText(task.title, { exact: true }).waitFor();
    await unknown();
    await work.getByText('Loading pending input...', { exact: true }).waitFor();
    failing = true;
    await release();
    await alert.getByText('Pending input could not load.', { exact: true }).waitFor();
    await unknown();
    assert.equal(await work.getByText(task.title, { exact: true }).count(), 1, 'Task results stay visible when attention fails');
    assert.equal(await work.locator('.task-filter.is-working .task-filter__count').innerText(), '1');
    await pending.click();
    await unknown();
    // A failed retry leaves the error actionable instead of displaying an empty success.
    await retry.click();
    await retry.waitFor();
    await unknown();
    failing = false;
    holding = true;
    items = [item];
    const beforeRetry = reads;
    await retry.click();
    await alert.getByRole('button', { name: 'Retrying...', exact: true }).waitFor();
    assert.equal(await alert.getByRole('button').isDisabled(), true);
    await unknown();
    for (let attempt = 0; reads === beforeRetry && attempt < 100; attempt++) await page.waitForTimeout(20);
    assert.ok(reads > beforeRetry, 'Retry issues another attention request');
    await release();
    await work.getByText(item.title, { exact: true }).waitFor();
    await alert.waitFor({ state: 'hidden' });
    assert.equal(await pending.locator('.task-filter__count').innerText(), '1');
    // Refresh failure retains the actionable card and labels the snapshot stale.
    failing = true;
    await refresh();
    await alert.getByText('Pending input could not refresh.', { exact: true }).waitFor();
    assert.equal(await work.getByText(item.title, { exact: true }).count(), 1);
    await alert.getByText('Showing the last update. Pending input may be out of date.', { exact: true }).waitFor();
    await unknown();
    // Scoping retained results must not clear their stale state.
    await work.getByRole('combobox', { name: 'Filter tasks by bot' }).selectOption(bot.id);
    await alert.waitFor();
    await unknown();
    await page.screenshot({ path: path.join(evidence, `stale-${width}.png`) });
    failing = false;
    items = [];
    await retry.click();
    await work.getByRole('heading', { name: 'No pending tasks', exact: true }).waitFor();
    assert.equal(await pending.locator('.task-filter__count').innerText(), '0');
    // A previously successful zero is also stale after a failed refresh.
    failing = true;
    await refresh();
    await alert.waitFor();
    await unknown();
    holding = true;
    failing = false;
    const beforeEmptyRetry = reads;
    await retry.click();
    await alert.getByRole('button', { name: 'Retrying...', exact: true }).waitFor();
    await unknown();
    for (let attempt = 0; reads === beforeEmptyRetry && attempt < 100; attempt++) await page.waitForTimeout(20);
    await release();
    await work.getByRole('heading', { name: 'No pending tasks', exact: true }).waitFor();
    // Preserve the independent task-list error and retry behavior.
    taskFailing = true;
    await refresh();
    const taskAlert = work.getByRole('alert').filter({ hasText: 'Tasks couldn’t refresh.' });
    await taskAlert.waitFor();
    await all.click();
    await work.getByText(task.title, { exact: true }).waitFor();
    taskFailing = false;
    tasks = [];
    await taskAlert.getByRole('button', { name: 'Retry', exact: true }).click();
    await taskAlert.waitFor({ state: 'hidden' });
    await work.getByRole('heading', { name: /No tasks for .* yet/ }).waitFor();
    if (width === 1280) {
      failing = true;
      await refresh();
      await alert.waitFor();
      await page.locator('.sidebar-island__count[aria-label="Pending input count unavailable"]').waitFor();
      await page.locator('.pinned__tile').filter({ hasText: 'Attention QA Bot' }).click();
      await page.getByRole('button', { name: 'Open Attention QA Bot details', exact: true }).click();
      const details = page.getByRole('complementary', { name: 'Conversation details' });
      await details.getByRole('navigation', { name: 'Conversation details sections' }).getByRole('button', { name: 'Tasks', exact: true }).click();
      const detailsAlert = details.getByRole('alert').filter({ hasText: 'Pending input could not load.' });
      await detailsAlert.waitFor();
      assert.equal(await details.getByText(/No tasks yet/).count(), 0, 'Bot details also avoid a false empty state');
      failing = false;
      await detailsAlert.getByRole('button', { name: 'Retry pending input', exact: true }).click();
      await details.getByText(/No tasks yet/).waitFor();
      await detailsAlert.waitFor({ state: 'hidden' });
    }
    console.log(`PASS ${width}px: loading, initial failure, retry failure, recovery, stale cards and zero, scoped state, independent task errors`);
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
