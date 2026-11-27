import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dashboardFixture, patch, inspectAlignment, assertGrid, readyWidgets } from './dashboard-fixture.mjs';
const server = await dashboardFixture(), output = path.resolve('.context/ui-custom/demo-f'); fs.mkdirSync(output, { recursive: true });
const checks = [], screenshots = [];
const shot = async (page, name) => { const file = path.join(output, `${name}.png`); await page.screenshot({ path: file, fullPage: true }); screenshots.push(file); };
try {
  const desktop = await server.page(1280), dashboard = await server.create(desktop);
  for (const width of [1280, 390]) for (const mode of ['light', 'dark']) {
    const page = width === 1280 ? desktop : await server.page(width);
    await patch(page, [{ op: 'replace', path: '/theme/mode', value: mode }]);
    await server.open(page, dashboard.id); await assertGrid(page, width);
    const issues = await page.evaluate(inspectAlignment); assert.deepEqual(issues, []);
    checks.push(`My week data and alignment ${width} ${mode}`); await shot(page, `my-week-${width}-${mode}`);
    if (width === 390) { await page.locator('[data-widget-type="chart"]').scrollIntoViewIfNeeded(); await page.locator('.dashboard-chart svg').waitFor(); await shot(page, `my-week-${width}-${mode}-chart`); }
  }
  await patch(desktop, [{ op: 'replace', path: '/theme/mode', value: 'light' }]);
  await server.open(desktop, dashboard.id); await desktop.getByRole('button', { name: 'Edit', exact: true }).click();
  await desktop.getByRole('button', { name: 'Wider: Cost by day', exact: true }).click();
  await desktop.waitForFunction(() => document.querySelector('[data-widget-type="chart"]').closest('[data-widget-span]').dataset.widgetSpan === '7'); checks.push('Widen chart');
  await desktop.getByRole('button', { name: 'Add widget', exact: true }).click();
  await desktop.getByRole('button', { name: 'Routine schedule Your next routine runs', exact: true }).click();
  await desktop.locator('dialog').waitFor({ state: 'detached' }); await desktop.locator('[data-widget-type="routineSchedule"]').waitFor(); checks.push('Add routine schedule');
  await desktop.getByRole('button', { name: 'Move earlier: Routine schedule', exact: true }).click(); checks.push('Move widget');
  await readyWidgets(desktop); await desktop.getByRole('heading', {name:'My week',exact:true}).scrollIntoViewIfNeeded();
  await shot(desktop, 'edit-mode');
  await desktop.getByRole('button', { name: 'Remove: Open tasks', exact: true }).click();
  await desktop.locator('[data-widget-type="list"]').waitFor({ state: 'detached' }); checks.push('Remove widget');
  await desktop.getByRole('button', { name: 'Done', exact: true }).click(); await readyWidgets(desktop); await desktop.getByRole('heading', {name:'My week',exact:true}).scrollIntoViewIfNeeded(); await shot(desktop, 'edited-dashboard');
  const final = await desktop.evaluate(async () => (await import('/src/customization/store.ts')).useCustomization.getState().saved);
  fs.writeFileSync(path.join(output, 'final-document.json'), JSON.stringify(final, null, 2));
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ passed: checks.length, failed: 0, checks, screenshots }, null, 2));
  console.log(`DEMO F: ${checks.length} passed, 0 failed. ${output}/results.json`); console.log(screenshots.join('\n'));
} finally { await server.close(); }
