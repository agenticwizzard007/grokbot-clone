import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dashboardFixture, patch, widgetTypes } from './dashboard-fixture.mjs';
const server = await dashboardFixture(); let passed = 0; const requests = [];
const saved = page => page.evaluate(async () => (await import('/src/customization/store.ts')).useCustomization.getState().saved.dashboards[0]);
try {
  const page = await server.page(), dashboard = await server.create(page); await server.open(page, dashboard.id);
  page.on('request', request => { if (request.method() === 'PATCH' && request.url().endsWith('/api/ui/config')) requests.push({ headers: request.headers(), body: request.postDataJSON() }); });
  await page.getByRole('button', { name: 'Edit dashboard', exact: true }).click();
  const activate = async (action, title = 'Cost by day') => {
    const button = page.getByRole('button', { name: `${action}: ${title}`, exact: true });
    await button.focus(); await page.keyboard.press('Enter');
    if (action !== 'Settings') await page.getByRole('button', { name: 'Done', exact: true }).waitFor();
  };
  for (const [size, span, rows] of [['Small',4,2], ['Large',8,4], ['Full',12,4], ['Medium',6,3]]) {
    await activate('Settings');
    const option = page.getByRole('radio', { name: size, exact: true });
    await option.focus(); await page.keyboard.press('Space');
    await page.getByRole('button', { name: 'Save', exact: true }).focus(); await page.keyboard.press('Enter');
    await page.locator('dialog').waitFor({ state: 'detached' });
    const chart = (await saved(page)).widgets.find(widget => widget.type === 'chart');
    assert.equal(chart.span, span); assert.equal(chart.rows, rows); passed++;
  }
  await activate('Move up'); await page.waitForFunction(() => [...document.querySelectorAll('[data-widget-type]')].findIndex(node => node.dataset.widgetType === 'chart') === 3); passed++;
  await activate('Move down'); await page.waitForFunction(() => [...document.querySelectorAll('[data-widget-type]')].findIndex(node => node.dataset.widgetType === 'chart') === 4); passed++;
  await activate('Settings'); await page.getByLabel('Title', { exact: true }).fill('<invalid>'); await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('dialog [role="alert"]').waitFor(); assert.equal((await saved(page)).widgets[4].title, 'Cost by day'); passed++;
  await page.getByLabel('Title', { exact: true }).fill('Weekly spending'); await page.getByRole('button', { name: 'Save', exact: true }).focus(); await page.keyboard.press('Enter');
  await page.locator('dialog').waitFor({ state: 'detached' }); await page.getByRole('heading', { name: 'Weekly spending', exact: true }).waitFor(); passed++;
  await activate('Remove', 'Weekly spending'); await page.locator('[data-widget-type="chart"]').waitFor({ state: 'detached' }); passed++;
  const catalogTypes = ['agent', ...widgetTypes];
  for (const type of catalogTypes) {
    await page.getByRole('button', { name: 'Add widget', exact: true }).click();
    const index = catalogTypes.indexOf(type); await page.locator('.dashboard-library-item').nth(index).click();
    if (type === 'agent') { await page.getByLabel('Prompt', { exact: true }).fill('Summarize my open tasks.'); await page.getByRole('dialog').getByRole('button', { name: 'Add widget', exact: true }).click(); }
    await page.locator('dialog').waitFor({ state: 'detached' }); assert.equal((await saved(page)).widgets.at(-1).type, type); passed++;
  }
  assert.ok(requests.length >= 18);
  for (const request of requests) {
    assert.ok(request.headers['if-match'], 'revision guard');
    const ops = request.body.patch; assert.ok(ops.some(op => op.op === 'test' && op.path === '/dashboards/0/id'));
  } passed++;
  await page.route('**/api/ui/config', async route => {
    if (route.request().method() === 'PATCH') await route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ details: [{ path: '/dashboards', code: 'invalid', message: 'This change could not be saved.' }] }) }); else await route.continue();
  });
  await activate('Move down', 'Needs you'); await page.getByRole('alert').filter({ hasText: 'This change could not be saved.' }).waitFor(); passed++;
  await page.unroute('**/api/ui/config');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await patch(page, [{ op: 'replace', path: '/dashboards/0/widgets', value: [] }]);
  await page.getByText('Your dashboard is empty.', { exact: true }).waitFor(); passed++;
  const messages = []; page.on('request', request => { if (request.method() === 'POST' && /\/(message|messages|send)(?:\?|$)/.test(request.url())) messages.push(request.url()); });
  await page.getByRole('button', { name: 'Create with your agent', exact: true }).click();
  await page.getByRole('dialog', { name: 'Create with your agent', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Request', { exact: true }).inputValue(), '');
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  assert.equal(messages.length, 0); passed++;
  await patch(page, [{ op: 'replace', path: '/dashboards/0/widgets', value: [{ id:'$new72', type:'shortcuts', title:'Quick links', span:6, rows:2, options:{items:[{label:'Draft a plan',target:`ask:${server.fixture.bot.id}:Help me draft the launch plan`}]}}] }]);
  await page.goto(`${server.base}/#dash/${dashboard.id}`); await page.getByRole('button',{name:'Draft a plan',exact:true}).click();
  await page.waitForFunction(() => [...document.querySelectorAll('textarea')].some(node => node.value.includes('Help me draft the launch plan'))); assert.equal(messages.length,0); passed++;
  // The phone uses real touch input for sizing and all four toolbar actions.
  const context = await server.browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  await context.route('**/*', route => ['127.0.0.1','localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  await context.addCookies([{ name: 'swarm_session', value: 'layout-test-token', url: server.base }]);
  const phone = await context.newPage(); await phone.goto(server.base);
  await phone.waitForFunction(async () => (await import('/src/customization/store.ts')).useCustomization.getState().status === 'ready');
  await phone.evaluate(async () => (await import('/src/customization/store.ts')).refreshUiConfig());
  await patch(phone, [{ op: 'replace', path: '/dashboards/0/widgets', value: [
    { id: '$new80', type: 'note', title: 'Weekly focus', span: 4, rows: 2, options: { text: 'Review the launch plan' } },
    { id: '$new81', type: 'note', title: 'Next steps', span: 4, rows: 2, options: { text: 'Review the next milestone' } },
  ] }]);
  await patch(phone, [{ op: 'add', path: '/dashboards/0/description', value: 'Launch planning and daily progress.' }]);
  await phone.goto(`${server.base}/#dash/${dashboard.id}`);
  await phone.getByText('Launch planning and daily progress.', { exact: true }).waitFor();
  for (const width of [320, 390, 500, 1280]) {
    await phone.setViewportSize({ width, height: 844 });
    assert.ok(await phone.getByText('Launch planning and daily progress.', { exact: true }).isVisible(), 'Hiding the duplicate title preserves the user description');
    assert.equal(await phone.locator('.shell-header__title:visible, .dashboard-switcher h1:visible').count(), 1);
    passed++;
  }
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.getByRole('button', { name: 'Edit dashboard', exact: true }).tap();
  for (const size of ['Small', 'Medium', 'Large', 'Full']) {
    await phone.getByRole('button', { name: 'Settings: Weekly focus', exact: true }).tap();
    await phone.getByRole('radio', { name: size, exact: true }).tap();
    await phone.getByRole('button', { name: 'Save', exact: true }).tap();
    await phone.locator('dialog').waitFor({ state: 'detached' }); passed++;
  }
  for (const action of ['Move down', 'Move up', 'Settings', 'Remove']) {
    const button = phone.getByRole('button', { name: `${action}: Weekly focus`, exact: true }); await button.scrollIntoViewIfNeeded();
    const box = await button.boundingBox(); assert.ok(box.width >= 44 && box.height >= 44);
    const response = action === 'Settings' ? undefined : phone.waitForResponse(response => response.request().method() === 'PATCH');
    await button.tap(); if (response) assert.equal((await response).status(), 200);
    if (action === 'Settings') { await phone.getByLabel('Title', { exact: true }).fill('Weekly focus'); await phone.getByRole('button', { name: 'Save', exact: true }).tap(); await phone.locator('dialog').waitFor({ state: 'detached' }); }
    passed++;
  }
  await context.close();
  fs.mkdirSync('.context/ui-custom/dashboard-editor', { recursive: true }); fs.writeFileSync('.context/ui-custom/dashboard-editor/results.json', JSON.stringify({ passed, failed: 0, patchRequests: requests.length }, null, 2));
  console.log(`DASHBOARD EDITOR: ${passed} passed, 0 failed`);
} finally { await server.close(); }
