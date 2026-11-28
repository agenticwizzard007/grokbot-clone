import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { inspectAlignment } from '../layout-alignment-ui.mjs';
import { readableWords } from '../paper-label-geometry.mjs';
import { runIntegrationDemo } from './integration-routes-ui.mjs';

const paperResults = [];
const setTheme = (page, theme) => page.evaluate(async theme => {
  const { setTheme } = await import('/src/customization/runtime.ts');
  await setTheme(theme);
  await document.fonts.ready;
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}, theme);

// Audit only the new Settings surface and its shared output-card mount. The
// handoff and Flow component source belongs to HO-P and is not changed here.
function inspectPaper(selector) {
  const root = document.querySelector(selector), issues = [];
  const visible = el => el.checkVisibility() && !el.closest('.sr-only, option, style, script');
  const all = [root, ...root.querySelectorAll('*')].filter(visible);
  const text = all.flatMap(el => [...el.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent)).join(' ');
  if (/mock:|mock-delay:|[\u2013\u2014]/i.test(text)) issues.push('Test script or forbidden punctuation is visible');
  for (const el of all) {
    const css = getComputedStyle(el), rect = el.getBoundingClientRect();
    const ownText = [...el.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
    if (ownText && parseFloat(css.fontSize) < (el.closest('.cfg-chip,.ho-chip') ? 12 : 13)) issues.push('Text below the Paper minimum: ' + el.textContent.trim());
    if (ownText && !el.matches('h1,h2,h3') && parseFloat(css.fontSize) > 15) issues.push('Body above 15px: ' + el.textContent.trim());
    if (el.matches('label,button,summary,.layout-row__title,.layout-row__subtitle,.cfg-chip,.ho-chip') && (el.scrollWidth > el.clientWidth + 1 || css.textOverflow === 'ellipsis' || !['none', ''].includes(css.webkitLineClamp))) issues.push(`Clipped label: ${el.textContent.trim()} (${el.scrollWidth}/${el.clientWidth}, ${css.textOverflow}, ${css.webkitLineClamp})`);
    if (el.matches('[data-layout="row"],button,summary,select,.agents-check') && rect.height < 43) issues.push('Control below 44px: ' + el.textContent.trim());
    if (el.matches('[data-layout="card"]') && (css.borderRadius !== '12px' || ['paddingTop','paddingRight','paddingBottom','paddingLeft'].some(key => css[key] !== '16px'))) issues.push('Card differs from 12px radius and 16px padding');
    if (el.matches('[role="status"],.cfg-chip,.ho-chip') && parseFloat(css.borderRadius) < 12) issues.push('Status is not a chip: ' + el.textContent.trim());
    if (el.matches('.cfg-chip,.ho-chip') && (Math.abs(rect.height - 20) > 1 || css.fontSize !== '12px' || css.lineHeight !== '16px' || css.fontWeight !== '500')) issues.push('Chip differs from Paper metrics: ' + el.textContent.trim());
    if (el.matches('a') && css.textDecorationLine.includes('underline')) issues.push('Raw underlined link');
    if (el.matches('[data-layout="row"],[data-layout="button-group"]') && el.querySelectorAll('.cfg-btn--primary,.ho-button--primary').length > 1) issues.push('Multiple primary actions in a row');
    if (el.dataset.layout === 'button-group') {
      const buttons = [...el.children].filter(visible).map(child => child.getBoundingClientRect());
      if (buttons.some(button => Math.abs(button.width - buttons[0].width) > 1)) issues.push('Unequal action widths');
      if (buttons.some(button => buttons.filter(other => Math.abs(button.top - other.top) < 1).length > 2)) issues.push('More than two actions per row');
    }
    for (const gap of [css.rowGap, css.columnGap]) if (gap.endsWith('px') && ![0,4,8,16,24,32,40,48].includes(parseFloat(gap))) issues.push('Off-scale gap: ' + gap);
  }
  return { issues: [...new Set(issues)], words: text.trim().split(/\s+/).filter(Boolean).length };
}

async function paperMatrix({ page, width, server, check, screenshots, evidence }, selector, name) {
  if (width !== 1280) return;
  for (const testedWidth of [320, 390, 500, 1280]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width: testedWidth, height: 1000 }); await setTheme(page, theme);
    // Reload the persisted theme to remove the transient customization Undo
    // banner, and wait for the resized settings frame and resources to settle.
    await page.reload(); await page.locator(selector).waitFor();
    if (name === 'settings-agents') {
      await page.getByLabel('Links from', { exact: true }).selectOption(server.fixture.bot.id);
      await page.getByLabel('Handoff mode for Research', { exact: true }).waitFor();
    }
    await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const result = await page.evaluate(inspectPaper, selector);
    assert.deepEqual(result.issues, [], `${name} ${testedWidth} ${theme}`);
    assert.deepEqual(await page.evaluate(inspectAlignment, { selector, requirePage: false }), []);
    if (name === 'settings-agents' && testedWidth <= 760) assert.equal(await page.getByRole('button', { name: 'Back', exact: true }).count(), 1);
    if (name === 'settings-agents') {
      const info = page.getByRole('button', { name: 'About handoffs', exact: true });
      await info.focus(); await page.getByRole('tooltip').waitFor();
      assert.deepEqual(await page.evaluate(inspectAlignment, { selector, requirePage: false }), []);
      assert.deepEqual((await page.evaluate(inspectPaper, selector)).issues, []);
      await page.keyboard.press('Escape');
      assert.equal(await page.getByRole('tooltip').count(), 0);
      await page.locator('.agents-settings summary').click();
      assert.deepEqual((await page.evaluate(inspectPaper, selector)).issues, []);
      assert.deepEqual(await page.evaluate(inspectAlignment, { selector, requirePage: false }), []);
      await page.locator('.agents-settings summary').click();
      const words = await page.locator('.paper-settings').evaluate(el => el.innerText.trim().split(/\s+/).length);
      result.mainWords = words;
      // The pre-polish captures count 191 phone / 212 desktop words, including
      // settings navigation. Keep at most 30%, as BUILD-SPEC 0b requires.
      assert.ok(words <= (testedWidth <= 760 ? 191 : 212) * 0.3, `Copy budget: ${words}`);
    }
    if ([390,1280].includes(testedWidth)) {
      const screenshot = path.join(evidence, `${name}-after-${testedWidth}-${theme}.png`);
      await page.screenshot({ path: screenshot, fullPage: true }); screenshots.push(screenshot);
    }
    paperResults.push({ name, width: testedWidth, theme, ...result });
    check(`Paper ${name} at ${testedWidth} ${theme}`, result);
    if (name === 'settings-agents') {
      // A cold Settings entry makes the list the previous page for Back.
      if (testedWidth <= 760) {
        await page.goto('about:blank');
        await page.goto(server.base + '/#settings');
      }
      const nav = page.getByRole('navigation', { name: 'Settings sections', exact: true });
      await nav.waitFor();
      assert.deepEqual(await nav.locator('.layout-section__header h2').allTextContents(), ['Workspace', 'Connections']);
      assert.equal(await nav.locator('.settings-nav__item').count(), 14);
      const agents = nav.getByRole('button', { name: 'Agents', exact: true });
      assert.equal(await agents.count(), 1);
      assert.equal(await agents.locator('svg.lucide-users').count(), 1);
      await readableWords(nav);
      assert.deepEqual(await page.evaluate(inspectAlignment, { selector: '.app-settings' }), []);
      await agents.click(); await page.getByLabel('Agent handoffs', { exact: true }).waitFor();
      if (testedWidth <= 760) {
        const back = page.getByRole('button', { name: 'Back', exact: true });
        assert.equal(await back.count(), 1);
        await back.click(); await nav.waitFor();
        await agents.click(); await page.getByLabel('Agent handoffs', { exact: true }).waitFor();
      }
      check(`Settings navigation has fourteen sections in two groups at ${testedWidth} ${theme}`);
    }
  }
  await page.setViewportSize({ width, height: 1000 }); await setTheme(page, 'light');
}

