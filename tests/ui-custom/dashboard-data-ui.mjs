import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dashboardFixture, patch, exampleDashboard } from './dashboard-fixture.mjs';
const server = await dashboardFixture(); let passed = 0; const batches = [], metrics = {};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  const page = await server.page(), doc = exampleDashboard();
  // Keep the chart below the fold independently of the dashboard header height.
  await page.setViewportSize({ width: 1280, height: 720 });
  doc.widgets[0].source = { id: 'tasks.counts', params: {} }; doc.widgets[0].options = { field: 'working' };
  doc.widgets.forEach(widget => widget.refreshSec = 0); doc.widgets[2].refreshSec = 30;
  doc.widgets.splice(3, 0, { id: '$new7', type: 'note', title: 'Weekly focus', span: 12, rows: 6, options: { text: 'Weekly focus' } });
  const dashboard = await server.create(page, doc);
  page.on('request', request => { if (request.url().endsWith('/api/ui/data')) batches.push({ body: request.postDataJSON(), time: Date.now(), fresh: request.headers()['cache-control'] }); });
  await server.open(page, dashboard.id); await pause(250);
  assert.equal(batches[0].body.requests.filter(row => row.source === 'tasks.counts').length, 1);
  assert.ok(batches[0].body.requests.some(row => row.source === 'usage.summary'));
  assert.ok(await page.locator('[data-widget-type="chart"]').evaluate(el => el.getBoundingClientRect().top >= innerHeight), 'Chart starts outside the viewport');
  assert.ok(!batches.some(batch => batch.body.requests.some(row => row.source === 'usage.series'))); passed += 2;
  const working = page.getByRole('region', { name: 'Working now', exact: true }).locator('output');
  assert.equal(await working.textContent(), '4');
  const start = Date.now(); server.db.prepare('UPDATE tasks SET state=? WHERE id=?').run('done', 'qa-dashboard-task-0');
  const answer = await page.evaluate(async id => { const response = await fetch(`/api/bots/${id}/cards/100/answer`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({answer:'Review the launch plan'}) }); return response.status; }, server.fixture.bot.id);
  assert.equal(answer, 200); await page.waitForFunction(() => document.querySelectorAll('.dashboard-stat')[2]?.textContent === '3', { timeout: 1900 });
  metrics.sseMs = Date.now() - start; assert.ok(metrics.sseMs < 2000); assert.ok(batches.some(batch => batch.fresh === 'no-cache')); passed++;
  await page.locator('[data-widget-type="chart"]').scrollIntoViewIfNeeded(); await page.locator('.dashboard-chart svg').waitFor(); assert.ok(batches.some(batch => batch.body.requests.some(row => row.source === 'usage.series'))); passed++;
  await working.scrollIntoViewIfNeeded(); await pause(200);
  let release; const held = new Promise(resolve => release = resolve); let intercepted = false;
  await page.route('**/api/ui/data', async route => { intercepted = true; await held; await route.continue(); });
  await page.getByRole('button', {name:'Refresh dashboard',exact:true}).click();
  for(let n=0; !intercepted && n<50; n++) await pause(20);
  assert.equal(intercepted, true); assert.equal(await working.textContent(), '3'); assert.equal(await page.locator('[data-widget-type="stat"] [role="status"][aria-label^="Loading"]').count(), 0); passed++;
  release(); await pause(250); await page.unroute('**/api/ui/data');
  await page.route('**/api/ui/data', route => route.fulfill({status:503,body:'Fixture unavailable'}));
  await page.getByRole('button', {name:'Refresh dashboard',exact:true}).click(); await page.getByRole('button',{name:'Retry Working now',exact:true}).waitFor(); assert.equal(await working.textContent(),'3'); passed++;
  await page.unroute('**/api/ui/data'); await page.getByRole('button',{name:'Retry Working now',exact:true}).click(); await page.getByRole('button',{name:'Retry Working now',exact:true}).waitFor({state:'detached'}); passed++;
  await page.clock.install();
  await page.evaluate(() => { Object.defineProperty(document,'visibilityState',{ configurable:true, value:'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  const beforeHidden = batches.length; await page.clock.runFor(120000); assert.equal(batches.length,beforeHidden); passed++;
  await page.evaluate(() => { Object.defineProperty(document,'visibilityState',{ configurable:true,value:'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.clock.runFor(200); await pause(250); assert.ok(batches.length > beforeHidden); passed++;
  const beforePoll = batches.length; await page.clock.runFor(29000); await pause(100); assert.equal(batches.length,beforePoll);
  await page.clock.runFor(2000); await pause(250); assert.ok(batches.length > beforePoll);
  assert.ok(batches.slice(beforePoll).every(batch => batch.body.requests.every(row => row.source === 'tasks.counts'))); passed++;
  // A failed poll still respects the minimum interval, while preserving stale content.
  await page.route('**/api/ui/data', route => route.fulfill({status:503,body:'Fixture poll failure'}));
  await page.clock.runFor(30000); await pause(250); const afterFailure=batches.length;
  await page.clock.runFor(29000); await pause(100); assert.equal(batches.length,afterFailure); assert.equal(await working.textContent(),'3'); passed++;
  await page.unroute('**/api/ui/data');
  // A new account must never see cached results from the previous account.
  await page.route('**/api/ui/data', route => route.fulfill({status:403,body:'Fixture session changed'}));
  await page.evaluate(async () => { const store=(await import('/src/store.ts')).useStore; store.setState({user:{...store.getState().user,id:'fixture-other-account'}}); });
  await page.clock.runFor(200); assert.equal(await page.locator('.dashboard-stat').count(),0); passed++;
  await page.context().close();
  // Measure the actual warm route, including the lazy dashboard boundary.
  const warm = await server.page(); await server.open(warm,dashboard.id); await warm.goto(`${server.base}/#bots`);
  await warm.evaluate(() => { window.dashboardCls=0; new PerformanceObserver(list => { for(const entry of list.getEntries()) if(!entry.hadRecentInput) window.dashboardCls += entry.value; }).observe({type:'layout-shift',buffered:false}); });
  const rendered = await warm.evaluate(async id => { const start=performance.now(); location.hash=`#dash/${id}`; while(!document.querySelector('.dashboard-stat')) await new Promise(resolve=>requestAnimationFrame(resolve)); return performance.now()-start; },dashboard.id);
  await pause(500); metrics.firstWidgetMs=rendered; metrics.cls=await warm.evaluate(()=>window.dashboardCls);
  assert.ok(rendered<500,`first widget ${rendered}ms`); assert.ok(metrics.cls<.05,`CLS ${metrics.cls}`); passed+=2;
  const asset=fs.readdirSync('web/dist/assets').find(name=>/^DashboardView-.*\.js$/.test(name)); assert.ok(asset,'Build web before this test');
  metrics.routeGzipBytes=gzipSync(fs.readFileSync(`web/dist/assets/${asset}`)).length; assert.ok(metrics.routeGzipBytes<40000); passed++;
  fs.mkdirSync('.context/ui-custom/dashboard-data',{recursive:true}); fs.writeFileSync('.context/ui-custom/dashboard-data/results.json',JSON.stringify({passed,failed:0,...metrics},null,2));
  console.log(`DASHBOARD DATA: ${passed} passed, 0 failed. ${JSON.stringify(metrics)}`);
} finally { await server.close(); }
