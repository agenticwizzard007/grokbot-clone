import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';
import { layoutServer } from '../layout-fixture.mjs';
import { inspectAlignment } from '../layout-alignment-ui.mjs';
import { inspectSidebarRows, runFixDash3 } from './demo-fix-dash-3.mjs';

export async function auditSidebarPolish(routes, output = path.resolve('.context/ui-custom/fix-dash-2/sidebar')) {
  fs.mkdirSync(output, { recursive: true });
  const server = await layoutServer({ customization: true }), db = new Database(server.dbPath);
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const report = [];
  const request = async (method, body, revision) => {
    const response = await fetch(`${server.base}/api/ui/config`, { method, headers: { cookie: 'swarm_session=layout-test-token', origin: server.base, 'content-type': 'application/json', ...(revision === undefined ? {} : { 'If-Match': `"${revision}"` }) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.ok(response.ok, await response.clone().text()); return response.json();
  };
  const original = (await request('GET')).doc;
  try {
    for (const shape of ['standard-short', 'custom-short', 'standard-long', 'custom-long']) {
      const long = shape.endsWith('long'), custom = shape.startsWith('custom');
      db.prepare("DELETE FROM bots WHERE id LIKE 'sidebar-polish-%'").run();
      if (long) for (let i = 0; i < 24; i++) db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(`sidebar-polish-${i}`, server.fixture.userId, `Project assistant ${i + 1}`, Date.now(), Date.now());
      const doc = structuredClone(original);
      if (custom) {
        doc.dashboards = Array.from({ length: long ? 12 : 1 }, (_, i) => ({ id: `d_${String(i + 1).padStart(8, '0')}`, name: ['Sales pipeline', 'Operations', 'Weekly review', 'Launch planning', 'Customer follow ups'][i] ?? `Project overview ${i + 1}`, icon: 'layout-dashboard', widgets: [] }));
        // Footer semantics remain stable even when the saved order interleaves them.
        doc.layout.sidebar.order = ['usage', 'tasks', 'settings', 'allBots', 'files', 'dashboards', 'yourBots', 'createBot'];
      }
      await request('PUT', doc, (await request('GET')).revision);
      const saved = (await request('GET')).doc;
      const viewports = [320,390,500,1280].map(width => ({ width, height: width <= 760 ? 844 : 900, extra: false }));
      for (const [width, height] of [[320,640],[390,640],[390,700],[1280,600],[1280,720]]) for (const state of custom ? ['expanded','collapsed','rail'] : ['default','rail']) {
        if (width <= 760 && state === 'rail') continue;
        viewports.push({ width, height, state, extra: true });
      }
      for (const { width, height, state, extra } of viewports) for (const theme of ['light', 'dark']) {
        const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, reducedMotion: 'reduce' });
        await context.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
        await context.addCookies([{ name: 'swarm_session', value: 'layout-test-token', url: server.base }]);
        await context.addInitScript(theme => { if (location.origin !== 'null') { localStorage.setItem('swarm.theme', theme); localStorage.setItem('swarm.sidebarCollapsed', '0'); } }, theme);
        const page = await context.newPage(); page.setDefaultTimeout(15000);
        const views = [...routes.filter(route => !route.signedOut), { name: 'appearance', hash: '#settings/appearance' }, { name: 'about-you', hash: '#settings/appearance/use' }, { name: 'dashboards', hash: '#dashboards' }, ...(custom ? [{ name: 'dashboard', hash: `#dash/${saved.dashboards[0].id}` }] : [])];
        for (const route of extra ? views.slice(0, 1) : views) {
          const issues = [];
          try {
            const hash = route.hash.replace('{bot}', server.fixture.bot.id).replace('{room}', server.fixture.room);
            await page.goto(`${server.base}/${hash}`);
            await page.locator('.shell-header').waitFor();
            await page.waitForFunction(async () => (await import('/src/customization/store.ts')).useCustomization.getState().status === 'ready');
            if (width <= 760) {
              const open = page.getByRole('button', { name: 'Open navigation', exact: true });
              if (await open.isVisible()) await open.click();
            }
            await page.locator('.sidebar:visible .sidebar-usage .plan-usage').waitFor();
            await page.evaluate(() => document.fonts.ready);
            if (state === 'rail') await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
            const disclosure = page.locator('.sidebar:visible .sidebar__disclosure');
            if (custom && state && state !== 'rail' && await disclosure.getAttribute('aria-expanded') !== String(state === 'expanded')) await disclosure.click();
            await page.waitForTimeout(50);
            issues.push(...await page.evaluate(inspectSidebarRows));
            const copy = await page.locator('.sidebar:visible').innerText();
            if (/mock|Fixture|PRIVATE|QA-|undefined|null|\[object|[\u2013\u2014]/i.test(copy)) issues.push('Sidebar contains forbidden visible text');
            issues.push(...await page.evaluate(inspectAlignment, { sidebarOnly: true }));
            const scroll = page.locator('.sidebar:visible .sidebar__custom-scroll, .sidebar:visible .sidebar__scroll');
            const before = await page.locator('.sidebar:visible .sidebar-usage').boundingBox();
            const scrolling = await scroll.evaluate(el => { el.scrollTop = el.scrollHeight; return { top: el.scrollTop, height: el.clientHeight, total: el.scrollHeight }; });
            if (long && scrolling.top <= 0) issues.push('G1 long middle list must scroll');
            if (scrolling.total <= scrolling.height && scrolling.top !== 0) issues.push('G1 fitting list must retain free space above the footer');
            assert.deepEqual(await page.locator('.sidebar:visible .sidebar-usage').boundingBox(), before, 'G1 scrolling must not move Usage');
            await page.waitForTimeout(50);
            issues.push(...await page.evaluate(inspectAlignment, { sidebarOnly: true }), ...await page.evaluate(inspectSidebarRows));
            await scroll.evaluate(el => { el.scrollTop = el.scrollHeight / 2; });
            await page.waitForTimeout(50);
            issues.push(...await page.evaluate(inspectSidebarRows));
            if (route === views[0]) await page.screenshot({ path: path.join(output, `${shape}-${width}x${height}-${state ?? 'default'}-${theme}.png`) });
            if (route === views[0]) {
              // D7 collapses failed reads to one line; resizing the pinned footer
              // must preserve whole rows and the same exact 8px gaps.
              await page.route('**/api/usage/summary', request => request.fulfill({ status: 503, json: { error: 'Temporarily unavailable.' } }));
              await page.evaluate(async () => (await import('/src/lib/planUsage.ts')).refreshPlanUsage());
              const meter = page.locator('.sidebar:visible .sidebar-usage');
              await meter.and(page.getByRole('button', { name: 'Usage unavailable', exact: true })).waitFor();
              assert.ok((await meter.boundingBox()).height <= 64, 'D7 unavailable meter remains compact');
              for (const position of [0, .5, 1]) {
                await scroll.evaluate((el, position) => { el.scrollTop = el.scrollHeight * position; }, position);
                await page.waitForTimeout(50);
                issues.push(...await page.evaluate(inspectSidebarRows), ...await page.evaluate(inspectAlignment, { sidebarOnly: true }));
              }
              await page.unroute('**/api/usage/summary');
              await page.evaluate(async () => (await import('/src/lib/planUsage.ts')).refreshPlanUsage());
            }
            if (width <= 760) await page.getByRole('button', { name: 'Close navigation', exact: true }).click();
          } catch (error) { issues.push(error.message); }
          report.push({ name: `${shape}/${route.name}/${state ?? 'default'}`, width, height, theme, owner: 'FIX-DASH-3', enforce: true, issues });
          console.log(`${issues.length ? 'FAIL' : 'PASS'} sidebar ${shape} ${route.name} ${width} ${theme}${issues.length ? `: ${issues.join('; ')}` : ''}`);
        }
        await context.close();
      }
    }
  } finally { await browser.close(); db.close(); await server.close(); fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2)); }
  const failed = report.filter(view => view.issues.length).length;
  console.log(`SIDEBAR POLISH: ${report.length - failed} passed, ${failed} failed`);
  assert.equal(failed, 0, 'G1 sidebar geometry on every route, short and long lists');
  const demo = await runFixDash3({ output: path.join(output, 'acceptance') });
  report.push(...demo.checks.map(check => ({ name: check.name, owner: 'FIX-DASH-3', enforce: true, issues: [] })));
  return report;
}

if (process.argv[1]?.endsWith('/sidebar-polish-ui.mjs')) {
  const { ROUTES } = await import('../layout-alignment-ui.mjs');
  await auditSidebarPolish(ROUTES);
}
