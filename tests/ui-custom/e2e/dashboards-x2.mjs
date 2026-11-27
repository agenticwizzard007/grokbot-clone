import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { agenticFixture } from './agentic-fixture.mjs';
import { inspectAlignment } from '../../layout-alignment-ui.mjs';
export const output = path.resolve(process.env.X2_OUTPUT || '.context/ui-custom/demo-x');
export const salesDashboard = { id: '$new1', name: 'Sales pipeline', icon: 'briefcase', widgets: [
  { id: '$new2', type: 'agent', title: 'Next steps', span: 6, rows: 3, options: { prompt: 'Show my open tasks and next steps.', display: 'list', schedule: 'manual' } },
  { id: '$new3', type: 'list', title: 'Open handoffs', span: 6, rows: 3, source: { id: 'handoffs.list', params: {} }, options: { limit: 5 } },
  { id: '$new4', type: 'list', title: 'Deals to review', span: 6, rows: 3, source: { id: 'crm.deals', params: {} }, options: { limit: 5 } },
] };
export const operationsDashboard = { id: '$new1', name: 'Operations', icon: 'activity', widgets: [
  { id: '$new2', type: 'stat', title: 'Working now', span: 4, rows: 1, source: { id: 'tasks.counts', params: {} }, options: { field: 'working' } },
  { id: '$new3', type: 'agent', title: 'Daily summary', span: 8, rows: 3, options: { prompt: 'Summarize my open tasks.', display: 'text', schedule: 'manual' } },
  { id: '$new4', type: 'list', title: 'Recent outputs', span: 6, rows: 3, source: { id: 'outputs.recent', params: {} }, options: { limit: 5 } },
  { id: '$new5', type: 'list', title: 'Active loops', span: 6, rows: 3, source: { id: 'loops.list', params: {} }, options: { limit: 5 } },
] };
export async function quality(page, name) {
  const selector = await page.locator('dialog[open]').count() ? 'dialog[open]' : '.dashboard-page';
  assert.deepEqual(await page.evaluate(inspectAlignment, { selector }), [], name);
  const visible = await page.locator('body').innerText();
  assert.doesNotMatch(visible, /mock|Fixture|PRIVATE|QA-|undefined|null|\[object|[\u2013\u2014]/i, name);
  const sizes = await page.locator(selector).evaluate(root => [...root.querySelectorAll('p, label, button, span, strong')].filter(el => el.checkVisibility() && el.textContent.trim() && !el.closest('svg')).filter(el => parseFloat(getComputedStyle(el).fontSize) < 13).map(el => el.textContent));
  assert.deepEqual(sizes, [], `Readable type: ${name}`);
}
export async function screenshot(page, name) { await page.evaluate(() => document.fonts.ready); await quality(page, name); const file = path.join(output, `${name}.png`); await page.screenshot({ path: file }); return file; }
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
    await page.getByRole('button', { name: 'Manage Project launch' }).click(); await page.getByRole('menuitem', { name: 'Delete', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click(); assert.equal(await page.getByRole('button', { name: 'Manage Project launch' }).count(), 1);
    await page.getByRole('button', { name: 'Manage Project launch' }).click(); await page.getByRole('menuitem', { name: 'Delete', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click(); await page.getByRole('button', { name: 'Manage Project launch' }).waitFor({ state: 'hidden' }); pass('delete UI requires confirmation');
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      const dashboard = structuredClone(width === 390 ? salesDashboard : operationsDashboard);
      await page.goto(`${server.base}/#bot/${account.bot.id}`); await page.locator('.composer__input:not([disabled])').waitFor();
      await server.propose(account, 'preview_ui_patch', { intent: `Create dashboard ${dashboard.name}`, patch: [{ op: 'add', path: '/dashboards/-', value: dashboard }] }, page, width === 390 ? 'Make a Sales pipeline dashboard with next steps, open handoffs and deals to review.' : 'Create an Operations dashboard with a daily summary, tasks, outputs and loops.');
      const card = page.getByRole('region', { name: `Create dashboard: ${dashboard.name}`, exact: true }); await card.waitFor();
      if (demo) { await page.evaluate(() => document.fonts.ready); const file = path.join(output, `chat-before-apply-${width}-light.png`); await page.screenshot({ path: file }); screenshots.push(file); }
      await card.getByRole('button', { name: 'Apply', exact: true }).click(); await page.getByRole('button', { name: `Switch dashboard: ${dashboard.name}` }).waitFor();
      if (demo) screenshots.push(await screenshot(page, `chat-after-apply-${width}-light`));
      pass(`chat preview and apply opens dashboard ${width}`);
    }
    const doc = (await server.request(account, 'GET', '/ui/config')).body.doc;
    const sales = doc.dashboards.find(d => d.name === 'Sales pipeline'), operations = doc.dashboards.find(d => d.name === 'Operations');
    await page.goto(`${server.base}/#dash/${sales.id}`);
    await page.getByRole('button', { name: 'Switch dashboard: Sales pipeline' }).click(); await page.getByRole('menuitem', { name: 'Operations', exact: true }).click(); await page.getByRole('button', { name: 'Switch dashboard: Operations' }).waitFor(); pass('desktop switcher changes dashboard');
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
    if (demo) for (const width of [390, 1280]) { await page.setViewportSize({ width, height: width === 390 ? 844 : 900 }); const file = path.join(output, `send-prefill-${width}-light.png`); await page.screenshot({ path: file }); screenshots.push(file); }
    await page.goto(`${server.base}/#dash/${sales.id}`); await agentCard.getByRole('button', { name: /^Approve:/ }).click();
    const approval = page.getByRole('dialog', { name: 'Approve item', exact: true });
    assert.equal(server.db.prepare('SELECT status FROM approvals WHERE id=?').get(approvalId.slice(9)).status, 'pending');
    if (demo) for (const width of [390, 1280]) { await page.setViewportSize({ width, height: width === 390 ? 844 : 900 }); screenshots.push(await screenshot(page, `approve-confirm-${width}-light`)); }
    await approval.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(server.db.prepare('SELECT status FROM approvals WHERE id=?').get(approvalId.slice(9)).status, 'pending');
    await agentCard.getByRole('button', { name: /^Approve:/ }).click(); await approval.getByRole('button', { name: 'Approve', exact: true }).click(); await approval.waitFor({ state: 'hidden' });
    assert.equal(server.db.prepare('SELECT status FROM approvals WHERE id=?').get(approvalId.slice(9)).status, 'allowed'); pass('inline Approve cancels safely and confirms server approval');
    // A different user's document and widget results remain independent.
    const other = await server.account({ bot: true }); server.seed(other);
    const otherPage = await server.page(other, 390);
    await otherPage.goto(`${server.base}/#bot/${other.bot.id}`);
    await server.propose(other, 'preview_ui_patch', { intent: 'Create Operations dashboard', patch: [{ op: 'add', path: '/dashboards/-', value: operationsDashboard }] }, otherPage, 'Create my Operations dashboard with tasks and a daily summary.');
    await otherPage.getByRole('region', { name: 'Create dashboard: Operations', exact: true }).getByRole('button', { name: 'Apply', exact: true }).click(); await otherPage.getByRole('button', { name: 'Switch dashboard: Operations' }).waitFor();
    const otherDoc = (await server.request(other, 'GET', '/ui/config')).body.doc; assert.equal(otherDoc.dashboards.length, 1); assert.notEqual(otherDoc.dashboards[0].id, sales.id);
    assert.equal((await server.request(other, 'GET', `/ui/widgets/${sales.id}/${sales.widgets[0].id}/result`)).status, 404);
    pass('two users build distinct dashboards with isolated results'); await otherPage.close();
    // Ask opens a draft, never a send request.
    await page.goto(`${server.base}/#dashboards`); let sends = 0;
    page.on('request', request => { if (request.method() === 'POST' && /\/messages$/.test(new URL(request.url()).pathname)) sends++; });
    await page.getByRole('button', { name: 'Ask your agent', exact: true }).click(); await page.locator('.composer__input').waitFor(); assert.match(await page.locator('.composer__input').inputValue(), /create a dashboard/); assert.equal(sends, 0); pass('ask your agent prefills without sending');
    await page.goto(`${server.base}/#dash/${sales.id}`); await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByRole('button', { name: 'Bigger: Next steps', exact: true }).focus(); await page.keyboard.press('Enter');
    await server.wait(async () => (await server.request(account, 'GET', '/ui/config')).body.doc.dashboards.find(d => d.id === sales.id).widgets[0].span === 7); pass('keyboard resize persists');
    await page.getByRole('button', { name: 'Move down: Next steps', exact: true }).click(); await server.wait(async () => (await server.request(account, 'GET', '/ui/config')).body.doc.dashboards.find(d => d.id === sales.id).widgets[1].id === sales.widgets[0].id); pass('keyboard and touch reorder persists');
    await page.getByRole('button', { name: 'Move up: Next steps', exact: true }).click();
    await page.getByRole('button', { name: 'Settings: Next steps', exact: true }).click(); assert.equal(await page.getByLabel('Prompt', { exact: true }).inputValue(), sales.widgets[0].options.prompt); await quality(page, 'agent settings'); await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Add widget', exact: true }).click(); await page.getByRole('button', { name: /Ask your agent Answers/ }).click(); await page.getByLabel('Prompt', { exact: true }).fill('Summarize my tasks.'); await page.getByRole('button', { name: 'Number', exact: true }).click(); await page.getByRole('button', { name: 'Hourly', exact: true }).click(); await quality(page, 'add agent'); await page.getByRole('dialog').getByRole('button', { name: 'Add widget', exact: true }).click(); await page.getByRole('dialog').waitFor({ state: 'hidden' }); pass('agent option form saves display and schedule');
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    if (demo) for (const [width, theme] of [[320, 'light'], [390, 'light'], [500, 'light'], [1280, 'light'], [390, 'dark'], [1280, 'dark']]) {
      await page.setViewportSize({ width, height: width <= 760 ? 844 : 900 }); await page.emulateMedia({ colorScheme: theme });
      await page.evaluate(theme => { localStorage.setItem('swarm.theme', theme); }, theme);
      await page.goto(`${server.base}/#dashboards`); await page.locator('.dashboards-manager').waitFor(); screenshots.push(await screenshot(page, `manager-${width}-${theme}`));
      for (const dashboard of [sales, operations]) { await page.goto(`${server.base}/#dash/${dashboard.id}`); await page.getByRole('button', { name: `Switch dashboard: ${dashboard.name}` }).waitFor(); screenshots.push(await screenshot(page, `${dashboard.name === 'Sales pipeline' ? 'sales' : 'operations'}-${width}-${theme}`)); }
      await page.getByRole('button', { name: 'Switch dashboard: Operations' }).click(); screenshots.push(await screenshot(page, `switcher-${width}-${theme}`)); await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Edit', exact: true }).click(); screenshots.push(await screenshot(page, `edit-${width}-${theme}`));
      await page.getByRole('button', { name: 'Settings: Daily summary', exact: true }).click(); screenshots.push(await screenshot(page, `settings-${width}-${theme}`)); await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.getByRole('button', { name: 'Add widget', exact: true }).click(); screenshots.push(await screenshot(page, `add-${width}-${theme}`)); await page.getByRole('button', { name: /Ask your agent Answers/ }).click(); screenshots.push(await screenshot(page, `add-agent-${width}-${theme}`)); await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    }
    assert.deepEqual(errors, []); pass('no console errors');
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: results.length, results, screenshots }, null, 2));
    console.log(`${results.length}/${results.length} dashboard client checks passed`);
  } finally { await server.close(); }
}
if (process.argv[1]?.endsWith('/dashboards-x2.mjs')) await runDashboards();
