import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dashboardFixture, patch, widgetTypes } from './dashboard-fixture.mjs';
const server = await dashboardFixture(); let passed = 0; const requests = [];
const saved = page => page.evaluate(async () => (await import('/src/customization/store.ts')).useCustomization.getState().saved.dashboards[0]);
try {
  const page = await server.page(), dashboard = await server.create(page); await server.open(page, dashboard.id);
  page.on('request', request => { if (request.method() === 'PATCH' && request.url().endsWith('/api/ui/config')) requests.push({ headers: request.headers(), body: request.postDataJSON() }); });
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const activate = async (action, title = 'Cost by day') => {
    const button = page.getByRole('button', { name: `${action}: ${title}`, exact: true });
    await button.focus(); await page.keyboard.press('Enter');
    if (action !== 'Settings') await page.getByRole('button', { name: 'Done', exact: true }).waitFor();
  };
  for (const [action, key, value] of [['Bigger','span',7], ['Smaller','span',6], ['Taller','rows',4], ['Shorter','rows',3]]) {
    await activate(action); await page.waitForFunction(({key,value}) => document.querySelector('[data-widget-type="chart"]').closest('[data-widget-span]').dataset[key === 'span' ? 'widgetSpan' : 'widgetRows'] === String(value), {key,value}); passed++;
  }
  await activate('Move up'); await page.waitForFunction(() => [...document.querySelectorAll('[data-widget-type]')].findIndex(node => node.dataset.widgetType === 'chart') === 3); passed++;
  await activate('Move down'); await page.waitForFunction(() => [...document.querySelectorAll('[data-widget-type]')].findIndex(node => node.dataset.widgetType === 'chart') === 4); passed++;
  await activate('Settings'); await page.getByLabel('Title', { exact: true }).fill('<invalid>'); await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('dialog [role="alert"]').waitFor(); assert.equal((await saved(page)).widgets[4].title, 'Cost by day'); passed++;
  await page.getByLabel('Title', { exact: true }).fill('Fixture chart'); await page.getByRole('button', { name: 'Save', exact: true }).focus(); await page.keyboard.press('Enter');
  await page.locator('dialog').waitFor({ state: 'detached' }); await page.getByRole('heading', { name: 'Fixture chart', exact: true }).waitFor(); passed++;
  await activate('Remove', 'Fixture chart'); await page.locator('[data-widget-type="chart"]').waitFor({ state: 'detached' }); passed++;
  for (const type of widgetTypes) {
    await page.getByRole('button', { name: 'Add widget', exact: true }).click();
    const index = widgetTypes.indexOf(type); await page.locator('.dashboard-library-item').nth(index).click();
    await page.locator('dialog').waitFor({ state: 'detached' }); assert.equal((await saved(page)).widgets.at(-1).type, type); passed++;
  }
  assert.ok(requests.length >= 18);
  for (const request of requests) {
    assert.ok(request.headers['if-match'], 'revision guard');
    const ops = request.body.patch; assert.ok(ops.some(op => op.op === 'test' && op.path === '/dashboards/0/id'));
  } passed++;
  await page.route('**/api/ui/config', async route => {
    if (route.request().method() === 'PATCH') await route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ details: [{ path: '/dashboards', code: 'invalid', message: 'Fixture validator rejection' }] }) }); else await route.continue();
  });
  await activate('Bigger', 'Needs you'); await page.getByRole('alert').filter({ hasText: 'Fixture validator rejection' }).waitFor(); passed++;
  await page.unroute('**/api/ui/config');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await patch(page, [{ op: 'replace', path: '/dashboards/0/widgets', value: [] }]);
  await page.getByText('Your dashboard is empty.', { exact: true }).waitFor(); passed++;
  const messages = []; page.on('request', request => { if (request.method() === 'POST' && /\/(message|messages|send)(?:\?|$)/.test(request.url())) messages.push(request.url()); });
  await page.getByRole('button', { name: 'Ask your agent', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('textarea')].some(node => node.value.includes('Help me customize the dashboard My week')));
  assert.equal(messages.length, 0); passed++;
  await patch(page, [{ op: 'replace', path: '/dashboards/0/widgets', value: [{ id:'$new72', type:'shortcuts', title:'Fixture shortcuts', span:6, rows:2, options:{items:[{label:'Draft a plan',target:`ask:${server.fixture.bot.id}:Fixture unsent draft`}]}}] }]);
  await page.goto(`${server.base}/#dash/${dashboard.id}`); await page.getByRole('button',{name:'Draft a plan',exact:true}).click();
  await page.waitForFunction(() => [...document.querySelectorAll('textarea')].some(node => node.value.includes('Fixture unsent draft'))); assert.equal(messages.length,0); passed++;
  // The phone uses real touch input on the same eight controls.
  const context = await server.browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  await context.route('**/*', route => ['127.0.0.1','localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  await context.addCookies([{ name: 'swarm_session', value: 'layout-test-token', url: server.base }]);
  const phone = await context.newPage(); await phone.goto(server.base);
  await phone.waitForFunction(async () => (await import('/src/customization/store.ts')).useCustomization.getState().status === 'ready');
  await phone.evaluate(async () => (await import('/src/customization/store.ts')).refreshUiConfig());
  await patch(phone, [{ op: 'replace', path: '/dashboards/0/widgets', value: [
    { id: '$new80', type: 'note', title: 'Fixture touch', span: 4, rows: 2, options: { text: 'Fixture note' } },
    { id: '$new81', type: 'note', title: 'Fixture next', span: 4, rows: 2, options: { text: 'Fixture next note' } },
  ] }]);
  await phone.goto(`${server.base}/#dash/${dashboard.id}`); await phone.getByRole('button', { name: 'Edit', exact: true }).tap();
  for (const action of ['Bigger', 'Smaller', 'Taller', 'Shorter', 'Move down', 'Move up', 'Settings', 'Remove']) {
    const button = phone.getByRole('button', { name: `${action}: Fixture touch`, exact: true }); await button.scrollIntoViewIfNeeded();
    const box = await button.boundingBox(); assert.ok(box.width >= 44 && box.height >= 44);
    const response = action === 'Settings' ? undefined : phone.waitForResponse(response => response.request().method() === 'PATCH');
    await button.tap(); if (response) assert.equal((await response).status(), 200);
    if (action === 'Settings') { await phone.getByLabel('Title', { exact: true }).fill('Fixture touch'); await phone.getByRole('button', { name: 'Save', exact: true }).tap(); await phone.locator('dialog').waitFor({ state: 'detached' }); }
    passed++;
  }
  await context.close();
  fs.mkdirSync('.context/ui-custom/dashboard-editor', { recursive: true }); fs.writeFileSync('.context/ui-custom/dashboard-editor/results.json', JSON.stringify({ passed, failed: 0, patchRequests: requests.length }, null, 2));
  console.log(`DASHBOARD EDITOR: ${passed} passed, 0 failed`);
} finally { await server.close(); }
