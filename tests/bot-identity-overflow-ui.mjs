// Local fixtures only. Run with UI_ORIGIN pointing at a Vite dev server or preview.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const origin = process.env.UI_ORIGIN ?? 'http://127.0.0.1:5198';
assert.match(origin, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/, 'Use a local frontend for identity fixtures.');
const out = new URL('../.context/bot-identity-overflow/', import.meta.url);
await fs.mkdir(out, { recursive: true });
const draftName = 'W'.repeat(60);
const label = 'W'.repeat(40);
const bot = {
  id: 'identity-fixture', name: 'QA-Long-' + 'B'.repeat(80), label, description: '', instructions: '',
  avatarShape: 'square', avatarColor: 'blue', mode: 'personal', isPrimary: true, kind: 'agent',
  effort: 'medium', model: null, generation: 1, unread: 0, lastActivityAt: 1, createdAt: 1,
  voice: '', voiceSpeed: 1, voiceLanguage: 'auto', onboarding: { status: 'active' },
};
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const results = [];
const failures = [];

async function checkText(page, selector, column, pane, expected, width) {
  const text = page.locator(selector);
  assert.equal(await text.textContent(), expected);
  const geometry = await text.evaluate((element, { column, pane }) => {
    const box = element => {
      const { left, right, top, bottom, width, height } = element.getBoundingClientRect();
      return { left, right, top, bottom, width, height, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
    };
    const range = document.createRange();
    range.selectNodeContents(element);
    return {
      text: box(element), column: box(element.closest(column)), pane: box(element.closest(pane)),
      lines: [...range.getClientRects()].map(({ left, right, top, bottom }) => ({ left, right, top, bottom })),
      viewport: window.innerWidth,
    };
  }, { column, pane });
  const context = `${width}px ${selector}`;
  const check = (ok, message) => { if (!ok) failures.push(`${context}: ${message}`); };
  for (const [name, box] of Object.entries({ text: geometry.text, column: geometry.column })) {
    check(box.clientWidth > 0, `${name} is visible`);
    check(box.scrollWidth <= box.clientWidth, `${name} scrollWidth ${box.scrollWidth} exceeds clientWidth ${box.clientWidth}`);
  }
  check(geometry.lines.length > 0, 'text has painted line boxes');
  // Range rectangles catch centered text escaping either edge even when a parent clips it.
  for (const box of [geometry.text, ...geometry.lines]) {
    for (const [name, bounds] of Object.entries({ column: geometry.column, pane: geometry.pane })) {
      check(box.left >= bounds.left - 0.5 && box.right <= bounds.right + 0.5, `text escapes ${name} horizontally`);
      check(box.top >= bounds.top - 0.5 && box.bottom <= bounds.bottom + 0.5, `text escapes ${name} vertically`);
    }
    check(box.left >= 0 && box.right <= geometry.viewport, 'text escapes the viewport');
  }
  return geometry;
}

try {
  for (const width of (process.env.QA_WIDTHS ? process.env.QA_WIDTHS.split(',').map(Number) : [1440, 1280, 1024, 768, 390])) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce', serviceWorkers: 'block' });
    const errors = [], writes = [], external = [];
    await context.addInitScript(() => {
      localStorage.setItem('swarm.selectedBot', 'identity-fixture');
      localStorage.setItem('swarm.theme', 'light');
      window.EventSource = class { static CLOSED = 2; constructor() { queueMicrotask(() => this.onopen?.({})); } close() {} };
    });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname;
      if (url.origin !== origin) { external.push(url.href); return route.abort(); }
      if (!path.startsWith('/api/')) return route.continue();
      // Suggestions use POST for a read of the draft; answer locally before blocking writes.
      if (path.endsWith('/suggested-apps') && request.method() === 'POST') return route.fulfill({ json: { suggestions: [] } });
      if (request.method() !== 'GET') {
        writes.push(`${request.method()} ${path}`);
        return route.fulfill({ status: 400, json: { error: 'Fixture writes are blocked.' } });
      }
      const send = json => route.fulfill({ json });
      if (path === '/api/auth/me') return send({ user: { id: 'identity-account', name: 'Fixture Account', email: 'identity@example.test' } });
      if (path === '/api/bots') return send({ bots: [bot], live: [] });
      if (path.endsWith('/rows')) return send({ generation: 1, rows: [] });
      if (path.endsWith('/routines')) return send({ routines: [] });
      if (path.endsWith('/tasks')) return send({ tasks: [] });
      if (path.endsWith('/learning/settings')) return send({ settings: {
        enabled: true, automaticReview: true, memoryReview: true, skillReview: true, skillApproval: true,
        memoryTurnInterval: 10, skillIterationInterval: 10, maxIterations: 16, maxInputTokens: 32000,
        auxiliaryModel: null, auxiliaryProvider: null, curatorEnabled: true, curatorIntervalHours: 168,
        curatorMinIdleHours: 2, curatorStaleDays: 14, curatorArchiveDays: 30, curatorConsolidate: false,
      }, overrides: {}, revision: 1, accountRevision: 1, botId: bot.id });
      if (path.endsWith('/analytics')) return send({ range: '7d', timezone: 'UTC', days: [{ day: '2026-11-23', messages: 0, minutesSaved: 0 }], totals: { messages: 0, minutesSaved: 0 }, breakdown: [], rates: { pageRead: 1, search: 1, message: 1, code: 1 } });
      if (path.endsWith('/files')) return send({ status: 'ok', path: '', files: [] });
      if (path.endsWith('/memories/pending')) return send({ changes: [] });
      if (path.endsWith('/settings')) return send({ settings: {}, skills: [], memories: [], routines: [], tasks: [], memory: { historyChars: 0, compactAtChars: 1000, lastCompaction: null } });
      if (path.endsWith('/coworker-setups')) return send({ setups: [] });
      if (path === '/api/team/exchanges') return send({ exchanges: [], nextBefore: null });
      if (path === '/api/computer') return send({ computer: { status: 'stopped', provider: 'local', screens: [] } });
      if (path === '/api/models') return send({ models: [], favourites: [], provider: 'direct', billing: 'api' });
      if (path === '/api/voice/options') return send({ voices: [], speeds: [1], languages: [{ code: 'auto', name: 'Auto-detect' }] });
      return route.fulfill({ status: 404, json: { error: 'No fixture for this read.' } });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
    await page.goto(origin);
    if (width <= 760) await page.locator('.pinned__tile').click();
    await page.getByRole('button', { name: `Open ${bot.name} details`, exact: true }).click();
    const details = page.getByRole('complementary', { name: 'Conversation details' });
    await details.locator('.bot-detail-identity p').waitFor();
    await page.evaluate(() => document.fonts.ready);
    await details.evaluate(element => element.scrollTo(0, 0));
    const labelGeometry = await checkText(page, '.bot-detail-identity p', '.bot-detail-identity', '.details', label, width);
    await page.screenshot({ path: new URL(`label-${width}.png`, out).pathname });
    // I08: every Details tab must contain a saved, unbroken name, including the workflow card.
    for (const tab of ['Activity', 'Tasks', 'Files', 'Setup']) {
      await details.getByRole('navigation').getByRole('button', { name: tab, exact: true }).click();
      await details.evaluate(el => el.scrollTo(0, 0));
      await page.waitForTimeout(100);
      const overflow = await details.evaluate(el => [el, ...el.querySelectorAll('.details-page__column, .work-row, .work-meta')]
        .map(node => ({ className: node.className, scroll: node.scrollWidth, client: node.clientWidth }))
        .filter(node => node.scroll > node.client));
      assert.deepEqual(overflow, [], `${width}: ${tab} has no horizontal overflow`);
      if (tab === 'Activity' || tab === 'Tasks') {
        const meta = details.locator('.work-meta').filter({ hasText: 'Plan and review work' });
        assert.equal(await meta.textContent(), `Plan and review work for ${bot.name}.`);
        const fits = await meta.evaluate(el => {
          const range = document.createRange(); range.selectNodeContents(el);
          const rect = el.getBoundingClientRect();
          return [...range.getClientRects()].every(line => line.left >= rect.left - .5 && line.right <= rect.right + .5);
        });
        assert.ok(fits, 'workflow name wraps without clipping');
      }
      await page.screenshot({ path: new URL(`details-${tab}-${width}.png`, out).pathname });
    }
    await details.getByRole('button', { name: 'Close details', exact: true }).click();
    await page.locator('.chat__pill').click();
    await page.getByRole('menuitem', { name: 'Bot settings', exact: true }).click();
    const settings = page.locator('.bot-settings-page');
    const nameInput = settings.getByRole('textbox', { name: 'Name', exact: true });
    assert.equal(await nameInput.getAttribute('maxlength'), '60');
    assert.equal(await settings.getByRole('textbox', { name: 'Label', exact: true }).getAttribute('maxlength'), '40');
    const nav = settings.getByRole('navigation', { name: 'Bot settings sections' });
    const position = await nav.boundingBox();
    for (const tab of ['Skills', 'Memories', 'Routines', 'Learning', 'Analytics', 'General']) {
      await nav.getByRole('button', { name: tab, exact: true }).click();
      await settings.evaluate(el => el.scrollTo(0, 0));
      await page.waitForTimeout(100);
      const next = await nav.boundingBox();
      assert.equal(next.x, position.x, `${width}: ${tab} tab bar x`);
      assert.equal(next.y, position.y, `${width}: ${tab} tab bar y`);
      if (!await settings.evaluate(el => el.scrollWidth <= el.clientWidth)) console.log(await settings.evaluate(el => [...el.querySelectorAll('*')].filter(n => n.scrollWidth > n.clientWidth && n.clientWidth > 0).map(n => [n.className, n.scrollWidth, n.clientWidth, n.textContent?.slice(0, 100)])));
      assert.ok(await settings.evaluate(el => el.scrollWidth <= el.clientWidth), `${width}: ${tab} settings overflow`);
      if (tab === 'Learning') {
        await settings.getByRole('checkbox', { name: 'Learning enabled', exact: true }).waitFor();
        const rows = await settings.locator('.learning-flags .cfg-row').evaluateAll(rows => rows.map(row => {
          const icon = row.querySelector('.settings-row__icon').getBoundingClientRect();
          const text = row.querySelector('.cfg-row__title').getBoundingClientRect();
          const control = row.querySelector('input').getBoundingClientRect();
          return { iconWidth: icon.width, iconHeight: icon.height, gap: text.x - icon.right, centers: icon.y - text.y - 2, controlGap: control.x - text.right };
        }));
        assert.equal(rows.length, 5);
        for (const row of rows) {
          assert.equal(row.iconWidth, 20); assert.equal(row.iconHeight, 20);
          assert.equal(row.gap, 16); assert.ok(Math.abs(row.centers) <= 1);
          assert.ok(row.controlGap >= 16);
        }
        await page.screenshot({ path: new URL(`learning-${width}.png`, out).pathname });
      }
    }
    await nameInput.fill(draftName);
    await settings.locator('.cfg-savebar.is-dirty').waitFor();
    await settings.evaluate(element => element.scrollTo(0, 0));
    const nameGeometry = await checkText(page, '.cfg-look__name', '.cfg-look__text', '.cfg-look', draftName, width);
    const avatar = await settings.locator('.cfg-look > .bot-avatar').boundingBox();
    assert.equal(avatar.width, 72, 'appearance avatar keeps its width');
    assert.equal(avatar.height, 72, 'appearance avatar keeps its height');
    assert.equal(await nameInput.inputValue(), draftName, 'all 60 characters remain in the unsaved draft');
    await page.screenshot({ path: new URL(`name-${width}.png`, out).pathname });
    assert.deepEqual(writes, [], 'the name remains unsaved');
    assert.deepEqual(external, [], 'all requests stay local');
    assert.deepEqual(errors, [], 'no browser errors');
    results.push({ width, name: nameGeometry, label: labelGeometry });
    await context.close();
    console.log(`Checked identity text at ${width}px`);
  }
  await fs.writeFile(new URL('verification.json', out), JSON.stringify({ results, failures }, null, 2) + '\n');
  assert.deepEqual(failures, [], 'identity text stays within its column and pane');
  console.log('PASS identity text: unsaved 60-character names and 40-character labels at all five widths');
} finally {
  await browser.close();
}