await runIntegrationDemo({ outputFlow: async args => {
  await args.page.locator('.settings-output-card').waitFor();
  await paperMatrix(args, '.settings-output-card', 'output-card');
}, settingsFlow: async ({ page, width, server, check, alignment, openSidebar, screenshots, evidence }) => {
  const settingsNav = page.getByRole('navigation', { name: 'Settings sections', exact: true });
  const back = page.getByRole('button', { name: 'Back', exact: true });
  const policy = page.getByLabel('Agent handoffs', { exact: true });
  const enabled = page.getByRole('switch', { name: 'Enable handoffs and loops', exact: true });
  const read = async route => { const response = await page.request.get(server.base + '/api' + route); assert.equal(response.status(), 200); return response.json(); };
  const save = async (route, action) => {
    const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api' + route && r.request().method() === 'PUT');
    await action(); assert.equal((await response).status(), 200);
    await page.waitForFunction(() => document.querySelector('.agents-settings')?.getAttribute('aria-busy') === 'false');
  };
  const pickSettings = async label => {
    if (width === 390 && !await settingsNav.isVisible()) await back.click();
    await settingsNav.getByRole('button', { name: label, exact: true }).click();
  };
  await openSidebar();
  await page.locator('.sidebar').getByRole('button', { name: /Account & settings$/ }).click();
  await page.getByRole('menuitem', { name: /^Settings/ }).click();
  await settingsNav.getByRole('button', { name: 'Agents', exact: true }).click();
  await policy.waitFor();
  assert.equal(new URL(page.url()).hash, '#settings/agents');
  await alignment(); check('Settings menu opens Agents with shared navigation and one phone Back');

  for (const value of ['links_only', 'off', 'team']) {
    await save('/handoff-settings', () => policy.selectOption(value));
    assert.equal((await read('/handoff-settings')).settings.agentHandoffs, value);
  }
  check('Team, Links only and Off persist through the real settings API');
  await save('/handoff-settings', () => enabled.click());
  assert.equal((await read('/handoff-settings')).settings.enabled, false);
  await page.reload(); await enabled.waitFor();
  assert.equal(await enabled.getAttribute('aria-checked'), 'false');
  assert.equal(await page.getByRole('button', { name: 'Open Loops', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Add link between agents', exact: true }).count(), 0);
  await save('/handoff-settings', () => enabled.click());
  assert.equal((await read('/handoff-settings')).settings.enabled, true);
  check('Disabled handoffs can be re-enabled after a fresh load');

  await page.getByLabel('Links from', { exact: true }).selectOption(server.fixture.bot.id);
  const mode = page.getByLabel('Handoff mode for Research', { exact: true });
  await mode.waitFor();
  const linksPath = '/handoff-links?botId=' + encodeURIComponent(server.fixture.bot.id);
  const before = (await read(linksPath)).links[0];
  for (const value of ['off', 'auto', 'suggest']) {
    await save('/handoff-links', () => mode.selectOption(value));
    const after = (await read(linksPath)).links[0];
    assert.equal(after.mode, value); assert.equal(after.id, before.id);
    assert.equal(after.template, before.template); assert.equal(after.trigger, before.trigger);
  }
  const auto = page.getByLabel('Auto approve loops started by agents with Research', { exact: true });
  assert.equal(await auto.isChecked(), false);
  await save('/handoff-links', () => auto.click());
  assert.equal(await auto.isChecked(), true);
  assert.equal((await read(linksPath)).links[0].autoApproveLoops, true);
  await page.reload(); await page.getByLabel('Links from', { exact: true }).selectOption(server.fixture.bot.id);
  await auto.waitFor(); assert.equal(await auto.isChecked(), true);
  await save('/handoff-links', () => auto.click());
  assert.equal(await auto.isChecked(), false);
  check('Standing links persist Off, Automatic, Suggest and exact-pair loop auto-approval');

  // A failed save keeps the prior policy and offers an honest inline error.
  await page.route('**/api/handoff-settings', async route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 503, json: { error: 'Handoff settings unavailable. Try again.' } }) : route.continue());
  await policy.selectOption('links_only');
  await page.getByRole('alert').filter({ hasText: 'Not saved' }).waitFor();
  await page.getByRole('button', { name: 'Save error', exact: true }).focus();
  await page.getByRole('tooltip').filter({ hasText: 'Handoff settings unavailable' }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await policy.inputValue(), 'team');
  await page.unroute('**/api/handoff-settings');
  await save('/handoff-settings', () => policy.selectOption('links_only'));
  await save('/handoff-settings', () => policy.selectOption('team'));
  check('Failed settings save stays inline and can be retried without changing the saved policy');

  await page.locator('.agents-settings summary').click();
  for (const text of ['4 (1 to 10)', '30 (5 to 240)', '10 (1 to 30)', 'Running loops', 'Starts per day']) {
    assert.equal(await page.getByText(text, { exact: true }).count(), 1);
  }
  await alignment();
  await page.locator('.agents-settings summary').click();
  const screenshot = path.join(evidence, `settings-agents-${width}.png`);
  await page.setViewportSize({ width, height: Math.min(4000, await page.locator('.app-settings__page').evaluate(el => el.scrollHeight) + 160) });
  await page.screenshot({ path: screenshot, fullPage: true }); screenshots.push(screenshot);
  await page.setViewportSize({ width, height: 1000 });
  check('Loop defaults and hard bounds use readable Paper rows');

  await page.getByRole('button', { name: 'Open Loops', exact: true }).click();
  await page.getByRole('button', { name: 'New loop', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'New loop', exact: true });
  const passes = sheet.getByLabel('Up to passes', { exact: true });
  assert.equal(await passes.inputValue(), '4'); assert.equal(await passes.getAttribute('min'), '1'); assert.equal(await passes.getAttribute('max'), '10');
  await sheet.locator('summary').filter({ hasText: 'Advanced' }).click();
  for (const [label, value, min, max] of [['Minutes', '30', '5', '240'], ['Step timeout in minutes', '10', '1', '30']]) {
    const field = sheet.getByLabel(label, { exact: true });
    assert.equal(await field.inputValue(), value); assert.equal(await field.getAttribute('min'), min); assert.equal(await field.getAttribute('max'), max);
  }
  await sheet.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.goBack(); await policy.waitFor(); await alignment();
  check('Agents opens the real loop builder with matching defaults and bounds, then returns');

  await page.getByRole('button', { name: 'Add link between agents', exact: true }).click();
  const linkSheet = page.getByRole('dialog', { name: 'Handoff links', exact: true });
  await linkSheet.waitFor(); await page.keyboard.press('Escape'); await linkSheet.waitFor({ state: 'hidden' });
  await page.goBack(); await policy.waitFor();
  check('Standing-link entry opens the real Flow editor and returns to Agents');

  await pickSettings('Layout');
  await page.getByRole('region', { name: 'Dashboards', exact: true }).waitFor();
  const createDashboard = page.getByRole('region', { name: 'Dashboards', exact: true }).getByRole('button').filter({ hasText: /^Create$/ });
  await createDashboard.waitFor();
  assert.equal(await createDashboard.count(), 1);
  await pickSettings('Agents'); await policy.waitFor(); await alignment();
  await page.reload(); await policy.waitFor(); await alignment();
  assert.equal(new URL(page.url()).hash, '#settings/agents');
  check('Layout dashboard manager and Agents share phone and desktop navigation; cold Agents works');
  await page.getByLabel('Links from', { exact: true }).selectOption(server.fixture.bot.id);
  await page.getByLabel('Handoff mode for Research', { exact: true }).waitFor();
  for (const theme of ['light', 'dark']) {
    await pickSettings('General');
    await page.getByRole('radio', { name: theme === 'light' ? 'Light' : 'Dark', exact: true }).click();
    await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
    await page.reload(); await page.getByRole('radio', { name: theme === 'light' ? 'Light' : 'Dark', exact: true }).waitFor();
    const reference = path.join(evidence, `settings-reference-${width}-${theme}.png`);
    await page.screenshot({ path: reference, fullPage: true }); screenshots.push(reference);
    await pickSettings('Agents'); await policy.waitFor();
    await openSidebar(); await page.locator('.sidebar').getByRole('button', { name: /^Tasks(?: \d|$)/ }).click();
    await page.locator('.task-card').first().waitFor();
    const tasks = path.join(evidence, `tasks-reference-${width}-${theme}.png`);
    await page.screenshot({ path: tasks, fullPage: true }); screenshots.push(tasks);
    await page.goBack(); await policy.waitFor();
  }
  await page.getByLabel('Links from', { exact: true }).selectOption(server.fixture.bot.id);
  await page.getByLabel('Handoff mode for Research', { exact: true }).waitFor();
  await paperMatrix({ page, width, server, check, screenshots, evidence }, '.agents-settings', 'settings-agents');
} });

fs.writeFileSync(path.resolve('.context/handoffs/demo-i/paper-report.json'), JSON.stringify(paperResults, null, 2));
