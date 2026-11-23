// Production web bundle, temporary SQLite, DEV_LOGIN, and local mock backends.
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
import { seedChatOpen, CHAT_OPEN_BOT, CHAT_OPEN_ROWS } from './chat-open-fixture.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-open-'));
const evidence = path.join(root, '.context/chat-open', 'after');
await fs.mkdir(evidence, { recursive: true });
async function freePort() {
  const socket = net.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}
const apiPort = await freePort(), modelPort = await freePort();
const base = `http://127.0.0.1:${apiPort}`, modelBase = `http://127.0.0.1:${modelPort}`;
const env = {
  PATH: process.env.PATH, NODE_ENV: 'test', SWARM_ROLE: 'standalone', DEV_LOGIN: '1',
  DB_PATH: path.join(temp, 'app.db'), FILES_DIR: path.join(temp, 'files'), CLI_PROFILES_DIR: path.join(temp, 'profiles'),
  SESSION_SECRET: 'chat-open-fixture-only', PORT: String(apiPort), APP_URL: base, SERVER_URL: base,
  COMPUTER_PROVIDER: 'local', SWARM_NO_SCHEDULER: '1', MEMORY_CONSOLIDATE_IDLE_MINUTES: '0', WHATSAPP_DISABLED: '1', INKBOX_TUNNEL: '0',
  LLM_PROVIDER: 'direct', DIRECT_API_KEY: 'fixture-only', DIRECT_BASE_URL: `${modelBase}/v1`,
  OPENROUTER_BASE_URL: `${modelBase}/api/v1`, COMPOSIO_API_KEY: '',
};
const preload = path.join(temp, 'profile.mjs');
await fs.writeFile(preload, `
import { appendFileSync } from 'node:fs';
import { db } from ${JSON.stringify(path.join(root, 'server/src/db.ts'))};
const original = db.prepare.bind(db);
db.prepare = sql => {
  const statement = original(sql);
  if (/\\b(rows|bot_setups|approvals|pending_turns)\\b/.test(sql)) for (const method of ['get', 'all', 'run']) {
    const execute = statement[method].bind(statement);
    statement[method] = (...params) => {
      const start = performance.now(); const result = execute(...params);
      appendFileSync(${JSON.stringify(path.join(evidence, 'queries.jsonl'))}, JSON.stringify({ sql, ms: performance.now() - start }) + '\\n');
      return result;
    };
  }
  return statement;
};
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (['127.0.0.1', 'localhost'].includes(url.hostname)) return realFetch(input, init);
  if (url.hostname === 'backend.composio.dev') return Promise.resolve(Response.json({ items: [], next_cursor: null }));
  if (url.hostname === 'openrouter.ai' && url.pathname.endsWith('/models')) return Promise.resolve(Response.json({ data: [] }));
  throw new Error('External backend request blocked');
};
`);
const children = [], logs = [];
let browser;
function start(args) {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => logs.push(String(data)));
  return child;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function ready(url, child) {
  for (let i = 0; i < 300; i++) {
    assert.equal(child.exitCode, null, logs.join(''));
    if (await fetch(url).then(r => r.ok, () => false)) return;
    await delay(100);
  }
  throw new Error('Local server did not start');
}
const results = [];
try {
  await ready(`${modelBase}/v1/models`, start(['tests/mock-provider.mjs', String(modelPort)]));
  await ready(`${base}/api/health`, start(['--import', 'tsx', '--import', preload, 'server/src/index.ts']));
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const auth = await browser.newContext();
  assert.equal((await auth.request.post(`${base}/api/auth/dev`, { data: { email: 'chat-open@example.test', name: 'Performance fixture' } })).status(), 200);
  const { user } = await (await auth.request.get(`${base}/api/auth/me`)).json();
  const db = new Database(env.DB_PATH); seedChatOpen(db, user.id);
  const plans = [];
  for (const [sql, args] of [
    ['SELECT * FROM rows WHERE bot_id=? AND generation=? ORDER BY seq DESC LIMIT ?', [CHAT_OPEN_BOT, 1, 30]],
    ['SELECT * FROM rows WHERE bot_id=? AND generation=? AND seq<? ORDER BY seq DESC LIMIT ?', [CHAT_OPEN_BOT, 1, 691, 30]],
    ["SELECT seq FROM rows WHERE bot_id=? AND generation=? AND created_at < ? AND kind='card' AND json_extract(body,'$.card')='question'", [CHAT_OPEN_BOT, 1, Date.now()]],
  ]) plans.push({ sql, plan: db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) });
  await fs.writeFile(path.join(evidence, 'query-plans.json'), JSON.stringify(plans, null, 2)); db.close();
  const storageState = await auth.storageState(); await auth.close();
  for (const width of [390, 1280]) {
    const context = await browser.newContext({ storageState, viewport: { width, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    const page = await context.newPage(), errors = [], waterfall = [], pending = [], tracked = new Set();
    page.setDefaultTimeout(30000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    // A reproducible phone connection and CPU budget, applied at both viewport sizes.
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 80, downloadThroughput: 500_000, uploadThroughput: 125_000 });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.addInitScript(() => {
      if (location.protocol !== 'http:') return;
      localStorage.setItem('swarm.theme', 'light');
      window.chatOpen = {};
      document.addEventListener('click', event => {
        if (!event.target.closest('.bot-row, .bots-view__item')) return;
        window.chatOpen = { click: performance.now() };
        const visible = el => el && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0 && getComputedStyle(el).visibility !== 'hidden';
        const frame = () => {
          const m = window.chatOpen;
          if (!m.shell && visible(document.querySelector('.chat__header')) && visible(document.querySelector('.chat textarea'))) m.shell = performance.now() - m.click;
          const latest = document.querySelector('[data-row-seq="720"]');
          if (!m.message && visible(latest)) {
            const rect = latest.getBoundingClientRect(), pane = document.querySelector('.transcript')?.getBoundingClientRect();
            if (pane && rect.bottom > pane.top && rect.top < pane.bottom) m.message = performance.now() - m.click;
          }
          if (!m.shell || !m.message) requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }, true);
    });
    let recording = false;
    page.on('request', request => { if (recording) tracked.add(request); });
    page.on('requestfinished', request => {
      if (!tracked.delete(request)) return;
      pending.push((async () => {
        const response = await request.response();
        const timing = request.timing(), size = await request.sizes();
        waterfall.push({ path: new URL(request.url()).pathname + new URL(request.url()).search,
          method: request.method(), status: response.status(), start: timing.startTime, ttfb: timing.responseStart,
          duration: timing.responseEnd, bytes: size.responseBodySize });
      })());
    });
    await page.goto(width === 390 ? base : `${base}/#tasks`);
    const target = page.locator('.sidebar .bot-row').filter({ hasText: 'History performance Bot' });
    await target.waitFor();
    // Start on the signed-in shell without preloading this Bot's history.
    for (const temperature of ['cold', 'warm']) {
      recording = true;
      await target.click();
      await page.waitForFunction(() => window.chatOpen.shell && window.chatOpen.message);
      const measured = await page.evaluate(() => window.chatOpen);
      results.push({ width, temperature, shell: Math.round(measured.shell), message: Math.round(measured.message) });
      console.log(JSON.stringify(results.at(-1)));
      assert.ok(measured.shell < 300, `${width} ${temperature}: shell ${measured.shell}ms`);
      assert.ok(measured.message < (temperature === 'cold' ? 3000 : 1500), `${width} ${temperature}: message ${measured.message}ms`);
      await page.screenshot({ path: path.join(evidence, `${width}-${temperature}.png`) });
      if (temperature === 'cold') {
        await page.getByRole('button', { name: width === 390 ? 'All Bots' : 'Back to Bots', exact: true }).click();
        await target.waitFor();
      }
    }
    const transcript = page.locator('.transcript');
    const countBefore = await transcript.locator('[data-row-seq]').count();
    await transcript.evaluate(el => { el.scrollTop = 0; });
    await page.waitForFunction(before => document.querySelectorAll('.transcript [data-row-seq]').length > before, countBefore);
    await Promise.all(pending); recording = false;
    await fs.writeFile(path.join(evidence, `${width}-waterfall.json`), JSON.stringify(waterfall, null, 2));
    // A held route chunk must still show a frame. SSE and secondary requests
    // remain held until after the latest message is visible.
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    let chunk;
    const held = [];
    await page.route('**/assets/ChatView-*.js', route => { chunk = route; });
    await page.route('**/api/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/api/events' || pathname === '/api/models' || pathname === '/api/team/exchanges' || pathname.endsWith('/routines')) {
        held.push(route); return;
      }
      return route.continue();
    });
    await page.goto('about:blank');
    await page.goto(width === 390 ? base : `${base}/#tasks`);
    await target.click();
    await page.waitForFunction(() => window.chatOpen.shell);
    const shell = await page.evaluate(() => window.chatOpen.shell);
    assert.ok(shell < 300, 'shell paints while the route chunk is held');
    await page.getByRole('textbox', { name: 'Loading composer' }).waitFor();
    for (let i = 0; !chunk && i < 100; i++) await delay(10);
    assert.ok(chunk, 'chat route is actually blocked');
    await chunk.continue();
    await page.waitForFunction(() => window.chatOpen.message);
    assert.ok(held.some(route => new URL(route.request().url()).pathname === '/api/events'), 'SSE remains disconnected');
    assert.ok(held.some(route => new URL(route.request().url()).pathname.endsWith('/routines')), 'routines remain pending');
    assert.equal(await page.locator('.chat textarea:not(:disabled)').isVisible(), true);
    console.log(`PASS ${width}px: shell with held chunk, latest messages with pending SSE and secondary requests`);
    assert.deepEqual(errors, []);
    await context.close();
  }
  await fs.writeFile(path.join(evidence, 'timings.json'), JSON.stringify(results, null, 2));
} finally {
  await browser?.close();
  for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
  }
  await fs.rm(temp, { recursive: true, force: true });
}
