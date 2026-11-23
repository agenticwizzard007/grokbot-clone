// QA P-10: real local auth and SQLite, Vite UI, mocked model/toolkit backends.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import Database from 'better-sqlite3';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'initial-load-recovery-'));
const evidence = path.join(root, '.context/initial-load-recovery');
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
  CLI_PROFILES_DIR: path.join(temp, 'profiles'), SESSION_SECRET: 'initial-load-recovery-fixture',
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
function seed(owner, width) {
  const db = new Database(env.DB_PATH), now = Date.now();
  const bots = [{ id: `recovery-${width}`, name: 'Recovery fixture Bot' }, { id: `empty-${width}`, name: 'Empty fixture Bot' }];
  try {
    for (const bot of bots) db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(bot.id, owner, bot.name, now, now);
    db.prepare('INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES(?,1,1,1,?,?,?)')
      .run(bots[0].id, 'message', JSON.stringify({ type: 'message', role: 'assistant', text: 'Previously saved fixture message' }), now);
  } finally { db.close(); }
  return bots;
}

try {
  await ready(`${modelBase}/v1/models`, start(['tests/mock-provider.mjs', String(modelPort)]));
  await ready(`${apiBase}/api/health`, start(['--import', preload, '--import', 'tsx', 'server/src/index.ts']));
  await ready(base, start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(root, 'web'), { SWARM_API: apiBase }));
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const width of [390, 768, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    assert.equal((await context.request.post(`${base}/api/auth/dev`, { data: { email: `recovery-${width}@example.test`, name: 'QA account' } })).status(), 200);
    const { user } = await (await context.request.get(`${base}/api/auth/me`)).json();
    const [bot, emptyBot] = seed(user.id, width);
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    let rosterMode = 'hold', rowsMode = 'fail', heldRoster, heldRows;
    await page.addInitScript(botId => {
      localStorage.setItem('swarm.selectedBot', botId);
      window.EventSource = class { static CLOSED = 2; constructor() { setTimeout(() => this.onopen?.(), 0); } close() {} };
    }, bot.id);
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== base) { errors.push('External browser request'); return route.abort(); }
      if (url.pathname === '/api/bots') {
        if (rosterMode === 'hold') { heldRoster = route; return; }
        if (rosterMode === 'fail') return route.fulfill({ status: 503, json: { error: 'Fixture unavailable' } });
        if (rosterMode === 'empty') return route.fulfill({ json: { bots: [], live: [] } });
      }
      if (url.pathname === `/api/bots/${bot.id}/rows`) {
        if (rowsMode === 'hold') { heldRows = route; return; }
        if (rowsMode === 'fail') return route.fulfill({ status: 503, json: { error: 'Fixture unavailable' } });
      }
      return route.continue();
    });
    async function held(which) {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (which === 'roster' ? heldRoster : heldRows) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.fail(`Expected held ${which} request`);
    }
    const refresh = resource => page.evaluate(async resource => {
      const { useStore } = await import('/src/store.ts');
      const state = useStore.getState();
      if (resource === 'roster') void state.loadBots();
      else void state.loadRows(state.selectedBotId);
    }, resource);
    await page.goto(base);
    await page.getByText('Loading Bots...', { exact: true }).waitFor();
    assert.equal(await page.getByText('No Bot selected.', { exact: true }).count(), 0);
    await held('roster');
    await heldRoster.fulfill({ status: 503, json: { error: 'Fixture unavailable' } });
    heldRoster = undefined;
    const retryBots = page.getByRole('button', { name: 'Retry Bots', exact: true });
    await retryBots.waitFor();
    await page.screenshot({ path: path.join(evidence, `roster-${width}.png`) });
    await retryBots.click();
    await held('roster');
    assert.equal(await retryBots.isDisabled(), true);
    await page.getByText('Retrying...', { exact: true }).waitFor();
    rosterMode = 'normal';
    await heldRoster.continue();
    await page.locator('.app').waitFor();
    if (width <= 760) await page.locator('.sidebar .bot-row').filter({ hasText: bot.name }).click();
    const retryRows = page.getByRole('button', { name: 'Retry messages', exact: true });
    await retryRows.waitFor();
    assert.equal(await page.locator('.transcript .empty-chat').count(), 0);
    await page.screenshot({ path: path.join(evidence, `transcript-${width}.png`) });
    rowsMode = 'hold';
    await retryRows.click();
    await held('rows');
    assert.equal(await retryRows.isDisabled(), true);
    rowsMode = 'normal';
    await heldRows.continue();
    await page.locator('.transcript').getByText('Previously saved fixture message', { exact: true }).waitFor();
    assert.equal(await retryRows.count(), 0);

    rowsMode = 'fail';
    await refresh('rows');
    await retryRows.waitFor();
    await page.getByText('Showing previously loaded data. Your messages may be out of date.', { exact: true }).waitFor();
    await page.locator('.transcript').getByText('Previously saved fixture message', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(evidence, `stale-messages-${width}.png`) });
    // Switching Bots must not carry the first Bot's error into an empty successful conversation.
    await page.evaluate(async id => { const { openConversation } = await import('/src/configStore.ts'); openConversation(id); }, emptyBot.id);
    await page.locator('.transcript .empty-chat').waitFor();
    assert.equal(await retryRows.count(), 0);
    assert.equal(await page.locator('.transcript').getByText('Previously saved fixture message', { exact: true }).count(), 0);

    rosterMode = 'fail';
    await refresh('roster');
    await page.locator('.chat').getByRole('button', { name: 'Retry Bots', exact: true }).waitFor();
    await page.locator('.chat').getByText('Showing previously loaded data. Your Bot list may be out of date.', { exact: true }).waitFor();
    if (width <= 760) {
      await page.getByRole('button', { name: 'All Bots', exact: true }).click();
      await page.locator('.sidebar').getByRole('button', { name: 'Retry Bots', exact: true }).waitFor();
    } else {
      await page.getByRole('button', { name: 'Back to Bots', exact: true }).click();
      await page.locator('.bots-view').getByRole('button', { name: 'Retry Bots', exact: true }).waitFor();
    }
    await page.screenshot({ path: path.join(evidence, `stale-roster-${width}.png`) });
    rosterMode = 'normal';
    await page.getByRole('button', { name: 'Retry Bots', exact: true }).filter({ visible: true }).click();
    await page.waitForFunction(() => !document.querySelector('.load-feedback'));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);

    rosterMode = 'empty';
    await page.reload();
    await page.locator('.app').waitFor();
    assert.equal(await page.locator('.load-feedback').count(), 0, 'empty success has no recovery prompt');
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS P-10: roster and transcript failure, pending retry, retained data, Bot scoping and empty success at ${width}px`);
  }
} finally {
  await browser?.close();
  for (const child of children.reverse()) {
    if (child.exitCode !== null) continue;
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
  await fs.rm(temp, { recursive: true, force: true });
}
