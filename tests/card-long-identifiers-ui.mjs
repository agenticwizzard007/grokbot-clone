// Local dev UI with synthetic API responses only. No live accounts or providers.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';

const port = await new Promise(resolve => {
  const server = http.createServer().listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});
const origin = `http://127.0.0.1:${port}`;
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: new URL('../web', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '', browser;
vite.stdout.on('data', data => { logs += data; });
vite.stderr.on('data', data => { logs += data; });
const evidence = new URL('../.context/card-long-identifiers/', import.meta.url);
await mkdir(evidence, { recursive: true });

const token = 'release_'.repeat(22);
const shortOption = 'Use the stable release';
const shortSubject = 'Release notes';
const draftText = `Release details\n${token}\nReady for review.`;
const bot = {
  id: 'card-layout', name: 'Card QA Bot', kind: 'agent', mode: 'personal', isPrimary: true, pinned: true,
  generation: 1, unread: 0, createdAt: 0, lastActivityAt: 0, description: '', label: '', instructions: '',
  model: null, effort: 'medium', avatarShape: 'blob', avatarColor: 'blue',
};
const row = (seq, body) => ({ botId: bot.id, generation: 1, seq, updatedSeq: seq, kind: 'card', audience: 'user', createdAt: seq, body: { type: 'card', ...body } });
const question = { card: 'question', question: 'Choose a release', options: [token, shortOption], status: 'pending' };
const draft = { card: 'draft', channel: 'email', to: 'qa@example.test', subject: token, text: draftText, approvalId: '', status: 'pending' };
const rows = [
  row(1, question),
  row(2, draft),
  row(3, { ...question, question: 'Chosen release', status: 'answered', answer: token }),
  row(4, { ...question, question: 'Choose a normal release', options: [shortOption] }),
  row(5, { ...draft, subject: shortSubject, text: 'Ready for review.' }),
];

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
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await fetch(origin).then(response => response.ok, () => false)) { ready = true; break; }
    if (vite.exitCode !== null) throw new Error(logs);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, `Local dev server started: ${logs}`);
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const width of [1280, 1024, 768, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    page.setDefaultTimeout(10000);
    const unexpected = [];
    page.on('pageerror', error => unexpected.push(error.message));
    await page.addInitScript(botId => {
      localStorage.setItem('swarm.selectedBot', botId);
      localStorage.setItem('swarm.theme', 'light');
      window.EventSource = class {
        static CLOSED = 2;
        constructor() { setTimeout(() => this.onopen?.(), 0); }
        close() {}
      };
    }, bot.id);
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname;
      if (url.origin !== origin) { unexpected.push(`External request: ${url.origin}`); return route.abort(); }
      if (!path.startsWith('/api/')) return route.continue();
      if (request.method() !== 'GET') { unexpected.push(`${request.method()} ${path}`); return route.abort(); }
      let body = {};
      if (path === '/api/auth/me') body = { user: { id: 'qa', name: 'QA account', email: 'qa@example.test' } };
      else if (path === '/api/bots') body = { bots: [bot], live: [] };
      else if (path.endsWith('/rows')) body = { generation: 1, rows };
      else if (path.endsWith('/tasks')) body = { tasks: [] };
      else if (path.endsWith('/routines')) body = { routines: [] };
      else if (path.endsWith('/coworker-setups')) body = { setups: [] };
      else if (path.endsWith('/suggested-apps')) body = { suggestions: [] };
      else if (path === '/api/team/exchanges') body = { exchanges: [], nextBefore: null };
      else if (path === '/api/models') body = { provider: 'openrouter', billing: 'api', models: [], favourites: [], canFast: false };
      else if (path === '/api/settings') body = { settings: {}, computer: { provider: 'local' } };
      else if (path === '/api/voice/options') body = { voices: [], languages: [], speeds: [], configured: false };
      else if (path === '/api/checkins/reports') body = { reports: [], nextCursor: null, hasMore: false };
      else if (path === '/api/computer') body = { computer: { provider: 'local', status: 'absent', screens: [] } };
      else if (path === '/api/needs-you') body = { items: [] };
      else if (path === '/api/apps') body = { apps: [], connected: [], categories: [], total: 0 };
      return route.fulfill({ json: body });
    });
    try {
      await page.goto(origin);
      if (width <= 760) await page.locator('.pinned__tile').filter({ hasText: bot.name }).click();
      await page.locator('.draft-card').last().waitFor();
      await page.evaluate(() => document.fonts.ready);
      const questions = page.locator('.question-card'), drafts = page.locator('.draft-card');
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
      await questions.nth(0).screenshot({ path: new URL(`${width}-question.png`, evidence).pathname });
      await checkText(drafts.nth(0).locator('.draft-card__subject'), token, true, 'draft subject');
      await checkText(drafts.nth(0).locator('.draft-card__text'), draftText, true, 'draft body');
      await drafts.nth(0).screenshot({ path: new URL(`${width}-draft.png`, evidence).pathname });
      await checkText(questions.nth(1).locator('.question-option__label').first(), token, true, 'answered option');
      await checkText(questions.nth(0).locator('.question-option__label').last(), shortOption, false, 'short option beside long option');
      await checkText(questions.nth(2).locator('.question-option__label'), shortOption, false, 'normal question');
      await checkText(drafts.nth(1).locator('.draft-card__subject'), shortSubject, false, 'normal subject');
      for (const [cards, defaultWidth] of [[questions, 560], [drafts, 414]]) {
        const widths = await cards.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().width));
        assert.ok(widths.every(value => value > 0 && value <= defaultWidth), 'Cards retain their default maximum width');
        assert.ok(widths.every(value => value === widths.at(-1)), 'Long identifiers do not change card width');
        if (width >= 1024) assert.equal(widths[0], defaultWidth, 'Default card width on desktop');
      }
      assert.deepEqual(unexpected, [], 'No page errors, external requests, or API writes');
    } catch (error) { failures.push(`${width}px: ${error.message}`); }
    await page.close();
  }
  await writeFile(new URL('measurements.json', evidence), JSON.stringify(report, null, 2));
  assert.deepEqual(failures, [], 'Card text remains visible at every required viewport');
  console.log('PASS card identifiers: 1280, 1024, 768, 390px; pending and answered options, draft subject/body, normal card widths');
} finally {
  await browser?.close();
  vite.kill('SIGTERM');
}
