import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { appearanceFixture, appearanceContext, saved, waitForSaved, reset } from './appearance-fixture.mjs';
import { inspectAlignment } from '../layout-alignment-ui.mjs';
import { readableWords } from '../paper-label-geometry.mjs';

const evidence = path.resolve('.context/ui-custom/demo-g'); fs.mkdirSync(evidence, { recursive: true });
const fixture = await appearanceFixture();
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const report = [];
try {
  for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
    const context = await appearanceContext(browser, fixture, width, theme);
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const screen = page.locator('.appearance-settings');
    const shot = async name => {
      if (['preset-preview', 'preset-applied', 'show-before', 'import-preview', 'undo'].includes(name)) await screen.locator('.ui-preview-card').scrollIntoViewIfNeeded();
      if (name === 'appearance') await page.locator('.app-settings__main').evaluate(el => el.scrollTop = 0);
      await page.screenshot({ path: path.join(evidence, `${width}-${theme}-${name}.png`) }); };
    const pass = (name, details = {}) => { report.push({ width, theme, name, ...details }); console.log(`PASS UC-G ${width} ${theme}: ${name}`); };
    const open = async () => { await page.goto('/#settings/appearance'); await screen.waitFor(); await page.waitForFunction(() => !document.querySelector('.appearance-fields')?.disabled); };
    await page.goto('/#bots'); await reset(page); await open();
    await screen.getByRole('radio', { name: theme === 'light' ? 'Light' : 'Dark', exact: true }).click();
    await waitForSaved(page, c => c.doc.theme.mode === theme, 'mode');
    await page.evaluate(() => document.fonts.ready);
    assert.deepEqual(await page.evaluate(inspectAlignment, { selector: '.app-settings' }), []);
    await readableWords(screen);
    const words = await screen.evaluate(root => {
      const text = [...root.querySelectorAll('*')].filter(el => el.checkVisibility() && !el.closest('select, .sr-only')).flatMap(el => [...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent)).join(' ');
      return text.trim().split(/\s+/).filter(Boolean).length;
    });
    assert.ok(words < 250, `Copy budget: ${words}`);
    for (const section of await screen.locator('.appearance-section').all()) {
      const title = await section.locator(':scope > header h2').innerText();
      assert.ok(title.split(/\s+/).length <= 3);
      assert.ok(await section.locator('.appearance-helper').count() <= 1);
      for (const helper of await section.locator('.appearance-helper').all()) assert.ok((await helper.innerText()).split(/\s+/).length <= 8);
    }
    assert.doesNotMatch(await screen.innerText(), /[\u2013\u2014]/);
    assert.equal(await page.locator('.shell-back:visible').count(), 1);
    await shot('appearance'); pass('alignment, copy and one Back', { words });
    const current = await saved(page);
    await screen.getByRole('button', { name: 'Forest', exact: true }).click();
    const card = screen.locator('.ui-preview-card'); await card.getByRole('button', { name: 'Apply', exact: true }).waitFor();
    assert.equal((await saved(page)).revision, current.revision, 'preset previews do not save');
    await page.getByRole('status', { name: 'Appearance preview', exact: true }).waitFor();
    await page.waitForTimeout(400);
    assert.equal(await page.getByRole('status', { name: 'Appearance preview', exact: true }).isVisible(), true, 'late pending SSE preserves the manual preview');
    await shot('preset-preview');
    assert.ok(await page.evaluate(() => document.querySelector('.app').getBoundingClientRect().bottom <= innerHeight + 1), 'the signed-in shell fits below the preview banner');
    await page.waitForFunction(color => getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim().toUpperCase() === color, theme === 'light' ? '#0F766E' : '#5EEAD4');
    await card.getByRole('button', { name: 'Apply', exact: true }).click();
    await waitForSaved(page, c => c.doc.preset === 'forest', 'preset');
    await shot('preset-applied'); pass('preset preview and Apply');
    await card.getByRole('button', { name: 'Show before', exact: true }).focus(); await page.keyboard.down('Space');
    assert.equal(await card.getByRole('button', { name: 'Show before', exact: true }).getAttribute('aria-pressed'), 'true');
    await shot('show-before'); await page.keyboard.up('Space');
    pass('Applied comparison');
    await screen.getByRole('radio', { name: theme === 'light' ? 'Light' : 'Dark', exact: true }).click();
    await waitForSaved(page, c => c.doc.theme.mode === theme, 'mode restored');
    const custom = screen.getByLabel('Custom', { exact: true });
    const valid = theme === 'light' ? '#0F766E' : '#5EEAD4';
    await custom.fill(valid); await screen.getByRole('button', { name: 'Save', exact: true }).click();
    await waitForSaved(page, c => c.doc.theme.colors[theme].primary === valid, 'accent');
    await page.waitForFunction(color => getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim().toUpperCase() === color, valid);
    await shot('accent'); pass('valid accent applies immediately');
    const beforeInvalid = (await saved(page)).revision;
    await custom.fill(theme === 'light' ? '#FFFFFF' : '#17222F'); await screen.getByRole('button', { name: 'Save', exact: true }).click();
    await screen.getByText('Low contrast', { exact: true }).waitFor();
    assert.equal((await saved(page)).revision, beforeInvalid);
    assert.match(await screen.getByRole('alert').innerText(), /contrast|ratio|primary/i);
    await shot('accent-rejected'); pass('low contrast rejected with suggestion');
    for (const [group, choice, test] of [
      ['Size', 'Large', c => c.doc.theme.font.scale === 'large'],
      ['Density', 'Roomy', c => c.doc.theme.density === 'comfortable'],
      ['Corners', 'Round', c => c.doc.theme.radius === 'round'],
    ]) { await screen.getByRole('radiogroup', { name: group, exact: true }).getByRole('radio', { name: choice, exact: true }).click(); await waitForSaved(page, test, group); await shot(group.toLowerCase()); pass(group); }
    await screen.getByRole('button', { name: 'Move Tasks up', exact: true }).focus(); await page.keyboard.press('Enter');
    await waitForSaved(page, c => c.doc.layout.sidebar.order[0] === 'tasks', 'sidebar reorder');
    await shot('sidebar-reordered'); pass('sidebar reorder by keyboard');
    await screen.getByRole('button', { name: 'New dashboard', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: 'New dashboard', exact: true });
    await dialog.getByRole('textbox', { name: 'Name' }).fill('QA-Temp-Board'); await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    const created = await waitForSaved(page, c => c.doc.dashboards.length === 1, 'dashboard create');
    await page.waitForURL(/#dash\//); await open();
    await screen.getByRole('button', { name: 'Manage QA-Temp-Board', exact: true }).scrollIntoViewIfNeeded(); await shot('dashboard-created');
    await screen.getByRole('button', { name: 'Manage QA-Temp-Board', exact: true }).click(); await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Rename dashboard', exact: true });
    await dialog.getByRole('textbox', { name: 'Name' }).fill('QA-Temp-Renamed'); await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await waitForSaved(page, c => c.doc.dashboards[0].name === 'QA-Temp-Renamed', 'rename'); pass('dashboard create and rename');
    await screen.getByRole('button', { name: 'Manage QA-Temp-Renamed', exact: true }).click(); await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Delete dashboard', exact: true });
    assert.match(await dialog.innerText(), /0 widgets/); await shot('delete-confirm');
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click(); await waitForSaved(page, c => !c.doc.dashboards.length, 'delete'); pass('dashboard delete confirms count');
    const manage = screen.getByRole('button', { name: 'Manage appearance', exact: true });
    await manage.click(); const downloadPromise = page.waitForEvent('download'); await page.getByRole('menuitem', { name: 'Export', exact: true }).click();
    const download = await downloadPromise, exportPath = path.join(evidence, `${width}-${theme}-export.json`); await download.saveAs(exportPath);
    assert.equal(download.suggestedFilename(), 'swarm-appearance.json');
    await screen.getByLabel('Import appearance file').setInputFiles(exportPath);
    await card.getByRole('button', { name: 'Apply', exact: true }).waitFor(); await page.getByRole('status', { name: 'Appearance preview', exact: true }).waitFor(); await shot('import-preview');
    await card.getByRole('button', { name: 'Apply', exact: true }).click(); await card.getByText('Applied', { exact: true }).waitFor();
    await card.getByRole('button', { name: 'Undo', exact: true }).click(); await card.getByText('Undone', { exact: true }).waitFor();
    await shot('undo'); pass('export, import preview, Apply and Undo');
    await manage.click(); await page.getByRole('menuitem', { name: 'History', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Appearance history', exact: true });
    const restores = dialog.getByRole('button', { name: /^Restore revision/ }); await restores.first().waitFor(); assert.ok(await restores.count() > 0 && await restores.count() <= 50);
    await shot('history'); await restores.last().click(); await dialog.waitFor({ state: 'hidden' }); pass('history and Restore');
    await manage.click(); await page.getByRole('menuitem', { name: 'Reset', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Reset appearance', exact: true }); assert.match(await dialog.innerText(), /Clears colors, fonts, spacing, navigation, visibility and shortcuts/);
    await shot('reset-confirm'); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); pass('Reset describes losses and can cancel');
    await screen.getByRole('button', { name: 'Forest', exact: true }).click(); await card.getByRole('button', { name: 'Discard', exact: true }).click(); await card.getByText('Discarded', { exact: true }).waitFor(); pass('preview Discard');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(evidence, `${width}-${theme}-config.json`), JSON.stringify(await saved(page), null, 2));
    assert.ok(created.doc.dashboards[0].id.startsWith('d_'));
    await context.close();
  }
} finally { await browser.close(); await fixture.close(); fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2)); }
console.log(`${report.length} passed, 0 failed. Demo: ${evidence}`);
