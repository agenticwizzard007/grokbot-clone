// Production build, local account and API fixtures only. Native input deliberately
// bypasses locator stability waits so a refresh can land between down and up.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build, preview } from '../web/node_modules/vite/dist/node/index.js';
import { chromium } from 'playwright';

const evidence = process.env.HH_EVIDENCE ?? '.context/readiness-hh';
await mkdir(evidence, { recursive: true });
const root = path.resolve(process.env.HH_ROOT ?? 'web'), outDir = path.resolve(evidence, 'dist');
await build({ root, build: { outDir, emptyOutDir: true } });
const vite = await preview({ root, build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
process.env.UI_ORIGIN = `http://127.0.0.1:${vite.httpServer.address().port}`;
const { fixturePage, origin } = await import('./qa-r3-work-fixture.mjs');
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const slack = { slug: 'slack', name: 'Slack', managedAuth: true, noAuth: false, categories: [], reason: "Slack is named in this Bot's work." };
const github = { ...slack, slug: 'github', name: 'GitHub', reason: "GitHub is named in this Bot's work." };
const savedReason = 'Slack was suggested for this Bot.';
const general = '#bot/research-bot/settings/general';
const bar = '.bot-settings-page > .setup-paper__bar';
const back = `${bar} .setup-paper__back`;
const results = [], cases = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function observeRefresh(theme) {
  localStorage.setItem('swarm.theme', theme);
  const selectors = ['.bot-settings-page', '.bot-settings-page > .setup-paper__bar', '.bot-settings-page .setup-paper__back', '.setup-paper__tabs', '.suggested-integrations'];
  const identities = new Map(), fibers = new Map();
  let recording = true;
  window.hh = { samples: [], events: [], replacements: [], missing: [], ancestors: {}, ancestryChanges: [], reasons: [], shifts: [], refreshes: [] };
  const ancestry = element => {
    const key = Object.keys(element).find(key => key.startsWith('__reactFiber$'));
    const result = [];
    for (let fiber = element[key]; fiber; fiber = fiber.return) result.push(fiber);
    return result;
  };
  const sample = () => {
    if (!recording) return;
    const boxes = {};
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (!element) {
        if (identities.has(selector)) window.hh.missing.push({ selector, at: performance.now() });
        continue;
      }
      if (!identities.has(selector)) {
        identities.set(selector, element); fibers.set(selector, ancestry(element));
        window.hh.ancestors[selector] = ancestry(element).map(fiber => ({ key: fiber.key, tag: fiber.tag, type: typeof fiber.type === 'string' ? fiber.type : fiber.type?.name ?? null }));
      } else if (identities.get(selector) !== element) window.hh.replacements.push({ selector, at: performance.now() });
      const before = fibers.get(selector), after = ancestry(element);
      if (after.length !== before.length || after.some((fiber, i) => {
        const previous = before[i];
        return !previous || fiber.key !== previous.key || fiber.type !== previous.type
          || (fiber !== previous && fiber.alternate !== previous);
      })) window.hh.ancestryChanges.push({ selector, at: performance.now() });
      const r = element.getBoundingClientRect();
      boxes[selector] = { x: r.x, y: r.y, width: r.width, height: r.height };
    }
    if (Object.keys(boxes).length) window.hh.samples.push({ at: performance.now(), boxes });
    const text = document.querySelector('.suggested-integrations')?.textContent;
    if (text && window.hh.reasons.at(-1)?.text !== text) window.hh.reasons.push({ at: performance.now(), text });
  };
  new MutationObserver(sample).observe(document, { childList: true, subtree: true, characterData: true, attributes: true });
  const paint = () => { sample(); if (recording) requestAnimationFrame(paint); };
  requestAnimationFrame(paint);
  new PerformanceObserver(list => {
    if (recording) window.hh.shifts.push(...list.getEntries().map(entry => ({ at: entry.startTime, value: entry.value, recentInput: entry.hadRecentInput,
      navigation: entry.sources.some(source => source.node instanceof Element && !!source.node.closest('.setup-paper__bar, .setup-paper__tabs')),
    })));
  }).observe({ type: 'layout-shift', buffered: true });
  for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'click']) document.addEventListener(type, event => {
    const button = event.target instanceof Element && event.target.closest('button');
    window.hh.events.push({ type, at: performance.now(), isBack: button === identities.get('.bot-settings-page .setup-paper__back'), connected: !!button?.isConnected, hash: location.hash });
    // Capture before React handles navigation and intentionally removes the page.
    if (type === 'click' && button === identities.get('.bot-settings-page .setup-paper__back')) { sample(); recording = false; }
  }, true);
  const fetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const response = await fetch(...args);
    if (String(args[0]).includes('/suggested-apps')) {
      const json = response.json.bind(response);
      response.json = async () => {
        const value = await json();
        // Three seconds from a direct load or reload, including body decoding.
        await new Promise(resolve => setTimeout(resolve, Math.max(0, 3000 - performance.now())));
        window.hh.refreshes.push({ at: performance.now(), slugs: value.suggestions.map(app => app.slug) });
        return value;
      };
    }
    return response;
  };
}

