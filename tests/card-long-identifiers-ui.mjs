// QA PR N01: real local auth and SQLite, Vite UI, mocked model/toolkit backends.
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
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'card-long-identifiers-'));
const evidence = path.join(root, '.context/card-long-identifiers');
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
  CLI_PROFILES_DIR: path.join(temp, 'profiles'), SESSION_SECRET: 'card-long-identifiers-fixture',
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

const identifier = 'R'.repeat(120);
const token = 'release_'.repeat(22);
const shortOption = 'Use the stable release';
const shortSubject = 'Release notes';
const draftText = `Release details\n${token}\nReady for review.`;
const bot = {
  id: 'card-layout', name: 'Card QA Bot',
};
const row = (seq, body) => ({ botId: bot.id, generation: 1, seq, updatedSeq: seq, kind: 'card', audience: 'user', createdAt: seq, body: { type: 'card', ...body } });
const question = { card: 'question', question: `Choose ${identifier}`, options: [token, shortOption], status: 'pending' };
const draft = { card: 'draft', channel: 'email', to: 'qa@example.test', subject: token, text: draftText, approvalId: '', status: 'pending' };
const approval = { card: 'approval', approvalId: 'local-fixture-only', tool: 'fixture', toolkitName: 'Fixture app', title: `Approve ${identifier}`, status: 'pending' };
const connection = { card: 'connect', toolkit: 'fixture', toolkitName: 'Fixture app', reason: `Access ${identifier}`, status: 'pending' };
const rows = [
  row(1, question),
  row(2, draft),
  row(3, { ...question, question: `Chosen ${identifier}`, status: 'answered', answer: token }),
  row(4, { ...question, question: 'Choose a normal release', options: [shortOption] }),
  row(5, { ...draft, subject: shortSubject, text: 'Ready for review.' }),
  row(6, approval),
  row(7, { ...approval, status: 'denied' }),
  row(8, { ...approval, title: 'Approve release' }),
  row(9, connection),
  row(10, { ...connection, status: 'dismissed' }),
  row(11, { ...connection, reason: 'Access releases' }),
];

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

function measureText(element) {
  const box = rect => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height });
  const range = document.createRange();
  range.selectNodeContents(element);
  const card = element.closest('.card');
  return {
    text: element.textContent, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
    clientHeight: element.clientHeight, scrollHeight: element.scrollHeight,
    element: box(element.getBoundingClientRect()), card: box(card.getBoundingClientRect()),
    lines: [...range.getClientRects()].filter(rect => rect.width > 0).map(box),
  };
}

