// Local API and browser fixtures only. Before mode runs unchanged assertions against main.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';
import { layoutServer } from './layout-fixture.mjs';

const server = await layoutServer({ root: path.resolve(process.env.LW_ROOT || '.') });
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const shots = process.env.LW_SHOTS || '.context/livewalk/shots', failures = [];
fs.mkdirSync(shots, { recursive: true });
const check = (name, fn) => { try { fn(); console.log(`PASS ${name}`); } catch (error) { failures.push(`${name}: ${error.message}`); } };
try {
  const db = new Database(server.dbPath);
  db.prepare("INSERT INTO cli_preferences(user_id,provider) VALUES(?,'codex')").run(server.fixture.userId);
  db.close();
  for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, colorScheme: theme, reducedMotion: 'reduce' });
    await context.addCookies([{ name: 'swarm_session', value: 'layout-test-token', url: server.base }]);
    await context.addInitScript(theme => { localStorage.setItem('swarm.theme', theme); localStorage.setItem('swarm.sidebarCollapsed', '0'); }, theme);
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${server.base}/#bots`);
    await page.locator('.shell-header').waitFor();
    if (width === 390) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    const meter = page.locator('.sidebar-usage:visible');
    await page.waitForFunction(() => {
      const meter = document.querySelector('.sidebar-usage');
      return meter && !meter.textContent.includes('Loading');
    });
    if (theme === 'light') await page.screenshot({ path: path.join(shots, `D7-${process.env.LW_STAGE || 'after'}-${width}.png`), fullPage: true });
    const realText = await meter.innerText();
    check(`${width} ${theme} real summary`, () => { assert.match(realText, /No limit/); assert.doesNotMatch(realText, /Quota unavailable|Reset unavailable/); });
    const original = await (await context.request.get(`${server.base}/api/usage/summary`)).json();
    let snapshot = { ...original, plan: { ...original.plan, name: 'Swarm plan', billing: 'api', provider: null, unit: 'usd', usedCents: 500, limitCents: 2500, percentUsed: 20 } };
    let fail = false;
    await page.route('**/api/usage/summary', route => route.fulfill(fail ? { status: 503, json: { error: 'Fixture unavailable' } } : { json: snapshot }));
    const refresh = async () => { await page.evaluate(async () => (await import('/src/lib/planUsage.ts')).refreshPlanUsage()); await page.waitForTimeout(100); };
    await refresh();
    await meter.getByText('20% used', { exact: true }).waitFor();
    assert.equal(await meter.getByRole('progressbar').getAttribute('value'), '20');
    snapshot.plan = { ...snapshot.plan, limitCents: null, percentUsed: null };
    await refresh(); await meter.getByText('No limit', { exact: true }).waitFor();
    assert.equal(await meter.getByRole('progressbar').count(), 0);
    // A legacy/null quota and a failed request both use the compact unavailable state.
    for (const kind of ['null-quota', 'request-error']) {
      if (kind === 'null-quota') snapshot.plan = { ...snapshot.plan, billing: 'plan', provider: 'codex-cli', unit: 'percent', percentUsed: null, resetsAt: null };
      else fail = true;
      await refresh();
      const text = (await meter.innerText()).replace(/^Usage\n+/, '').trim();
      const box = await meter.boundingBox();
      check(`${width} ${theme} ${kind} compact line`, () => { assert.equal(text, 'Usage unavailable'); assert.ok(box.height >= 44 && box.height <= 64, `height ${box.height}`); });
      const sizes = await meter.evaluate(el => [...el.querySelectorAll('span, strong')].filter(child => child.checkVisibility()).map(child => parseFloat(getComputedStyle(child).fontSize)));
      check(`${width} ${theme} ${kind} readable text`, () => assert.ok(sizes.every(size => size >= 13)));
      if (theme === 'light' && kind === 'null-quota') await page.screenshot({ path: path.join(shots, `D7-${process.env.LW_STAGE || 'after'}-unavailable-${width}.png`), fullPage: true });
    }
    fail = false;
    snapshot.plan = { ...snapshot.plan, billing: 'plan', provider: 'codex-cli', unit: 'percent', percentUsed: 25 };
    await refresh();
    await meter.getByText('25% used', { exact: true }).waitFor();
    if (width === 1280) {
      await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
      assert.ok((await meter.getAttribute('aria-label')).startsWith('Usage:'));
    }
    await meter.click();
    await page.waitForTimeout(300);
    check(`${width} ${theme} usage navigation`, () => assert.equal(new URL(page.url()).hash, '#settings/usage'));
    assert.equal(await page.locator('.phone-drawer').count(), 0);
    if (width === 390) assert.equal(await page.getByRole('button', { name: 'Back', exact: true }).count(), 1);
    if (width === 390 && new URL(page.url()).hash === '#settings/usage') {
      await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
      await page.locator('.sidebar-usage:visible').click();
      await page.waitForTimeout(100);
      assert.equal(await page.locator('.phone-drawer').count(), 0, 'clicking Usage from Usage also closes the drawer');
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  assert.deepEqual(failures, []);
  console.log('PASS D7 real summary, three meter states, geometry and navigation');
} finally { await browser.close(); await server.close(); }
