// Exercise the real responsive Tasks view against an isolated, mocked API.
// Run after npm run build -w web. No provider calls or live task changes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';

const port = await new Promise((resolve) => {
  const s = http.createServer().listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); });
});
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(port)], { cwd: new URL('../web', import.meta.url), stdio: 'pipe' });
const origin = `http://127.0.0.1:${port}`;
let logs = '';
vite.stdout.on('data', (s) => { logs += s; });
vite.stderr.on('data', (s) => { logs += s; });
const now = Date.now();
const bots = ['Quinn', 'Atlas', 'Nova'].map((name, i) => ({ id: `bot-${i}`, name, label: ['Your primary bot', 'Research & strategy', 'Product & engineering'][i], description: '', instructions: '', avatarShape: ['blob', 'star', 'flower'][i], avatarColor: ['blue', 'purple', 'green'][i], mode: 'personal', isPrimary: i === 0, pinned: i === 0, effort: 'medium', model: null, voice: 'ara', voiceSpeed: 1, voiceLanguage: 'auto', generation: 1, unread: 0, lastPreview: ['Your team is ready.', 'Comparing agent architectures.', 'Your launch summary is ready.'][i], lastActivityAt: now, createdAt: now }));
const sampleTasks = [
  ['needs_input', 'GrokBot Architecture Comparison', 'Which architecture should I use for the prototype?', 1, 3],
  ['needs_input', 'Live Trading Co-Pilot', 'Please confirm the trading limits before I continue.', 0, 7],
  ['needs_input', 'Obelisk AI Google Cloud Setup', 'Connect your Google Cloud account to continue.', 2, 24],
  ['working', 'Open-Instinct Comparison', 'Comparing multi-agent coordination and workflows.', 1, 0.04],
  ['working', 'Systemised.com Infoproduct', 'Checking sources and tightening the final draft.', 0, 0.2],
  ['working', 'AI Video Generation Tools', 'Evaluating tools against your requirements.', 1, 0.44],
  ['working', 'E2B System Design', 'Mapping the sandbox lifecycle and API.', 2, 1],
  ['done', 'Grokbot Launch and Test', 'Build checks passed. Your launch summary is ready.', 2, 1],
  ['done', 'Connection and Preparation', 'Account setup and app connections are complete.', 0, 24],
].map(([state, title, note, bot, hours], i) => ({ id: `task-${i}`, botId: bots[bot].id, title, note, state, updatedAt: now - hours * 3600000 }));
const screenshotDir = new URL('../.context/tasks/', import.meta.url);
await fs.mkdir(screenshotDir, { recursive: true });
let browser;
try {
  for (let n = 0; n < 100; n++) {
    if (await fetch(origin).then((r) => r.ok, () => false)) break;
    if (vite.exitCode !== null) throw new Error(logs);
    await new Promise((r) => setTimeout(r, 100));
  }
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  for (const width of [1440, 390, 320, 768, 1024]) {
    const page = await browser.newPage({ viewport: { width, height: width > 1100 ? 1000 : 844 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(8000);
    let tasks = structuredClone(sampleTasks), failing = false;
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      let body = {};
      if (path === '/api/auth/me') body = { user: { id: 'user-a', name: 'Alex Rivera', email: 'alex@example.com' } };
      else if (path === '/api/bots') body = { bots, live: [] };
      else if (path.endsWith('/tasks')) {
        if (failing) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Unavailable"}' });
        const botId = path.match(/\/bots\/([^/]+)\/tasks/)?.[1];
        body = { tasks: botId ? tasks.filter((t) => t.botId === botId) : tasks };
      } else if (path.endsWith('/rows')) body = { generation: 1, rows: [] };
      else if (path.endsWith('/routines')) body = { routines: [] };
      else if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"type":"hello"}\n\n' });
      else if (path === '/api/computer') body = { computer: { status: 'absent', screens: [] } };
      else if (path === '/api/voice/options') body = { voices: [], languages: [], speeds: [], configured: false };
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    });
    const openTasks = async () => {
      if (width <= 760) await page.getByRole('button', { name: 'Open bots', exact: true }).click();
      await page.locator('.sidebar').getByRole('button', { name: 'Tasks', exact: true }).click();
    };
    const checkFits = async () => {
      assert.ok(await page.locator('.tasks-view__scroll').evaluate((el) => el.scrollWidth <= el.clientWidth + 1), `${width}: no horizontal task scrolling`);
      const outside = await page.locator('.tasks-view button, .tasks-view select, .task-card__title, .task-card__note').evaluateAll((els) => els.filter((el) => {
        const r = el.getBoundingClientRect(); return r.width && (r.left < -1 || r.right > innerWidth + 1);
      }).map((el) => el.className));
      assert.deepEqual(outside, [], `${width}: task controls and text fit`);
    };
    const changed = () => page.evaluate(() => window.dispatchEvent(new CustomEvent('swarm:event', { detail: { type: 'tasks', botId: 'bot-1' } })));
    await page.goto(origin);
    await page.locator('.composer__input').waitFor();
    await openTasks();
    await page.getByText('3 tasks need your input', { exact: true }).waitFor();
    assert.equal(await page.locator('.task-card').count(), 9);
    assert.equal(await page.locator('.task-card').first().locator('.task-card__title').innerText(), 'Obelisk AI Google Cloud Setup', 'oldest pending task appears first');
    await checkFits();
    const columns = await page.locator('.task-column').evaluateAll((els) => els.map((e) => ({ x: e.getBoundingClientRect().x, y: e.getBoundingClientRect().y })));
    if (width === 1440) assert.ok(columns.every((c) => c.y === columns[0].y), 'wide board has three status columns');
    if (width <= 760) assert.ok(columns.every((c) => c.x === columns[0].x), 'phone uses a vertical status list');
    if (width === 1440 || width === 390) await page.screenshot({ path: new URL(width === 1440 ? 'web.png' : 'mobile.png', screenshotDir).pathname });
    await page.getByRole('button', { name: 'Show pending' }).click();
    assert.equal(await page.locator('.task-card').count(), 3);
    assert.equal(await page.locator('.task-filter.is-needs_input').getAttribute('aria-pressed'), 'true');
    await checkFits();
    if (width === 390) await page.screenshot({ path: new URL('mobile-pending.png', screenshotDir).pathname });
    await page.getByRole('combobox', { name: 'Filter tasks by bot' }).selectOption('bot-1');
    assert.equal(await page.locator('.task-card').count(), 1, 'bot and state filters combine');
    await page.getByRole('button', { name: /Done/ }).click();
    await page.getByRole('heading', { name: 'Nothing finished yet' }).waitFor();
    await page.getByRole('button', { name: 'See all tasks' }).click();
    assert.equal(await page.locator('.task-card').count(), 3, 'resetting state preserves the bot filter');
    await page.getByRole('combobox').selectOption('all');
    await page.locator('.task-filter.is-needs_input').click();
    tasks[0].state = 'done';
    await changed();
    await page.getByText('2 tasks need your input', { exact: true }).waitFor();
    assert.equal(await page.locator('.task-card').count(), 2, 'live update removes completed pending card');
    failing = true;
    await changed();
    await page.getByRole('alert').waitFor();
    assert.equal(await page.locator('.task-card').count(), 2, 'refresh error preserves prior tasks');
    failing = false;
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.getByRole('alert').waitFor({ state: 'hidden' });
    await page.locator('.task-card').first().focus();
    await page.keyboard.press('Enter');
    await page.locator('.composer__input').waitFor();
    assert.match(await page.locator('.chat__pill-name').innerText(), /Nova/, 'keyboard card action opens the correct bot');
    failing = true;
    await openTasks();
    await page.getByRole('alert').waitFor();
    assert.equal(await page.getByText('No tasks yet', { exact: true }).count(), 0, 'failed initial fetch never displays an empty success state');
    failing = false;
    tasks = [];
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.getByRole('heading', { name: 'No tasks yet' }).waitFor();
    await page.locator('.task-filter.is-needs_input').click();
    await page.getByRole('heading', { name: 'No pending tasks' }).waitFor();
    tasks = structuredClone(sampleTasks);
    tasks.push({ id: 'orphan', botId: 'missing-bot', title: 'Unavailable teammate', state: 'working', note: 'Retained task', updatedAt: now });
    await changed();
    await page.getByText('3 tasks need your input', { exact: true }).waitFor();
    await page.locator('.task-filter.is-all').click();
    assert.equal(await page.getByRole('button', { name: /Unavailable teammate/ }).isDisabled(), true);
    tasks[2].title = 'A very long task title with an unbroken identifier: ' + 'longidentifier'.repeat(12);
    tasks[2].note = 'This task needs a detailed response. '.repeat(12);
    await changed();
    await page.getByText(tasks[2].title, { exact: true }).waitFor();
    await checkFits();
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await checkFits();
    if (width === 390) await page.screenshot({ path: new URL('mobile-dark-long-content.png', screenshotDir).pathname });
    assert.deepEqual(errors, [], 'no browser runtime errors');
    await page.close();
    console.log(`PASS ${width}px: status and bot filters, live updates, keyboard navigation, errors/retry, empty state, long content, dark mode`);
  }
} finally { await browser?.close(); vite.kill(); }
