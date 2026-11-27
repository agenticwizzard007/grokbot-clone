import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dashboardFixture, patch, inspectAlignment, assertGrid } from './dashboard-fixture.mjs';
const server = await dashboardFixture(), out = path.resolve('.context/ui-custom/dashboard-states'); fs.mkdirSync(out, { recursive: true });
let passed = 0;
try {
  for (const width of [390, 1280]) {
    const page = await server.page(width);
    await page.evaluate(async () => {
      const entry = await (await fetch('/src/main.tsx')).text();
      const reactUrl = entry.match(/from ["']([^"']+\/react\.js[^"']*)/)[1], domUrl = entry.match(/from ["']([^"']+\/react-dom_client\.js[^"']*)/)[1];
      const React = (await import(reactUrl)).default, { createRoot } = (await import(domUrl)).default;
      const { DashboardGrid } = await import('/src/dashboards/DashboardGrid.tsx'), { Page } = await import('/src/components/layout/index.tsx');
      const { defaultWidget } = await import('/src/dashboards/model.ts'); await import('/src/styles/dashboards.css');
      document.querySelector('#root').style.display = 'none';
      const container = document.createElement('div'); container.id = 'dashboard-harness'; container.style.cssText = 'position:fixed;inset:0;overflow:auto;background:var(--color-bg-pane)'; document.body.append(container);
      const root = createRoot(container); window.dashboardRetries = 0;
      const types = ['stat', 'list', 'table', 'chart', 'meter', 'botStatus', 'taskBoard', 'routineSchedule', 'note', 'shortcuts'];
      const widgets = [], states = {};
      for (const [typeIndex, type] of types.entries()) for (const [stateIndex, state] of ['loading', 'empty', 'error', 'data'].entries()) {
        const widget = { ...defaultWidget(type), id: `w_${String(typeIndex * 4 + stateIndex).padStart(8, '0')}`, title: `${type} ${state}`, span: 6, rows: 4 };
        if (state === 'empty' && type === 'note') widget.options.text = '';
        if (state === 'empty' && type === 'shortcuts') widget.options.items = [];
        if (state === 'data' && type === 'note') widget.options.text = '## Weekly notes\n**Bold** and *italic*.\n[Read](https://example.test/report)\n- First\n- Next';
        widgets.push(widget);
        let data = { ok: true, count: 3, value: { total: 12, working: 4 }, rows: [
          { id: 'fixture-1', title: 'Draft the launch email', name: 'Project assistant', state: 'working', status: 'ready', botName: 'Project assistant', botId: 'fixture-bot', openTasks: 3, day: '2026-01-01', value: 1, created: 2, done: 1, at: Date.now() + 100000, routineId: 'r1', label: 'Weekly', usedPercent: 37, resetsAt: null },
          { id: 'fixture-2', title: 'Review the launch plan', name: 'Daily summary', state: 'needs_input', status: 'needs_you', botName: 'Project assistant', botId: 'fixture-bot', openTasks: 1, day: '2026-01-02', value: 3, created: 3, done: 2, at: Date.now() + 200000, routineId: 'r2' },
          { id: 'fixture-3', title: 'Publish the weekly update', name: 'Planning assistant', state: 'done', status: 'ready', botName: 'Project assistant', botId: 'fixture-bot', openTasks: 0, day: '2026-01-03', value: 2, created: 1, done: 1, at: Date.now() + 300000, routineId: 'r3' },
        ], available: true };
        if (state === 'empty') data = { ok: true, count: 0, value: {}, rows: [], available: false };
        states[widget.id] = state === 'loading' ? { status: 'loading' } : state === 'error' ? { status: 'error', error: 'Data is unavailable.' } : { status: 'ready', data };
      }
      window.renderDashboardHarness = (nextWidgets = widgets, nextStates = states) => root.render(React.createElement(Page, { type: 'wide', className: 'dashboard-page' }, React.createElement(DashboardGrid, { widgets: nextWidgets, states: nextStates, refresh: () => { window.dashboardRetries++; } })));
      window.renderDashboardHarness();
    });
    await page.locator('#dashboard-harness [data-widget-id]').last().waitFor({state:'attached'});
    assert.equal(await page.locator('#dashboard-harness [data-widget-id]').count(), 40);
    for (const widget of await page.locator('#dashboard-harness [data-widget-id]').all()) {
      await widget.scrollIntoViewIfNeeded();
      const title = await widget.locator('h2').first().textContent(), state = title.split(' ').at(-1);
      if (state === 'loading') assert.equal(await widget.getByRole('status', { name: `Loading ${title}` }).count(), 1);
      if (state === 'error') { await widget.getByRole('button', { name: `Retry ${title}` }).click(); }
      if (state === 'empty') assert.equal(await widget.locator('.dashboard-empty-data').count(), 1);
      if (state === 'data') assert.equal(await widget.locator('.dashboard-empty-data').count(), 0);
      assert.equal(await widget.getByRole('region', { name: title, exact: true }).count(), 1);
      passed++;
    }
    assert.equal(await page.evaluate(() => window.dashboardRetries), 10);
    assert.deepEqual(await page.evaluate(inspectAlignment, { selector: '#dashboard-harness' }), []);
    const external = page.locator('.dashboard-note a[href="https://example.test/report"]');
    assert.equal(await external.getAttribute('target'), '_blank'); assert.equal(await external.getAttribute('rel'), 'noopener noreferrer');
    assert.equal(await page.locator('.dashboard-link-domain').textContent(), ' (example.test)');
    assert.equal(await page.getByRole('table', { name: 'chart data data', exact: true }).count(), 1);
    await page.evaluate(() => document.querySelector('#dashboard-harness').scrollTo(0, 0));
    await page.screenshot({ path: path.join(out, `states-${width}.png`) });
    await page.context().close();
  }
  const hostile = await server.page(390); const dashboard = await server.create(hostile);
  await server.open(hostile, dashboard.id);
  const corpus = [
    '<script>window.dashboardXss=true</script>', '<img src=x onerror="window.dashboardXss=true">', '<svg onload="window.dashboardXss=true">',
    '<iframe src="https://example.test">', '<a href="javascript:alert(1)">Run</a>', '[Run](javascript:alert)', '[Run](data:text/html,x)',
    '[Run](//example.test)', '![Image](https://example.test/image.png)', '<style>body{display:none}</style>',
  ];
  await hostile.evaluate(async payloads => {
    const entry = await (await fetch('/src/main.tsx')).text();
    const React = (await import(entry.match(/from ["']([^"']+\/react\.js[^"']*)/)[1])).default, { createRoot } = (await import(entry.match(/from ["']([^"']+\/react-dom_client\.js[^"']*)/)[1])).default;
    const Note = (await import('/src/dashboards/widgets/Note.tsx')).default;
    const container = document.createElement('div'); container.id = 'note-corpus'; document.body.append(container);
    createRoot(container).render(React.createElement('div', {}, payloads.map((payload, index) => React.createElement(Note, { key: index, widget: { id: `w_${String(index).padStart(8, '0')}`, type: 'note', span: 6, rows: 2, options: { text: payload } } }))));
  }, Array.from({ length: 50 }, (_, n) => corpus[n % corpus.length]));
  await hostile.locator('#note-corpus .dashboard-note').first().waitFor({ state: 'attached' });
  assert.equal(await hostile.locator('#note-corpus img, #note-corpus script, #note-corpus iframe, #note-corpus svg, #note-corpus style').count(), 0);
  assert.equal(await hostile.evaluate(() => !!window.dashboardXss), false); passed += 50;
  await hostile.evaluate(() => document.querySelector('#note-corpus').remove());
  await patch(hostile, [{ op: 'replace', path: '/dashboards/0/widgets/0/title', value: 'A'.repeat(60) }]);
  await hostile.locator('[data-widget-id]').first().scrollIntoViewIfNeeded();
  const heading = hostile.locator('[data-widget-id]').first().locator('h2'); assert.equal((await heading.textContent()).length, 60);
  const titleGeometry = await heading.evaluate(node => ({scroll:node.scrollWidth,client:node.clientWidth,overflow:getComputedStyle(node).textOverflow,white:getComputedStyle(node).whiteSpace,wrap:getComputedStyle(node).overflowWrap,width:getComputedStyle(node).width,display:getComputedStyle(node).display})); assert.ok(titleGeometry.scroll <= titleGeometry.client + 1 && titleGeometry.overflow !== 'ellipsis');
  for (const width of [320, 390, 500, 768, 1280]) { await hostile.setViewportSize({ width, height: 900 }); await assertGrid(hostile, width); passed++; }
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ passed, failed: 0 }, null, 2));
  console.log(`DASHBOARD STATES: ${passed} passed, 0 failed (80 render states, 50 XSS payloads, 5 grid widths)`);
} finally { await server.close(); }
