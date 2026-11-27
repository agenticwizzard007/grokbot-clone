import assert from 'node:assert/strict';

export async function observeDashboard(page, id) {
  const events = [], client = await page.context().newCDPSession(page);
  await client.send('Network.enable');
  client.on('Network.eventSourceMessageReceived', event => { try { events.push(JSON.parse(event.data)); } catch {} });
  await page.goto(`${new URL(page.url()).origin}/#dash/${id}`);
  await page.locator('.dashboard-grid').waitFor();
  await page.evaluate(() => { window.fixtureDashboardDocument = 'original'; });
  return { page, events };
}
export async function waitDashboard(page, dashboard, revision) {
  await page.waitForFunction(async ({ dashboard, revision }) => {
    const state = (await import('/src/customization/store.ts')).useCustomization.getState();
    const actual = [...document.querySelectorAll('[data-widget-id]')].map(node => ({ id: node.dataset.widgetId, span: Number(node.closest('[data-widget-span]').dataset.widgetSpan), rows: Number(node.closest('[data-widget-rows]').dataset.widgetRows) }));
    return state.revision === revision && JSON.stringify(actual) === JSON.stringify(dashboard.widgets.map(({ id, span, rows }) => ({ id, span, rows })));
  }, { dashboard, revision });
}
export async function agentEdit(server, account, chat, watchers, tool, args) {
  const before = (await server.request(account, 'GET', '/ui/config')).body;
  const proposed = await server.propose(account, tool, args, chat);
  assert.equal((await server.request(account, 'GET', '/ui/config')).body.revision, before.revision, 'preview waits for user approval');
  const banner = chat.getByRole('status', { name: 'Appearance preview', exact: true });
  await banner.getByRole('button', { name: 'Apply', exact: true }).click();
  const saved = await server.wait(async () => {
    const saved = (await server.request(account, 'GET', '/ui/config')).body;
    return saved.revision === before.revision + 1 ? saved : undefined;
  });
  const dashboard = saved.doc.dashboards.find(item => item.id === args.dashboardId) ?? saved.doc.dashboards.at(-1);
  for (const { page, events } of watchers) {
    await waitDashboard(page, dashboard, saved.revision);
    await server.wait(() => events.some(event => event.type === 'ui_config' && event.revision === saved.revision));
    assert.equal(await page.evaluate(() => window.fixtureDashboardDocument), 'original', 'open dashboard updated without navigation');
    await page.reload(); await waitDashboard(page, dashboard, saved.revision);
    await page.evaluate(() => { window.fixtureDashboardDocument = 'original'; });
  }
  return { ...proposed, saved, dashboard };
}
