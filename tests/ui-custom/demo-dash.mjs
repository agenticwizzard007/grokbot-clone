import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { agenticFixture } from './e2e/agentic-fixture.mjs';
import { inspectAlignment } from '../layout-alignment-ui.mjs';
import { inspectDashboardPolish } from './dashboard-polish-guards.mjs';

export const DASH_POLISH_STATES = ['sales-pipeline', 'operations', 'manager', 'create', 'sidebar', 'empty', 'empty-widget', 'edit', 'widget-settings', 'add-widget', 'ask-agent', 'approve-confirm', 'send-prefill'];
const prompt = 'Show my tasks that have been open for more than 2 days';
const widget = (id, type, title, span, rows, source, options = {}) => ({ id: `$new${id}`, type, title, span, rows, ...(source ? { source: { id: source, params: {} } } : {}), options });
async function runPolishView({ before, output, view }) {
  fs.mkdirSync(output, { recursive: true });
  const server = await agenticFixture(), checks = [], screenshots = [], counts = [], failures = [], guards = [];
  const pass = label => { checks.push(label); console.log(`PASS ${label}`); };
  let page;
  try {
    const account = await server.account({ bot: true }); server.seed(account);
    // Distinct live tasks, including fresh and completed records which the answer must omit.
    const titles = ['Draft the launch email', 'Prepare the customer proposal', 'Review the launch plan', 'Plan the customer call', 'Publish the weekly update', 'Prepare the meeting agenda', 'Review the project brief', 'Send the daily summary', 'Plan the next milestone', 'Approve the release notes', 'Update the project timeline', 'Write the team update'];
    const tasks = server.db.prepare('SELECT id FROM tasks WHERE bot_id=? ORDER BY id').all(account.bot.id);
    tasks.slice(9).forEach(task => server.db.prepare('DELETE FROM tasks WHERE id=?').run(task.id));
    tasks.slice(0, 9).forEach((task, i) => server.db.prepare('UPDATE tasks SET title=?,state=?,created_at=?,updated_at=? WHERE id=?').run(titles[i], i === 4 ? 'done' : 'working', Date.now() - (i < 3 ? 4 : 1) * 86400000, Date.now() - (i < 3 && i !== 1 ? 3 : 1) * 86400000, task.id));
    const approvalId = server.seedApproval(account);
    const dashboards = [
      { id: '$new1', name: 'Sales pipeline', icon: 'briefcase', widgets: [
        widget(2, 'stat', 'Open tasks', 4, 1, 'tasks.counts', { field: 'working' }),
        widget(3, 'stat', 'Needs you', 4, 1, 'needsYou.list', { field: 'count' }),
        widget(4, 'stat', 'Done', 4, 1, 'tasks.counts', { field: 'done' }),
        widget(5, 'agent', 'Tasks stuck over 2 days', 6, 3, null, { prompt, display: 'list', schedule: 'manual' }),
        { ...widget(6, 'list', 'Open tasks', 6, 3, 'tasks.list', { limit: 4 }), source: { id: 'tasks.list', params: { state: 'working', limit: 10 } } },
        widget(7, 'botStatus', 'Bots', 6, 2, 'bots.status', { limit: 6 }),
        widget(8, 'meter', 'Plan usage', 6, 2, 'usage.windows', { window: 0 }),
      ] },
      { id: '$new20', name: 'Operations', icon: 'activity', widgets: [
        widget(21, 'stat', 'Tasks completed', 4, 1, 'tasks.counts', { field: 'done' }),
        { ...widget(22, 'routineSchedule', 'Upcoming routines', 8, 2, 'routines.upcoming', { days: 1 }), source: { id: 'routines.upcoming', params: { days: 1 } } },
        widget(23, 'table', 'All tasks', 6, 3, 'tasks.list', { columns: ['title', 'state'], limit: 3 }),
        widget(24, 'note', 'Weekly focus', 6, 2, null, { text: 'Review the launch plan.\n\nPrepare the next customer update.' }),
      ] },
      ...['Weekly review', 'Launch planning', 'Customer follow ups', 'Content calendar', 'Research'].map((name, i) => ({ id: `$new${30 + i}`, name, icon: 'layout-dashboard', widgets: [] })),
    ];
    const created = await server.request(account, 'PATCH', '/ui/config', [{ op: 'replace', path: '/dashboards', value: dashboards }], 0);
    assert.equal(created.status, 200, JSON.stringify(created));
    const doc = (await server.request(account, 'GET', '/ui/config')).body.doc;
    const sales = doc.dashboards[0], operations = doc.dashboards[1], empty = doc.dashboards[2];
    server.answers.set(prompt, { source: 'tasks_list', actions: true, botId: account.bot.id, approvalId, olderThanDays: 2 });
    const run = await server.request(account, 'POST', `/ui/widgets/${sales.id}/${sales.widgets[3].id}/run`, {});
    assert.equal(run.status, 202, JSON.stringify(run));
    const result = await server.wait(async () => { const r = (await server.request(account, 'GET', `/ui/widgets/${sales.id}/${sales.widgets[3].id}/result`)).body; return r.state === 'ready' ? r : false; });
    if (!before) { assert.deepEqual(result.doc.rows.map(row => row.title).sort(), titles.slice(0, 3).sort()); pass('Agent answer uses only old open tasks from live read tools'); }
    server.db.prepare('UPDATE ui_widget_results SET run_at=? WHERE user_id=?').run(Date.now() - 300000, account.userId);
    page = await server.page(account);
    let sends = 0; page.on('request', request => { if (request.method() === 'POST' && /\/messages$/.test(new URL(request.url()).pathname)) sends++; });
    async function open(board) {
      await page.goto(`${server.base}/#dash/${board.id}`); await page.locator('.dashboard-page').waitFor();
      await page.reload(); await page.locator('.dashboard-page').waitFor();
      for (const cell of await page.locator('[data-widget-id]').all()) { await cell.scrollIntoViewIfNeeded(); await page.waitForFunction(id => document.querySelector(`[data-widget-id="${id}"]`)?.dataset.widgetState !== 'loading', await cell.getAttribute('data-widget-id')); }
      await page.locator('.dashboard-surface').evaluate(el => { el.scrollTop = 0; });
    }
    async function capture(name, width, theme) {
      await page.evaluate(() => document.fonts.ready);
      const file = path.join(output, `${name}-${width}-${theme}.png`);
      await page.screenshot({ path: file, animations: 'disabled' }); screenshots.push(file);
      const guardIssues = [...await page.evaluate(inspectDashboardPolish), ...await page.evaluate(inspectAlignment, { sidebarOnly: true })];
      guards.push({ name, width, theme, issues: guardIssues });
      if (!before) assert.deepEqual(guardIssues, [], `${name}: dashboard polish guards`);
      if (before) return;
      const dialog = page.locator('dialog[open]');
      const selector = await dialog.count() ? 'dialog[open]' : name === 'send-prefill' ? '.composer' : name === 'sidebar' ? '.sidebar__dashboards' : '.dashboard-page';
      assert.doesNotMatch(await page.locator('body').innerText(), /mock|Fixture|PRIVATE|QA-|undefined|null|\[object|[\u2013\u2014]/i, `${name}: clean copy`);
      assert.deepEqual(await page.evaluate(inspectAlignment, { selector: selector === '.dashboard-page' ? '.dashboard-page, .dashboard-header-actions' : selector, requirePage: !['sidebar', 'send-prefill'].includes(name) }), [], `${name}: alignment`);
      const issues = await page.locator(selector).evaluate(root => [...root.querySelectorAll('p,span,strong,label,button,h2')].filter(el => el.checkVisibility() && el.textContent.trim() && !el.closest('svg')).flatMap(el => parseFloat(getComputedStyle(el).fontSize) < (el.closest('.model-pill, .plan-usage__status, .plan-usage__reset, .plan-usage__own, .plan-usage__note') || el.closest('.sidebar__section-label, .dashboard-caption, .dashboard-schedule li > span, .dashboard-bot-meta, .dashboard-bot-meta *, .dashboard-list-meta *, .dashboard-muted, .dashboard-library-item > span, .dashboard-status') ? 13 : 14) && !el.matches('.dashboard-status > span') ? [el.textContent] : []));
      if (name !== 'send-prefill') assert.deepEqual(issues, [], `${name}: readable type`);
      if (width <= 760 && name !== 'sidebar') assert.equal(await page.getByRole('button', { name: 'Back', exact: true }).count(), 1, `${name}: one Back`);
      const fields = await page.locator('input,textarea').evaluateAll(fields => fields.filter(el => el.checkVisibility()).map(el => `${el.value} ${el.placeholder}`).join(' '));
      assert.doesNotMatch(fields, /mock|Fixture|PRIVATE|QA-|undefined|null|\[object|[\u2013\u2014]/i, `${name}: clean form copy`);
      if (name !== 'send-prefill') {
        const contrast = await page.locator(selector).evaluate(root => {
          const rgb = color => color.match(/[\d.]+/g)?.map(Number);
          const light = color => color.slice(0,3).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum,v,i) => sum + v * [.2126,.7152,.0722][i], 0);
          return [...root.querySelectorAll('p,span,strong,label,button,h2')].filter(el => el.checkVisibility() && el.textContent.trim() && !el.closest('svg,[disabled]') && !el.matches('.dashboard-status > span')).flatMap(el => {
            const ink = rgb(getComputedStyle(el).color); let surface = el, background;
            while (surface) { const color = rgb(getComputedStyle(surface).backgroundColor); if (color && (color[3] ?? 1) === 1) { background = color; break; } surface = surface.parentElement; }
            if (!ink || !background) return [];
            const a = light(ink), b = light(background), ratio = (Math.max(a,b) + .05) / (Math.min(a,b) + .05);
            return ratio < 4.5 ? [`${el.textContent}: ${ratio.toFixed(2)}`] : [];
          });
        });
        assert.deepEqual(contrast, [], `${name}: readable contrast`);
        assert.deepEqual(await page.locator(`${selector} .dashboard-widget`).evaluateAll(cards => cards.flatMap(card => { const css = getComputedStyle(card); return css.padding === '16px' && css.borderTopLeftRadius === '12px' ? [] : [css.padding, css.borderTopLeftRadius]; })), [], `${name}: shared card geometry`);
      }
      pass(`${name} ${width} ${theme}: alignment, targets, type, clean copy`);
    }
    for (const [width, theme] of [view]) {
      await page.setViewportSize({ width, height: width <= 760 ? 844 : 720 }); await page.emulateMedia({ colorScheme: theme });
      await open(sales);
      if (!before) {
        const stats = await page.locator('[data-widget-type="stat"]').evaluateAll(cells => cells.map(el => { const r = el.getBoundingClientRect(); return { top: r.top, width: r.width }; }));
        assert.ok(stats.every(r => Math.abs(r.width - stats[0].width) < 1));
        assert.equal(new Set(stats.map(r => Math.round(r.top))).size, width === 320 ? 3 : 1, 'No orphan KPI');
        const list = page.locator('[data-widget-type="list"]');
        const fit = await list.evaluate(root => { const card = root.getBoundingClientRect(); return [...root.querySelectorAll('li')].every(row => row.getBoundingClientRect().bottom <= card.bottom - 15); });
        assert.ok(fit, 'Whole list rows fit inside the card');
        assert.equal(await list.getByRole('link', { name: 'View all 8', exact: true }).getAttribute('href'), '#tasks');
        const bot = page.locator('[data-widget-type="botStatus"]'); assert.equal(await bot.locator('.bot-avatar svg').count(), 1);
        assert.equal(await bot.locator('.dashboard-bot-name').evaluate(el => getComputedStyle(el).whiteSpace), 'nowrap');
        assert.equal(await bot.getByRole('link', { name: /Project assistant/ }).evaluate(el => getComputedStyle(el).textDecorationLine), 'none');
        await page.locator('[data-widget-type="meter"] .plan-usage').waitFor();
        assert.equal(await page.getByRole('button', { name: 'Refresh dashboard', exact: true }).count(), 1);
        assert.equal(await page.getByRole('button', { name: 'Edit dashboard', exact: true }).count(), 1);
        const headerActions = await page.locator('.dashboard-header-actions').evaluate(el => ({ inHeader: !!el.closest('.shell-header'), width: el.getBoundingClientRect().width, targets: [...el.querySelectorAll('button')].map(button => button.getBoundingClientRect().height) }));
        assert.ok(headerActions.inHeader && headerActions.width <= 128 && headerActions.targets.every(height => height >= 44), 'Compact header controls retain 44px targets');
        await page.getByText('Updated 5 min ago', { exact: true }).waitFor();
        const actionWidths = await page.locator('.dashboard-agent-list .btn').evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().width));
        assert.ok(actionWidths.every(width => Math.abs(width - actionWidths[0]) <= 1), 'Inline action buttons have equal widths');
        pass(`dashboard regressions ${width} ${theme}: KPI row, whole rows, View all, avatar, plan usage, header`);
      }
      await capture('sales-pipeline', width, theme);
      counts.push({ phase: before ? 'before' : 'after', width, theme, screen: 'sales-pipeline', words: (await page.locator('.shell-content').innerText()).trim().split(/\s+/).length });
      await page.locator('[data-widget-type="botStatus"]').scrollIntoViewIfNeeded(); await capture('sales-details', width, theme);
      if (!before) {
        const meter = page.locator('[data-widget-type="meter"]'); await meter.scrollIntoViewIfNeeded();
        // Exercise the unavailable response without changing the real seeded plan summary.
        const unavailable = async route => {
          const response = await route.fetch(), body = await response.json();
          for (const request of route.request().postDataJSON().requests) if (request.source === 'usage.windows') body.results[request.key] = { ok: true, available: false, rows: [], count: 0, fetchedAt: Date.now() };
          await route.fulfill({ response, json: body });
        };
        await page.route('**/api/ui/data', unavailable);
        await page.getByRole('button', { name: 'Refresh dashboard', exact: true }).click(); await meter.getByText('Usage unavailable', { exact: true }).waitFor();
        assert.ok(await meter.evaluate(el => el.getBoundingClientRect().height <= 136), 'Empty meter is compact');
        await capture('empty-widget', width, theme);
        await page.unroute('**/api/ui/data', unavailable);
        await page.getByRole('button', { name: 'Refresh dashboard', exact: true }).click(); await meter.locator('.plan-usage').waitFor();
      }
      await open(operations);
      if (!before) assert.ok(await page.locator('[data-widget-type="table"]').evaluate(root => {
        const card = root.getBoundingClientRect();
        return [...root.querySelectorAll('tr')].every(row => row.getBoundingClientRect().bottom <= card.bottom - 15);
      }), 'Whole table rows fit inside the card');
      await capture('operations', width, theme);
      await page.goto(`${server.base}/#dashboards`); await page.locator('.dashboards-manager').waitFor();
      if (!before) await page.getByRole('button', { name: 'Create with your agent', exact: true }).waitFor();
      if (!before) { assert.doesNotMatch(await page.locator('.dashboards-manager').innerText(), /0 widgets/); assert.equal(await page.getByText('Empty dashboards are ready for widgets. Open one and tap Add widget.', { exact: true }).count(), 1); }
      await capture('manager', width, theme);
      await page.getByRole('button', { name: 'Create', exact: true }).click(); await capture('create', width, theme); await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      if (width <= 760) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
      if (!before) { const disclosure = page.locator('.sidebar__disclosure'); if (await disclosure.getAttribute('aria-expanded') === 'false') await disclosure.click(); assert.equal(await page.locator('.sidebar__dashboards .sidebar-island').count(), width <= 760 || page.viewportSize().height < 760 ? 4 : 6); assert.equal(await page.locator('.sidebar__dashboards').getByRole('button', { name: 'All dashboards', exact: true }).count(), 1); }
      await capture('sidebar', width, theme);
      await open(empty); if (!before) await page.getByRole('button', { name: 'Create with your agent', exact: true }).waitFor(); await capture('empty', width, theme);
      await open(sales); await page.getByRole('button', { name: 'Edit dashboard', exact: true }).click(); await capture('edit', width, theme);
      await page.getByRole('button', { name: 'Settings: Open tasks', exact: true }).first().click(); await capture('widget-settings', width, theme); await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.getByRole('button', { name: 'Add widget', exact: true }).click(); await capture('add-widget', width, theme);
      if (!before) assert.match(await page.locator('.dashboard-library-item').first().innerText(), /^Ask your agent/);
      await page.getByRole('button', { name: /Ask your agent Answers/ }).click(); await capture('ask-agent', width, theme); await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await open(sales); await page.getByRole('button', { name: /^Approve:/ }).click(); await capture('approve-confirm', width, theme); await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.getByRole('button', { name: /^Send to agent:/ }).click(); await page.locator('.composer__input:not([disabled])').waitFor();
      if (!before) { assert.match(await page.locator('.composer__input').inputValue(), /^Draft next steps for /); assert.equal(sends, 0); }
      await capture('send-prefill', width, theme);
    }
    if (!before) {
      await open(sales); await page.getByRole('button', { name: /^Open:/ }).click(); await page.locator('.tasks-view').waitFor(); pass('Open navigates to Tasks');
      await open(sales); await page.getByRole('button', { name: /^Approve:/ }).click(); await page.getByRole('dialog').getByRole('button', { name: 'Approve', exact: true }).click(); await page.getByRole('dialog').waitFor({ state: 'hidden' });
      assert.equal(server.db.prepare('SELECT status FROM approvals WHERE id=?').get(approvalId.slice(9)).status, 'allowed'); pass('Approve requires confirmation and resolves the owned item');
      await page.goto(`${server.base}/#dashboards`); await page.getByRole('button', { name: 'Create with your agent', exact: true }).click(); await page.getByRole('dialog', { name: 'Create with your agent', exact: true }).waitFor();
      assert.equal(await page.getByLabel('Request', { exact: true }).inputValue(), ''); assert.equal(sends, 0); pass('Create with your agent opens the request sheet without sending');
    }
  } catch (error) { if (page) await page.screenshot({ path: path.join(output, `failure-${view[0]}-${view[1]}.png`) }); failures.push(error.stack); throw error; }
  finally { await server.close(); fs.writeFileSync(path.join(output, `results-${view[0]}-${view[1]}.json`), JSON.stringify({ passed: checks.length, failed: failures.length, checks, failures, screenshots, counts, guards }, null, 2)); }
  return { passed: checks.length, failed: failures.length, checks, failures, screenshots, counts, guards };
}
export async function runDashboardPolish({ before = false, output = path.resolve(`.context/ui-custom/demo-dash${before ? '/before' : ''}`), views = [[320,'light'],[390,'light'],[500,'light'],[1280,'light'],[390,'dark'],[1280,'dark']] } = {}) {
  const results = [];
  for (const view of views) results.push(await runPolishView({ before, output, view }));
  const report = { passed: results.reduce((n,r) => n + r.passed, 0), failed: 0, screenshots: results.flatMap(r => r.screenshots), counts: results.flatMap(r => r.counts), checks: results.flatMap(r => r.checks), guards: results.flatMap(r => r.guards) };
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
  console.log(`DEMO DASH: ${report.passed} passed, 0 failed. ${output}/results.json`);
  return report;
}
if (process.argv[1]?.endsWith('/demo-dash.mjs')) await runDashboardPolish({ before: process.argv.includes('--before') });
