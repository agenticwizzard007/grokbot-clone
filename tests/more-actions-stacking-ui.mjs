// QA N06: real local auth and SQLite, Vite UI, mocked model/toolkit backends.
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
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'more-actions-stacking-'));
const evidence = path.join(root, '.context/more-actions-stacking');
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
  CLI_PROFILES_DIR: path.join(temp, 'profiles'), SESSION_SECRET: 'more-actions-stacking-fixture',
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
  const bot = { id: `more-actions-${width}`, name: 'Menu QA Bot' };
  const now = Date.now() - 100_000;
  try {
    db.transaction(() => {
      db.prepare('INSERT INTO bots(id,user_id,name,next_seq,rev,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
        .run(bot.id, owner, bot.name, 61, 60, now, now);
      const insert = db.prepare('INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES(?,1,?,?,?,?,?)');
      for (let seq = 1; seq <= 60; seq++) insert.run(bot.id, seq, seq, 'message', JSON.stringify({
        type: 'message', role: seq % 2 ? 'user' : 'assistant',
        text: `Fixture message ${seq}. A populated conversation makes the scroll control available.`,
      }), now + seq * 1000);
    })();
  } finally { db.close(); }
  return bot;
}

try {
  await ready(`${modelBase}/v1/models`, start(['tests/mock-provider.mjs', String(modelPort)]));
  await ready(`${apiBase}/api/health`, start(['--import', preload, '--import', 'tsx', 'server/src/index.ts']));
  await ready(base, start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(root, 'web'), { SWARM_API: apiBase }));
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const failures = [];
  for (const width of [390, 768]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    const login = await context.request.post(`${base}/api/auth/dev`, { data: { email: `menu-${width}@example.test`, name: 'QA account' } });
    assert.equal(login.status(), 200);
    const { user } = await (await context.request.get(`${base}/api/auth/me`)).json();
    const bot = seed(user.id, width);
    const page = await context.newPage(), errors = [], writes = [];
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== base) { errors.push(`External browser request: ${url.origin}`); return route.abort(); }
      if (url.pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(request.method())) writes.push(url.pathname);
      return route.continue();
    });
    await page.addInitScript(botId => {
      localStorage.setItem('swarm.selectedBot', botId);
      localStorage.setItem('swarm.theme', 'light');
      window.__jumpClicks = 0;
      document.addEventListener('click', event => {
        if (event.target.closest('.jump-btn')) window.__jumpClicks++;
      }, true);
    }, bot.id);
    try {
      await page.goto(base);
      if (width <= 760) await page.locator('.sidebar .bot-row').filter({ hasText: bot.name }).click();
      const transcript = page.locator('.transcript');
      await transcript.locator('[data-row-seq="60"]').waitFor();
      // Initial history is bounded since the chat-open performance change.
      assert.equal(await transcript.locator('[data-row-seq]').count(), 24);
      await page.evaluate(() => document.fonts.ready);
      await transcript.evaluate(el => { el.scrollTop = el.scrollHeight; });
      await page.waitForFunction(() => {
        const el = document.querySelector('.transcript');
        return el.scrollHeight - el.scrollTop - el.clientHeight < 1;
      });
      await transcript.hover();
      await page.mouse.wheel(0, -10000);
      const jump = page.getByRole('button', { name: 'Jump to latest', exact: true });
      await jump.waitFor();
      const more = page.getByRole('button', { name: 'More actions', exact: true });
      writes.length = 0;
      await more.click();
      const menu = page.locator('.composer__plus-anchor .menu');
      await menu.waitFor();
      await menu.evaluate(el => Promise.all(el.getAnimations({ subtree: true })
        .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map(animation => animation.finished)));
      await page.screenshot({ path: path.join(evidence, `${width}.png`) });
      const geometry = await menu.evaluate(el => {
        const j = document.querySelector('.jump-btn').getBoundingClientRect();
        return [...el.querySelectorAll('[role="menuitem"]')].map(item => {
          const r = item.getBoundingClientRect();
          const left = Math.max(r.left, j.left), right = Math.min(r.right, j.right);
          const top = Math.max(r.top, j.top), bottom = Math.min(r.bottom, j.bottom);
          const overlaps = right > left && bottom > top;
          const points = overlaps ? [
            { x: (left + right) / 2, y: (top + bottom) / 2 },
            { x: Math.min(left + 8, (left + right) / 2), y: Math.min(top + 8, (top + bottom) / 2) },
            { x: Math.max(right - 8, (left + right) / 2), y: Math.max(bottom - 8, (top + bottom) / 2) },
          ] : [{ x: r.x + r.width / 2, y: r.y + r.height / 2 }];
          return { label: item.textContent.trim(), overlaps, points: points.map(point => ({
            ...point, onTop: item.contains(document.elementFromPoint(point.x, point.y)),
          })) };
        });
      });
      assert.ok(geometry.some(item => item.overlaps), 'Fixture must overlap the jump control with a menu item');
      // Capture real pointer delivery, but keep only the menu open: no action is executed.
      await menu.evaluate(el => {
        window.__menuClicks = [];
        el.addEventListener('click', event => {
          const item = event.target.closest('[role="menuitem"]');
          if (item) window.__menuClicks.push(item.textContent.trim());
          event.stopPropagation();
        }, true);
      });
      const scrollTop = await transcript.evaluate(el => el.scrollTop);
      const expected = [];
      for (const item of geometry.filter(item => ['New conversation', 'Connect apps'].includes(item.label))) {
        for (const point of item.points) {
          if (!point.onTop) failures.push(`${width}px: ${item.label} is covered at ${point.x}, ${point.y}`);
          await page.mouse.click(point.x, point.y);
          expected.push(item.label);
        }
      }
      const clicks = await page.evaluate(() => ({ menu: window.__menuClicks, jump: window.__jumpClicks }));
      if (clicks.jump !== 0 || JSON.stringify(clicks.menu) !== JSON.stringify(expected)) {
        failures.push(`${width}px: incorrect pointer delivery ${JSON.stringify(clicks)}`);
      }
      if (!failures.some(failure => failure.startsWith(`${width}px:`))) {
        assert.equal(await transcript.evaluate(el => el.scrollTop), scrollTop, 'Menu clicks preserve scroll position');
        await page.keyboard.press('Escape');
        await menu.waitFor({ state: 'detached' });
        await jump.click();
        await page.waitForFunction(() => {
          const el = document.querySelector('.transcript');
          return el.scrollHeight - el.scrollTop - el.clientHeight < 1;
        });
        assert.equal(await page.evaluate(() => window.__jumpClicks), 1, 'Jump works after menu dismissal');
      }
      assert.deepEqual(writes, [], 'Opening the menu and probing clicks performs no API writes');
      assert.deepEqual(errors, [], 'No browser errors or external requests');
      await fs.writeFile(path.join(evidence, `${width}.json`), JSON.stringify({ geometry, clicks }, null, 2) + '\n');
      console.log(`Checked N06 at ${width}px: menu hit testing, pointer delivery, dismissal and jump recovery`);
    } finally { await context.close(); }
  }
  assert.deepEqual(failures, [], 'More actions must receive clicks above the jump button');
  console.log('PASS N06: More actions stays above Jump to latest at 390 and 768');
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
