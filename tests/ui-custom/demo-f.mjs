import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dashboardAgentFixture } from './dashboard-agent-fixture.mjs';
import { observeDashboard, agentEdit } from './dashboard-chat-flow.mjs';
import { inspectAlignment, assertGrid } from './dashboard-fixture.mjs';
const server = await dashboardAgentFixture(), output = path.resolve('.context/ui-custom/demo-f'); fs.mkdirSync(output, { recursive: true });
const checks = [], screenshots = [];
const capture = async (watchers, name, widgetId) => {
  for (const { page } of watchers) {
    const width=page.viewportSize().width;
    await (widgetId ? page.locator(`[data-widget-id="${widgetId}"]`) : page.locator('.dashboard-heading')).scrollIntoViewIfNeeded();
    await assertGrid(page,width); assert.deepEqual(await page.evaluate(inspectAlignment),[]);
    const file=path.join(output,`${name}-${width}.png`); await page.screenshot({path:file,fullPage:true}); screenshots.push(file); checks.push(`${name} ${width}: saved dashboard and alignment`);
  }
};
try {
  const account=await server.account({bot:true}), chat=await server.page(account);
  await chat.goto(`${server.base}/#bot/${account.bot.id}`);
  const created=await agentEdit(server,account,chat,[],'create_dashboard',{name:'My week',template:'overview'});
  // Creating the dashboard through the mock chat records fixture usage. Clear
  // those test-only receipts to capture a genuinely empty source account.
  server.db.prepare('DELETE FROM usage_events WHERE user_id=?').run(account.userId);
  const watchers=[]; for(const width of [390,1280]) watchers.push(await observeDashboard(await server.page(account,width),created.dashboard.id));
  for(const {page} of watchers) {
    for(const widget of await page.locator('[data-widget-id]').all()) { await widget.scrollIntoViewIfNeeded(); await widget.locator('.dashboard-empty-data').waitFor(); assert.equal(await widget.locator('.dashboard-empty-data button,.dashboard-empty-data a').count(),1); }
  }
  await capture(watchers,'new-account');
  server.seed(account);
  for(const {page} of watchers) {
    await page.getByRole('button',{name:'Refresh',exact:true}).click();
    await page.getByRole('region',{name:'Working now',exact:true}).locator('output').waitFor();
    await page.locator('[data-widget-type="list"]').scrollIntoViewIfNeeded(); await page.locator('.dashboard-list li').first().waitFor();
    await page.locator('[data-widget-type="chart"]').scrollIntoViewIfNeeded(); await page.locator('.dashboard-chart svg').waitFor();
  }
  await capture(watchers,'seeded-account');
  let result=await agentEdit(server,account,chat,watchers,'add_widget',{dashboardId:created.dashboard.id,type:'note',title:'Weekly priorities',options:{text:'Review the next three tasks.'},span:6,rows:2});
  const widgetId=result.dashboard.widgets.at(-1).id;
  await capture(watchers,'widget-added',widgetId);
  result=await agentEdit(server,account,chat,watchers,'update_widget',{dashboardId:created.dashboard.id,widgetId,set:{span:12,rows:3}});
  await capture(watchers,'widget-resized',widgetId);
  result=await agentEdit(server,account,chat,watchers,'move_widget',{dashboardId:created.dashboard.id,widgetId,after:'start'});
  await capture(watchers,'widget-moved',widgetId);
  result=await agentEdit(server,account,chat,watchers,'remove_widget',{dashboardId:created.dashboard.id,widgetId});
  await capture(watchers,'widget-removed');
  fs.writeFileSync(path.join(output,'final-document.json'),JSON.stringify(result.saved.doc,null,2));
  fs.writeFileSync(path.join(output,'transcript.json'),JSON.stringify(server.transcript,null,2));
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({passed:checks.length,failed:0,checks,screenshots},null,2));
  console.log(`DEMO F: ${checks.length} passed, 0 failed. ${output}/results.json`); console.log(screenshots.join('\n'));
} finally { await server.close(); }
