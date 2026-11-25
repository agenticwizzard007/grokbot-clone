// Production assets and local API fixtures. No live account or user data.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build, preview } from '../web/node_modules/vite/dist/node/index.js';
import { chromium } from 'playwright';
import { smallComputerUsage } from './fixtures/usage-small-computer.mjs';

const evidence = process.env.GG_EVIDENCE ?? '.context/readiness-gg';
await mkdir(evidence, { recursive: true });
const root = path.resolve(process.env.GG_ROOT ?? 'web'), outDir = path.resolve(evidence, 'dist');
await build({ root, build: { outDir, emptyOutDir: true } });
const vite = await preview({ root, build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
process.env.UI_ORIGIN = `http://127.0.0.1:${vite.httpServer.address().port}`;
const { fixturePage, origin } = await import('./qa-r3-work-fixture.mjs');
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const results = [], cases = [];
const sectionLabels = { general: 'General', account: 'Account', messaging: 'Messaging', usage: 'Usage', learning: 'Learning', computer: 'Computer', permissions: 'Permissions', apps: 'Connected apps', mcp: 'MCP servers', subscriptions: 'Models & access', keys: 'API keys' };
const sections = ['general', 'account', 'messaging', 'usage', 'learning', 'computer', 'permissions', 'apps', 'mcp', 'subscriptions', 'keys'];
const tabs = ['general', 'skills', 'memories', 'routines', 'learning', 'analytics'];
const routes = ['#settings', ...sections.map(s => `#settings/${s}`), ...tabs.map(t => `#bot/research-bot/settings/${t}`), '#bots', '#team'];
const bar = '.access-settings__bar, .bot-settings-page > .setup-paper__bar';
const ready = hash => hash.startsWith('#settings') ? '.access-settings__bar' : hash.includes('/settings/') ? '.bot-settings-page > .setup-paper__bar' : hash === '#team' ? '.tasks-view__header' : '.sidebar';
const hashIs = (page, hash) => page.waitForFunction(hash => location.hash === hash, hash);

// Install before application code. Sample every paint for two seconds, including
// font arrival and late API results. CLS excludes recent input; geometry does not.
function observeNavigation(theme) {
  localStorage.setItem('swarm.theme', theme);
  const selectors = ['.settings-nav__item', '.access-settings__bar', '.access-settings__bar > button', '.access-settings__bar-title', '.bot-settings-page > .setup-paper__bar', '.setup-paper__tabs button', '.sidebar-island', '.sidebar .bot-row', '.sidebar .pinned__tile'];
  window.gg = { samples: [], shifts: [], events: [], start: performance.now() };
  window.ggReset = () => { window.gg.samples = []; window.gg.shifts = []; window.gg.start = performance.now(); };
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method].bind(history);
    history[method] = (...args) => { const previous = location.hash; original(...args); if (location.hash !== previous) window.ggReset(); };
  }
  new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      const navigation = entry.sources.some(source => source.node instanceof Element && selectors.some(selector => source.node.matches(selector) || source.node.closest(selector)));
      if (entry.startTime < window.gg.start) continue;
      window.gg.shifts.push({ at: entry.startTime, value: entry.value, recentInput: entry.hadRecentInput, navigation });
    }
  }).observe({ type: 'layout-shift', buffered: true });
  for (const type of ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'click']) document.addEventListener(type, event => {
    const button = event.target instanceof Element && event.target.closest('button');
    window.gg.events.push({ type, at: performance.now(), label: button?.getAttribute('aria-label') ?? button?.textContent, hash: location.hash });
  }, true);
  const sample = () => {
    const boxes = {};
    for (const selector of selectors) [...document.querySelectorAll(selector)].forEach((element, i) => {
      const r = element.getBoundingClientRect();
      if (!r.width || !r.height || element.closest('[hidden]')) return;
      boxes[`${selector}:${i}`] = { x: r.x, y: r.y, width: r.width, height: r.height, label: element.getAttribute('aria-label') ?? element.textContent };
    });
    window.gg.samples.push({ at: performance.now(), boxes });
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
}

