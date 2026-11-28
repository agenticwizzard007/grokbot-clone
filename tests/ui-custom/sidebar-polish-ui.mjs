import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';
import { layoutServer } from '../layout-fixture.mjs';
import { inspectSidebarUsage } from './dashboard-polish-guards.mjs';

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
        doc.dashboards = Array.from({ length: long ? 12 : 1 }, (_, i) => ({ id: `$new${i + 1}`, name: ['Sales pipeline', 'Operations', 'Weekly review', 'Launch planning', 'Customer follow ups'][i] ?? `Project overview ${i + 1}`, icon: 'layout-dashboard', widgets: [] }));
        // Footer semantics remain stable even when the saved order interleaves them.
        doc.layout.sidebar.order = ['usage', 'tasks', 'settings', 'allBots', 'files', 'dashboards', 'yourBots', 'createBot'];
      }
      await request('PUT', doc, (await request('GET')).revision);
      const saved = (await request('GET')).doc;
      for (const width of [320, 390, 500, 1280]) for (const theme of ['light', 'dark']) {
        const context = await browser.newContext({ viewport: { width, height: width <= 760 ? 844 : 900 }, colorScheme: theme, reducedMotion: 'reduce' });
        await context.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
        await context.addCookies([{ name: 'swarm_session', value: 'layout-test-token', url: server.base }]);
        await context.addInitScript(theme => { if (location.origin !== 'null') { localStorage.setItem('swarm.theme', theme); localStorage.setItem('swarm.sidebarCollapsed', '0'); } }, theme);
        const page = await context.newPage(); page.setDefaultTimeout(15000);
        const views = [...routes.filter(route => !route.signedOut), { name: 'appearance', hash: '#settings/appearance' }, { name: 'about-you', hash: '#settings/appearance/use' }, { name: 'dashboards', hash: '#dashboards' }, ...(custom ? [{ name: 'dashboard', hash: `#dash/${saved.dashboards[0].id}` }] : [])];
        for (const route of views) {
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
            issues.push(...await page.evaluate(inspectSidebarUsage));
            const scroll = page.locator('.sidebar:visible .sidebar__custom-scroll, .sidebar:visible .sidebar__scroll');
            const before = await page.locator('.sidebar:visible .sidebar-usage').boundingBox();
            const scrolling = await scroll.evaluate(el => { el.scrollTop = el.scrollHeight; return { top: el.scrollTop, height: el.clientHeight, total: el.scrollHeight }; });
            if (long && scrolling.top <= 0) issues.push('G1 long middle list must scroll');
            if (!long && scrolling.top !== 0) issues.push('G1 short list must retain free space above the footer');
            assert.deepEqual(await page.locator('.sidebar:visible .sidebar-usage').boundingBox(), before, 'G1 scrolling must not move Usage');
            issues.push(...await page.evaluate(inspectSidebarUsage));
            if (route === views[0]) await page.screenshot({ path: path.join(output, `${shape}-${width}-${theme}.png`) });
            if (width <= 760) await page.getByRole('button', { name: 'Close navigation', exact: true }).click();
          } catch (error) { issues.push(error.message); }
          report.push({ name: `${shape}/${route.name}`, width, theme, owner: 'FIX-DASH-2', enforce: true, issues });
          console.log(`${issues.length ? 'FAIL' : 'PASS'} sidebar ${shape} ${route.name} ${width} ${theme}${issues.length ? `: ${issues.join('; ')}` : ''}`);
        }
        await context.close();
      }
    }
  } finally { await browser.close(); db.close(); await server.close(); fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2)); }
  const failed = report.filter(view => view.issues.length).length;
  console.log(`SIDEBAR POLISH: ${report.length - failed} passed, ${failed} failed`);
  assert.equal(failed, 0, 'G1 sidebar geometry on every route, short and long lists');
  return report;
}

if (process.argv[1]?.endsWith('/sidebar-polish-ui.mjs')) {
  const { ROUTES } = await import('../layout-alignment-ui.mjs');
  await auditSidebarPolish(ROUTES);
}
