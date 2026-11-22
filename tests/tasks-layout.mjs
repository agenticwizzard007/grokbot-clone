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
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', ...(process.env.WORK_UI_DEV === '1' ? [] : ['preview']), '--host', '127.0.0.1', '--port', String(port)], { cwd: new URL('../web', import.meta.url), stdio: 'pipe' });
const origin = `http://127.0.0.1:${port}`;
let logs = '';
vite.stdout.on('data', (s) => { logs += s; });
vite.stderr.on('data', (s) => { logs += s; });
const now = Date.now();
const bots = ['Quinn', 'Atlas', 'Nova'].map((name, i) => ({ id: `bot-${i}`, name, label: ['Your primary bot', 'Research & strategy', 'Product & engineering'][i], description: '', instructions: '', avatarShape: ['blob', 'star', 'flower'][i], avatarColor: ['blue', 'violet', 'green'][i], mode: 'personal', isPrimary: i === 0, pinned: i === 0, effort: 'medium', model: null, voice: 'ara', voiceSpeed: 1, voiceLanguage: 'auto', generation: 1, unread: 0, lastPreview: ['Your team is ready.', 'Comparing agent architectures.', 'Your launch summary is ready.'][i], lastActivityAt: now, createdAt: now }));
const sampleTasks = [
  ['needs_input', 'Swarms Architecture Comparison', 'Which architecture should I use for the prototype?', 1, 3],
  ['needs_input', 'Live Trading Co-Pilot', 'Please confirm the trading limits before I continue.', 0, 7],
  ['needs_input', 'Obelisk AI Google Cloud Setup', 'Connect your Google Cloud account to continue.', 2, 24],
  ['working', 'Open-Instinct Comparison', 'Comparing multi-agent coordination and workflows.', 1, 0.04],
  ['working', 'Systemised.com Infoproduct', 'Checking sources and tightening the final draft.', 0, 0.2],
  ['working', 'AI Video Generation Tools', 'Evaluating tools against your requirements.', 1, 0.44],
  ['working', 'E2B System Design', 'Mapping the sandbox lifecycle and API.', 2, 1],
  ['done', 'Swarms Launch and Test', 'Build checks passed. Your launch summary is ready.', 2, 1],
  ['done', 'Connection and Preparation', 'Account setup and app connections are complete.', 0, 24],
].map(([state, title, note, bot, hours], i) => ({ id: `task-${i}`, botId: bots[bot].id, title, note, state, updatedAt: now - hours * 3600000 }));
const screenshotDir = process.env.WORK_EVIDENCE ? new URL(`file://${process.env.WORK_EVIDENCE.replace(/\/$/, '')}/`) : new URL('../.context/tasks/', import.meta.url);
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
      else if (path.endsWith('/coworker-setups')) body = { setups: [] };
      else if (path.endsWith('/routines')) body = { routines: [] };
      else if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"type":"hello"}\n\n' });
      else if (path === '/api/computer') body = { computer: { status: 'absent', screens: [] } };
      else if (path === '/api/voice/options') body = { voices: [], languages: [], speeds: [], configured: false };
      else if (path === '/api/checkins') body = { enabled: false, times: ['09:00'], timezone: 'UTC', timezoneSource: 'account', quietHours: [] };
      else if (path === '/api/checkins/reports') body = { reports: [], nextCursor: 0, hasMore: false };
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    });
    const openTasks = async () => {
      // Phones: the Bot list is the home screen; from a chat or Tasks, back returns to it.
      if (width <= 760 && !(await page.locator('.sidebar').isVisible())) await page.getByRole('button', { name: /^All Bots/ }).first().click();
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
    await page.locator(width <= 760 ? '.sidebar' : '.composer__input').waitFor();
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
    await page.mouse.move(0, 0);
    await page.waitForFunction(() => {
      const all = document.querySelector('.task-filter.is-all'), sync = document.querySelector('.tasks-sync');
      return all?.getAttribute('aria-pressed') === 'false' && sync && getComputedStyle(all).color === getComputedStyle(sync).color;
    });
    if (width === 390) await page.screenshot({ path: new URL('mobile-pending.png', screenshotDir).pathname });
    await page.getByRole('combobox', { name: 'Filter tasks by bot' }).selectOption('bot-1');
    await page.waitForFunction(() => document.querySelectorAll('.task-card').length === 1);
    assert.equal(await page.locator('.task-card').count(), 1, 'bot and state filters combine');
    await page.getByRole('button', { name: /Done/ }).click();
    await page.getByRole('heading', { name: 'Nothing finished yet' }).waitFor();
    await page.getByRole('button', { name: 'See all tasks' }).click();
    assert.equal(await page.locator('.task-card').count(), 3, 'resetting state preserves the bot filter');
    await page.getByRole('combobox').selectOption('all');
    await page.waitForFunction(() => document.querySelectorAll('.task-card').length === 9);
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
    assert.equal(await page.getByText('No pending tasks', { exact: true }).count(), 0, 'failed scoped fetch never displays an empty success state');
    failing = false;
    tasks = [];
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.getByRole('heading', { name: 'No pending tasks' }).waitFor();
    await page.getByRole('button', { name: 'See all tasks', exact: true }).click();
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
    if (width === 1440) {
      await page.emulateMedia({ colorScheme: 'light' });
      tasks = structuredClone(sampleTasks);
      await openTasks();
      await page.getByText('3 tasks need your input', { exact: true }).waitFor();
      const tabBar = page.getByRole('navigation', { name: 'Work sections' });
      const heading = page.locator('#tasks-heading'), subtitle = page.locator('.work-heading p');
      const boxes = () => tabBar.getByRole('button').evaluateAll(els => els.map(el => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }));
      const sameBoxes = (a, b, label) => { assert.equal(a.length, b.length, label); a.forEach((box, i) => box.forEach((v, j) => assert.ok(Math.abs(v - b[i][j]) <= 1, `${label}: ${JSON.stringify(a[i])} vs ${JSON.stringify(b[i])}`))); };
      const board = await boxes();
      // R2F-014 and R2F-022: fixed titles without a Bot name (the primary only in the Team subtitle), and a tab bar that never moves.
      const pages = [
        ['Team', 'Team', /^Quinn’s board · Owners, dependencies and evidence/],
        ['Goals', 'Goals', /^Keep work running across turns/],
        ['Reports', 'Reports', /^Saved reports · Download saved reports/],
      ];
      for (const [tab, title, sub] of pages) {
        await tabBar.getByRole('button', { name: tab, exact: true }).click();
        await page.waitForFunction(([t, s]) => document.querySelector('#tasks-heading')?.textContent === t && new RegExp(s).test(document.querySelector('.work-heading p')?.textContent ?? ''), [title, sub.source]);
        const text = await subtitle.innerText();
        for (const name of tab === 'Team' ? ['Atlas', 'Nova', 'All Bots'] : ['Quinn', 'Atlas', 'Nova', 'All Bots']) assert.ok(!text.includes(name), `${tab} subtitle names no Bot: ${text}`);
        sameBoxes(await boxes(), board, `${tab} tab bar`);
      }
      for (const [open, title] of [['Daily synopses', 'Daily synopses'], ['Routines', 'Routines']]) {
        await tabBar.getByRole('button', { name: 'Reports', exact: true }).click();
        const backToReports = page.getByRole('button', { name: 'Back to saved reports', exact: true });
        if (await backToReports.count()) await backToReports.click();
        await page.getByRole('button', { name: open, exact: true }).click();
        await page.waitForFunction(t => document.querySelector('#tasks-heading')?.textContent === t, title);
        assert.ok(!(await heading.innerText()).includes('Quinn') && !(await subtitle.innerText()).includes('Quinn'), `${title} names no Bot`);
        sameBoxes(await boxes(), board, `${title} tab bar`);
      }
      await tabBar.getByRole('button', { name: 'Tasks', exact: true }).click();
      await page.getByText('3 tasks need your input', { exact: true }).waitFor();
      sameBoxes(await boxes(), board, 'back on Tasks');
      // R2F-010: Details "See all tasks" opens Tasks filtered to that Bot, with a chip to clear it.
      await page.locator('.bot-row').filter({ hasText: 'Atlas' }).click();
      await page.getByRole('button', { name: 'Open Atlas details', exact: true }).click();
      const details = page.getByRole('complementary', { name: 'Conversation details' });
      await details.getByRole('navigation', { name: 'Conversation details sections' }).getByRole('button', { name: 'Tasks', exact: true }).click();
      await details.getByRole('button', { name: 'See all tasks', exact: true }).click();
      const scope = page.getByRole('combobox', { name: 'Filter tasks by bot' });
      await page.getByText('Showing tasks for Atlas', { exact: true }).waitFor();
      assert.equal(await scope.inputValue(), 'bot-1', 'See all tasks keeps the Bot filter');
      await page.waitForFunction(() => document.querySelectorAll('.task-card').length === 3);
      assert.equal(await page.locator('.task-card').count(), 3, 'only that Bot’s tasks');
      await tabBar.getByRole('button', { name: 'Team', exact: true }).click();
      assert.match(await subtitle.innerText(), /^Quinn’s board · Atlas · /, 'a filtered Bot is named');
      await tabBar.getByRole('button', { name: 'Tasks', exact: true }).click();
      await page.getByRole('button', { name: 'Clear the Atlas filter and show tasks for all Bots', exact: true }).click();
      assert.equal(await scope.inputValue(), 'all');
      await page.waitForFunction(() => document.querySelectorAll('.task-card').length === 9);
      assert.equal(await page.getByText('Showing tasks for', { exact: false }).count(), 0);
      // R2F-029: the "Back to chat" text is part of the button.
      const back = page.locator('.tasks-view__header').getByText('Back to chat', { exact: true });
      const [backBox, buttonBox] = await Promise.all([back.boundingBox(), page.locator('.tasks-view__header').getByRole('button', { name: 'Back to chat', exact: true }).boundingBox()]);
      assert.ok(backBox.x >= buttonBox.x && backBox.x + backBox.width <= buttonBox.x + buttonBox.width + 1, 'label inside the button');
      await back.click();
      await page.locator('.composer__input').waitFor();
      assert.match(await page.locator('.chat__pill-name').innerText(), /Atlas/, 'clicking the text returns to the chat');
    }
    assert.deepEqual(errors, [], 'no browser runtime errors');
    await page.close();
    console.log(`PASS ${width}px: status and bot filters, live updates, keyboard navigation, errors/retry, empty state, long content, dark mode`);
  }
} finally { await browser?.close(); vite.kill(); }
