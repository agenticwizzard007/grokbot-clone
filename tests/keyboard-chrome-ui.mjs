// Actual Tab, Shift+Tab, Enter and Escape on the local production app only.
import assert from 'node:assert/strict';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { preview } from '../web/node_modules/vite/dist/node/index.js';
import path from 'node:path';
import { chromium } from 'playwright';
const evidence = '.context/keyboard-chrome';
await mkdir(evidence, { recursive: true });
const outDir = path.resolve(evidence, 'dist');
await cp('web/dist', outDir, { recursive: true });
const vite = await preview({ root: `${process.cwd()}/web`, build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
process.env.UI_ORIGIN = `http://127.0.0.1:${vite.httpServer.address().port}`;
const { fixturePage, origin } = await import('./qa-r3-work-fixture.mjs');
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const results = [];
let lastPage;
async function focused(page) {
  const state = await page.evaluate(() => {
    const el = document.activeElement, indicator = el.closest('.bird-picker__choice') ?? el, s = getComputedStyle(indicator), r = indicator.getBoundingClientRect();
    const parentRing = el.closest('.settings-search, .pill-input');
    return { name: el.getAttribute('aria-label') || el.textContent?.trim() || el.tagName, tag: el.tagName, className: el.className,
      ring: (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 1 && s.outlineColor !== 'transparent') || s.boxShadow !== 'none' || !!(parentRing && getComputedStyle(parentRing).boxShadow !== 'none'),
      focusVisible: el.matches(':focus-visible'), visible: r.width > 0 && r.height > 0 && !el.closest('[inert]') };
  });
  assert.ok(state.visible && state.focusVisible && state.ring, `visible keyboard focus: ${JSON.stringify(state)}`);
  return state;
}
async function tabTo(page, locator, direction = 'Tab', max = 100) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press(direction);
    // A full chrome cycle may pass through the browser document boundary.
    if (await page.evaluate(() => document.activeElement === document.body)) continue;
    await focused(page);
    if (await locator.evaluateAll(els => els.includes(document.activeElement))) return;
  }
  throw Error(`Tab did not reach ${locator}`);
}
async function walkDialog(page, dialog) {
  const controls = dialog.locator('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]');
  const expected = await controls.evaluateAll(els => els.filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && el.tabIndex >= 0).length);
  const visited = new Set();
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let i = 0; i <= expected; i++) {
      await page.keyboard.press(key);
      await focused(page);
      assert.equal(await dialog.evaluate(el => el.contains(document.activeElement)), true, 'modal contains Tab focus');
      visited.add(await controls.evaluateAll(els => els.indexOf(document.activeElement)));
    }
  }
  assert.equal(visited.size, expected, 'walk reaches every dialog control in both directions');
}
async function walkSurface(page, scope) {
  const controls = scope.locator('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]');
  const visible = [];
  for (const control of await controls.all()) if (await control.isVisible() && await control.evaluate(el => el.tabIndex >= 0 && (el.type !== 'radio' || el.checked))) visible.push(control);
  assert.ok(visible.length > 0);
  for (const direction of ['Tab', 'Shift+Tab']) {
    for (const control of direction === 'Tab' ? visible : [...visible].reverse()) {
      if (!await control.evaluate(el => el === document.activeElement)) await tabTo(page, control, direction, 150);
      await focused(page);
    }
  }
}
try {
  for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
    const { page, fixture, errors, writes } = await fixturePage(browser, { width, height: 900 }, { colorScheme: theme });
    lastPage = page;
    await page.addInitScript(theme => { localStorage.setItem('swarm.theme', theme); localStorage.setItem('swarm.sidebarCollapsed', '0'); }, theme);
    fixture.bots[0].onboarding = { status: 'active', revision: 1 };
    fixture.bots[0].model = 'claude/opus-4-6';
    fixture.respond = ({ path }) => {
      if (path === '/api/models') return { json: { provider: 'claude-cli', billing: 'plan', plan: 'max', defaultModel: 'claude/opus-4-6',
        models: [{ id: 'claude/opus-4-6', name: 'Opus 4.6', short: 'Opus 4.6', author: 'anthropic', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' }], favourites: ['claude/opus-4-6'] } };
      if (path.endsWith('/rows')) return { json: { generation: 1, rows: [{ botId: 'coordinator', generation: 1, seq: 1, updatedSeq: 1, kind: 'card', audience: 'user', createdAt: Date.now(), body: {
        type: 'card', card: 'approval', approvalId: 'local-keyboard-card', title: 'Allow saving this file?', detail: '', tool: 'save_file', args: { path: 'fixture.txt', content: 'Local fixture' }, status: 'pending',
      } }] } };
      if (path.endsWith('/suggested-apps')) return { json: { suggestions: [] } };
      return null;
    };
    await page.goto(`${origin}/#bot/coordinator`);
    await page.locator('.composer__input').waitFor();
    await page.waitForFunction(() => document.querySelector('.model-pill')?.getAttribute('aria-busy') === 'false');
    const chip = page.locator('.model-pill'), field = page.locator('.composer__input'), plus = page.getByRole('button', { name: 'More actions', exact: true });
    // DOM order and visual order must agree: plus, field, model, action.
    await tabTo(page, plus);
    await page.keyboard.press('Enter');
    await page.getByRole('menuitem', { name: 'Talk live', exact: true }).waitFor();
    await page.keyboard.press('Tab'); await focused(page);
    await page.keyboard.press('Escape');
    await tabTo(page, field);
    await page.keyboard.type('Hi all.');
    await page.keyboard.press('Tab');
    assert.equal(await chip.evaluate(el => el === document.activeElement), true, 'field Tab reaches model');
    await focused(page);
    await page.keyboard.press('Enter');
    const picker = page.getByRole('dialog', { name: 'Choose a model', exact: true });
    await picker.waitFor(); await picker.locator('.mm-row__main').waitFor(); await walkDialog(page, picker);
    await page.keyboard.press('Escape');
    assert.equal(await chip.evaluate(el => el === document.activeElement), true, 'Escape returns to chip');
    await focused(page);
    await page.screenshot({ path: `${evidence}/chip-focus-${width}-${theme}.png` });
    await page.keyboard.press('Tab'); await focused(page);
    assert.equal(await page.locator('.composer__right').evaluate(el => el.contains(document.activeElement)), true, 'model Tab reaches send');
    await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Shift+Tab');
    assert.equal(await field.evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.press('Backspace');
    await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); await focused(page);
    assert.equal(await page.locator('.composer__right').evaluate(el => el.contains(document.activeElement)), true, 'empty composer has a keyboard action');
    await tabTo(page, page.locator('.chat__header button').first());
    for (const button of await page.locator('.chat__header button').all()) if (await button.isVisible()) await tabTo(page, button);
    await tabTo(page, page.locator('.chat__pill'), 'Shift+Tab'); await page.keyboard.press('Enter');
    await page.getByRole('menuitem', { name: /^Show details/ }).waitFor();
    await page.keyboard.press('Escape'); await focused(page);
    await tabTo(page, page.getByRole('button', { name: 'Show details', exact: true })); await page.keyboard.press('Enter');
    const details = page.getByRole('complementary', { name: 'Conversation details', exact: true });
    await details.waitFor(); await walkSurface(page, details);
    await page.keyboard.press('Escape'); await details.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.matches('.chat__details'));
    await focused(page);
    for (const name of ["Don't allow", 'Always allow', 'Allow']) await tabTo(page, page.locator('.approval-card').getByRole('button', { name, exact: true }));
    await page.keyboard.press('Tab'); await focused(page);
    assert.equal(await page.locator('.approval-card').evaluate(el => el.contains(document.activeElement)), false, 'Tab can leave approval without deciding');
    if (width === 390) { await tabTo(page, page.getByRole('button', { name: 'All Bots', exact: true })); await page.keyboard.press('Enter'); }
    const search = page.locator('.sidebar').getByRole('button', { name: 'Search', exact: true });
    await tabTo(page, search); await page.keyboard.press('Enter');
    const searchDialog = page.getByRole('dialog', { name: 'Search', exact: true });
    await searchDialog.waitFor(); await walkDialog(page, searchDialog);
    await page.keyboard.press('Escape');
    assert.equal(await search.evaluate(el => el === document.activeElement), true); await focused(page);
    await page.keyboard.press('Enter'); await searchDialog.waitFor();
    await tabTo(page, searchDialog.getByRole('button', { name: 'Close search', exact: true })); await page.keyboard.press('Enter');
    await searchDialog.waitFor({ state: 'detached' });
    await tabTo(page, page.locator('.sidebar').getByRole('button', { name: 'Tasks', exact: true }));
    await tabTo(page, page.locator('.sidebar-usage'));
    await tabTo(page, page.getByRole('button', { name: 'Account & settings', exact: true })); await page.keyboard.press('Enter');
    await tabTo(page, page.getByRole('menuitem', { name: /^Settings/ })); await page.keyboard.press('Enter');
    await page.locator('.app-settings').waitFor();
    await walkSurface(page, page.locator('.app-settings, .settings-nav'));
    if (width === 390) {
      await tabTo(page, page.getByRole('button', { name: 'General', exact: true })); await page.keyboard.press('Enter');
      await page.locator('.settings-appearance').waitFor();
      await walkSurface(page, page.locator('.app-settings'));
      await page.keyboard.press('Escape');
    }
    await page.keyboard.press('Escape'); await page.locator('.app-settings').waitFor({ state: 'detached' });
    if (width === 390 && !await search.isVisible()) { await tabTo(page, page.getByRole('button', { name: 'All Bots', exact: true })); await page.keyboard.press('Enter'); }
    await tabTo(page, page.getByRole('button', { name: 'New Bot', exact: true })); await page.keyboard.press('Enter');
    await page.getByRole('heading', { name: 'Create a Bot', exact: true }).waitFor();
    await tabTo(page, page.getByRole('textbox', { name: 'Bot name', exact: false })); await page.keyboard.type('Local keyboard Bot');
    await walkSurface(page, page.locator('.setup-create'));
    await tabTo(page, page.locator('.bird-picker input:checked'));
    for (let i = 0; i < await page.locator('.bird-picker input').count(); i++) { await page.keyboard.press('ArrowRight'); await focused(page); }
    await page.keyboard.press('Escape'); await page.getByRole('heading', { name: 'Create a Bot', exact: true }).waitFor({ state: 'detached' });
    assert.deepEqual(errors, []); assert.deepEqual(writes.filter(write => !write.path.endsWith('/suggested-apps')), [], 'keyboard walk does not decide approvals or mutate data');
    results.push({ width, theme, pass: true });
    console.log(`PASS keyboard chrome ${width} ${theme}: composer, header, sidebar, picker, Search, Settings, Create a Bot, approval`);
    await page.context().close();
  }
} catch (error) { await lastPage?.screenshot({ path: `${evidence}/failure.png` }); throw error; }
finally { await writeFile(`${evidence}/results.json`, JSON.stringify(results, null, 2)); await browser.close(); await new Promise(resolve => vite.httpServer.close(resolve)); }
