// I15: local account-menu fixtures, with every API request intercepted.
// Run: node tests/account-popover-ui.mjs (starts Vite), or set a local UI_ORIGIN.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';

const evidence = new URL('../.context/account-popover/', import.meta.url);
await fs.mkdir(evidence, { recursive: true });
let server, browser, origin = process.env.UI_ORIGIN, logs = '';
if (!origin) {
  const port = await new Promise(resolve => {
    const socket = http.createServer().listen(0, '127.0.0.1', () => {
      const port = socket.address().port;
      socket.close(() => resolve(port));
    });
  });
  origin = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: new URL('../web', import.meta.url), stdio: 'pipe' });
  server.stdout.on('data', chunk => { logs += chunk; });
  server.stderr.on('data', chunk => { logs += chunk; });
}
assert.match(origin, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/, 'Account fixtures require a local frontend.');

const wait = async (predicate, label) => {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${label}\n${logs}`);
};
const longEmail = `${'q'.repeat(60)}@${'fixture'.repeat(7)}.example.test`;
const inViewport = element => {
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0 && box.top >= 0 && box.left >= 0
    && box.bottom <= innerHeight && box.right <= innerWidth;
};
const insideMenu = element => {
  const box = element.getBoundingClientRect(), menu = element.closest('[role="menu"]');
  const parent = menu.getBoundingClientRect();
  return box.top >= parent.top + menu.clientTop && box.bottom <= parent.top + menu.clientTop + menu.clientHeight
    && box.left >= parent.left && box.right <= parent.right;
};

async function fixturePage(viewport, email) {
  const page = await browser.newPage({ viewport, reducedMotion: 'reduce', timezoneId: 'UTC', serviceWorkers: 'block' });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.EventSource = class {
      static CLOSED = 2;
      constructor() { queueMicrotask(() => this.onopen?.()); }
      close() {}
    };
  });
  await page.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { errors.push(`External request: ${url.href}`); return route.abort(); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (request.method() !== 'GET') { errors.push(`Unexpected write: ${request.method()} ${url.pathname}`); return route.abort(); }
    const fixtures = {
      '/api/auth/me': { user: { id: 'account-fixture', name: 'Account', email, timezone: 'UTC' } },
      '/api/bots': { bots: [], live: [] },
      '/api/computer': { computer: { provider: 'local', status: 'absent', screens: [], error: null } },
      '/api/models': { models: [], favourites: [], provider: 'openrouter', billing: 'api' },
      '/api/needs-you': { items: [] },
      '/api/settings': { settings: {}, computer: { provider: 'local' } },
      '/api/voice/options': { voices: [], languages: [], speeds: [], configured: false },
    };
    return route.fulfill({ json: fixtures[url.pathname] ?? {} });
  });
  await page.goto(origin);
  if (viewport.width <= 760) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page.getByRole('button', { name: /Account & settings$/ }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  return { page, errors };
}

async function assertHeader(page, email) {
  const menu = page.getByRole('menu');
  await wait(() => menu.evaluate(inViewport), 'account menu inside viewport').catch(async error => {
    console.error(await menu.evaluate(element => ({ menu: element.getBoundingClientRect().toJSON(), anchor: element.parentElement.getBoundingClientRect().toJSON(), cap: getComputedStyle(element).maxHeight, innerHeight })));
    await page.screenshot({ path: new URL('failure.png', evidence).pathname });
    throw error;
  });
  assert.equal(await menu.evaluate(element => element.getBoundingClientRect().width <= Math.min(320, innerWidth - 16)), true, 'account text does not widen the popover');
  assert.equal(await menu.locator('.menu__header').count(), 0, 'The compact menu keeps account details on the Account page');
  assert.equal(await menu.evaluate(element => element.scrollWidth <= element.clientWidth), true, 'menu has no horizontal scroller');
  const first = menu.getByRole('menuitem', { name: /^Settings/ });
  assert.equal(await first.evaluate(inViewport), true, 'first action is inside the viewport');
  assert.equal(await first.evaluate(insideMenu), true, 'first action is not clipped by the menu');
}

try {
  await wait(() => fetch(origin).then(response => response.ok, () => false), 'local Vite');
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const email of ['account@example.test', longEmail]) {
    const label = email === longEmail ? 'long' : 'ordinary';
    for (const width of [1280, 1024, 768, 390]) {
      const { page, errors } = await fixturePage({ width, height: 900 }, email);
      for (const collapsed of width > 760 ? [false, true] : [false]) {
        if (collapsed) await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
        await page.getByRole('button', { name: /Account & settings$/ }).click();
        await assertHeader(page, email);
        const last = page.getByRole('menuitem', { name: 'Log out', exact: true });
        assert.equal(await last.evaluate(inViewport), true, 'all actions fit in a tall window');
        assert.equal(await last.evaluate(insideMenu), true, 'last action is not clipped in a tall window');
        await page.screenshot({ path: new URL(`${label}-${width}-${collapsed ? 'collapsed' : 'expanded'}.png`, evidence).pathname });
        await page.keyboard.press('Escape');
        await page.getByRole('menu').waitFor({ state: 'detached' });
      }
      assert.deepEqual(errors, []);
      await page.close();
      console.log(`PASS I15 ${label} account header at ${width}x900`);
    }

    const { page, errors } = await fixturePage({ width: 1024, height: 280 }, email);
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
    await page.getByRole('button', { name: /Account & settings$/ }).click();
    await assertHeader(page, email);
    const menu = page.getByRole('menu');
    assert.equal(await menu.evaluate(element => element.scrollHeight <= element.clientHeight || getComputedStyle(element).overflowY === 'auto'), true, 'short window fits the compact menu or scrolls internally');
    await page.screenshot({ path: new URL(`${label}-1024x280.png`, evidence).pathname });
    await menu.press('End');
    const last = menu.getByRole('menuitem', { name: 'Log out', exact: true });
    assert.equal(await last.evaluate(inViewport), true, 'last action can be reached by keyboard');
    assert.equal(await last.evaluate(insideMenu), true, 'last action scrolls into view');
    await menu.evaluate(element => { element.scrollTop = 0; });
    await assertHeader(page, email);
    // Keep the popover open while the available space changes in both directions.
    await page.setViewportSize({ width: 1024, height: 900 });
    await assertHeader(page, email);
    await wait(() => menu.evaluate(element => element.scrollHeight === element.clientHeight), 'menu expands after a taller resize');
    await page.setViewportSize({ width: 1024, height: 280 });
    await assertHeader(page, email);
    await page.setViewportSize({ width: 1024, height: 900 });
    await assertHeader(page, email);
    await page.keyboard.press('Control+b');
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).waitFor();
    await assertHeader(page, email);
    await page.keyboard.press('Control+b');
    await page.getByRole('button', { name: 'Expand sidebar', exact: true }).waitFor();
    await assertHeader(page, email);
    await page.setViewportSize({ width: 390, height: 900 });
    await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    await page.getByRole('button', { name: /Account & settings$/ }).click();
    await assertHeader(page, email);
    await page.setViewportSize({ width: 1024, height: 280 });
    await page.getByRole('button', { name: /Account & settings$/ }).click();
    await assertHeader(page, email);
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`PASS I15 ${label} collapsed 1024x280: header, first row, last row and resize`);
  }
} finally {
  await browser?.close();
  server?.kill();
}