async function fresh(width, theme) {
  const f = await fixturePage(browser, { width, height: 900 }, { colorScheme: theme, hasTouch: true, isMobile: width === 390 });
  await f.page.addInitScript(observeNavigation, theme);
  f.fixture.respond = async ({ path }) => {
    if (path.endsWith('/settings') || ['/api/usage', '/api/computer/details'].includes(path)) await new Promise(resolve => setTimeout(resolve, 350));
    if (path === '/api/cli') return { json: { runtime: 'server', selected: null, connected: false, providers: { codex: { installed: true, authenticated: false }, claude: { installed: true, authenticated: false } } } };
    if (path === '/api/providers/openrouter') return { json: { connected: false, linked: false, selected: false, active: false, hint: null } };
    if (path === '/api/settings/keys') { const key = { set: false, source: null }; return { json: { canEdit: false, isolated: false, provider: { value: 'direct', chosen: 'direct' }, model: { value: 'fixture' }, openrouterModel: { value: 'fixture' }, openrouter: key, direct: key, composio: key, voice: key } }; }
    if (path === '/api/messaging') return { json: { account: {}, links: [], line: null, prefs: { voiceReplies: 'off' }, speech: {}, invites: { allowance: 0 } } };
    if (path === '/api/usage') return { json: smallComputerUsage };
    if (path === '/api/apps') return { json: { apps: [], connected: [], connectedApps: [], categories: [], total: 0 } };
    if (/^\/api\/bots\/[^/]+\/setup$/.test(path)) return { status: 404, json: { error: 'No saved configuration.' } };
    if (/^\/api\/bots\/[^/]+\/files$/.test(path)) return { json: { status: 'ok', path: '', files: [] } };
    if (path === '/api/computer/details') return { json: { computer: { status: 'absent', screens: [] }, screens: [], hibernation: { idleMinutes: 15 } } };
    if (path.endsWith('/suggested-apps')) return { json: { filterVersion: 'purpose-2', hasContext: false, suggestions: [] } };
    return null;
  };
  return f;
}
function check(name, run) { cases.push({ name, run }); }
async function runCase({ name, run }) {
  try { const detail = await run(); results.push({ name, pass: true, ...detail }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, pass: false, error: String(error) }); console.error(`FAIL ${name}: ${error}`); }
}
async function stable(page) {
  await page.waitForTimeout(2000);
  const data = await page.evaluate(() => window.gg);
  const initial = new Map();
  const moves = [];
  for (const sample of data.samples) for (const [key, box] of Object.entries(sample.boxes)) {
    const first = initial.get(key);
    if (!first) { initial.set(key, box); continue; }
    // Text widths may change with the font; position and row height must not.
    for (const axis of ['x', 'y', 'height']) if (Math.abs(first[axis] - box[axis]) > 1) moves.push({ key, axis, from: first[axis], to: box[axis] });
  }
  const cls = data.shifts.filter(s => !s.recentInput).reduce((n, s) => n + s.value, 0);
  const navigationCLS = data.shifts.filter(s => s.navigation && !s.recentInput).reduce((n, s) => n + s.value, 0);
  if (moves.length) await writeFile(`${evidence}/geometry-${Date.now()}.json`, JSON.stringify(data));
  assert.deepEqual(moves.slice(0, 6), [], 'navigation moved after its first paint');
  assert.ok(navigationCLS < 0.01, `navigation CLS ${navigationCLS}`);
  assert.ok(initial.size > 0, 'observed navigation');
  return { cls, navigationCLS, samples: data.samples.length };
}

