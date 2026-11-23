// Run: node tests/app-row-overlap-ui.mjs
// Real local dev UI with fake accounts and catalog responses. All API calls are intercepted.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';

const port = await new Promise(resolve => {
  const server = http.createServer().listen(0, '127.0.0.1', () => {
    const value = server.address().port;
    server.close(() => resolve(value));
  });
});
const origin = `http://127.0.0.1:${port}`;
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: new URL('../web', import.meta.url), stdio: 'pipe',
});
let logs = '';
vite.stdout.on('data', data => { logs += data; });
vite.stderr.on('data', data => { logs += data; });
const evidence = new URL('../.context/app-row-overlap/', import.meta.url);
await mkdir(evidence, { recursive: true });

const toolkit = (slug, name, description, connected = false) => ({ slug, name, description, connected, categories: ['productivity'] });
const connectedApps = [
  toolkit('gmail', 'Gmail', 'Search and organize email conversations, read important updates, prepare detailed replies, and keep project correspondence together across shared inboxes and archived messages.', true),
  toolkit('googlecalendar', 'Calendar', 'Review upcoming meetings and organize shared schedules.', true),
  toolkit('slack', 'Slack', 'Find conversations and share updates with project channels.', true),
];
// Three results ensure a following row in the same column in both one and two column layouts.
const searchApps = [
  toolkit('notion', 'Notion', 'Search your workspace pages, read and update detailed project documents, organize databases and meeting notes, and keep related knowledge available to everyone working across your shared workspace.'),
  toolkit('notion_mcp', 'Notion MCP', 'Search pages and manage workspace documents through custom tools.'),
  toolkit('notion_archive', 'Notion archive', 'Browse archived project pages and reference notes.'),
];

function disjoint(first, second, label) {
  const overlapWidth = Math.min(first.right, second.right) - Math.max(first.left, second.left);
  const overlapHeight = Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top);
  assert.ok(overlapWidth <= 0.5 || overlapHeight <= 0.5, `${label}: boxes overlap`);
}

async function checkRows(rows, label, connected, hovered) {
  const measurements = await rows.evaluateAll(elements => elements.map(element => {
    const box = node => node.getBoundingClientRect().toJSON();
    const description = element.querySelector('.app-row__desc');
    const range = document.createRange();
    range.selectNodeContents(description);
    const status = element.querySelector('.app-row__status');
    return {
      row: box(element), name: box(element.querySelector('.app-row__name')),
      description: box(description), painted: range.getBoundingClientRect().toJSON(),
      scrollHeight: description.scrollHeight, lineHeight: parseFloat(getComputedStyle(description).lineHeight),
      opacity: getComputedStyle(description).opacity,
      status: status && box(status), action: box(element.querySelector('button')), hovered: element.matches(':hover'),
    };
  }));
  assert.equal(measurements.length, 3, `${label}: fixture has a following row in either grid layout`);
  const first = measurements[0];
  assert.equal(first.hovered, hovered, `${label}: expected hover state`);
  assert.ok(first.painted.height > first.lineHeight * 2, `${label}: fixture must wrap to several lines`);
  for (const [index, item] of measurements.entries()) {
    assert.equal(item.opacity, '1', `${label}: description ${index} is visible`);
    assert.ok(item.description.height + 1 >= item.scrollHeight, `${label}: description ${index} contains its scroll height`);
    assert.ok(item.painted.top >= item.description.top - 1 && item.painted.bottom <= item.description.bottom + 1,
      `${label}: description ${index} contains its painted text`);
    assert.ok(item.description.top >= item.row.top && item.description.bottom <= item.row.bottom,
      `${label}: row ${index} reserves the full description height`);
  }
  const parts = { description: first.description, painted: first.painted, action: first.action };
  if (connected) {
    assert.ok(first.status, `${label}: fake connected status is present`);
    assert.ok(first.status.top >= first.description.bottom, `${label}: Connected sits below description`);
    parts.status = first.status;
  } else {
    assert.equal(first.status, null, `${label}: search result is unconnected`);
  }
  for (const [name, rect] of Object.entries(parts)) {
    for (const [otherName, other] of Object.entries(parts)) {
      if (name >= otherName || (name === 'description' && otherName === 'painted')) continue;
      disjoint(rect, other, `${label}: ${name} and ${otherName}`);
    }
    for (const next of measurements.slice(1)) {
      disjoint(rect, next.name, `${label}: ${name} and following title`);
      disjoint(rect, next.description, `${label}: ${name} and following description`);
      disjoint(rect, next.painted, `${label}: ${name} and following painted text`);
    }
  }
  assert.ok(measurements.slice(1).some(next => Math.abs(next.row.left - first.row.left) < 1 && next.row.top >= first.row.bottom - 1),
    `${label}: a following row must be below the tested row in the same column`);
}

