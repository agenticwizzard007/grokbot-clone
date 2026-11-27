import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { clientFixture, signedInPage, patch } from '../unit/client-fixture.mjs';
export const DASHBOARD_ROUTES = [
  { name: 'dashboards', hash: '#dashboards' }, { name: 'dashboard', hash: '#dash/{dashboard}' },
  { name: 'dashboard-edit', hash: '#dash/{dashboard}', state: 'edit' },
  { name: 'dashboard-settings', hash: '#dash/{dashboard}', state: 'settings' },
  { name: 'dashboard-add', hash: '#dash/{dashboard}', state: 'add' },
  { name: 'dashboard-add-agent', hash: '#dash/{dashboard}', state: 'add-agent' },
  { name: 'dashboard-switcher', hash: '#dash/{dashboard}', state: 'switcher' },
].map(route => ({ ...route, owner: 'UC-X2', enforce: true }));
export async function auditDashboardRoutes(evidence, inspectAlignment) {
  fs.mkdirSync(evidence, { recursive: true });
  const server = await clientFixture(), browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] }), report = [];
  server.db.prepare('UPDATE users SET name=?,email=? WHERE id=?').run('Alex Example', 'alex@example.test', server.fixture.userId);
  try {
    for (const [width, theme] of [[320, 'light'], [390, 'light'], [500, 'light'], [1280, 'light'], [390, 'dark'], [1280, 'dark']]) {
      const { context, page } = await signedInPage(browser, server, width);
      const doc = await page.evaluate(async () => (await import('/src/customization/store.ts')).useCustomization.getState().saved);
      await patch(page, [{ op: 'replace', path: '/theme/mode', value: theme }, ...(!doc.dashboards.length ? [{ op: 'add', path: '/dashboards/-', value: { id: '$new1', name: 'Operations', icon: 'activity', widgets: [
        { id: '$new2', type: 'agent', title: 'Daily summary', span: 6, rows: 3, options: { prompt: 'Summarize my open tasks.', display: 'list', schedule: 'manual' } },
        { id: '$new3', type: 'list', title: 'Recent outputs', span: 6, rows: 3, source: { id: 'outputs.recent', params: {} }, options: { limit: 5 } },
      ] } }] : [])]);
      const id = await page.evaluate(async () => (await import('/src/customization/store.ts')).useCustomization.getState().saved.dashboards[0].id);
      for (const route of DASHBOARD_ROUTES) {
        const issues = [];
        try {
          await page.goto(`${server.base}/${route.hash.replace('{dashboard}', id)}`);
          await page.locator('.dashboard-page').waitFor();
          if (['edit', 'settings', 'add', 'add-agent'].includes(route.state)) await page.getByRole('button', { name: 'Edit', exact: true }).click();
          if (route.state === 'settings') await page.getByRole('button', { name: 'Settings: Daily summary', exact: true }).click();
          if (route.state === 'add' || route.state === 'add-agent') await page.getByRole('button', { name: 'Add widget', exact: true }).click();
          if (route.state === 'add-agent') await page.getByRole('button', { name: /Ask your agent Answers/ }).click();
          if (route.state === 'switcher') await page.getByRole('button', { name: 'Switch dashboard: Operations' }).click();
          await page.evaluate(() => document.fonts.ready);
          issues.push(...await page.evaluate(inspectAlignment, { selector: await page.locator('dialog[open]').count() ? 'dialog[open]' : '.dashboard-page, .dashboard-switcher' }));
          const visible = await page.locator('body').innerText();
          if (/mock|Fixture|PRIVATE|QA-|undefined|null|\[object|[\u2013\u2014]/i.test(visible)) issues.push('Forbidden visible text');
          const phoneBacks = await page.getByRole('button', { name: 'Back', exact: true }).count();
          if (width <= 760 && phoneBacks !== 1) issues.push(`Expected one Back, found ${phoneBacks}`);
          await page.screenshot({ path: path.join(evidence, `${route.name}-${width}-${theme}.png`) });
        } catch (error) { issues.push(error.message.split('\n')[0]); }
        report.push({ ...route, width, theme, issues });
        console.log(`${issues.length ? 'FAIL' : 'PASS'} UC-X2 ${route.name} ${width} ${theme}: ${issues.length} issues`);
        for (const issue of issues) console.log(`FAIL ${route.name}: ${issue}`);
      }
      await context.close();
    }
  } finally { await browser.close(); await server.close(); }
  fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  return report;
}
