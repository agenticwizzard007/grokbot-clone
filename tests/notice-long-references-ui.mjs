// QA PR N04: real local auth and SQLite, Vite UI, mocked model/toolkit backends.
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
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'notice-long-references-'));
const evidence = path.join(root, '.context/notice-long-references');
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
  CLI_PROFILES_DIR: path.join(temp, 'profiles'), SESSION_SECRET: 'notice-long-references-fixture',
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

const reference = `Reference ${'R'.repeat(120)}`;
const shortText = 'Reference ready';
const bot = { id: 'notice-layout', name: 'Notice QA Bot' };
const rows = ['warn', 'info', 'error'].flatMap(tone => [reference, shortText].map(text => ({
  kind: 'notice', body: { type: 'notice', tone, text },
}))).map((row, index) => ({ ...row, seq: index + 1, updatedSeq: index + 1 }));

function seed(owner) {
  const db = new Database(env.DB_PATH);
  try {
    db.transaction(() => {
      const now = Date.now();
      db.prepare('INSERT INTO bots(id,user_id,name,next_seq,rev,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
        .run(bot.id, owner, bot.name, rows.length + 1, rows.length, now, now);
      const insert = db.prepare('INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES(?,1,?,?,?,?,?)');
      for (const row of rows) insert.run(bot.id, row.seq, row.updatedSeq, row.kind, JSON.stringify(row.body), now + row.seq);
    })();
  } finally { db.close(); }
}

const report = [], failures = [];
try {
  await ready(`${modelBase}/v1/models`, start(['tests/mock-provider.mjs', String(modelPort)]));
  await ready(`${apiBase}/api/health`, start(['--import', preload, '--import', 'tsx', 'server/src/index.ts']));
  await ready(base, start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(root, 'web'), { SWARM_API: apiBase }));
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const auth = await browser.newContext();
  const login = await auth.request.post(`${base}/api/auth/dev`, { data: { email: 'notice-qa@example.test', name: 'QA account' } });
  assert.equal(login.status(), 200);
  const { user } = await (await auth.request.get(`${base}/api/auth/me`)).json();
  const timezone = await auth.request.patch(`${base}/api/auth/me`, { data: { timezone: 'UTC' } });
  assert.equal(timezone.status(), 200);
  seed(user.id);
  const storageState = await auth.storageState();
  await auth.close();
  for (const width of [390, 768, 1024, 1280]) {
    const page = await browser.newPage({ storageState, timezoneId: 'UTC', viewport: { width, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    page.setDefaultTimeout(10000);
    const unexpected = [];
    page.on('pageerror', error => unexpected.push(error.message));
    await page.addInitScript(botId => {
      localStorage.setItem('swarm.selectedBot', botId);
      localStorage.setItem('swarm.theme', 'light');
    }, bot.id);
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname;
      if (url.origin !== base) { unexpected.push(`External request: ${url.origin}`); return route.abort(); }
      if (path.startsWith('/api/') && request.method() !== 'GET') {
        unexpected.push(`${request.method()} ${path}`);
        return route.abort();
      }
      return route.continue();
    });
    try {
      await page.goto(base);
      if (width <= 760) await page.locator('.sidebar .bot-row').filter({ hasText: bot.name }).click();
      await page.locator('.notice').last().waitFor();
      await page.evaluate(() => document.fonts.ready);
      const notices = page.locator('.notice');
      assert.equal(await notices.count(), rows.length);
      for (const [index, row] of rows.entries()) {
        const notice = notices.nth(index);
        await notice.scrollIntoViewIfNeeded();
        const measured = await notice.evaluate(element => {
          const box = node => {
            const { left, right, top, bottom, width, height } = node.getBoundingClientRect();
            return { left, right, top, bottom, width, height };
          };
          const range = document.createRange();
          range.selectNodeContents(element);
          return {
            text: element.textContent, notice: box(element),
            column: box(element.closest('.transcript__col')),
            transcript: box(element.closest('.transcript')),
            clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
            clientHeight: element.clientHeight, scrollHeight: element.scrollHeight,
            lines: [...range.getClientRects()].map(({ left, right, top, bottom }) => ({ left, right, top, bottom })),
          };
        });
        const label = `${width}px ${row.body.tone} ${index % 2 ? 'short' : 'long'}`;
        report.push({ label, ...measured });
        try {
          assert.equal(measured.text, row.body.text, 'The full reference is rendered');
          assert.ok(measured.notice.width > 0 && measured.notice.width <= 560, 'Notice retains its desktop maximum');
          assert.ok(measured.notice.left >= measured.column.left - 0.5 && measured.notice.right <= measured.column.right + 0.5, 'Notice fits the available transcript column');
          assert.ok(Math.abs((measured.notice.left + measured.notice.right) - (measured.column.left + measured.column.right)) < 1, 'Notice stays centered');
          assert.ok(measured.scrollWidth <= measured.clientWidth, 'No horizontal notice overflow');
          assert.ok(measured.scrollHeight <= measured.clientHeight, 'No vertical notice overflow');
          if (index % 2) {
            assert.equal(measured.lines.length, 1, 'Short text stays on one line');
            assert.ok(measured.notice.width < measured.column.width, 'Short notices keep their natural width');
          } else {
            assert.ok(measured.lines.length > 1, 'The 120-character reference wraps');
          }
          for (const line of measured.lines) {
            assert.ok(line.left >= measured.notice.left + 11.5 && line.right <= measured.notice.right - 11.5, 'Every painted line fits inside the notice padding');
            assert.ok(line.top >= measured.notice.top && line.bottom <= measured.notice.bottom, 'Every painted line fits vertically');
            assert.ok(line.left >= measured.transcript.left && line.right <= measured.transcript.right && line.top >= measured.transcript.top && line.bottom <= measured.transcript.bottom, 'Every painted line is visible in the transcript');
          }
        } catch (error) { failures.push(`${label}: ${error.message}`); }
      }
      await page.screenshot({ path: path.join(evidence, `${width}.png`) });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'No page overflow');
      assert.deepEqual(unexpected, [], 'No page errors, external requests, or API writes');
    } catch (error) { failures.push(`${width}px: ${error.message}`); }
    await page.close();
  }
  await fs.writeFile(path.join(evidence, 'measurements.json'), JSON.stringify(report, null, 2));
  assert.deepEqual(failures, [], 'Notice references remain fully visible at every required viewport');
  console.log('PASS N04: long and short warning, info, and error notices at 390, 768, 1024, 1280px');
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
