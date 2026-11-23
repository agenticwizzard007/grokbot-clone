// QA SO C-01: real local auth and SQLite, Vite UI, mocked model/toolkit backends.
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
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'transcript-paging-'));
const evidence = path.join(root, '.context/transcript-paging');
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
  CLI_PROFILES_DIR: path.join(temp, 'profiles'), SESSION_SECRET: 'transcript-paging-fixture',
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
  const db = new Database(env.DB_PATH);
  const now = Date.now() - 1_000_000;
  const bots = [{ id: `paging-${width}`, name: 'Transcript QA Bot', count: 260, anchor: 'QA-OLDEST-ANCHOR' },
    { id: `deep-${width}`, name: 'History QA Bot', count: 660, anchor: 'QA-DEEP-ANCHOR' }];
  try {
    db.transaction(() => {
      for (const bot of bots) {
        db.prepare('INSERT INTO bots(id,user_id,name,next_seq,rev,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
          .run(bot.id, owner, bot.name, bot.count + 1, bot.count, now, now);
        const insert = db.prepare('INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES(?,1,?,?,?,?,?)');
        for (let seq = 1; seq <= bot.count; seq++) insert.run(bot.id, seq, seq, 'message', JSON.stringify({
          type: 'message', role: 'assistant', text: seq === 1 ? bot.anchor : `History fixture message ${seq}`,
        }), now + seq * 1000);
      }
    })();
  } finally { db.close(); }
  return bots;
}

