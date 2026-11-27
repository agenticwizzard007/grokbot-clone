import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { appearanceFixture, appearanceContext, saved, waitForSaved, reset } from './appearance-fixture.mjs';
import { inspectAlignment } from '../layout-alignment-ui.mjs';
import { readableWords } from '../paper-label-geometry.mjs';

const evidence = path.resolve('.context/ui-custom/demo-g-layout'); fs.mkdirSync(evidence, { recursive: true });
const fixture = await appearanceFixture();
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const report = [], failures = [];
let activePage;
for (const name of ['failure.png', 'failure.json']) fs.rmSync(path.join(evidence, name), { force: true });
try {
  for (const width of [390, 1280]) for (const scheme of ['light', 'dark']) {
    const context = await appearanceContext(browser, fixture, width, scheme);
    const page = await context.newPage(); page.setDefaultTimeout(20000); activePage = page;
    const previewEvents = [], client = await context.newCDPSession(page);
    await client.send('Network.enable');
    client.on('Network.eventSourceMessageReceived', event => {
      try { const data = JSON.parse(event.data); if (data.type === 'ui_preview') previewEvents.push(data); } catch {}
    });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const screen = page.locator('.appearance-settings'), card = screen.locator('.ui-preview-card');
    const shot = async name => page.screenshot({ path: path.join(evidence, `${width}-${scheme}-${name}.png`) });
    const pass = (name, details = {}) => { report.push({ width, scheme, name, ...details }); console.log(`PASS UC-G ${width} ${scheme}: ${name}`); };
    // Preserve integration failures while allowing the rest of the workspace journey to run.
    const integration = (ok, name, details = {}) => { if (ok) pass(name, details); else { failures.push({ width, scheme, name, ...details }); console.log(`FAIL UC-G ${width} ${scheme}: ${name} ${JSON.stringify(details)}`); } };
    const open = async () => { await page.goto('/#settings/appearance'); await screen.waitFor(); await page.waitForFunction(() => !document.querySelector('.appearance-fields')?.disabled); };
    const manage = screen.getByRole('button', { name: 'Manage layout', exact: true });
    const menu = async name => { await manage.click(); await page.getByRole('menuitem', { name, exact: true }).click(); };
    const boardMenu = async (name, action) => { await screen.getByRole('button', { name: `Manage ${name}`, exact: true }).click(); await page.getByRole('menuitem', { name: action, exact: true }).click(); };
    const create = async name => {
      await screen.getByRole('button', { name: 'New dashboard', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'New dashboard', exact: true });
      await dialog.getByRole('textbox', { name: 'Name' }).fill(name); await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      const result = await waitForSaved(page, c => c.doc.dashboards.some(d => d.name === name), 'dashboard create');
      await page.waitForURL(/#dash\//); await open(); return result.doc.dashboards.find(d => d.name === name);
    };
    await page.goto('/#bots'); await reset(page); await open(); await page.evaluate(() => document.fonts.ready);
    assert.deepEqual(await page.evaluate(inspectAlignment, { selector: '.app-settings' }), []);
    await readableWords(screen);
    const words = await screen.evaluate(root => [...root.querySelectorAll('*')].filter(el => el.checkVisibility() && !el.closest('select, .sr-only')).flatMap(el => [...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent)).join(' ').trim().split(/\s+/).filter(Boolean).length);
    assert.ok(words < 250, `Copy budget: ${words}`);
    for (const section of await screen.locator('.appearance-section').all()) {
      assert.ok((await section.locator(':scope > header h2').innerText()).split(/\s+/).length <= 3);
      assert.ok(await section.locator('.appearance-helper').count() <= 1);
      for (const helper of await section.locator('.appearance-helper').all()) assert.ok((await helper.innerText()).split(/\s+/).length <= 8);
    }
    assert.doesNotMatch(await screen.innerText(), /[\u2013\u2014]/);
    assert.equal(await page.locator('.shell-back:visible').count(), 1);
    await shot('layout'); pass('alignment, copy and one Back', { words });
    await screen.getByRole('button', { name: 'Move Tasks up', exact: true }).focus(); await page.keyboard.press('Enter');
    await waitForSaved(page, c => c.doc.layout.sidebar.order[0] === 'tasks', 'sidebar reorder');
    await screen.getByRole('button', { name: 'Move Tasks up', exact: true }).scrollIntoViewIfNeeded(); await shot('sidebar-reordered'); pass('sidebar reorder by keyboard');
    const board = await create('Launch plan'); assert.ok(board.id.startsWith('d_'));
    await screen.getByRole('button', { name: 'Manage Launch plan', exact: true }).scrollIntoViewIfNeeded(); await shot('dashboard-created'); pass('dashboard create opens its route');
    await boardMenu('Launch plan', 'Rename');
    let dialog = page.getByRole('dialog', { name: 'Rename dashboard', exact: true });
    await dialog.getByRole('textbox', { name: 'Name' }).fill('Weekly priorities'); await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    const renamed = await waitForSaved(page, c => c.doc.dashboards[0].name === 'Weekly priorities', 'rename'); pass('dashboard rename');
    await boardMenu('Weekly priorities', 'Set as home');
    await waitForSaved(page, c => c.doc.layout.home.dashboardId === board.id, 'dashboard home');
    await screen.getByLabel('Tab 5', { exact: true }).selectOption(`dashboard:${board.id}`);
    await waitForSaved(page, c => c.doc.layout.phoneTabs.includes(`dashboard:${board.id}`), 'dashboard phone tab');
    await screen.getByRole('button', { name: 'Open Weekly priorities', exact: true }).click(); await page.waitForURL(new RegExp(`#dash/${board.id}$`));
    await page.reload(); assert.equal((await saved(page)).doc.layout.home.dashboardId, board.id); await open();
    await shot('dashboard-home'); pass('dashboard home, phone tab and Open persist');
    await manage.click(); const downloadPromise = page.waitForEvent('download'); await page.getByRole('menuitem', { name: 'Export', exact: true }).click();
    const download = await downloadPromise, exportPath = path.join(evidence, `${width}-${scheme}-export.json`); await download.saveAs(exportPath);
    assert.equal(download.suggestedFilename(), 'swarm-layout.json');
    const imported = JSON.parse(fs.readFileSync(exportPath, 'utf8')); imported.layout.home = { kind: 'tasks' };
    const importPath = path.join(evidence, `${width}-${scheme}-import.json`); fs.writeFileSync(importPath, JSON.stringify(imported));
    pass('export downloads the saved workspace');
    const before = await saved(page);
    const importResponse = page.waitForResponse(response => response.url().endsWith('/api/ui/import/preview') && response.request().method() === 'POST');
    await screen.getByLabel('Import layout file').setInputFiles(importPath); await card.getByRole('button', { name: 'Apply', exact: true }).waitFor();
    const { previewId } = await (await importResponse).json();
    const receivedPending = () => previewEvents.some(event => event.previewId === previewId && event.state === 'pending');
    for (let attempt = 0; !receivedPending() && attempt < 100; attempt++) await page.waitForTimeout(20);
    assert.ok(receivedPending(), 'The import emits a pending SSE event');
    await card.scrollIntoViewIfNeeded();
    const banner = page.getByRole('status', { name: 'Appearance preview', exact: true });
    // X2 gives the visible review card ownership of Apply/Discard. Hiding the
    // duplicate banner must not discard the unsaved, effective import preview.
    await banner.waitFor({ state: 'hidden' });
    assert.equal(await page.getByRole('button', { name: 'Apply', exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: 'Discard', exact: true }).count(), 1);
    await card.getByText('Pending', { exact: true }).waitFor();
    const effectiveHome = await screen.getByLabel('Start on', { exact: true }).inputValue();
    const pendingSaved = await saved(page);
    integration(effectiveHome === 'tasks' && pendingSaved.revision === before.revision && pendingSaved.doc.layout.home.dashboardId === board.id, 'manual import preview survives pending SSE', { effectiveHome, revision: pendingSaved.revision });
    await manage.scrollIntoViewIfNeeded(); await banner.waitFor({ state: 'visible' });
    assert.ok(await banner.getByRole('button', { name: 'Apply', exact: true }).isEnabled());
    assert.ok(await banner.getByRole('button', { name: 'Discard', exact: true }).isEnabled());
    await card.scrollIntoViewIfNeeded(); await banner.waitFor({ state: 'hidden' });
    await shot('import-preview');
    const geometry = await page.evaluate(() => {
      const shell = document.querySelector('.app').getBoundingClientRect();
      const banners = [...document.querySelectorAll('#root > .ui-runtime-banner')].filter(el => el.checkVisibility()).map(el => el.getBoundingClientRect());
      return { shellTop: shell.top, shellBottom: shell.bottom, shellHeight: shell.height, bannerBottom: Math.max(0, ...banners.map(rect => rect.bottom)), viewportHeight: innerHeight, viewportWidth: innerWidth, documentWidth: document.documentElement.scrollWidth, documentHeight: document.documentElement.scrollHeight };
    });
    integration(geometry.shellHeight > 0 && Math.abs(geometry.shellTop - geometry.bannerBottom) <= 1 && geometry.shellBottom <= geometry.viewportHeight + 1 && geometry.documentHeight <= geometry.viewportHeight + 1 && geometry.documentWidth <= geometry.viewportWidth + 1, 'shell fits below the preview banner', geometry);
    await card.getByRole('button', { name: 'Apply', exact: true }).click(); await card.getByText('Applied', { exact: true }).waitFor();
    await waitForSaved(page, c => c.doc.layout.home.kind === 'tasks', 'import Apply'); await shot('import-applied'); pass('import card Apply');
    await card.getByRole('button', { name: 'Show before', exact: true }).focus(); await page.keyboard.down('Space');
    assert.equal(await card.getByRole('button', { name: 'Show before', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await screen.getByLabel('Start on', { exact: true }).inputValue(), board.id);
    await shot('show-before'); await page.keyboard.up('Space'); pass('applied card compares the previous layout');
    await card.getByRole('button', { name: 'Undo', exact: true }).click(); await card.getByText('Undone', { exact: true }).waitFor();
    await waitForSaved(page, c => c.doc.layout.home.dashboardId === board.id, 'Undo import'); await shot('undo'); pass('card Undo restores the saved home');
    const beforeDiscard = (await saved(page)).revision;
    await screen.getByLabel('Import layout file').setInputFiles(importPath); await card.getByRole('button', { name: 'Discard', exact: true }).click();
    await card.getByText('Discarded', { exact: true }).waitFor(); assert.equal((await saved(page)).revision, beforeDiscard); pass('import Discard does not save');
    await menu('History'); dialog = page.getByRole('dialog', { name: 'Layout history', exact: true });
    const restores = dialog.getByRole('button', { name: /^Restore revision/ }); await restores.first().waitFor(); assert.ok(await restores.count() <= 50);
    await shot('history'); await dialog.getByRole('button', { name: `Restore revision ${renamed.revision}`, exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    await waitForSaved(page, c => c.doc.layout.home.kind === 'default', 'history restore'); pass('history restores a selected revision');
    await boardMenu('Weekly priorities', 'Set as home'); await waitForSaved(page, c => c.doc.layout.home.dashboardId === board.id, 'home before delete');
    await boardMenu('Weekly priorities', 'Delete'); dialog = page.getByRole('dialog', { name: 'Delete dashboard', exact: true });
    assert.match(await dialog.innerText(), /0 widgets/); await shot('delete-confirm');
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    const deleted = await waitForSaved(page, c => !c.doc.dashboards.length, 'delete');
    assert.equal(deleted.doc.layout.home.kind, 'default'); assert.ok(!deleted.doc.layout.phoneTabs.includes(`dashboard:${board.id}`)); pass('dashboard Delete confirms count and clears references');
    await create('Daily summary');
    await screen.getByLabel('Start on', { exact: true }).selectOption('tasks'); await waitForSaved(page, c => c.doc.layout.home.kind === 'tasks', 'home before reset');
    await screen.getByRole('button', { name: 'Change Focus composer shortcut', exact: true }).click(); await page.keyboard.press('Alt+j');
    await waitForSaved(page, c => c.doc.keybindings.focusComposer === 'Alt+J', 'shortcut before reset');
    await menu('Reset'); dialog = page.getByRole('dialog', { name: 'Reset layout', exact: true });
    assert.match(await dialog.innerText(), /Resets navigation, visibility and shortcuts/); assert.match(await dialog.innerText(), /Keeps 1 dashboard\./);
    const beforeReset = (await saved(page)).revision; await shot('reset-confirm'); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal((await saved(page)).revision, beforeReset); pass('Reset confirmation can cancel');
    await menu('Reset'); dialog = page.getByRole('dialog', { name: 'Reset layout', exact: true }); await dialog.getByRole('button', { name: 'Reset', exact: true }).click();
    await waitForSaved(page, c => c.doc.layout.home.kind === 'default' && !Object.keys(c.doc.keybindings).length && c.doc.dashboards.length === 1, 'reset keeping dashboards');
    await screen.getByRole('button', { name: 'Undo', exact: true }).click();
    await waitForSaved(page, c => c.doc.layout.home.kind === 'tasks' && c.doc.keybindings.focusComposer === 'Alt+J', 'Undo reset'); pass('Reset keeps dashboards and supports Undo');
    await menu('Reset'); dialog = page.getByRole('dialog', { name: 'Reset layout', exact: true }); await dialog.getByLabel('Reset', { exact: true }).selectOption('all');
    assert.match(await dialog.innerText(), /Deletes 1 dashboard and 0 widgets/); await dialog.getByRole('button', { name: 'Reset', exact: true }).click();
    await waitForSaved(page, c => !c.doc.dashboards.length && c.doc.layout.home.kind === 'default', 'reset including dashboards');
    await open(); assert.equal((await saved(page)).doc.dashboards.length, 0); await shot('reset-complete'); pass('Reset can include dashboards and persists');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(evidence, `${width}-${scheme}-config.json`), JSON.stringify(await saved(page), null, 2)); await context.close();
  }
} catch (error) {
  if (activePage && !activePage.isClosed()) {
    await activePage.screenshot({ path: path.join(evidence, 'failure.png') });
    fs.writeFileSync(path.join(evidence, 'failure.json'), JSON.stringify({ passed: report.length, error: error.message, url: activePage.url(), alerts: await activePage.getByRole('alert').allTextContents(), saved: await saved(activePage) }, null, 2));
  }
  throw error;
} finally { await browser.close(); await fixture.close(); fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify({ passed: report.length, failed: failures.length, checks: report, failures }, null, 2)); }
console.log(`${report.length} passed, ${failures.length} failed. Demo: ${evidence}`);
assert.equal(failures.length, 0, 'Runtime integration checks must pass');
