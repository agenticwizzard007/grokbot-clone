// Local full-app regressions for I04 and I06. Every API response is synthetic.
// Run: node tests/qa-model-menu-ui.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';

const evidence = new URL('../.context/model-menu/', import.meta.url);
await fs.mkdir(evidence, { recursive: true });
const port = await new Promise(resolve => {
  const socket = http.createServer().listen(0, '127.0.0.1', () => {
    const port = socket.address().port;
    socket.close(() => resolve(port));
  });
});
const origin = `http://127.0.0.1:${port}`;
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: new URL('../web', import.meta.url), stdio: 'pipe' });
let logs = '';
vite.stdout.on('data', data => { logs += data; });
vite.stderr.on('data', data => { logs += data; });
const wait = async (check, label) => {
  for (let i = 0; i < 150; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${label}`);
};
const now = Date.now();
const model = { id: 'test/reasoning', name: 'Test reasoning', short: 'Test reasoning', author: 'test', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium', billing: 'api', vision: true, reasoning: true, context: 0 };
const initialBot = { id: 'bot_picker_fixture', name: 'Research', description: '', instructions: '', label: '', mode: 'personal', pinned: true, isPrimary: true, effort: 'medium', model: model.id, generation: 1, unread: 0, lastPreview: '', lastActivityAt: now, createdAt: now, voice: 'ara', voiceSpeed: 1, voiceLanguage: 'auto', kind: 'agent', onboarding: { status: 'active' }, avatarColor: 'blue', avatarShape: 'blob' };
const rows = Array.from({ length: 60 }, (_, i) => ({ botId: initialBot.id, generation: 1, seq: i + 1, updatedSeq: i + 1, createdAt: now + i, kind: 'message', body: { type: 'message', role: i % 2 ? 'assistant' : 'user', text: `Fixture message ${i + 1}. A populated conversation makes the scroll control available for the picker regression.` } }));
let browser, page;

const settleMenu = () => page.locator('.mm-wrap').evaluate(el => Promise.all(el.getAnimations({ subtree: true }).filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished)));
const openMenu = async () => {
  await page.locator('.model-pill').click();
  await page.getByRole('button', { name: 'API details', exact: true }).waitFor();
  await settleMenu();
};
const assertStacking = async (requireOverlap = false) => {
  const result = await page.evaluate(() => {
    const jump = document.querySelector('.jump-btn');
    const j = jump.getBoundingClientRect();
    const controls = [...document.querySelectorAll('.mm-wrap button, .mm-wrap input, .mm-wrap a')];
    const overlaps = [];
    for (const control of controls) {
      const r = control.getBoundingClientRect();
      const left = Math.max(r.left, j.left), right = Math.min(r.right, j.right);
      const top = Math.max(r.top, j.top), bottom = Math.min(r.bottom, j.bottom);
      if (right <= left || bottom <= top) continue;
      for (const [x, y] of [[(left + right) / 2, (top + bottom) / 2], [left + 1, top + 1], [right - 1, bottom - 1]]) {
        const hit = document.elementFromPoint(x, y);
        overlaps.push({ label: control.textContent || control.getAttribute('aria-label'), covered: !!hit?.closest('.mm-wrap'), jumpOnTop: jump.contains(hit) });
      }
    }
    const center = document.elementFromPoint(j.x + j.width / 2, j.y + j.height / 2);
    const menu = document.querySelector('.mm-wrap').getBoundingClientRect();
    const jumpInside = j.x + j.width / 2 >= menu.left && j.x + j.width / 2 <= menu.right && j.y + j.height / 2 >= menu.top && j.y + j.height / 2 <= menu.bottom;
    return { overlaps, jumpCovered: !jumpInside || !jump.contains(center) };
  });
  if (requireOverlap) assert.ok(result.overlaps.length > 0, 'fixture exercises intersecting jump and picker control bounds');
  assert.equal(result.jumpCovered, true, 'jump does not paint over the picker');
  assert.ok(result.overlaps.every(item => item.covered && !item.jumpOnTop), `no painted or clickable jump intersection with picker controls: ${JSON.stringify(result.overlaps)}`);
};
const clickPickerControl = async control => {
  const point = await control.evaluate(el => {
    const r = el.getBoundingClientRect(), j = document.querySelector('.jump-btn').getBoundingClientRect();
    const left = Math.max(r.left, j.left), right = Math.min(r.right, j.right);
    const top = Math.max(r.top, j.top), bottom = Math.min(r.bottom, j.bottom);
    return right > left && bottom > top ? { x: (left + right) / 2, y: (top + bottom) / 2 } : { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(point.x, point.y);
  assert.equal(await page.evaluate(() => window.__jumpClicks), 0, 'jump never receives a click intended for a picker control');
  assert.equal(await page.locator('.jump-btn').isVisible(), true, 'the transcript remains scrolled up');
};
const assertEffortFits = async () => {
  await page.getByRole('listbox', { name: 'Effort', exact: true }).waitFor();
  await settleMenu();
  const result = await page.evaluate(() => {
    const chat = document.querySelector('.chat').getBoundingClientRect();
    const container = document.querySelector('.mm-flyout') || document.querySelector('.model-menu');
    const inside = (r, bounds) => r.width > 0 && r.height > 0 && r.left >= bounds.left - 0.5 && r.right <= bounds.right + 0.5 && r.top >= bounds.top - 0.5 && r.bottom <= bounds.bottom + 0.5;
    const box = container.getBoundingClientRect();
    const parts = [...document.querySelectorAll('.mm-effort, .mm-effort__desc, .mm-effort[aria-selected="true"] > svg')];
    return {
      containerInside: inside(box, chat),
      descriptions: document.querySelectorAll('.mm-effort__desc').length,
      selected: document.querySelectorAll('.mm-effort[aria-selected="true"] > svg').length,
      parts: parts.map(el => {
        const r = el.getBoundingClientRect();
        return { label: el.textContent || 'selection indicator', inside: inside(r, chat) && inside(r, box), unclipped: el.scrollWidth <= el.clientWidth + 1,
          hit: [[r.left + 1, r.top + r.height / 2], [r.right - 1, r.top + r.height / 2]].every(([x, y]) => el.closest('.mm-effort').contains(document.elementFromPoint(x, y))) };
      }),
    };
  });
  assert.equal(result.containerInside, true, 'effort list is fully inside visible chat');
  assert.equal(result.descriptions, model.efforts.length);
  assert.equal(result.selected, 1, 'selection indicator is present');
  assert.ok(result.parts.every(part => part.inside && part.unclipped && part.hit), `effort descriptions and selection indicator are fully visible: ${JSON.stringify(result.parts)}`);
};

try {
  await wait(() => fetch(origin).then(response => response.ok, () => false), 'local Vite');
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const width of [1280, 1180, 1024, 768, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [], patches = [];
    let bot = { ...initialBot };
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(id => {
      localStorage.setItem('swarm.selectedBot', id);
      localStorage.setItem('swarm.sidebarCollapsed', '0');
      window.EventSource = class { constructor() { setTimeout(() => this.onopen?.(), 0); } close() {} };
      window.__jumpClicks = 0;
      document.addEventListener('click', event => { if (event.target.closest('.jump-btn')) window.__jumpClicks++; }, true);
    }, bot.id);
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname;
      if (url.origin !== origin) return route.abort();
      if (!path.startsWith('/api/')) return route.continue();
      if (path === `/api/bots/${bot.id}` && request.method() === 'PATCH') {
        const patch = request.postDataJSON(); patches.push(patch); bot = { ...bot, ...patch };
        return route.fulfill({ json: { bot } });
      }
      let body = {};
      if (path === '/api/auth/me') body = { user: { id: 'fixture_account', name: 'Test account', email: 'fixture@example.test' } };
      else if (path === '/api/bots') body = { bots: [bot], live: [{ botId: bot.id, isRunning: false }] };
      else if (path.endsWith('/rows')) body = { generation: 1, rows };
      else if (path.endsWith('/routines')) body = { routines: [] };
      else if (path.endsWith('/coworker-setups')) body = { setups: [] };
      else if (path.endsWith('/tasks')) body = { tasks: [] };
      else if (path === '/api/team/exchanges') body = { exchanges: [], nextBefore: null };
      else if (path === '/api/needs-you') body = { items: [] };
      else if (path === '/api/computer') body = { computer: { provider: 'local', status: 'absent', screens: [], error: null } };
      else if (path === '/api/models') body = { provider: 'direct', billing: 'api', models: [model], defaultModel: model.id, favourites: [model.id], canFast: true };
      else if (path === '/api/settings') body = { settings: {}, computer: { provider: 'local' } };
      else if (path === '/api/voice/options') body = { voices: [], languages: [], speeds: [], configured: false };
      else if (path === '/api/apps') body = { apps: [], connected: [], categories: [], total: 0 };
      else if (path.endsWith('/suggested-integrations')) body = { status: 'ready', suggestions: [] };
      else if (path === '/api/cli') body = { connected: false, providers: { codex: { installed: false }, claude: { installed: false } } };
      return route.fulfill({ json: body });
    });
    await page.goto(origin);
    if (width <= 760) await page.locator('.pinned__tile').click();
    await page.locator('.bubble').last().waitFor();
    const transcript = page.locator('.transcript');
    await wait(() => transcript.evaluate(el => el.scrollHeight > el.clientHeight * 2), 'populated transcript');
    await transcript.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await wait(() => transcript.evaluate(el => el.scrollTop + el.clientHeight >= el.scrollHeight - 1), 'start at bottom');
    await transcript.hover();
    await page.mouse.wheel(0, -10000);
    await page.locator('.jump-btn').waitFor();
    await openMenu();
    await assertStacking(true);
    if (width === 390) {
      const backdrop = await page.locator('.chat__header').evaluate(header => {
        const r = header.getBoundingClientRect();
        const scrim = document.querySelector('.mm-scrim');
        const box = scrim.getBoundingClientRect(), style = getComputedStyle(scrim);
        return { covers: box.left <= r.left && box.right >= r.right && box.top <= r.top && box.bottom >= r.bottom,
          onTop: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === scrim,
          color: style.backgroundColor, opacity: Number(style.opacity) };
      });
      assert.equal(backdrop.covers && backdrop.onTop, true, 'phone scrim covers the chat header and intercepts header clicks');
      assert.ok(backdrop.opacity > 0 && backdrop.color !== 'rgba(0, 0, 0, 0)' && backdrop.color !== 'transparent', 'phone scrim visibly dims header');
    }
    await page.screenshot({ path: new URL(`picker-${width}.png`, evidence).pathname });
    await clickPickerControl(page.getByRole('button', { name: 'API details', exact: true }));
    await page.getByRole('dialog', { name: 'Connection details', exact: true }).waitFor();
    await assertStacking();
    await page.getByRole('button', { name: 'Back to models', exact: true }).click();
    await clickPickerControl(page.getByRole('button', { name: 'Effort', exact: true }));
    await assertEffortFits();
    await assertStacking();
    await page.keyboard.press('Escape');
    if (await page.locator('.mm-wrap').count()) await page.keyboard.press('Escape');

    if (width >= 1180) {
      assert.equal(await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).isVisible(), true);
      await page.getByRole('button', { name: 'Show details', exact: true }).click();
      await page.locator('.bot-details-pane').waitFor();
      await openMenu();
      await page.locator('.mm-row__effort').click();
      await assertEffortFits();
      await page.screenshot({ path: new URL(`effort-details-${width}.png`, evidence).pathname });
      // The open picker must also adapt when Details changes without a window resize.
      await page.keyboard.press('Control+Shift+,');
      await page.locator('.bot-details-pane').waitFor({ state: 'hidden' });
      await page.locator('.mm-flyout').waitFor();
      await assertEffortFits();
      await page.keyboard.press('Escape');
      await page.locator('.mm-wrap').waitFor({ state: 'detached' });
      await openMenu();
      await page.locator('.mm-row__effort').click();
      await page.locator('.mm-flyout').waitFor();
      await page.keyboard.press('Control+Shift+,');
      await page.locator('.bot-details-pane').waitFor();
      await page.locator('.mm-flyout').waitFor({ state: 'detached' });
      await assertEffortFits();
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'API details', exact: true }).waitFor();
      await page.locator('.mm-row__effort').click();
    } else {
      await openMenu();
      await page.locator('.mm-row__effort').click();
      await assertEffortFits();
    }
    await page.getByRole('option', { name: /^High\b/ }).click();
    await wait(() => patches.length === 1, 'fake effort save');
    assert.deepEqual(patches[0], { model: model.id, effort: 'high' });
    await page.locator('.mm-wrap').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.model-pill').evaluate(el => el === document.activeElement), true, 'closing restores focus');
    await page.locator('.jump-btn').click();
    assert.equal(await page.evaluate(() => window.__jumpClicks), 1, 'jump works again after closing');
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}: picker stacking, API details, effort containment, real pointer clicks${width >= 1180 ? ', expanded sidebar and Details, live column resize' : ''}`);
    await context.close();
    page = null;
  }
} catch (error) {
  if (page) await page.screenshot({ path: new URL('failure.png', evidence).pathname });
  console.error(logs.slice(-2000));
  throw error;
} finally {
  await browser?.close();
  vite.kill();
  await new Promise(resolve => vite.exitCode !== null ? resolve() : vite.once('exit', resolve));
}
