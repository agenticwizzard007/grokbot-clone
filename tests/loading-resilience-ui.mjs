// Built frontend, local mocked APIs and deliberate HTTP/2-style chunk failures only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
const origin = process.env.UI_ORIGIN ?? 'http://127.0.0.1:5198';
assert.match(origin, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/);
const evidence = new URL('../.context/loading-resilience/', import.meta.url); await fs.mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const bot = { id: 'local-bot', name: 'Local Bot', kind: 'agent', isPrimary: true, avatarShape: 'square', avatarColor: 'blue', mode: 'personal', generation: 1, instructions: '', description: '', label: '', model: null, effort: 'medium', onboarding: { status: 'active' } };
let passes = 0;
try {
  for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', e => console.error(e.stack));
    let holdModels = true, holdBots = true, failChunk = true, chunkFailures = 0, chunkRetries = 0;
    await page.addInitScript(() => { window.EventSource = class { constructor() { queueMicrotask(() => this.onopen?.()); } close() {} }; });
    await page.route('**/*', async route => {
      const url = new URL(route.request().url()), p = url.pathname;
      if (url.origin !== origin) return route.abort();
      if (/\/assets\/TasksView-.*\.js$/.test(p)) {
        if (url.searchParams.has('retry')) chunkRetries++;
        if (failChunk && !url.searchParams.has('retry')) { chunkFailures++; return route.abort('connectionreset'); }
        failChunk = false;
        return route.continue();
      }
      if (!p.startsWith('/api/')) return route.continue();
      if (p === '/api/auth/me') return route.fulfill({ json: { user: { id: 'slow-account', name: 'Local', email: 'local@example.test' } } });
      if (p === '/api/models') {
        if (holdModels) return; // Deliberately never answer. The client owns the deadline.
        return route.fulfill({ json: { provider: 'direct', billing: 'api', models: [], favourites: [] } });
      }
      if (p === '/api/bots') {
        if (holdBots) return;
        return route.fulfill({ json: { bots: [bot], live: [] } });
      }
      if (p.endsWith('/coworker-setups')) return route.fulfill({ json: { setups: [] } });
      if (p.endsWith('/tasks')) return route.fulfill({ json: { tasks: [] } });
      if (p.endsWith('/rows')) return route.fulfill({ json: { generation: 1, rows: [] } });
      if (p.endsWith('/routines')) return route.fulfill({ json: { routines: [] } });
      if (p === '/api/needs-you') return route.fulfill({ json: { items: [] } });
      if (p === '/api/team/exchanges') return route.fulfill({ json: { exchanges: [], nextBefore: null } });
      if (p === '/api/computer') return route.fulfill({ json: { computer: null } });
      return route.fulfill({ json: {} });
    });
    const started = performance.now();
    await page.goto(`${origin}/#tasks`);
    await page.getByRole('button', { name: 'Retry Bots', exact: true }).first().waitFor();
    assert.ok(performance.now() - started < 6000, 'roster loading ends within the deadline');
    holdBots = false; await page.getByRole('button', { name: 'Retry Bots', exact: true }).first().click();
    if (width === 390) await page.getByRole('button', { name: 'All Bots', exact: true }).click();
    await page.locator('.sidebar-usage').filter({ hasText: 'Unavailable' }).waitFor();
    assert.ok(performance.now() - started < 6500, 'usage loading ends within the deadline');
    assert.ok(chunkFailures >= 1); assert.equal(chunkRetries, 1, 'failed module fetched once with a fresh URL');
    holdModels = false; await page.locator('.sidebar-usage').click();
    await page.locator('.sidebar-usage').filter({ hasText: 'API credits' }).waitFor();
    await page.locator('.pinned__tile').waitFor();
    holdModels = true; await page.reload();
    await page.locator('.sidebar-usage').filter({ hasText: 'Previously loaded' }).waitFor();
    assert.equal(await page.locator('.sidebar-usage').filter({ hasText: 'Loading usage' }).count(), 0, 'cached usage renders while refreshing');
    await page.screenshot({ path: new URL(`cached-${width}.png`, evidence).pathname });
    // A persistent asset outage resolves to Retry, then recovers without reloading the document.
    const recovery = await context.newPage(); recovery.setDefaultTimeout(10000);
    let assetDown = true;
    await recovery.route('**/*', async route => {
      const url = new URL(route.request().url()), p = url.pathname;
      if (url.origin !== origin) return route.abort();
      if (/\/assets\/TasksView-.*\.js$/.test(p) && assetDown) return route.abort('connectionreset');
      if (!p.startsWith('/api/')) return route.continue();
      const body = p === '/api/auth/me' ? { user: { id: 'asset-account', name: 'Local', email: 'local@example.test' } }
        : p === '/api/bots' ? { bots: [bot], live: [] }
        : p === '/api/models' ? { provider: 'direct', billing: 'api', models: [], favourites: [] }
        : p.endsWith('/tasks') ? { tasks: [] } : p.endsWith('/rows') ? { generation: 1, rows: [] }
        : p.endsWith('/routines') ? { routines: [] } : p === '/api/needs-you' ? { items: [] }
        : p === '/api/team/exchanges' ? { exchanges: [], nextBefore: null } : p.endsWith('/coworker-setups') ? { setups: [] } : {};
      return route.fulfill({ json: body });
    });
    await recovery.addInitScript(() => { window.EventSource = class { constructor() { queueMicrotask(() => this.onopen?.()); } close() {} }; });
    await recovery.goto(`${origin}/#tasks`);
    await recovery.getByRole('button', { name: 'Retry Tasks', exact: true }).waitFor();
    assetDown = false;
    await recovery.getByRole('button', { name: 'Retry Tasks', exact: true }).click();
    await recovery.getByRole('heading', { name: 'Tasks', exact: true }).waitFor();
    assert.equal(await recovery.getByRole('button', { name: 'Retry Tasks', exact: true }).count(), 0);
    await recovery.close();
    console.log(`PASS ${width}px: chunk retry, roster timeout and retry, usage timeout and retry, cached usage on reload`); passes++;
    await context.close();
  }
  console.log(`Loading resilience browser cases: ${passes} passed, 0 failed`);
} finally { await browser.close(); }