try {
  await ready(`${modelBase}/v1/models`, start(['tests/mock-provider.mjs', String(modelPort)]));
  await ready(`${apiBase}/api/health`, start(['--import', preload, '--import', 'tsx', 'server/src/index.ts']));
  await ready(base, start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(root, 'web'), { SWARM_API: apiBase }));
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const width of [1280, 1024, 768, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    const login = await context.request.post(`${base}/api/auth/dev`, { data: { email: `paging-${width}@example.test`, name: 'QA account' } });
    assert.equal(login.status(), 200);
    const { user } = await (await context.request.get(`${base}/api/auth/me`)).json();
    const [bot, deep] = seed(user.id, width);
    const page = await context.newPage(), errors = [], requests = [];
    let olderMode = 'normal', held;
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== base) { errors.push(`External browser request: ${url.origin}`); return route.abort(); }
      if (url.pathname.endsWith('/rows')) {
        requests.push({ bot: url.pathname.split('/')[3], before: url.searchParams.get('beforeSeq') });
        if (url.searchParams.has('beforeSeq')) {
          if (olderMode === 'fail') return route.fulfill({ status: 503, json: { error: 'Fixture offline' } });
          if (olderMode === 'hold') { held = route; return; }
        }
      }
      return route.continue();
    });
    await page.addInitScript(botId => {
      localStorage.setItem('swarm.selectedBot', botId);
      localStorage.setItem('swarm.theme', 'light');
    }, bot.id);
    const transcript = page.locator('.transcript');
    const earlier = page.getByRole('button', { name: 'Earlier messages', exact: true });
    const open = async () => {
      await page.goto(base);
      if (width <= 760) await page.locator('.sidebar .bot-row').filter({ hasText: bot.name }).click();
      await transcript.locator('[data-row-seq="260"]').waitFor();
      await transcript.evaluate(el => { el.scrollTop = el.scrollHeight; });
      await page.waitForFunction(() => {
        const el = document.querySelector('.transcript');
        return el && el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      });
    };
    const search = async (anchor, expectedBot) => {
      await page.keyboard.press('Control+k');
      const dialog = page.getByRole('dialog', { name: 'Search', exact: true });
      await dialog.getByRole('textbox', { name: 'Search', exact: true }).fill(anchor);
      const option = dialog.getByRole('option').filter({ hasText: anchor });
      await option.click();
      return { dialog, option, expectedBot };
    };
    const highlighted = async expectedBot => {
      const hit = page.locator(`.transcript[data-bot-id="${expectedBot.id}"] [data-row-seq="1"].is-search-hit`);
      await hit.waitFor();
      assert.equal(await transcript.getAttribute('data-bot-id'), expectedBot.id);
      const rect = await hit.boundingBox(), pane = await transcript.boundingBox();
      assert.ok(rect.y >= pane.y + 60 && rect.y + rect.height <= pane.y + pane.height, 'search target is visible below the chat header');
      assert.ok(rect.x >= 0 && rect.x + rect.width <= width, 'target fits viewport');
      await page.screenshot({ path: path.join(evidence, `${width}-${expectedBot.id.startsWith('deep') ? 'deep' : 'oldest'}.png`) });
    };
    try {
      await open();
      assert.equal(await transcript.locator('[data-row-seq]').count(), 24);
      assert.equal(await transcript.getByText(bot.anchor, { exact: true }).count(), 0);
      olderMode = 'hold';
      await transcript.evaluate(el => { el.scrollTop = 0; });
      const before = await transcript.locator('[data-row-seq="237"]').boundingBox();
      const loading = page.getByRole('button', { name: 'Loading earlier messages...', exact: true });
      await loading.waitFor();
      assert.equal(await loading.isDisabled(), true);
      assert.ok(held, 'one older-page request is pending');
      await held.continue(); held = undefined; olderMode = 'normal';
      await transcript.locator('[data-row-seq="37"]').waitFor({ state: 'attached' });
      const after = await transcript.locator('[data-row-seq="237"]').boundingBox();
      assert.ok(Math.abs(before.y - after.y) <= 2, `prepended history preserves the visible row: ${before.y} vs ${after.y}`);
      assert.equal(await transcript.locator('[data-row-seq]').count(), 224);
      await transcript.evaluate(el => { el.scrollTop = 0; });
      await transcript.locator('[data-row-seq="1"]').waitFor({ state: 'attached' });
      assert.equal(await transcript.locator('[data-row-seq]').count(), 260);
      assert.equal(await earlier.count(), 0, 'end of history removes the control');
      await transcript.evaluate(el => { el.scrollTop = 0; });
      const oldest = await transcript.locator('[data-row-seq="1"]').boundingBox();
      assert.ok(oldest.y >= 0 && oldest.y < 900, 'scrolling reaches the oldest message');
      await page.getByRole('button', { name: 'Jump to latest', exact: true }).click();
      await page.waitForFunction(() => {
        const el = document.querySelector('.transcript');
        return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      });

      // Reload removes the cache, so global search must fetch the older window.
      await open();
      olderMode = 'fail';
      const failed = await search(bot.anchor, bot);
      await failed.dialog.getByText("Couldn't load this message. Try selecting it again.", { exact: true }).waitFor();
      assert.equal(await failed.dialog.isVisible(), true, 'failure keeps Search open for retry');
      olderMode = 'normal';
      await failed.option.click();
      await failed.dialog.waitFor({ state: 'detached' });
      await highlighted(bot);

      // An unopened Bot needs the latest page plus four earlier pages, even when
      // another visible transcript already contains a row with the same sequence.
      const countBefore = requests.length;
      await search(deep.anchor, deep);
      await highlighted(deep);
      assert.deepEqual(requests.slice(countBefore).filter(r => r.bot === deep.id).map(r => r.before), [null, '637', '437', '237', '37']);
      assert.equal(await transcript.locator('[data-row-seq]').count(), 660);

      // Closing Search while a page is pending must not navigate afterwards.
      await open();
      olderMode = 'hold';
      const cancelled = await search(deep.anchor, deep);
      await cancelled.dialog.getByText('Loading message...', { exact: true }).waitFor();
      for (let attempt = 0; !held && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.ok(held, 'search reaches a held older page');
      await page.keyboard.press('Escape');
      await cancelled.dialog.waitFor({ state: 'detached' });
      await held.continue(); held = undefined; olderMode = 'normal';
      await page.waitForFunction(async botId => {
        const { useStore } = await import('/src/store.ts');
        return !!useStore.getState().transcripts[botId]?.bySeq[1];
      }, deep.id);
      assert.equal(await transcript.getAttribute('data-bot-id'), bot.id, 'cancelled search does not open the destination');

      // A failed manual page remains retryable without resetting the transcript.
      olderMode = 'fail';
      await transcript.evaluate(el => { el.scrollTop = 0; });
      await page.getByRole('status').filter({ hasText: "Couldn't load earlier messages. Try again." }).waitFor();
      assert.equal(await earlier.isEnabled(), true);
      olderMode = 'normal';
      await earlier.click();
      await transcript.locator('[data-row-seq="37"]').waitFor({ state: 'attached' });
      await transcript.evaluate(el => { el.scrollTop = 0; });
      await transcript.locator('[data-row-seq="1"]').waitFor({ state: 'attached' });
      assert.equal(await page.locator('.transcript__error').count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors, [], 'no page errors or external requests');
      console.log(`PASS C-01 ${width}px: pagination, reading position, oldest search hit, cross-Bot multipage search, retry and cancellation`);
    } catch (error) {
      await page.screenshot({ path: path.join(evidence, `${width}-failure.png`) });
      throw error;
    } finally { await context.close(); }
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