async function fresh(width, theme) {
  const f = await fixturePage(browser, { width, height: 900 }, { colorScheme: theme, hasTouch: width === 390, isMobile: width === 390 });
  f.fixture.bots[1].name = 'QA-Temp-1';
  f.fixture.bots[1].suggestedApps = { version: 1, filterVersion: 'purpose-2', computedAt: 100, hasContext: true, suggestions: [{ ...slack, reason: savedReason }] };
  f.fixture.apps = [slack];
  f.fixture.respond = async ({ path }) => path.endsWith('/suggested-apps')
    ? { json: { filterVersion: 'purpose-2', hasContext: true, suggestions: f.fixture.apps } } : null;
  await f.page.addInitScript(observeRefresh, theme);
  return f;
}

function assertStable(data, appSetChanged = false) {
  assert.deepEqual(data.replacements, [], 'page, header, back and suggestions retain node identity');
  assert.deepEqual(data.missing, [], 'no route recreation or Suspense fallback removes mounted navigation');
  assert.deepEqual(data.ancestryChanges, [], 'React keys, component types and mounted fibers stay stable');
  const initial = new Map(), moves = [];
  for (const { at, boxes } of data.samples) {
    if (at < 2500) continue; // Ignore initial font load; cover the full refresh window.
    for (const [selector, box] of Object.entries(boxes)) {
      if (selector === '.suggested-integrations') continue;
      if (!initial.has(selector)) initial.set(selector, box);
      for (const axis of ['x', 'y', 'width', 'height']) if (Math.abs(initial.get(selector)[axis] - box[axis]) > 0.5) moves.push({ selector, axis, at });
    }
  }
  assert.ok(initial.size >= 4, 'sampled page, header, back and tabs around refresh');
  assert.deepEqual(moves, [], 'no movement around the back control');
  // Adding/removing a card necessarily moves list contents. The header and tabs
  // must stay fixed even then; same-app refreshes must have no shift anywhere.
  assert.deepEqual(data.shifts.filter(shift => shift.at >= 2500 && (!appSetChanged || shift.navigation)), [], 'no layout shift during refresh, including recent input');
}
async function capture(page, name) {
  const data = await page.evaluate(() => window.hh);
  await writeFile(`${evidence}/${name}.json`, JSON.stringify(data, null, 2));
  return data;
}

