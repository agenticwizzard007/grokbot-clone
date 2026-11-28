import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';
import { layoutServer } from '../layout-fixture.mjs';
import { inspectAlignment } from '../layout-alignment-ui.mjs';

export const EMPTY_HINT = 'Empty dashboards are ready for widgets. Open one and tap Add widget.';
export function inspectSidebarRows() {
  const issues = [], near = (a, b) => Math.abs(a - b) <= 1;
  for (const sidebar of document.querySelectorAll('.sidebar')) {
    if (!sidebar.checkVisibility() || sidebar.getBoundingClientRect().right <= 0) continue;
    const scroll = sidebar.querySelector('.sidebar__custom-scroll, .sidebar__scroll');
    const meter = sidebar.querySelector('.sidebar-usage'), footer = sidebar.querySelector('.sidebar__footer');
    if (!scroll || !meter) continue;
    const s = scroll.getBoundingClientRect(), m = meter.getBoundingClientRect(), f = footer.getBoundingClientRect();
    if (!near(m.top - s.bottom, 8)) issues.push(`G1 scroll/meter gap ${m.top - s.bottom}px, expected 8px`);
    if (!near(f.top - m.bottom, 8)) issues.push(`G1 meter/Settings gap ${f.top - m.bottom}px, expected 8px`);
    const top = s.top + scroll.clientTop, bottom = Math.min(top + scroll.clientHeight, m.top);
    for (const row of scroll.querySelectorAll('button, a[href], [role="button"]')) {
      if (!row.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const r = row.getBoundingClientRect();
      if (!r.height || r.bottom <= top + 1 || r.top >= bottom - 1) continue;
      if (r.top < top - 1 || r.bottom > bottom + 1) issues.push(`G1 clipped row ${row.textContent.trim() || row.getAttribute('aria-label')}: ${r.top.toFixed(1)}..${r.bottom.toFixed(1)} outside ${top.toFixed(1)}..${bottom.toFixed(1)}`);
    }
  }
  return issues;
}

export async function runFixDash3({ before = false, output = path.resolve(`.context/ui-custom/fix-dash-3/${before ? 'before' : 'after'}`) } = {}) {
  fs.mkdirSync(output, { recursive: true });
  const server = await layoutServer({ customization: true, ...(process.env.FIX_DASH3_ROOT ? { root: path.resolve(process.env.FIX_DASH3_ROOT) } : {}) });
  const db = new Database(server.dbPath);
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const checks = [], failures = [], screenshots = [], guards = [];
  const check = (name, condition, details = '') => { (condition ? checks : failures).push({ name, details }); console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${details ? `: ${details}` : ''}`); };
  try {
    const request = async (method, body, revision) => {
      const res = await fetch(`${server.base}/api/ui/config`, { method, headers: { cookie: 'swarm_session=layout-test-token', origin: server.base, 'content-type': 'application/json', ...(revision === undefined ? {} : { 'If-Match': `"${revision}"` }) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.ok(res.ok, await res.clone().text()); return res.json();
    };
    const initial = await request('GET');
    initial.doc.dashboards = ['Sales pipeline', 'Operations', 'Weekly review', 'Launch planning', 'Customer follow ups', 'Content calendar', 'Research'].map((name, i) => ({ id: `d_${String(i + 1).padStart(8, '0')}`, name, icon: 'layout-dashboard', widgets: i < 2 ? [{ id: `w_${String(i + 1).padStart(8, '0')}`, type: 'stat', title: 'Open tasks', span: 4, rows: 1, source: { id: 'tasks.counts', params: {} }, options: { field: 'working' } }] : [] }));
    await request('PUT', initial.doc, initial.revision);
    for (const [width, height] of [[320,640],[390,700],[390,844],[500,844],[1280,600],[1280,720],[1280,900]]) for (const theme of ['light','dark']) {
      const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, reducedMotion: 'reduce' });
      await context.route('**/*', route => ['127.0.0.1','localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
      await context.addCookies([{ name: 'swarm_session', value: 'layout-test-token', url: server.base }]);
      await context.addInitScript(theme => { localStorage.setItem('swarm.theme', theme); localStorage.setItem('swarm.sidebarCollapsed', '0'); }, theme);
      const page = await context.newPage(); page.setDefaultTimeout(15000);
      const label = `${width}x${height}-${theme}`;
      const open = async hash => { await page.goto(`${server.base}/${hash}`); await page.locator('.shell-header').waitFor(); await page.waitForFunction(async () => (await import('/src/customization/store.ts')).useCustomization.getState().status === 'ready'); await page.evaluate(() => document.fonts.ready); };
      const drawer = async () => { if (width <= 760) await page.getByRole('button', { name: 'Open navigation', exact: true }).click(); await page.locator('.sidebar:visible .plan-usage__amount').waitFor(); await page.waitForTimeout(100); };
      const capture = async name => { const file = path.join(output, `${name}-${label}.png`); await page.screenshot({ path: file, animations: 'disabled' }); screenshots.push(file); };
      await open('#dash/d_00000001'); await page.locator('[data-widget-state="ready"]').waitFor();
      await capture('sales-pipeline');
      await open('#dashboards'); await page.locator('.dashboard-manager-row').first().waitFor();
      await capture('manager');
      if (width <= 760) { await page.locator('.dashboard-manager-row').last().scrollIntoViewIfNeeded(); const hint = page.locator('.dashboard-empty-hint'); if (await hint.count()) await hint.scrollIntoViewIfNeeded(); await capture('manager-bottom'); }
      const text = await page.locator('.dashboards-manager').innerText();
      check(`manager no zero widgets ${label}`, !text.includes('0 widgets'));
      check(`manager single empty hint ${label}`, text.split(EMPTY_HINT).length === 2);
      check(`manager populated count ${label}`, await page.locator('.dashboard-caption').getByText('1 widget', { exact: true }).count() === 2);
      check(`manager alignment ${label}`, (await page.evaluate(inspectAlignment, { selector: '.dashboards-manager' })).length === 0);
      await drawer();
      const disclosure = page.locator('.sidebar:visible').getByRole('button', { name: 'Dashboards', exact: true });
      const exists = await disclosure.count() === 1 && await disclosure.getAttribute('aria-expanded') !== null;
      check(`disclosure available ${label}`, exists);
      if (exists) {
        check(`disclosure default ${label}`, await disclosure.getAttribute('aria-expanded') === String(height >= 760));
        check(`disclosure target ${label}`, (await disclosure.boundingBox()).height >= 44);
        if (await disclosure.getAttribute('aria-expanded') === 'false') await disclosure.click();
      }
      check(`dashboard cap ${label}`, await page.locator('.sidebar:visible .sidebar__dashboards .sidebar-island').count() === (width <= 760 || height < 760 ? 4 : 6));
      await capture('dash-sidebar-expanded');
      const initialGuard = await page.evaluate(inspectSidebarRows); guards.push({ view: label, position: 'top', issues: initialGuard });
      check(`whole rows and gaps ${label}`, initialGuard.length === 0, initialGuard.join('; '));
      const geometry = await page.locator('.sidebar:visible').evaluate(sidebar => {
        const scroll = sidebar.querySelector('.sidebar__custom-scroll, .sidebar__scroll'), s = scroll.getBoundingClientRect();
        const full = el => { const r = el.getBoundingClientRect(); return el.checkVisibility({ opacityProperty: true }) && r.top >= s.top - 1 && r.bottom <= s.bottom + 1; };
        return { bots: [...sidebar.querySelectorAll('.pinned__tile, .bot-row')].filter(full).length, primary: full(sidebar.querySelector('.pinned__tile')), scrolls: scroll.scrollHeight > scroll.clientHeight, meter: sidebar.querySelector('.sidebar-usage').getBoundingClientRect().height };
      });
      if (width === 390) check(`full Bots ${label}`, geometry.primary && geometry.bots >= (height === 844 ? 2 : 1) && (height !== 700 || geometry.scrolls), JSON.stringify(geometry));
      if (width <= 760) check(`compact meter ${label}`, geometry.meter <= 73, `${geometry.meter}px`);
      for (const position of ['middle','end']) {
        await page.locator('.sidebar:visible .sidebar__custom-scroll').evaluate((el, pos) => { el.scrollTop = pos === 'middle' ? el.scrollHeight / 2 : el.scrollHeight; }, position);
        await page.waitForTimeout(100);
        const issues = await page.evaluate(inspectSidebarRows); guards.push({ view: label, position, issues }); check(`whole rows ${position} ${label}`, issues.length === 0, issues.join('; '));
      }
      const create = page.locator('.sidebar:visible .sidebar__create');
      await create.focus();
      check(`keyboard reveals edge row ${label}`, await create.evaluate(el => !el.hasAttribute('data-sidebar-clipped')) && (await page.evaluate(inspectSidebarRows)).length === 0);
      await page.locator('.sidebar:visible .sidebar__custom-scroll').evaluate(el => { el.scrollTop = 0; });
      if (exists) {
        await disclosure.focus(); await page.keyboard.press('Enter');
        check(`Enter collapses ${label}`, await disclosure.getAttribute('aria-expanded') === 'false');
        await capture('dash-sidebar-collapsed');
        await page.reload(); await drawer();
        check(`closed survives reload ${label}`, await disclosure.getAttribute('aria-expanded') === 'false');
        await disclosure.focus(); await page.keyboard.press('Space');
        check(`Space expands ${label}`, await disclosure.getAttribute('aria-expanded') === 'true');
        await page.reload(); await drawer();
        check(`open survives reload ${label}`, await disclosure.getAttribute('aria-expanded') === 'true');
      }
      check(`clean visible copy ${label}`, !/mock|Fixture|PRIVATE|QA-|undefined|null|\[object|[\u2013\u2014]/i.test(await page.locator('.sidebar:visible').innerText()));
      await context.close();
    }
  } finally {
    await browser.close(); db.close(); await server.close();
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ passed: checks.length, failed: failures.length, checks, failures, guards, screenshots }, null, 2));
  }
  console.log(`FIX-DASH-3: ${checks.length} passed, ${failures.length} failed. ${output}/results.json`);
  // --before records the same assertions and deliberately exits nonzero on the old UI.
  assert.equal(failures.length, 0, 'FIX-DASH-3 acceptance');
  return { checks, failures, screenshots, guards };
}
if (process.argv[1]?.endsWith('/demo-fix-dash-3.mjs')) await runFixDash3({ before: process.argv.includes('--before') });
