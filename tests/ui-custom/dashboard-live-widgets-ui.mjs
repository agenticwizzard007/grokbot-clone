import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tsImport } from 'tsx/esm/api';
import { dashboardAgentFixture } from './dashboard-agent-fixture.mjs';
import { widgetTypes, readyWidgets, assertGrid, inspectAlignment } from './dashboard-fixture.mjs';
const { defaultWidget } = await tsImport('../../web/src/dashboards/model.ts', { parentURL: import.meta.url, tsconfig: 'web/tsconfig.json' });
const server = await dashboardAgentFixture(), checks = [];
async function open(account, width, seeded) {
  const widgets = widgetTypes.map((type, index) => ({ ...defaultWidget(type), id: `$new${index + 2}`, span: 6, rows: 4,
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
    await empty.locator('.dashboard-heading').scrollIntoViewIfNeeded(); await empty.screenshot({path:`${out}/empty-${width}.png`});
    await empty.context().close();
    const account = await server.account({ bot: true }); server.seed(account);
    const page = await open(account, width, true);
    for (const type of widgetTypes) {
      const widget = page.locator(`[data-widget-type="${type}"]`); await widget.scrollIntoViewIfNeeded();
      if (type === 'meter') { await server.seedMeter(account); await page.getByRole('button',{name:'Refresh',exact:true}).click(); await widget.scrollIntoViewIfNeeded(); await widget.locator('progress').waitFor(); }
      assert.equal(await widget.getAttribute('data-widget-state'), 'ready'); assert.equal(await widget.locator('.dashboard-empty-data').count(), 0, `${type}: seeded data`);
      if (type === 'stat') assert.equal(await widget.locator('output').textContent(), '12');
      if (['list','table','taskBoard'].includes(type)) assert.match(await widget.textContent(), /Draft the launch email|Review the launch plan/);
      if (type === 'chart') { assert.equal(await widget.locator('svg[role="img"]').count(), 1); assert.match(await widget.locator('table').textContent(), /0.25/); }
      if (type === 'meter') assert.equal(await widget.locator('progress').getAttribute('value'), '37');
      if (type === 'botStatus') assert.match(await widget.textContent(), /Project assistant/);
      if (type === 'routineSchedule') assert.match(await widget.textContent(), /Daily summary|Weekly review/);
      if (type === 'note') assert.match(await widget.textContent(), /Review the next three tasks/);
      if (type === 'shortcuts') { assert.equal(await widget.getByRole('link',{name:'Open tasks',exact:true}).getAttribute('href'), '#tasks'); assert.equal(await widget.getByRole('link',{name:'Open Bots',exact:true}).count(),1); }
      checks.push(`${type}: persisted data through real source API or saved static content at ${width}`);
    }
    await assertGrid(page, width); assert.deepEqual(await page.evaluate(inspectAlignment), []);
    await page.locator('.dashboard-heading').scrollIntoViewIfNeeded(); await page.screenshot({path:`${out}/seeded-${width}.png`});
    // A period can contain completed older tasks but no newly created tasks.
    // Likewise, zero working tasks is meaningful when the account has tasks.
    server.db.prepare('UPDATE tasks SET created_at=?,updated_at=?,state=? WHERE bot_id=?').run(Date.now()-60*86400_000,Date.now(),'done',account.bot.id);
    const current=(await server.request(account,'GET','/ui/config')).body;
    const updated=await server.request(account,'PATCH','/ui/config',{patch:[
      {op:'replace',path:'/dashboards/0/widgets/3/source',value:{id:'tasks.series',params:{range:'7d'}}},
      {op:'replace',path:'/dashboards/0/widgets/0/options/field',value:'working'},
    ]},current.revision);
    assert.equal(updated.status,200,JSON.stringify(updated));
    await page.getByRole('button',{name:'Refresh',exact:true}).click();
    const stat=page.locator('[data-widget-type="stat"]'); await stat.scrollIntoViewIfNeeded();
    await page.waitForFunction(()=>document.querySelector('[data-widget-type="stat"] output')?.textContent==='0');
    assert.equal(await stat.locator('.dashboard-empty-data').count(),0); checks.push(`stat: meaningful zero with existing tasks at ${width}`);
    const chart=page.locator('[data-widget-type="chart"]'); await chart.scrollIntoViewIfNeeded();
    await chart.getByRole('columnheader',{name:'Done',exact:true}).waitFor({state:'attached'});
    assert.equal(await chart.locator('svg[role="img"]').count(),1); assert.match(await chart.locator('table').textContent(),/12/);
    assert.equal(await chart.locator('.dashboard-empty-data').count(),0); checks.push(`chart: completed older tasks remain visible with no new tasks at ${width}`);
    // A local usage receipt can contain computer hours without any AI requests.
    server.db.prepare('DELETE FROM usage_events WHERE user_id=?').run(account.userId);
    server.db.prepare('INSERT INTO vm_usage(day,user_id,vm_key,provider,state,seconds,cost_usd,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(new Date().toISOString().slice(0,10),account.userId,`fixture-${account.userId}`,'fixture','running',7200,0,Date.now());
    const computer=await server.request(account,'PATCH','/ui/config',{patch:[
      {op:'replace',path:'/dashboards/0/widgets/0/source',value:{id:'usage.summary',params:{range:'7d'}}},
      {op:'replace',path:'/dashboards/0/widgets/0/options/field',value:'computerHours'},
    ]},updated.body.revision);
    assert.equal(computer.status,200,JSON.stringify(computer)); await stat.scrollIntoViewIfNeeded();
    await page.waitForFunction(()=>document.querySelector('[data-widget-type="stat"] output')?.textContent==='2');
    assert.equal(await stat.locator('.dashboard-empty-data').count(),0); checks.push(`stat: computer hours remain visible without AI requests at ${width}`);
    await page.context().close();
  }
  fs.writeFileSync('.context/ui-custom/dashboard-live-widgets/results.json',JSON.stringify({passed:checks.length,failed:0,checks},null,2));
  console.log(`DASHBOARD LIVE WIDGETS: ${checks.length} passed, 0 failed (10 types, empty and seeded accounts, 2 widths)`);
} finally { await server.close(); }