for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
  for (const entry of ['direct', 'reload']) for (const offset of [-200, -100, 0, 100, 200]) {
    const name = `first-back-${width}-${theme}-${entry}-${offset}ms`;
    cases.push({ name, run: async () => {
      const { page, errors } = await fresh(width, theme);
      try {
        await page.goto(`${origin}/${general}`, { waitUntil: 'commit' });
        await page.locator(back).waitFor();
        if (entry === 'reload') { await page.reload({ waitUntil: 'commit' }); await page.locator(back).waitFor(); }
        await page.getByText(savedReason, { exact: true }).waitFor();
        const box = await page.locator(back).boundingBox();
        const x = box.x + box.width / 2, y = box.y + box.height / 2;
        const cdp = await page.context().newCDPSession(page);
        if (width === 1280) await page.mouse.move(x, y);
        // At zero, keep the pointer down across response delivery and React's
        // commit. Other cases use ordinary 50 ms taps throughout the +/-200 ms window.
        await page.evaluate(target => new Promise(resolve => setTimeout(resolve, Math.max(0, target - performance.now()))), 3000 + (offset || -40));
        if (width === 390) await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        else await page.mouse.down();
        if (offset === 0) {
          await page.waitForFunction(() => window.hh.refreshes.length === 1);
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        } else await sleep(50);
        if (width === 390) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        else await page.mouse.up();
        await page.waitForFunction(() => !location.hash.includes('/settings/'));
        await page.locator('.chat__header').waitFor();
        await page.waitForFunction(() => window.hh.refreshes.length === 1);
        const data = await capture(page, name);
        assert.match(new URL(page.url()).hash, /^#bot\/qa-temp-1/);
        assert.match(await page.locator('.chat__header').innerText(), /QA-Temp-1/);
        const events = data.events.filter(event => event.isBack);
        assert.deepEqual(events.map(event => event.type), ['pointerdown', 'pointerup', 'click']);
        assert.ok(events.every(event => event.connected), 'the original back control receives the entire gesture');
        assert.equal(data.refreshes.length, 1);
        const refreshAt = data.refreshes[0].at;
        if (offset === 0) assert.ok(events[0].at < refreshAt && events[2].at > refreshAt, 'response lands between pointerdown and click');
        else assert.ok(Math.abs(events[0].at - refreshAt - offset) < 75, 'input lands in the requested refresh window');
        assertStable(data);
        assert.ok(data.reasons.every(frame => frame.text.includes(savedReason)), 'quiet refresh keeps server-saved wording');
        assert.deepEqual(errors, []);
      } finally { await page.context().close(); }
    } });
  }
  const name = `quiet-reasons-and-app-changes-${width}-${theme}`;
  cases.push({ name, run: async () => {
    const { page, fixture, errors } = await fresh(width, theme);
    try {
      await page.goto(`${origin}/${general}`);
      const region = page.getByRole('region', { name: 'Suggested integrations' });
      await region.getByText(savedReason, { exact: true }).waitFor();
      const before = await region.boundingBox();
      await page.waitForFunction(() => window.hh.refreshes.length === 1);
      await page.waitForTimeout(200);
      for (const event of [{ type: 'connections' }, { type: 'setup', botId: 'research-bot' }]) {
        const count = await page.evaluate(() => window.hh.refreshes.length);
        await page.evaluate(event => window.__emitFixture(event), event);
        assert.equal(await region.locator('.suggested-integration__text p').innerText(), savedReason, 'a passive notification does not expose the newer cached wording');
        await page.waitForFunction(count => window.hh.refreshes.length > count, count);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await region.locator('.suggested-integration__text p').innerText(), savedReason);
      }
      const data = await capture(page, name);
      assertStable(data);
      assert.ok(data.reasons.every(frame => frame.text.includes(savedReason)), 'all quiet refresh frames retain saved wording');
      assert.equal(await region.locator('.suggested-integration__text p').innerText(), savedReason);
      assert.deepEqual(await region.boundingBox(), before, 'same-app wording refresh preserves the block height');
      await page.screenshot({ path: `${evidence}/${width}-${theme}.png` });
      await region.locator('li').evaluate(element => { window.hhSlack = element; });
      // Editing the purpose is an explicit action. Add and remove an app without
      // remounting General; the new set and its reasons must actually reach the UI.
      fixture.apps = [slack, github];
      await page.locator('#cfg-about').fill('Use Slack and GitHub.');
      await region.getByText(github.reason, { exact: true }).waitFor();
      await region.getByText(slack.reason, { exact: true }).waitFor();
      assert.ok(await region.locator('li').first().evaluate(element => element === window.hhSlack), 'editing purpose keeps the surviving card mounted');
      fixture.apps = [{ ...github, reason: 'Review repository updates.' }];
      await page.locator('#cfg-about').fill('Use GitHub.');
      await region.getByText('Review repository updates.', { exact: true }).waitFor();
      assert.equal(await region.getByText('Slack', { exact: true }).count(), 0);
      assert.equal(await page.locator(bar).count(), 1);
      assert.deepEqual(errors, []);
    } finally { await page.context().close(); }
  } });
  for (const change of ['add', 'remove']) {
    const name = `quiet-app-${change}-${width}-${theme}`;
    cases.push({ name, run: async () => {
      const { page, fixture, errors } = await fresh(width, theme);
      try {
        if (change === 'add') fixture.apps = [slack, github];
        else { fixture.bots[1].suggestedApps.suggestions.push(github); fixture.apps = [github]; }
        await page.goto(`${origin}/${general}`);
        const region = page.getByRole('region', { name: 'Suggested integrations' });
        await region.getByText(savedReason, { exact: true }).waitFor();
        const before = await region.boundingBox();
        await region.getByText(github.reason, { exact: true }).waitFor();
        await page.waitForTimeout(100);
        assert.equal(await region.locator('li').count(), change === 'add' ? 2 : 1);
        if (change === 'add') await region.getByText(slack.reason, { exact: true }).waitFor();
        else assert.equal(await region.getByText('Slack', { exact: true }).count(), 0);
        assert.ok((await region.boundingBox()).height >= before.height, 'removing a card retains reserved space');
        assertStable(await capture(page, name), true);
        assert.deepEqual(errors, []);
      } finally { await page.context().close(); }
    } });
  }
}

try {
  for (const { name, run } of cases) {
    try { await run(); results.push({ name, pass: true }); console.log(`PASS ${name}`); }
    catch (error) { results.push({ name, pass: false, error: String(error) }); console.error(`FAIL ${name}: ${error}`); }
  }
} finally {
  await writeFile(`${evidence}/results.json`, JSON.stringify(results, null, 2));
  await browser.close(); await new Promise(resolve => vite.httpServer.close(resolve));
}
const failures = results.filter(result => !result.pass);
console.log(`${results.length - failures.length} passed, ${failures.length} failed`);
assert.equal(failures.length, 0, failures.map(result => result.name).join('\n'));
