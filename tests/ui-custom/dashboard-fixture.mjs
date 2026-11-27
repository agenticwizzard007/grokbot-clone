import assert from 'node:assert/strict';
import { clientFixture, signedInPage, patch } from './unit/client-fixture.mjs';
import { chromium } from 'playwright';
import { inspectAlignment } from '../layout-alignment-ui.mjs';
export { inspectAlignment, patch };

export const widgetTypes = ['stat', 'list', 'table', 'chart', 'meter', 'botStatus', 'taskBoard', 'routineSchedule', 'note', 'shortcuts'];
export function exampleDashboard() {
  return { id: '$new1', name: 'My week', icon: 'layout-dashboard', widgets: [
    { id: '$new2', type: 'stat', title: 'Needs you', span: 4, rows: 1, source: { id: 'needsYou.list', params: {} }, options: { field: 'count' } },
    { id: '$new3', type: 'stat', title: 'Spent this week', span: 4, rows: 1, source: { id: 'usage.summary', params: { range: '7d' } }, options: { field: 'costUsd', format: 'usd' } },
    { id: '$new4', type: 'stat', title: 'Working now', span: 4, rows: 1, source: { id: 'tasks.counts', params: {} }, options: { field: 'working' } },
    { id: '$new5', type: 'list', title: 'Open tasks', span: 6, rows: 3, source: { id: 'tasks.list', params: { state: 'needs_input', limit: 10 } }, options: { limit: 5 } },
    { id: '$new6', type: 'chart', title: 'Cost by day', span: 6, rows: 3, source: { id: 'usage.series', params: { range: '7d', metric: 'cost' } }, options: { kind: 'bar' } },
  ] };
}
export function seedDashboardData(db, fixture) {
  const { userId, bot } = fixture, at = Date.now(), prefix = userId === 'layout-owner' ? 'qa-dashboard' : userId;
  db.prepare('UPDATE users SET name=? WHERE id=?').run('Test User', userId);
  db.prepare('UPDATE bots SET name=? WHERE id=?').run('Project assistant', bot.id);
  const titles = ['Draft the launch email', 'Review the launch plan', 'Publish the weekly update', 'Prepare the meeting agenda', 'Review the project brief', 'Send the daily summary', 'Plan the next milestone', 'Approve the release notes', 'Update the project timeline', 'Write the team update', 'Review the draft proposal', 'Share the launch checklist'];
  db.prepare('DELETE FROM tasks WHERE bot_id IN (SELECT id FROM bots WHERE user_id=?)').run(userId);
  for (let n = 0; n < 12; n++) db.prepare('INSERT INTO tasks(id,bot_id,title,state,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run(`${prefix}-task-${n}`, bot.id, titles[n], ['working', 'needs_input', 'done'][n % 3], 'PRIVATE_FIXTURE_NOTE', at - 1000, at);
  db.prepare("DELETE FROM rows WHERE bot_id=? AND kind='card'").run(bot.id);
  db.prepare('INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(bot.id, bot.generation, 100, 100, 'card', JSON.stringify({ type: 'card', card: 'question', status: 'pending', question: 'Choose the next task', options: ['Review the launch plan'], private: 'PRIVATE_FIXTURE_QUESTION' }), at);
  db.prepare('UPDATE bots SET next_seq=101,rev=100 WHERE id=?').run(bot.id);
  for (let day = 0; day < 30; day++) db.prepare('INSERT INTO usage_events(user_id,bot_id,kind,provider,model,input_tokens,output_tokens,cost_usd,cost_source,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(userId, bot.id, 'chat', 'direct', 'gpt-4.1', 100, 20, .25 + (day % 5) * .1, 'provider', at - day * 86400_000);
  for (let n = 0; n < 2; n++) db.prepare('INSERT INTO routines(id,bot_id,name,prompt,schedule,timezone,enabled,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(`${prefix}-routine-${n}`, bot.id, ['Daily summary', 'Weekly review'][n], 'PRIVATE_FIXTURE_PROMPT', '0 9 * * *', 'UTC', 1, at);
  for (let n = 0; n < 8; n++) db.prepare('INSERT INTO agent_jobs(id,user_id,bot_id,trigger,state,created_at,started_at,finished_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(`${prefix}-job-${n}`, userId, bot.id, JSON.stringify({ type: 'user', text: 'PRIVATE_FIXTURE_MESSAGE' }), n % 2 ? 'uncertain' : 'completed', at - 1000, at - 900, at);
}
export async function dashboardFixture() {
  const server = await clientFixture();
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  seedDashboardData(server.db, server.fixture);
  const pages = [];
  return { ...server, browser,
    async page(width = 1280) { const result = await signedInPage(browser, server, width); pages.push(result.context); return result.page; },
    async create(page, dashboard = exampleDashboard()) {
      await patch(page, [{ op: 'add', path: '/dashboards/-', value: dashboard }]);
      return page.evaluate(async name => (await import('/src/customization/store.ts')).useCustomization.getState().saved.dashboards.find(item => item.name === name), dashboard.name);
    },
    async open(page, id) {
      await page.goto(`${server.base}/#dash/${id}`);
      await page.locator('.dashboard-page[aria-label="My week"]').waitFor();
      await page.locator('[data-widget-type="stat"] output').first().waitFor();
      await page.evaluate(() => document.fonts.ready);
    },
    close: async () => { for (const context of pages) await context.close(); await browser.close(); await server.close(); },
  };
}
export async function readyWidgets(page) {
  for (const widget of await page.locator('[data-widget-id]').all()) {
    await widget.scrollIntoViewIfNeeded();
    await widget.locator('[data-widget-state="loading"]').count();
    await page.waitForFunction(id => document.querySelector(`[data-widget-id="${id}"]`)?.dataset.widgetState !== 'loading', await widget.getAttribute('data-widget-id'));
  }
}
export async function assertGrid(page, width) {
  const geometry = await page.evaluate(() => {
    const grid = document.querySelector('.dashboard-grid'), bounds = grid.getBoundingClientRect(), style = getComputedStyle(grid);
    return { columns: style.gridTemplateColumns.split(' ').length, width: bounds.width, left: bounds.left, right: bounds.right, gap: parseFloat(style.columnGap), overflow: document.documentElement.scrollWidth > innerWidth,
      slots: [...grid.children].map(slot => { const rect = slot.getBoundingClientRect(); return { span: Number(slot.dataset.widgetSpan), rows: Number(slot.dataset.widgetRows), width: rect.width, height: rect.height, top: rect.top, left: rect.left, right: rect.right }; }) };
  });
  const columns = width <= 480 ? 2 : width <= 1023 ? 6 : 12;
  assert.equal(geometry.columns, columns); assert.equal(geometry.overflow, false); assert.equal(geometry.gap, 16);
  for (const slot of geometry.slots) {
    const span = width <= 480 ? slot.span <= 4 ? 1 : 2 : width <= 1023 ? Math.ceil(slot.span / 2) : slot.span;
    const expected = (geometry.width - geometry.gap * (columns - 1)) / columns * span + geometry.gap * (span - 1);
    assert.ok(Math.abs(slot.width - expected) <= 1, `span ${span}: ${slot.width} versus ${expected}`);
    for (const other of geometry.slots) if (Math.abs(slot.top - other.top) <= 1 && slot.rows === other.rows) assert.ok(Math.abs(slot.height - other.height) <= 1);
  }
  for (const slot of geometry.slots) {
    const row = geometry.slots.filter(other => Math.abs(slot.top - other.top) <= 1);
    const total = row.reduce((sum, item) => sum + (width <= 480 ? item.span <= 4 ? 1 : 2 : width <= 1023 ? Math.ceil(item.span / 2) : item.span), 0);
    if (total === columns) { assert.ok(Math.abs(Math.min(...row.map(item => item.left)) - geometry.left) <= 1); assert.ok(Math.abs(Math.max(...row.map(item => item.right)) - geometry.right) <= 1); }
  }
  return geometry;
}