const report = [], failures = [];
try {
  await ready(`${modelBase}/v1/models`, start(['tests/mock-provider.mjs', String(modelPort)]));
  await ready(`${apiBase}/api/health`, start(['--import', preload, '--import', 'tsx', 'server/src/index.ts']));
  await ready(base, start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(root, 'web'), { SWARM_API: apiBase }));
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const auth = await browser.newContext();
  const login = await auth.request.post(`${base}/api/auth/dev`, { data: { email: 'card-qa@example.test', name: 'QA account' } });
  assert.equal(login.status(), 200);
  const { user } = await (await auth.request.get(`${base}/api/auth/me`)).json();
  const timezone = await auth.request.patch(`${base}/api/auth/me`, { data: { timezone: 'UTC' } });
  assert.equal(timezone.status(), 200);
  seed(user.id);
  const storageState = await auth.storageState();
  await auth.close();
  for (const width of [1280, 1024, 768, 390]) {
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
      await page.locator('.draft-card').last().waitFor();
      await page.evaluate(() => document.fonts.ready);
      const questions = page.locator('.question-card'), drafts = page.locator('.draft-card');
      const approvals = page.locator('.approval-card'), connections = page.locator('.connect-card');
      const checkText = async (locator, expected, wraps, label) => {
        await locator.scrollIntoViewIfNeeded();
        const measured = await locator.evaluate(measureText);
        report.push({ width, label, ...measured });
        try {
          assert.equal(measured.text, expected, `${label}: complete text is rendered`);
          assert.ok(measured.clientWidth > 0, `${label}: measurable text box`);
          assert.ok(measured.scrollWidth <= measured.clientWidth, `${label}: no horizontal text overflow (${measured.scrollWidth} > ${measured.clientWidth})`);
          assert.ok(measured.scrollHeight <= measured.clientHeight, `${label}: no vertical text overflow`);
          assert.ok(wraps ? measured.lines.length > 1 : measured.lines.length === 1, `${label}: ${wraps ? 'long text wraps onto multiple lines' : 'short text stays on one line'}`);
          for (const line of measured.lines) for (const [name, bounds] of [['text box', measured.element], ['card', measured.card]]) {
            assert.ok(line.left >= bounds.left - 0.5 && line.right <= bounds.right + 0.5 && line.top >= bounds.top - 0.5 && line.bottom <= bounds.bottom + 0.5, `${label}: every text line is inside the ${name}`);
          }
        } catch (error) { failures.push(`${width}px: ${error.message}`); }
      };
      await checkText(questions.nth(0).locator('.question-option__label').first(), token, true, 'pending option');
      await questions.nth(0).screenshot({ path: path.join(evidence, `${width}-question.png`) });
      await checkText(drafts.nth(0).locator('.draft-card__subject'), token, true, 'draft subject');
      await checkText(drafts.nth(0).locator('.draft-card__text'), draftText, true, 'draft body');
      await drafts.nth(0).screenshot({ path: path.join(evidence, `${width}-draft.png`) });
      await checkText(questions.nth(1).locator('.question-option__label').first(), token, true, 'answered option');
      await checkText(questions.nth(0).locator('.question-option__label').last(), shortOption, false, 'short option beside long option');
      await checkText(questions.nth(2).locator('.question-option__label'), shortOption, false, 'normal question');
      await checkText(drafts.nth(1).locator('.draft-card__subject'), shortSubject, false, 'normal subject');
      await checkText(questions.nth(0).locator('.question-card__q'), question.question, true, 'pending question heading');
      await checkText(questions.nth(1).locator('.question-card__q'), `Chosen ${identifier}`, true, 'answered question heading');
      await checkText(questions.nth(2).locator('.question-card__q'), 'Choose a normal release', false, 'normal question heading');
      for (const index of [0, 1]) {
        await checkText(approvals.nth(index).locator('.card__title'), approval.title, true, `${index === 0 ? 'pending' : 'resolved'} approval title`);
        await checkText(connections.nth(index).locator('.card__sub'), connection.reason, true, `${index === 0 ? 'pending' : 'resolved'} connection reason`);
      }
      await checkText(approvals.nth(2).locator('.card__title'), 'Approve release', false, 'normal approval title');
      await checkText(connections.nth(2).locator('.card__sub'), 'Access releases', false, 'normal connection reason');
      for (const label of ["Don't allow", 'Always allow', 'Allow']) {
        const button = approvals.first().getByRole('button', { name: label, exact: true });
        await button.scrollIntoViewIfNeeded();
        assert.equal(await button.isEnabled(), true, `${label} remains enabled`);
        assert.equal(await button.evaluate(element => {
          const box = element.getBoundingClientRect(), card = element.closest('.card').getBoundingClientRect();
          return box.left >= card.left && box.right <= card.right && box.top >= card.top && box.bottom <= card.bottom;
        }), true, `${label} remains inside the approval card`);
      }
      await approvals.first().screenshot({ path: path.join(evidence, `${width}-approval.png`) });
      await connections.first().screenshot({ path: path.join(evidence, `${width}-connection.png`) });
      for (const [cards, defaultWidth] of [[questions, 560], [drafts, 414], [approvals, 414], [connections, 414]]) {
        const widths = await cards.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().width));
        assert.ok(widths.every(value => value > 0 && value <= defaultWidth), 'Cards retain their default maximum width');
        assert.ok(widths.every(value => value === widths.at(-1)), 'Long identifiers do not change card width');
        if (width >= 1024) assert.equal(widths[0], defaultWidth, 'Default card width on desktop');
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'No page overflow');
      assert.deepEqual(unexpected, [], 'No page errors, external requests, or API writes');
    } catch (error) { failures.push(`${width}px: ${error.message}`); }
    await page.close();
  }
  await fs.writeFile(path.join(evidence, 'measurements.json'), JSON.stringify(report, null, 2));
  assert.deepEqual(failures, [], 'Card text remains visible at every required viewport');
  console.log('PASS N01 card identifiers: 1280, 1024, 768, 390px; approval titles, question headings, connection reasons, existing option/draft wraps, normal widths and approval controls');
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
