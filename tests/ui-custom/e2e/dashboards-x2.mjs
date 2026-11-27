import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { agenticFixture } from './agentic-fixture.mjs';
import { inspectAlignment } from '../../layout-alignment-ui.mjs';
import { readableWords } from '../../paper-label-geometry.mjs';
export const output = path.resolve(process.env.X2_OUTPUT || '.context/ui-custom/demo-x');
export const salesDashboard = { id: '$new1', name: 'Sales pipeline', icon: 'briefcase', widgets: [
  { id: '$new2', type: 'agent', title: 'Next steps', span: 6, rows: 3, options: { prompt: 'Show my open tasks and next steps.', display: 'list', schedule: 'manual' } },
  { id: '$new3', type: 'list', title: 'Open handoffs', span: 6, rows: 3, source: { id: 'handoffs.list', params: {} }, options: { limit: 5 } },
  { id: '$new4', type: 'list', title: 'Deals to review', span: 6, rows: 3, source: { id: 'crm.deals', params: {} }, options: { limit: 5 } },
] };
export const operationsDashboard = { id: '$new1', name: 'Operations', icon: 'activity', widgets: [
  { id: '$new2', type: 'stat', title: 'Working now', span: 4, rows: 1, source: { id: 'tasks.counts', params: {} }, options: { field: 'working' } },
  { id: '$new3', type: 'agent', title: 'Daily summary', span: 8, rows: 3, options: { prompt: 'List my open tasks for today.', display: 'list', schedule: 'manual' } },
  { id: '$new4', type: 'list', title: 'Recent outputs', span: 6, rows: 3, source: { id: 'outputs.recent', params: {} }, options: { limit: 5 } },
  { id: '$new5', type: 'list', title: 'Active loops', span: 6, rows: 3, source: { id: 'loops.list', params: {} }, options: { limit: 5 } },
] };
export async function assertCopy(page, name) { const visible = await page.locator('body').innerText(); assert.doesNotMatch(visible, /mock|Fixture|PRIVATE|QA-|undefined|null|\[object|[\u2013\u2014]/i, name); }
export async function quality(page, name) {
  const selector = await page.locator('dialog[open]').count() ? 'dialog[open]' : '.dashboard-page';
  assert.deepEqual(await page.evaluate(inspectAlignment, { selector }), [], name);
  await assertCopy(page, name);
  for (const group of await page.locator('.dashboard-agent-fieldset:visible').all()) await readableWords(group);
  const sizes = await page.locator(selector).evaluate(root => [...root.querySelectorAll('p, label, button, span, strong')].filter(el => el.checkVisibility() && el.textContent.trim() && !el.closest('svg')).filter(el => parseFloat(getComputedStyle(el).fontSize) < 13).map(el => el.textContent));
  assert.deepEqual(sizes, [], `Readable type: ${name}`);
}
export async function screenshot(page, name) { await page.waitForFunction(() => [...document.querySelectorAll('.dashboard-skeleton')].every(el => { const box = el.getBoundingClientRect(); return !el.checkVisibility() || box.top >= innerHeight || box.bottom <= 0; })); await page.evaluate(() => document.fonts.ready); await quality(page, name); const file = path.join(output, `${name}.png`); await page.screenshot({ path: file, animations: 'disabled' }); return file; }
export async function runDashboards({ demo = false } = {}) {
  fs.mkdirSync(output, { recursive: true });
  const server = await agenticFixture(), results = [], screenshots = [];
  const pass = text => { results.push(text); console.log(`PASS ${text}`); };
  try {
    const account = await server.account({ bot: true }); server.seed(account);
    const page = await server.page(account, 390), errors = [];
    page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(`${message.text()} ${message.location().url}`); });
    await page.goto(`${server.base}/#dashboards`); await page.getByRole('button', { name: 'Create', exact: true }).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Dashboards', exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: 'Back', exact: true }).count(), 1);
    await page.getByRole('button', { name: 'Create', exact: true }).click(); await page.getByLabel('Name', { exact: true }).fill('Launch'); await page.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click();
    await page.getByRole('button', { name: 'Switch dashboard: Launch' }).waitFor(); pass('create UI opens dashboard');
    await page.goto(`${server.base}/#dashboards`); await page.getByRole('button', { name: 'Manage Launch' }).click(); await page.getByRole('menuitem', { name: 'Duplicate', exact: true }).click();
    await page.getByLabel('Name', { exact: true }).fill('Launch copy'); await page.getByRole('dialog').getByRole('button', { name: 'Duplicate', exact: true }).click(); await page.getByRole('button', { name: 'Switch dashboard: Launch copy' }).waitFor(); pass('duplicate UI creates independent dashboard');
    await page.goto(`${server.base}/#dashboards`); await page.getByRole('button', { name: 'Manage Launch copy' }).click(); await page.getByRole('menuitem', { name: 'Rename', exact: true }).click(); await page.getByLabel('Name', { exact: true }).fill('Project launch'); await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByRole('button', { name: 'Manage Project launch' }).waitFor(); pass('rename UI persists');
    const updateBanner = page.getByRole('status', { name: 'Dashboard updated', exact: true });
    await updateBanner.waitFor(); assert.equal(await page.getByRole('status', { name: 'Appearance updated', exact: true }).count(), 0);
    await page.locator('.dashboard-open').filter({ hasText: 'Project launch' }).click(); await page.getByRole('button', { name: 'Switch dashboard: Project launch' }).waitFor();
    await updateBanner.waitFor({ state: 'hidden' }); pass('dashboard update notice uses dashboard copy and dismisses on navigation');
    await page.goto(`${server.base}/#dashboards`);
    await page.getByRole('button', { name: 'Manage Project launch' }).click(); await page.getByRole('menuitem', { name: 'Delete', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click(); assert.equal(await page.getByRole('button', { name: 'Manage Project launch' }).count(), 1);
    await page.getByRole('button', { name: 'Manage Project launch' }).click(); await page.getByRole('menuitem', { name: 'Delete', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click(); await page.getByRole('button', { name: 'Manage Project launch' }).waitFor({ state: 'hidden' }); pass('delete UI requires confirmation');
    await updateBanner.waitFor(); await updateBanner.waitFor({ state: 'hidden', timeout: 9000 }); pass('update notice expires after eight seconds without navigation');
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      const dashboard = structuredClone(width === 390 ? salesDashboard : operationsDashboard);
      await page.goto(`${server.base}/#bot/${account.bot.id}`); await page.locator('.composer__input:not([disabled])').waitFor();
      await server.propose(account, 'preview_ui_patch', { intent: `Create dashboard ${dashboard.name}`, patch: [{ op: 'add', path: '/dashboards/-', value: dashboard }] }, page, width === 390 ? 'Make a Sales pipeline dashboard with next steps, open handoffs and deals to review.' : 'Create an Operations dashboard with a daily summary, tasks, outputs and loops.');
      const card = page.getByRole('region', { name: `Create dashboard: ${dashboard.name}`, exact: true }); await card.waitFor(); await assertCopy(page, 'chat preview');
      await card.scrollIntoViewIfNeeded();
      const previewBanner = page.getByRole('status', { name: 'Appearance preview', exact: true });
      await previewBanner.waitFor({ state: 'hidden' });
      assert.equal(await page.getByRole('button', { name: 'Apply', exact: true }).count(), 1);
      if (width === 390) {
        await page.goto(`${server.base}/#dashboards`); await previewBanner.waitFor();
        await page.goto(`${server.base}/#bot/${account.bot.id}`); await card.scrollIntoViewIfNeeded(); await previewBanner.waitFor({ state: 'hidden' });
        pass('visible chat preview owns the controls and banner returns away from chat');
      }
      if (demo) { await page.evaluate(() => document.fonts.ready); const file = path.join(output, `chat-before-apply-${width}-light.png`); await assertCopy(page, 'chat screenshot'); await page.screenshot({ path: file }); screenshots.push(file); }
      await card.getByRole('button', { name: 'Apply', exact: true }).click(); await page.getByRole('button', { name: `Switch dashboard: ${dashboard.name}` }).waitFor();
      await updateBanner.waitFor({ state: 'hidden' });
      if (demo) screenshots.push(await screenshot(page, `chat-after-apply-${width}-light`));
      pass(`chat preview and apply opens dashboard ${width}`);
      await page.goto(`${server.base}/#bot/${account.bot.id}`); await card.scrollIntoViewIfNeeded();
      assert.ok(await card.getByRole('button', { name: 'Undo', exact: true }).isEnabled());
      pass(`chat card retains Undo after navigation ${width}`);
    }
    const doc = (await server.request(account, 'GET', '/ui/config')).body.doc;
    const sales = doc.dashboards.find(d => d.name === 'Sales pipeline'), operations = doc.dashboards.find(d => d.name === 'Operations');
    await page.goto(`${server.base}/#dash/${sales.id}`);
    await page.getByRole('button', { name: 'Switch dashboard: Sales pipeline' }).click(); await page.getByRole('menuitemradio', { name: 'Operations', exact: true }).click(); await page.getByRole('button', { name: 'Switch dashboard: Operations' }).waitFor(); pass('desktop switcher changes dashboard');
    const approvalId = server.seedApproval(account);
    server.answers.set(sales.widgets[0].options.prompt, { source: 'tasks_list', actions: true, botId: account.bot.id, approvalId });
    server.answers.set(operations.widgets[1].options.prompt, { source: 'tasks_list' });
    await page.goto(`${server.base}/#dash/${sales.id}`);
    const agentCard = page.getByRole('region', { name: 'Next steps', exact: true });
    await agentCard.getByRole('button', { name: 'Run', exact: true }).click();
    await agentCard.getByText('Working', { exact: true }).waitFor();
    await agentCard.getByRole('button', { name: /^Open:/ }).waitFor();
    assert.match(await agentCard.innerText(), /Updated just now/); pass('agent run reads live seeded tasks and shows running and update states');
    // The next answer must reflect a changed database row, not literal provider text.
    server.db.prepare('UPDATE tasks SET title=?,updated_at=? WHERE id=(SELECT id FROM tasks WHERE bot_id=? ORDER BY updated_at DESC,id LIMIT 1)').run('Draft the partner email', Date.now(), account.bot.id);
    await agentCard.getByRole('button', { name: 'Refresh Next steps', exact: true }).click();
    await agentCard.getByText('Draft the partner email', { exact: true }).waitFor(); pass('refresh answers with changed live data');
    await page.reload(); await agentCard.getByText('Draft the partner email', { exact: true }).waitFor(); pass('agent result persists across reload');
    if (demo) for (const width of [390, 1280]) { await page.setViewportSize({ width, height: width === 390 ? 844 : 900 }); screenshots.push(await screenshot(page, `agent-answer-${width}-light`)); }
    await agentCard.getByRole('button', { name: /^Open:/ }).click(); await page.locator('.tasks-view').waitFor(); pass('inline Open navigates after server validation');
    await page.goto(`${server.base}/#dash/${sales.id}`); let actionSends = 0;
    const countSend = request => { if (request.method() === 'POST' && /\/messages$/.test(new URL(request.url()).pathname)) actionSends++; };
    page.on('request', countSend); await agentCard.getByRole('button', { name: /^Send to agent:/ }).click(); await page.locator('.composer__input').waitFor();
    await page.waitForFunction(() => document.querySelector('.composer__input')?.value.startsWith('Draft next steps for ')); assert.match(await page.locator('.composer__input').inputValue(), /^Draft next steps for /); assert.equal(actionSends, 0); page.off('request', countSend); pass('inline Send prefills chat without sending');
    if (demo) for (const width of [390, 1280]) { await page.setViewportSize({ width, height: width === 390 ? 844 : 900 }); const file = path.join(output, `send-prefill-${width}-light.png`); await assertCopy(page, 'chat screenshot'); await page.screenshot({ path: file }); screenshots.push(file); }
    await page.goto(`${server.base}/#dash/${sales.id}`); await agentCard.getByRole('button', { name: /^Approve:/ }).click();
    const approval = page.getByRole('dialog', { name: 'Approve item', exact: true });
    assert.equal(server.db.prepare('SELECT status FROM approvals WHERE id=?').get(approvalId.slice(9)).status, 'pending');
    if (demo) for (const width of [390, 1280]) { await page.setViewportSize({ width, height: width === 390 ? 844 : 900 }); screenshots.push(await screenshot(page, `approve-confirm-${width}-light`)); }
    await approval.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(server.db.prepare('SELECT status FROM approvals WHERE id=?').get(approvalId.slice(9)).status, 'pending');
    await agentCard.getByRole('button', { name: /^Approve:/ }).click(); await approval.getByRole('button', { name: 'Approve', exact: true }).click(); await approval.waitFor({ state: 'hidden' });
    assert.equal(server.db.prepare('SELECT status FROM approvals WHERE id=?').get(approvalId.slice(9)).status, 'allowed'); pass('inline Approve cancels safely and confirms server approval');
    server.seedOutputTitles(account);
    server.answers.set(sales.widgets[0].options.prompt, { source: 'tasks_list' });
    server.db.prepare('UPDATE tasks SET title=?,updated_at=? WHERE id=(SELECT id FROM tasks WHERE bot_id=? ORDER BY updated_at DESC,id LIMIT 1)').run('Plan the customer call', Date.now(), account.bot.id);
    const externalRun = await server.request(account, 'POST', `/ui/widgets/${sales.id}/${sales.widgets[0].id}/run`, {}); assert.equal(externalRun.status, 202);
    await agentCard.getByText('Plan the customer call', { exact: true }).waitFor({ timeout: 4000 }); pass('SSE refreshes a result started outside this page');
    await page.goto(`${server.base}/#dash/${operations.id}`);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    const outputRows = page.getByRole('region', { name: 'Recent outputs', exact: true }).locator('.dashboard-output-row');
    await outputRows.first().waitFor();
    assert.doesNotMatch(await outputRows.allTextContents().then(rows => rows.join('\n')), /Review this dashboard change|^Output$/m);
    assert.ok(new Set(await outputRows.locator('strong').allTextContents()).size > 1, 'Demo outputs have distinct realistic titles');
    assert.deepEqual(await outputRows.evaluateAll(rows => rows.map(row => ({ decoration: getComputedStyle(row).textDecorationLine, size: getComputedStyle(row.querySelector('strong')).fontSize, weight: getComputedStyle(row.querySelector('strong')).fontWeight }))), Array.from({ length: await outputRows.count() }, () => ({ decoration: 'none', size: '14px', weight: '600' })));
    const outputRoute = await outputRows.first().getAttribute('href'); await outputRows.first().click();
    await page.waitForURL(url => url.hash === outputRoute); pass('output rows use plain readable titles and open on tap');
    await page.goto(`${server.base}/#dash/${operations.id}`);
    const summaryCard = page.getByRole('region', { name: 'Daily summary', exact: true });
    await summaryCard.getByRole('button', { name: 'Run', exact: true }).click(); await summaryCard.locator('.dashboard-agent-list').waitFor(); assert.match(await summaryCard.innerText(), /Plan the customer call/); pass('list display renders a readable live summary');
    server.answers.set(operations.widgets[1].options.prompt, { source: 'not_a_tool' });
    await summaryCard.getByRole('button', { name: 'Refresh Daily summary', exact: true }).click(); await summaryCard.getByRole('button', { name: 'Try again', exact: true }).waitFor();
    server.answers.set(operations.widgets[1].options.prompt, { source: 'tasks_list' });
    await summaryCard.getByRole('button', { name: 'Try again', exact: true }).click(); await summaryCard.locator('.dashboard-agent-list').waitFor(); pass('failed runs have a working Try again action');
    // A different user's document and widget results remain independent.
    const other = await server.account({ bot: true }); server.seed(other);
    const otherPage = await server.page(other, 390);
    await otherPage.goto(`${server.base}/#bot/${other.bot.id}`);
    await server.propose(other, 'preview_ui_patch', { intent: 'Create Operations dashboard', patch: [{ op: 'add', path: '/dashboards/-', value: operationsDashboard }] }, otherPage, 'Create my Operations dashboard with tasks and a daily summary.');
    await otherPage.getByRole('region', { name: 'Create dashboard: Operations', exact: true }).getByRole('button', { name: 'Apply', exact: true }).click(); await otherPage.getByRole('button', { name: 'Switch dashboard: Operations' }).waitFor();
    const otherDoc = (await server.request(other, 'GET', '/ui/config')).body.doc; assert.equal(otherDoc.dashboards.length, 1); assert.notEqual(otherDoc.dashboards[0].id, sales.id);
    assert.equal((await server.request(other, 'GET', `/ui/widgets/${sales.id}/${sales.widgets[0].id}/result`)).status, 404);
    pass('two users build distinct dashboards with isolated results');
    const applyChatChange = async (tool, args, text) => { await otherPage.goto(`${server.base}/#bot/${other.bot.id}`); await server.propose(other, tool, args, otherPage, text); await otherPage.locator('.ui-preview-card').last().getByRole('button', { name: 'Apply', exact: true }).click(); };
    await applyChatChange('duplicate_dashboard', { dashboardId: otherDoc.dashboards[0].id, name: 'Weekly operations' }, 'Duplicate Operations as Weekly operations.');
    await otherPage.getByRole('button', { name: 'Switch dashboard: Weekly operations' }).waitFor();
    const copy = (await server.request(other, 'GET', '/ui/config')).body.doc.dashboards.find(d => d.name === 'Weekly operations');
    await applyChatChange('rename_dashboard', { dashboardId: copy.id, name: 'Team operations' }, 'Rename Weekly operations to Team operations.');
    await server.wait(async () => (await server.request(other, 'GET', '/ui/config')).body.doc.dashboards.some(d => d.name === 'Team operations'));
    await applyChatChange('delete_dashboard', { dashboardId: copy.id }, 'Delete Team operations.');
    await server.wait(async () => (await server.request(other, 'GET', '/ui/config')).body.doc.dashboards.length === 1);
    pass('chat duplicate, rename and delete apply through preview cards');
    const limited = (await server.request(other, 'GET', '/ui/config')).body;
    const names = ['Planning', 'Launch', 'Support', 'Product', 'Research', 'Weekly review', 'Customer success', 'Recruiting', 'Finance', 'Team projects', 'Daily focus'];
    const filled = await server.request(other, 'PATCH', '/ui/config', { patch: names.map((name, index) => ({ op: 'add', path: '/dashboards/-', value: { id: `$new${index + 100}`, name, icon: 'layout-dashboard', widgets: [] } })) }, limited.revision); assert.equal(filled.status, 200);
    await otherPage.goto(`${server.base}/#dashboards`); await otherPage.getByText('You have reached the limit of 12 dashboards.', { exact: true }).waitFor(); assert.ok(await otherPage.getByRole('button', { name: 'Create', exact: true }).isDisabled()); await assertCopy(otherPage, 'dashboard limit'); pass('dashboard limit shows one line and disables Create'); await otherPage.close();
    // Ask opens a draft, never a send request.
    await page.goto(`${server.base}/#dashboards`); let sends = 0;
    page.on('request', request => { if (request.method() === 'POST' && /\/messages$/.test(new URL(request.url()).pathname)) sends++; });
    await page.getByRole('button', { name: 'Ask your agent', exact: true }).click(); await page.locator('.composer__input').waitFor(); assert.match(await page.locator('.composer__input').inputValue(), /create a dashboard/); assert.equal(sends, 0); pass('ask your agent prefills without sending');
    await page.goto(`${server.base}/#settings`); await page.locator('nav[aria-label="Settings sections"]').getByRole('button', { name: 'Dashboards', exact: true }).click(); await page.locator('.dashboards-manager').waitFor(); pass('Settings entry opens manager');
    await page.goto(`${server.base}/#search`); await page.getByRole('textbox', { name: 'Search', exact: true }).fill('Dashboards'); await page.keyboard.press('Enter'); await page.locator('.dashboards-manager').waitFor(); pass('command palette keyboard path opens manager');
    await page.goto(`${server.base}/#dash/${sales.id}`); await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByRole('button', { name: 'Bigger: Next steps', exact: true }).focus(); await page.keyboard.press('Enter');
    await server.wait(async () => (await server.request(account, 'GET', '/ui/config')).body.doc.dashboards.find(d => d.id === sales.id).widgets[0].span === 7); pass('keyboard resize persists');
    await page.getByRole('button', { name: 'Move down: Next steps', exact: true }).click(); await server.wait(async () => (await server.request(account, 'GET', '/ui/config')).body.doc.dashboards.find(d => d.id === sales.id).widgets[1].id === sales.widgets[0].id); pass('keyboard and touch reorder persists');
    await page.getByRole('button', { name: 'Move up: Next steps', exact: true }).click();
    await server.wait(async () => (await server.request(account, 'GET', '/ui/config')).body.doc.dashboards.find(d => d.id === sales.id).widgets[0].id === sales.widgets[0].id);
    await page.getByRole('button', { name: 'Smaller: Next steps', exact: true }).click();
    await server.wait(async () => (await server.request(account, 'GET', '/ui/config')).body.doc.dashboards.find(d => d.id === sales.id).widgets[0].span === 6);
    await page.getByRole('button', { name: 'Drag to reorder: Next steps', exact: true }).dragTo(page.locator(`[data-widget-id="${sales.widgets[1].id}"]`));
    await server.wait(async () => (await server.request(account, 'GET', '/ui/config')).body.doc.dashboards.find(d => d.id === sales.id).widgets[1].id === sales.widgets[0].id); pass('desktop drag reorder persists');
    await page.getByRole('button', { name: 'Move up: Next steps', exact: true }).click();
    await page.getByRole('button', { name: 'Settings: Next steps', exact: true }).click(); assert.equal(await page.getByLabel('Prompt', { exact: true }).inputValue(), sales.widgets[0].options.prompt); await quality(page, 'agent settings'); await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Add widget', exact: true }).click(); await page.getByRole('button', { name: /Ask your agent Answers/ }).click(); await page.getByLabel('Prompt', { exact: true }).fill('Summarize my tasks.'); await page.getByRole('button', { name: 'Number', exact: true }).click(); await page.getByRole('button', { name: 'Hourly', exact: true }).click(); await quality(page, 'add agent'); await page.getByRole('dialog').getByRole('button', { name: 'Add widget', exact: true }).click(); await page.getByRole('dialog').waitFor({ state: 'hidden' }); pass('agent option form saves display and schedule');
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    server.answers.set('Summarize my tasks.', { source: 'tasks_counts' });
    const numberCard = page.getByRole('region', { name: 'Daily summary', exact: true });
    await numberCard.getByRole('button', { name: 'Run', exact: true }).click(); await numberCard.locator('output').waitFor(); assert.equal(await numberCard.locator('output').innerText(), '12'); assert.doesNotMatch(await numberCard.innerText(), /Hourly/); pass('Number display renders live counts with schedule confined to settings');
    if (demo) for (const [width, theme] of [[320, 'light'], [390, 'light'], [500, 'light'], [1280, 'light'], [390, 'dark'], [1280, 'dark']]) {
      await page.setViewportSize({ width, height: width <= 760 ? 844 : 900 }); await page.emulateMedia({ colorScheme: theme });
      await page.evaluate(theme => { localStorage.setItem('swarm.theme', theme); }, theme);
      await page.goto(`${server.base}/#dashboards`); await page.locator('.dashboards-manager').waitFor(); screenshots.push(await screenshot(page, `manager-${width}-${theme}`));
      for (const dashboard of [sales, operations]) { await page.goto(`${server.base}/#dash/${dashboard.id}`); await page.getByRole('button', { name: `Switch dashboard: ${dashboard.name}` }).waitFor(); screenshots.push(await screenshot(page, `${dashboard.name === 'Sales pipeline' ? 'sales' : 'operations'}-${width}-${theme}`)); }
      await page.getByRole('button', { name: 'Switch dashboard: Operations' }).click(); await page.getByRole(width > 760 ? 'menu' : 'dialog', { name: width > 760 ? 'Dashboards' : 'Switch dashboard', exact: true }).waitFor(); screenshots.push(await screenshot(page, `switcher-${width}-${theme}`)); await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Edit', exact: true }).click(); screenshots.push(await screenshot(page, `edit-${width}-${theme}`));
      await page.getByRole('button', { name: 'Settings: Daily summary', exact: true }).click(); screenshots.push(await screenshot(page, `settings-${width}-${theme}`)); await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.getByRole('button', { name: 'Add widget', exact: true }).click(); screenshots.push(await screenshot(page, `add-${width}-${theme}`)); await page.getByRole('button', { name: /Ask your agent Answers/ }).click(); screenshots.push(await screenshot(page, `add-agent-${width}-${theme}`)); await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    }
    assert.deepEqual(errors, []); pass('no console errors');
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: results.length, results, screenshots, consoleErrors: errors }, null, 2));
    console.log(`${results.length}/${results.length} dashboard client checks passed`);
  } finally { await server.close(); }
}
if (process.argv[1]?.endsWith('/dashboards-x2.mjs')) await runDashboards();