try {
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    for (const route of routes) for (const entry of ['direct', 'in-app']) {
      await check(`stable navigation ${width} ${theme} ${entry} ${route}`, async () => {
        const { page, errors } = await fresh(width, theme);
        try {
          if (entry === 'direct') await page.goto(`${origin}/${route}`);
          else {
            await page.goto(`${origin}/#bots`); await page.locator('.sidebar').waitFor(); await page.evaluate(() => document.fonts.ready);
            if (route.startsWith('#settings')) {
              await page.getByRole('button', { name: 'Account & settings', exact: true }).click();
              await page.evaluate(() => window.ggReset());
              await page.getByRole('menuitem', { name: /^Settings/ }).click();
              if (route === '#settings' && width === 1280) await page.locator('.access-settings__bar').getByRole('button', { name: 'Back to Settings', exact: true }).click();
              if (route !== '#settings') {
                const section = route.split('/')[1];
                if (width === 390 || section !== 'general') {
                  await page.locator('.settings-nav').getByRole('button', { name: sectionLabels[section], exact: true }).click();
                  // On phones the list scrolls to the chosen row before leaving.
                  // Begin the new route's measurement from its first DOM commit.
                }
              }
            } else if (route.includes('/settings/')) {
              await page.locator('.sidebar .bot-row').filter({ hasText: 'Research Bot' }).click();
              await page.locator('.chat__pill').click();
              await page.evaluate(() => window.ggReset());
              await page.getByRole('menuitem', { name: 'Bot settings', exact: true }).click();
              const tab = route.split('/').at(-1);
              await page.locator('.setup-paper__tabs').getByRole('button', { name: tab[0].toUpperCase() + tab.slice(1), exact: true }).click();
            } else {
              await page.getByRole('button', { name: 'Tasks', exact: true }).click();
              await page.evaluate(() => window.ggReset());
              if (route === '#team') await page.locator('.work-tabs').getByRole('button', { name: 'Team', exact: true }).click();
              else if (width === 1280) await page.locator('.sidebar__brand').click();
              else { await page.evaluate(() => { location.hash = '#bots'; }); }
            }
          }
          await page.locator(ready(route)).waitFor();
          const detail = await stable(page);
          if (entry === 'direct' && route === '#settings/general') await page.screenshot({ path: `${evidence}/${width}-${theme}-settings.png` });
          assert.deepEqual(errors, []); return detail;
        } finally { await page.context().close(); }
      });
    }
    await check(`Settings root and section reserve the same header ${width} ${theme}`, async () => {
      const { page } = await fresh(width, theme);
      try {
        await page.goto(`${origin}/#settings`); await page.locator(bar).waitFor(); await page.evaluate(() => document.fonts.ready);
        const nav = page.locator('.settings-nav__item');
        const before = await nav.first().boundingBox();
        await nav.filter({ hasText: 'General' }).click();
        await hashIs(page, '#settings/general');
        if (width === 1280) assert.deepEqual(await nav.first().boundingBox(), before);
        await page.locator('.access-settings__bar').getByRole('button', { name: 'Back to Settings', exact: true }).tap();
        await hashIs(page, '#settings');
        if (width === 1280) assert.deepEqual(await nav.first().boundingBox(), before);
      } finally { await page.context().close(); }
    });
    await check(`Models & access first 100 ms ${width} ${theme}`, async () => {
      const { page } = await fresh(width, theme);
      try {
        // Mutation observer records the first rendered coordinates. A real mouse
        // click uses those coordinates without Playwright waiting for stability.
        await page.addInitScript(() => {
          new MutationObserver(() => {
            if (window.ggModelTarget) return;
            const button = [...document.querySelectorAll('.settings-nav__item')].find(b => b.textContent.includes('Models & access'));
            if (!button) return;
            const r = button.getBoundingClientRect();
            window.ggModelTarget = { at: performance.now(), x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }).observe(document, { subtree: true, childList: true });
        });
        await page.goto(`${origin}/#settings`, { waitUntil: 'commit' });
        await page.waitForFunction(() => window.ggModelTarget, null, { polling: 'raf' });
        const target = await page.evaluate(() => window.ggModelTarget);
        await page.mouse.click(target.x, target.y);
        await hashIs(page, '#settings/subscriptions');
        const elapsed = await page.evaluate(() => window.gg.events.find(e => e.type === 'click').at - window.ggModelTarget.at);
        assert.ok(elapsed < 100, `first click took ${elapsed} ms after first render`);
        return { elapsed };
      } finally { await page.context().close(); }
    });
    for (const route of [
      ...tabs.map(tab => `#bot/research-bot/settings/${tab}`),
      ...sections.map(section => `#settings/${section}`),
      '#bot/research-bot', '#new-bot', '#new-bot/group',
      '#bot/research-bot/details/activity', '#bot/research-bot/details/files/reports', '#bot/research-bot/details/setup/history',
      '#bot/research-bot/tasks', '#bot/research-bot/team', '#bot/research-bot/goals', '#bot/research-bot/reports',
    ]) {
      await check(`first back tap ${width} ${theme} ${route}`, async () => {
        const { page, errors } = await fresh(width, theme);
        try {
          await page.goto(`${origin}/${route}`, { waitUntil: 'commit' });
          const scopedWork = /^#bot\/[^/]+\/(tasks|team|goals|reports)$/.test(route);
          const back = route.startsWith('#settings') ? page.locator('.access-settings__bar').getByRole('button', { name: 'Back to Settings', exact: true })
            : scopedWork ? page.locator('.tasks-view__header').getByRole('button', { name: /^Back to / })
            : route.includes('/details/') ? page.locator('#bot-details .setup-paper__back')
            : route.includes('/settings/') || route.startsWith('#new-bot') ? page.locator('.setup-paper__back') : page.locator('.chat__back');
          await back.waitFor();
          const child = new URL(page.url()).hash;
          const parent = route.startsWith('#settings') ? '#settings'
            : scopedWork ? `#${route.split('/').at(-1)}`
            : route === '#new-bot/group' ? '#new-bot'
            : route.endsWith('/files/reports') || route.endsWith('/setup/history') ? child.slice(0, child.lastIndexOf('/'))
            : route.includes('/settings/') ? child.split('/settings/')[0]
            : route.includes('/details/') ? child.split('/details/')[0] : '#bots';
          assert.deepEqual(await page.evaluate(() => history.state.swarmNavigation.trail), []);
          await back.tap(); await hashIs(page, parent);
          // Repeat through actual browser history, where the parent is reusable.
          await page.evaluate(child => { location.hash = child; }, child);
          await back.tap(); await hashIs(page, parent);
          await page.goForward(); await hashIs(page, child);
          assert.deepEqual(errors, []);
          return { clicks: await page.evaluate(() => window.gg.events.filter(e => e.type === 'click').length) };
        } finally { await page.context().close(); }
      });
    }
    if (width === 1280) for (const collapsed of [false, true]) await check(`sidebar first back tap ${theme} collapsed=${collapsed}`, async () => {
      const { page, errors } = await fresh(width, theme);
      try {
        if (collapsed) await page.addInitScript(() => localStorage.setItem('swarm.sidebarCollapsed', '1'));
        await page.goto(`${origin}/#settings/general`, { waitUntil: 'commit' });
        // Use the UI to collapse when the saved preference is not enabled.
        if (collapsed && await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).count()) await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
        const back = page.locator(collapsed ? '#sidebar-back-slot .sidebar__back' : '.settings-nav__back');
        await back.tap(); await hashIs(page, '#settings');
        assert.deepEqual(errors, []);
      } finally { await page.context().close(); }
    });
    await check(`Settings back before page code loads ${width} ${theme}`, async () => {
      const { page, errors } = await fresh(width, theme);
      let release;
      const held = new Promise(resolve => { release = resolve; });
      await page.route('**/assets/ConfigLayer-*.js', async route => { await held; await route.continue(); });
      try {
        await page.goto(`${origin}/#settings/general`, { waitUntil: 'commit' });
        const back = page.locator('.access-settings__bar').getByRole('button', { name: 'Back to Settings', exact: true });
        await back.waitFor();
        await page.locator('.settings-page-loading').waitFor();
        await back.tap(); await hashIs(page, '#settings');
        await page.goBack(); await hashIs(page, '#settings/general');
        await back.evaluate(element => { window.ggBack = element; });
        const box = await back.boundingBox();
        release();
        await page.getByRole('heading', { name: 'Keyboard shortcuts', exact: true }).waitFor();
        assert.ok(await back.evaluate(element => element === window.ggBack), 'page code preserves the original back button');
        assert.deepEqual(await back.boundingBox(), box);
        await back.tap(); await hashIs(page, '#settings');
        assert.deepEqual(errors, []);
      } finally { release(); await page.context().close(); }
    });
    await check(`first routine history back tap ${width} ${theme}`, async () => {
      const { page, errors } = await fresh(width, theme);
      try {
        // Routine history is local view state, with no standalone URL. Enter its
        // owning Reports route directly, then open the history before one tap.
        await page.goto(`${origin}/#reports`);
        await page.getByRole('button', { name: 'Routines', exact: true }).tap();
        await page.getByRole('button', { name: 'Run history', exact: true }).tap();
        await page.getByRole('button', { name: 'Back to routines', exact: true }).tap();
        await page.getByRole('button', { name: 'Run history', exact: true }).waitFor();
        assert.deepEqual(errors, []);
      } finally { await page.context().close(); }
    });
  }
  // Independent fresh contexts, with a small worker count to keep first-tap timing meaningful.
  await Promise.all(Array.from({ length: 2 }, async () => {
    while (cases.length) await runCase(cases.shift());
  }));
} finally {
  await writeFile(`${evidence}/results.json`, JSON.stringify(results, null, 2));
  await browser.close(); await new Promise(resolve => vite.httpServer.close(resolve));
}
const failures = results.filter(r => !r.pass);
console.log(`${results.length - failures.length} passed, ${failures.length} failed`);
assert.equal(failures.length, 0, failures.map(f => f.name).join('\n'));
