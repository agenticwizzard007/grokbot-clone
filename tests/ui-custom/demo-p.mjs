import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readableWords } from '../paper-label-geometry.mjs';
import { dashboardFixture, widgetTypes, readyWidgets, patch, inspectAlignment, assertGrid } from './dashboard-fixture.mjs';

const before = process.argv.includes('--before');
const output = path.resolve(process.env.POLISH_OUTPUT || `.context/ui-custom/polish-${before ? 'before' : 'after'}`);
fs.mkdirSync(output, { recursive: true });
let server, failure;
const checks = [], screenshots = [], counts = [];
const forbidden = /mock|Fixture|PRIVATE|QA-|undefined|null|\[object/i;
async function capture(page, name, width, theme, selector) {
  await page.evaluate(() => document.fonts.ready);
  const file = path.join(output, `${name}-${width}-${theme}.png`);
  await page.screenshot({ path: file, fullPage: true }); screenshots.push(file);
  if (!before) {
    assert.doesNotMatch(await page.locator('body').innerText(), forbidden, `${name}: visible test text`);
    assert.deepEqual(await page.evaluate(inspectAlignment, { selector, requirePage: selector !== '.appearance-dialog' }), [], `${name}: alignment`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const root = page.locator(selector);
    const issues = await root.evaluate(root => [...root.querySelectorAll('button,a.cfg-btn,[data-layout="row"]')].filter(el => el.checkVisibility()).flatMap(el => {
      const box = el.getBoundingClientRect();
      return box.height < 43.5 ? [`${el.textContent || el.getAttribute('aria-label')}: ${box.height}`] : [];
    }));
    assert.deepEqual(issues, [], `${name}: targets`);
    await readableWords(root);
    const switches = await root.locator('[role="switch"]').evaluateAll(elements => elements.map(el => {
      const knob = el.querySelector('.toggle__knob').getBoundingClientRect(), target = el.getBoundingClientRect();
      return knob.left >= target.left && knob.right <= target.right && knob.top >= target.top && knob.bottom <= target.bottom && knob.width === 20;
    }));
    assert.ok(switches.every(Boolean), `${name}: switch knobs stay inside their targets`);
    checks.push(`${name} ${width} ${theme}: alignment, touch targets and clean visible text`);
  }
}
try {
  for (const width of [320, 390, 500, 1280]) for (const theme of width === 390 || width === 1280 ? ['light', 'dark'] : ['light']) {
    server = await dashboardFixture();
    const page = await server.page(width); await page.emulateMedia({ colorScheme: theme });
    const widgets = await page.evaluate(async types => {
      const { defaultWidget } = await import('/src/dashboards/model.ts');
      const titles = ['Total tasks', 'Open tasks', 'Task overview', 'Cost by day', 'Usage', 'Assistants', 'Task board', 'Upcoming routines', 'Weekly focus', 'Quick links'];
      return types.map((type, i) => ({ ...defaultWidget(type), id: `$new${i + 2}`, title: titles[i], span: type === 'taskBoard' ? 12 : 6, rows: ['stat', 'meter', 'botStatus', 'note', 'shortcuts'].includes(type) ? 2 : type === 'taskBoard' ? 5 : 3,
        ...(type === 'note' ? { options: { text: 'Review the launch plan.' } } : {}) })).sort((a, b) => ['stat','meter','list','chart','table','botStatus','taskBoard','routineSchedule','note','shortcuts'].indexOf(a.type) - ['stat','meter','list','chart','table','botStatus','taskBoard','routineSchedule','note','shortcuts'].indexOf(b.type));
    }, widgetTypes);
    await patch(page, [{ op: 'replace', path: '/dashboards', value: [{ id: '$new1', name: 'My week', icon: 'layout-dashboard', widgets }, { id: '$new20', name: 'Daily summary', icon: 'layout-dashboard', widgets: [] }] }]);
    const boards = await page.evaluate(async () => (await import('/src/customization/store.ts')).useCustomization.getState().saved.dashboards);
    await server.open(page, boards[0].id); await readyWidgets(page);
    await page.locator('.dashboard-heading').scrollIntoViewIfNeeded();
    if (!before) await assertGrid(page, width);
    await capture(page, 'dashboard', width, theme, '.dashboard-page');
    if ([390,1280].includes(width) && theme === 'light') counts.push({ page: 'dashboard', width, words: await wordCount(page) });
    for (const type of widgetTypes) {
      const widget = page.locator(`[data-widget-type="${type}"]`); await widget.scrollIntoViewIfNeeded();
      await capture(page, `widget-${type}`, width, theme, '.dashboard-page');
    }
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.locator('.dashboard-heading').scrollIntoViewIfNeeded();
    await capture(page, 'edit', width, theme, '.dashboard-page');
    await page.getByRole('button', { name: 'Settings: Total tasks', exact: true }).click();
    await capture(page, 'widget-settings', width, theme, '.dashboard-dialog');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Add widget', exact: true }).click();
    await capture(page, 'add-widget', width, theme, '.dashboard-dialog');
    await page.getByRole('button', { name: before ? 'Cancel' : 'Close', exact: true }).click();
    await page.goto(`${server.base}/#dash/${boards[1].id}`); await page.getByText('Your dashboard is empty.', { exact: true }).waitFor();
    await capture(page, 'empty-dashboard', width, theme, '.dashboard-page');
    await page.goto(`${server.base}/#settings/appearance`); await page.locator('.appearance-fields').waitFor();
    await capture(page, 'appearance', width, theme, '.app-settings');
    if ([390,1280].includes(width) && theme === 'light') counts.push({ page: 'appearance', width, words: await wordCount(page) });
    for (const title of ['Sidebar', 'Home', 'Show', 'Shortcuts', 'Agent', 'Manage']) {
      await page.locator('.appearance-section').getByRole('heading', { name: title, exact: true }).scrollIntoViewIfNeeded();
      await capture(page, `appearance-${title.toLowerCase()}`, width, theme, '.app-settings');
    }
    await page.getByRole('button', { name: 'Manage My week', exact: true }).click();
    await capture(page, 'dashboards-manager', width, theme, '.app-settings');
    await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    await capture(page, 'delete-confirm', width, theme, '.appearance-dialog');
    await page.context().close(); await server.close(); server = undefined;
  }
} catch (error) { failure = error.message; throw error; } finally {
  await server?.close();
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ passed: checks.length, failed: failure ? 1 : 0, failure, counts, checks, screenshots }, null, 2));
}
async function wordCount(page) {
  return page.locator('.shell-content').evaluate(root => {
    let text = root.innerText;
    for (const el of root.querySelectorAll('.phone-tabs')) text = text.replace(el.innerText, '');
    return text.trim().split(/\s+/).filter(Boolean).length;
  });
}
console.log(`DEMO P: ${checks.length} passed, 0 failed. ${output}/results.json`);
console.log(JSON.stringify(counts));