let browser;
try {
  let ready = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    if (vite.exitCode !== null) throw new Error(`Local Vite exited: ${logs}`);
    if (await fetch(origin).then(response => response.ok, () => false)) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(ready, `Local Vite did not start: ${logs}`);
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const width of [1280, 1024, 768, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors = [], mutations = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.fallback() : route.abort());
    await context.route('**/api/**', route => {
      const request = route.request(), url = new URL(request.url());
      if (request.method() !== 'GET') {
        mutations.push(`${request.method()} ${url.pathname}`);
        return route.abort();
      }
      if (url.pathname === '/api/auth/me') return route.fulfill({ json: { user: { id: 'app-row-fixture', email: 'app-row@example.test' } } });
      if (url.pathname === '/api/apps') {
        const apps = url.searchParams.get('search') ? searchApps : connectedApps;
        return route.fulfill({ json: { apps, connected: connectedApps.map(app => app.slug), connectedApps, total: apps.length, nextOffset: null, categories: ['productivity'] } });
      }
      if (url.pathname === '/api/bots') return route.fulfill({ json: { bots: [], live: [] } });
      if (url.pathname === '/api/computer') return route.fulfill({ json: { computer: null } });
      if (url.pathname === '/api/models') return route.fulfill({ json: { models: [], favourites: [], canFast: false } });
      if (url.pathname === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: '' });
      return route.fulfill({ json: {} });
    });
    await page.goto(origin);
    // Open the real dialog through the store after the fake account is loaded.
    await page.waitForFunction(async () => (await import('/src/store.ts')).useStore.getState().user?.id === 'app-row-fixture');
    await page.evaluate(async () => (await import('/src/store.ts')).useStore.getState().setModal('apps'));
    const dialog = page.getByRole('dialog', { name: 'Connect Apps', exact: true });
    await dialog.getByRole('button', { name: '3 connected', exact: true }).click();
    await dialog.getByRole('heading', { name: 'Connected', exact: true }).waitFor();
    await page.evaluate(() => document.fonts.ready);

    for (const scenario of ['connected', 'search']) {
      if (scenario === 'search') {
        await dialog.getByRole('searchbox', { name: 'Search apps' }).fill('Notion');
        await dialog.getByRole('heading', { name: 'Results', exact: true }).waitFor();
        await dialog.getByRole('button', { name: 'Connect Notion', exact: true }).waitFor();
      }
      const rows = dialog.locator('.app-row');
      await rows.first().scrollIntoViewIfNeeded();
      for (const state of ['rest', 'hover', 'off-hover']) {
        if (state === 'hover') await rows.first().locator('.app-row__name').hover();
        else await dialog.getByRole('heading', { name: 'Connect an app', exact: true }).hover();
        await checkRows(rows, `${width}px ${scenario} ${state}`, scenario === 'connected', state === 'hover');
        if (state === 'hover') await page.screenshot({ path: new URL(`${scenario}-${width}.png`, evidence).pathname });
      }
      console.log(`PASS ${width}px ${scenario}: rest, hover and off-hover reserve description height without overlap`);
    }
    assert.deepEqual(errors, [], `${width}px: browser errors`);
    assert.deepEqual(mutations, [], `${width}px: no provider mutations`);
    await context.close();
  }
} finally {
  await browser?.close();
  vite.kill();
  await new Promise(resolve => vite.exitCode !== null ? resolve() : vite.once('exit', resolve));
}
