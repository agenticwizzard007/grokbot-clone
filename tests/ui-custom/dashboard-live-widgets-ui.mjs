import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tsImport } from 'tsx/esm/api';
import { dashboardAgentFixture } from './dashboard-agent-fixture.mjs';
import { widgetTypes, readyWidgets, assertGrid, inspectAlignment } from './dashboard-fixture.mjs';
const { defaultWidget } = await tsImport('../../web/src/dashboards/model.ts', { parentURL: import.meta.url, tsconfig: 'web/tsconfig.json' });
const server = await dashboardAgentFixture(), checks = [];
async function open(account, width, seeded) {
  const widgets = widgetTypes.map((type, index) => ({ ...defaultWidget(type), id: `$new${index + 2}`, title: `Fixture ${type}`, span: 6, rows: 4,
    ...(type === 'note' ? { options: { text: seeded ? '## Weekly focus\nReview the next three tasks.' : '' } } : {}),
    ...(type === 'shortcuts' ? { options: { items: seeded ? [{ label: 'Open tasks', target: 'tasks' }, { label: 'Open Bots', target: 'bots' }] : [{ label: 'Tasks', target: 'tasks' }] } } : {}),
  }));
  const created = await server.request(account, 'PATCH', '/ui/config', { patch: [{ op: 'add', path: '/dashboards/-', value: { id: '$new1', name: 'My week', icon: 'layout-dashboard', widgets } }] }, 0);
  assert.equal(created.status, 200, JSON.stringify(created));
  const dashboard = created.body.doc.dashboards[0], page = await server.page(account, width);
  await page.goto(`${server.base}/#dash/${dashboard.id}`); await page.locator('.dashboard-grid').waitFor(); await readyWidgets(page); return page;
}
try {
  for (const width of [390, 1280]) {
    const emptyAccount = await server.account(), empty = await open(emptyAccount, width, false);
    assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM bots WHERE user_id=?').get(emptyAccount.userId).n, 0);
    for (const type of widgetTypes) {
      const widget = empty.locator(`[data-widget-type="${type}"]`); await widget.scrollIntoViewIfNeeded();
      const placeholder = widget.locator('.dashboard-empty-data'); assert.equal(await placeholder.count(), 1, `${type}: new account empty state`);
      assert.equal(await placeholder.locator('p').count(), 1); assert.equal(await placeholder.locator('button,a').count(), 1);
      assert.equal(await placeholder.getByRole('link').getAttribute('href'), type === 'shortcuts' ? '#tasks' : '#new-bot');
      assert.ok((await placeholder.locator('p').textContent()).length > 0);
      assert.equal(await widget.getAttribute('data-widget-state'), 'ready'); checks.push(`${type}: empty account, one line and one action at ${width}`);
    }
    await assertGrid(empty, width); assert.deepEqual(await empty.evaluate(inspectAlignment), []);
    const out='.context/ui-custom/dashboard-live-widgets'; fs.mkdirSync(out,{recursive:true});
    await empty.getByRole('heading',{name:'My week',exact:true}).scrollIntoViewIfNeeded(); await empty.screenshot({path:`${out}/empty-${width}.png`});
    await empty.context().close();
    const account = await server.account({ bot: true }); server.seed(account);
    const page = await open(account, width, true);
    for (const type of widgetTypes) {
      const widget = page.locator(`[data-widget-type="${type}"]`); await widget.scrollIntoViewIfNeeded();
      if (type === 'meter') { await server.seedMeter(account); await page.getByRole('button',{name:'Refresh',exact:true}).click(); await widget.scrollIntoViewIfNeeded(); await widget.locator('progress').waitFor(); }
      assert.equal(await widget.getAttribute('data-widget-state'), 'ready'); assert.equal(await widget.locator('.dashboard-empty-data').count(), 0, `${type}: seeded data`);
      if (type === 'stat') assert.equal(await widget.locator('output').textContent(), '12');
      if (['list','table','taskBoard'].includes(type)) assert.match(await widget.textContent(), /Fixture task/);
      if (type === 'chart') { assert.equal(await widget.locator('svg[role="img"]').count(), 1); assert.match(await widget.locator('table').textContent(), /0.25/); }
      if (type === 'meter') assert.equal(await widget.locator('progress').getAttribute('value'), '37');
      if (type === 'botStatus') assert.match(await widget.textContent(), /Fixture assistant/);
      if (type === 'routineSchedule') assert.match(await widget.textContent(), /Fixture routine/);
      if (type === 'note') assert.match(await widget.textContent(), /Review the next three tasks/);
      if (type === 'shortcuts') { assert.equal(await widget.getByRole('link',{name:'Open tasks',exact:true}).getAttribute('href'), '#tasks'); assert.equal(await widget.getByRole('link',{name:'Open Bots',exact:true}).count(),1); }
      checks.push(`${type}: persisted data through real source API or saved static content at ${width}`);
    }
    await assertGrid(page, width); assert.deepEqual(await page.evaluate(inspectAlignment), []);
    await page.getByRole('heading',{name:'My week',exact:true}).scrollIntoViewIfNeeded(); await page.screenshot({path:`${out}/seeded-${width}.png`});
    await page.context().close();
  }
  fs.writeFileSync('.context/ui-custom/dashboard-live-widgets/results.json',JSON.stringify({passed:checks.length,failed:0,checks},null,2));
  console.log(`DASHBOARD LIVE WIDGETS: ${checks.length} passed, 0 failed (10 types, empty and seeded accounts, 2 widths)`);
} finally { await server.close(); }
