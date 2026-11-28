import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { readableWords } from '../../paper-label-geometry.mjs';
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
          await page.goto('about:blank');
          await page.goto(`${server.base}/${route.hash.replace('{dashboard}', id)}`);
          await page.locator('.dashboard-page').waitFor();
          if (['edit', 'settings', 'add', 'add-agent'].includes(route.state)) await page.getByRole('button', { name: 'Edit dashboard', exact: true }).click();
          if (route.state === 'settings') await page.getByRole('button', { name: 'Settings: Daily summary', exact: true }).click();
          if (route.state === 'add' || route.state === 'add-agent') await page.getByRole('button', { name: 'Add widget', exact: true }).click();
          if (route.state === 'add-agent') await page.getByRole('button', { name: /Ask your agent Answers/ }).click();
          if (route.state === 'switcher') await page.getByRole('button', { name: 'Switch dashboard: Operations' }).click();
          await page.evaluate(() => document.fonts.ready);
          issues.push(...await page.evaluate(inspectAlignment, { selector: await page.locator('dialog[open]').count() ? 'dialog[open]' : '.dashboard-page, .dashboard-switcher' }));
          const surface = await page.locator('dialog[open]').count() ? page.locator('dialog[open]') : page.locator('.dashboard-page');
          await readableWords(surface);
          issues.push(...await surface.evaluate(root => {
            const issues = [];
            for (const el of root.querySelectorAll('p, label, button, span, strong, h2')) {
              if (!el.checkVisibility() || !el.textContent.trim() || el.closest('svg')) continue;
              const minimum = el.matches('.dashboard-caption, .dashboard-library-item > span') ? 13 : 14;
              if (parseFloat(getComputedStyle(el).fontSize) < minimum) issues.push(`Text below ${minimum}px: ${el.textContent.trim()}`);
            }
            for (const toolbar of root.querySelectorAll('.dashboard-toolbar')) {
              const card = toolbar.closest('.dashboard-widget')?.getBoundingClientRect(), box = toolbar.getBoundingClientRect();
              if (!card || box.left < card.left + 15 || box.right > card.right - 15 || box.bottom > card.bottom) issues.push('Edit toolbar must stay inside its card padding');
              const controls = [...toolbar.querySelectorAll('button')].filter(el => el.checkVisibility());
              if (controls.length !== (innerWidth <= 760 ? 4 : 5)) issues.push('Compact edit controls, plus desktop drag');
              if (innerWidth <= 760) {
                const rows = new Map();
                for (const control of controls) { const top = Math.round(control.getBoundingClientRect().top); rows.set(top, (rows.get(top) ?? 0) + 1); }
                if (rows.size > 1 && (rows.size !== 2 || [...rows.values()].some(count => count !== 2))) issues.push('Phone edit icons need one row or a balanced two-by-two grid');
              }
              for (const control of controls) {
                const target = control.getBoundingClientRect();
                if (target.width < 44 || target.height < 44 || !control.title || !control.getAttribute('aria-label')) issues.push('Edit controls need 44px targets, names and tooltips');
              }
            }
            return issues;
          }));
          if (route.name === 'dashboards') issues.push(...await page.locator('.dashboard-manager-row').evaluateAll(rows => rows.flatMap(row => {
            const box = row.getBoundingClientRect(), button = row.querySelector('.layout-row__trailing button').getBoundingClientRect(), card = row.closest('.layout-card').getBoundingClientRect();
            const count = getComputedStyle(row.querySelector('.dashboard-caption'));
            return [
              ...(box.height < 60 || button.top - box.top < 8 || box.bottom - button.bottom < 8 ? ['Manager rows need 8px above and below controls'] : []),
              ...(Math.abs(card.right - button.right - 17) > 1 ? ['Manage button needs a consistent 16px right inset'] : []),
              ...(parseFloat(count.fontSize) < 14 ? ['Widget count must be at least 14px'] : []),
            ];
          })));
          const visible = await page.locator('body').innerText();
          if (/mock|Fixture|PRIVATE|QA-|undefined|null|\[object|[\u2013\u2014]/i.test(visible)) issues.push('Forbidden visible text');
          const phoneBacks = await page.getByRole('button', { name: 'Back', exact: true }).count();
          if (width <= 760 && phoneBacks !== 1) issues.push(`Expected one Back, found ${phoneBacks}`);
          await page.screenshot({ path: path.join(evidence, `${route.name}-${width}-${theme}.png`), animations: 'disabled' });
        } catch (error) { await page.screenshot({ path: path.join(evidence, `failure-${route.name}-${width}-${theme}.png`) }); console.log(error.message); issues.push(error.message.split('\n')[0]); }
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
if (process.argv[1]?.endsWith('/layout-x2.mjs')) {
  // Let this module finish exporting before the shared audit imports its routes.
  void import('../../layout-alignment-ui.mjs').then(async ({ inspectAlignment }) => {
    const report = await auditDashboardRoutes(path.resolve('.context/layout-alignment/dashboards'), inspectAlignment);
    console.log(`${report.filter(view => !view.issues.length).length}/${report.length} dashboard layout views passed`);
    if (report.some(view => view.issues.length)) process.exitCode = 1;
  }).catch(error => { console.error(error); process.exitCode = 1; });
}
