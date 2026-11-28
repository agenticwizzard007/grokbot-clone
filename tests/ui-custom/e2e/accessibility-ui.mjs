// Ported from UC-H, retargeted to the current product and navigation inventory.
// npm run test:ui-custom discovers this script. Loopback fixtures only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

let AxeBuilder;
try { ({ default: AxeBuilder } = await import('@axe-core/playwright')); }
catch (error) {
  throw new Error('Accessibility checks require @axe-core/playwright. Run npm install at the repository root, then rerun node tests/ui-custom/e2e/accessibility-ui.mjs.', { cause: error });
}
const axeCore = (await import('axe-core')).default;
const rules = [...new Set([...axeCore.getRules(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).map(rule => rule.ruleId), 'label-content-name-mismatch', 'scrollable-region-focusable'])];
const { accessibilityFixture, navigationRoutes } = await import('../fixtures/accessibility.mjs');
const out = path.resolve(process.env.A11Y_OUTPUT || '.context/ui-custom/accessibility');
fs.mkdirSync(out, { recursive: true });
const results = [];
const modalSelector = 'dialog[open], [role=dialog][aria-modal=true]';
async function assertSingleDialog(page, flow) {
  const names = await page.locator(modalSelector).evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label') || node.textContent?.trim().slice(0, 80)));
  assert.ok(names.length <= 1, `${flow}: at most one dialog may be open; found ${names.length}: ${names.join(', ')}`);
  const maximum = await page.evaluate(() => window.__a11yMaxDialogs);
  assert.ok(Number.isInteger(maximum), `${flow}: dialog tracking must be initialized in the current document`);
  assert.ok(maximum <= 1, `${flow}: multiple dialogs were open during the sheet flow (maximum ${maximum})`);
}
async function openAgentSheet(page) {
  await page.getByRole('button', { name: 'Add widget', exact: true }).click();
  await page.getByRole('dialog', { name: 'Add widget', exact: true }).waitFor();
  await assertSingleDialog(page, 'Add widget');
  await page.getByRole('button', { name: /^Ask your agent/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Ask your agent', exact: true });
  await dialog.waitFor();
  await assertSingleDialog(page, 'Add widget to Ask your agent');
  assert.equal(await dialog.evaluate(node => node.contains(document.activeElement)), true, 'Focus moves inside Ask your agent');
}
async function openRoutines(page) {
  await page.getByRole('button', { name: 'Routines', exact: true }).click();
  await page.getByRole('region', { name: 'Routines', exact: true }).getByRole('switch').first().waitFor();
}
async function openUsageMeter(page, collapsed) {
  const response = await page.request.get(`${server.base}/api/usage/summary`);
  assert.equal(response.status(), 200);
  const summary = await response.json();
  // Exercise a populated progress meter using synthetic quota figures only.
  summary.plan = { ...summary.plan, name: 'API credits', billing: 'api', provider: null,
    unit: 'usd', usedCents: 1234, limitCents: 5000, percentUsed: 24.68 };
  await page.route('**/api/usage/summary', route => route.fulfill({ json: summary }));
  await page.evaluate(async collapsed => {
    const { useStore } = await import('/src/store.ts');
    useStore.setState({ sidebarCollapsed: collapsed });
    await (await import('/src/lib/planUsage.ts')).refreshPlanUsage();
  }, collapsed);
  const mobile = page.viewportSize().width <= 760;
  if (mobile) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  const meter = page.locator('.sidebar-usage:visible');
  await meter.and(page.getByRole('button', { name: /API credits.*\$12\.34 of \$50\.00.*24\.7% used/ })).waitFor();
  // Phone navigation intentionally expands either saved desktop preference.
  assert.equal(await meter.getAttribute('aria-label') !== null, collapsed && !mobile);
  assert.equal(await meter.getByRole('progressbar', { name: 'API credits usage', exact: true }).count(), collapsed && !mobile ? 0 : 1);
}
async function showUsage(page, surface) {
  const sidebar = page.locator('.sidebar');
  if (!await sidebar.isVisible()) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  if (surface === 'rail' && page.viewportSize().width > 760 && !await sidebar.evaluate(node => node.classList.contains('is-collapsed'))) {
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
  }
  const meter = sidebar.locator('.sidebar-usage');
  await meter.waitFor();
  if (await sidebar.evaluate(node => node.classList.contains('is-collapsed'))) {
    assert.equal(await meter.and(page.getByRole('button', { name: /^Usage: (API credits|Claude Pro plan)\./ })).count(), 1, 'Collapsed usage has a descriptive accessible name');
  } else {
    await meter.locator('.plan-usage__name').getByText(/^(API credits|Claude Pro plan)$/).waitFor();
    assert.equal(await meter.getAttribute('aria-label'), null, 'Expanded usage derives its name from all visible labels');
    assert.equal(await meter.and(page.getByRole('button', { name: /On your own keys/ })).count(), 1, 'The usage button includes the own-key label in its name');
  }
  if (surface === 'menu') {
    const trigger = page.getByRole('button', { name: /Account & settings$/ });
    if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
    await page.getByRole('menuitem', { name: 'Usage', exact: true }).waitFor();
  }
}
async function showDashboardSidebar(page) {
  if (!await page.locator('.sidebar').isVisible()) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  const group = page.locator('.sidebar__dashboards');
  const disclosure = group.getByRole('button', { name: 'Dashboards', exact: true });
  if (await disclosure.getAttribute('aria-expanded') === 'false') await disclosure.click();
  const { width, height } = page.viewportSize();
  assert.equal(await group.locator('.sidebar-island').count(), width <= 760 || height < 760 ? 4 : 6, 'Viewport dashboard cap and the All dashboards entry');
  assert.equal(await group.getByRole('button', { name: 'All dashboards', exact: true }).count(), 1);
  assert.equal(await group.getByRole('button', { name: 'Operations', exact: true }).count(), 0, 'The remaining dashboards stay in the manager');
  await group.scrollIntoViewIfNeeded();
}
async function checkDashboardHeader(page) {
  const header = page.locator('.shell-header .dashboard-header-actions');
  assert.equal(await header.getByRole('button', { name: 'Refresh dashboard', exact: true }).count(), 1);
  assert.equal(await header.getByRole('button', { name: 'Edit dashboard', exact: true }).innerText(), 'Edit');
}
const routes = [...navigationRoutes.map(hash => ({ name: hash || 'home', hash })),
  ...[false, true].map(collapsed => ({ name: `usage-meter-${collapsed ? 'collapsed' : 'expanded'}`, hash: '#bots', action: page => openUsageMeter(page, collapsed) })),
  ...['sidebar', 'menu', 'rail'].flatMap(surface => ['normal', 'warning', 'critical', 'no-limit', 'cli-known', 'cli-unknown'].map(usage => ({
    name: `usage-${surface}-${usage}`, hash: '#bots', usage, surface,
    desktopOnly: surface === 'rail', action: page => showUsage(page, surface), reflow: page => showUsage(page, surface),
  }))),
  { name: 'routines', hash: '#bot/coordinator/reports', action: openRoutines },
  { name: 'routine-confirm', hash: '#bot/coordinator/reports', action: async page => { await openRoutines(page); await page.getByRole('button').filter({ hasText: /^Run now$/ }).first().click(); } },
  { name: 'about-you', hash: '#settings/appearance/use' },
  { name: 'shortcut-recording', hash: '#settings/appearance', action: async page => page.getByRole('button', { name: 'Change Focus composer shortcut', exact: true }).click() },
  { name: 'layout-reset', hash: '#settings/appearance', action: async page => { await page.getByRole('button', { name: 'Manage layout', exact: true }).click(); await page.getByRole('menuitem', { name: 'Reset', exact: true }).click(); } },
  { name: 'chat-preview', hash: '#bot/coordinator', action: page => server.previewCard(page) },
  { name: 'dashboards-manager', hash: '#dashboards' },
  { name: 'dashboard-agent-sheet', hash: '#dashboards', action: async page => {
    await page.getByRole('button', { name: 'Create with your agent', exact: true }).click();
    await page.getByRole('radiogroup', { name: 'Bot', exact: true }).waitFor();
    await assertSingleDialog(page, 'Create with your agent');
  } },
  { name: 'dashboard-suggestion-sheet', hash: '#dashboards', action: async page => {
    await page.getByRole('button', { name: 'Suggest a dashboard for me', exact: true }).click();
    await page.getByLabel('Role', { exact: true }).waitFor();
    await assertSingleDialog(page, 'Suggest a dashboard');
  } },
  { name: 'dashboard', hash: '#dash/d_a11y0001', action: checkDashboardHeader },
  { name: 'dashboard-sidebar-capped', hash: '#dashboards', action: showDashboardSidebar, reflow: showDashboardSidebar },
  { name: 'dashboard-refresh', hash: '#dash/d_a11y0001', action: async page => {
    await checkDashboardHeader(page);
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ui/data' && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Refresh dashboard', exact: true }).click();
    assert.equal((await refreshed).status(), 200);
    await page.waitForFunction(() => [...document.querySelectorAll('[data-widget-state]')].every(node => node.dataset.widgetState === 'ready'));
  } },
  { name: 'dashboard-view-all', hash: '#dash/d_a11y0001', action: async page => {
    const link = page.locator('[data-widget-id="w_a11y0002"]').getByRole('link', { name: 'View all 12', exact: true });
    assert.equal(await link.getAttribute('href'), '#tasks');
    await link.focus();
  } },
  { name: 'agent-widget-actions', hash: '#dash/d_a11y0001', action: async page => {
    const widget = page.locator('[data-widget-id="w_a11y0005"]');
    for (const name of ['Open: Task 1', 'Send to agent: Task 2', 'Approve: Task 3']) {
      const action = widget.getByRole('button', { name, exact: true });
      await action.scrollIntoViewIfNeeded(); await action.focus();
      assert.equal(await action.evaluate(node => node === document.activeElement), true);
    }
  } },
  { name: 'agent-approve', hash: '#dash/d_a11y0001', action: async page => page.getByRole('button', { name: 'Approve: Task 3', exact: true }).click() },
  { name: 'dashboard-empty', hash: '#dash/d_a11y0002' },
  { name: 'dashboard-edit', hash: '#dash/d_a11y0001', action: async page => page.getByRole('button', { name: 'Edit dashboard', exact: true }).click() },
  { name: 'add-widget', hash: '#dash/d_a11y0001', action: async page => { await page.getByRole('button', { name: 'Edit dashboard', exact: true }).click(); await page.getByRole('button', { name: 'Add widget', exact: true }).click(); } },
  { name: 'ask-agent', hash: '#dash/d_a11y0001', action: async page => { await page.getByRole('button', { name: 'Edit dashboard', exact: true }).click(); await openAgentSheet(page); } },
  { name: 'widget-settings', hash: '#dash/d_a11y0001', action: async page => { await page.getByRole('button', { name: 'Edit dashboard', exact: true }).click(); await page.getByRole('button', { name: 'Settings: Task table', exact: true }).click(); } },
  { name: 'dashboard-switcher', hash: '#dash/d_a11y0001', action: async page => page.getByRole('button', { name: 'Switch dashboard: My week', exact: true }).click() },
  { name: 'create-dashboard', hash: '#dashboards', action: async page => page.getByRole('button', { name: 'Create', exact: true }).click() },
  { name: 'confirm-dialog', hash: '#dashboards', action: async page => { await page.getByRole('button', { name: 'Manage My week', exact: true }).click(); await page.getByRole('menuitem', { name: 'Delete', exact: true }).click(); } },
];
const server = await accessibilityFixture();
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
try {
  for (const preset of (process.env.A11Y_PRESETS || 'swarm,midnight,paper,contrast').split(',')) for (const width of (process.env.A11Y_WIDTHS || '390,1280').split(',').map(Number)) for (const theme of (process.env.A11Y_THEMES || 'light,dark').split(',')) {
    await server.preset(preset);
    const context = await server.context(browser, width, theme);
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    await page.addInitScript(() => {
      window.__a11yOpener = null;
      window.__a11yMaxDialogs = 0;
      const recordDialogs = () => { window.__a11yMaxDialogs = Math.max(window.__a11yMaxDialogs, document.querySelectorAll('dialog[open], [role=dialog][aria-modal=true]').length); };
      new MutationObserver(recordDialogs).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['open', 'role', 'aria-modal'] });
      recordDialogs();
      document.addEventListener('click', event => {
        const button = event.target.closest?.('button');
        if (button && !button.closest('dialog[open], [role=dialog][aria-modal=true], [role=menu]')) window.__a11yOpener = button;
      }, true);
    });
    const selectedRoutes = preset === 'swarm' ? routes : routes.filter(route => ['#settings/appearance', 'dashboard', '#bot/coordinator', '#bots', 'usage-meter-expanded', 'usage-meter-collapsed'].includes(route.name));
    for (const route of selectedRoutes.filter(route => (!route.desktopOnly || width > 760) && (!process.env.A11Y_ROUTES || new RegExp(process.env.A11Y_ROUTES).test(route.name)))) {
      const name = `${preset === 'swarm' ? '' : `${preset}-`}${width}-${theme}-${route.name}`, file = name.replace(/[^a-z0-9-]/gi, '_');
      const item = { name, preset, width, theme, route: route.name, violations: [], reflow: [] };
      try {
        await page.setViewportSize({ width, height: width < 760 ? 844 : 900 });
        if (route.usage) await server.usage(page, route.usage);
        await server.open(page, route.hash);
        await route.action?.(page);
        await assertSingleDialog(page, route.name);
        await page.evaluate(() => document.fonts.ready);
        const axe = await new AxeBuilder({ page }).withRules(rules).analyze();
        item.violations = axe.violations.map(({ id, impact, nodes }) => ({ id, impact, nodes: nodes.map(({ target, html, failureSummary }) => ({ target, html, failureSummary })) }));
        // CSS viewport size is what browser zoom changes. DPR alone cannot test
        // reflow. A 1280px display at 400% has a 320 CSS px layout viewport.
        for (const scale of width === 1280 ? [1, 2, 4] : [1]) {
          const cssWidth = scale === 2 ? 640 : 320;
          await page.setViewportSize({ width: cssWidth, height: 844 });
          const cdp = await context.newCDPSession(page);
          if (scale === 4) await cdp.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 844, deviceScaleFactor: 4, mobile: false, screenWidth: 1280, screenHeight: 3376 });
          await page.waitForFunction(() => document.querySelector('.app')?.classList.contains('is-mobile') === matchMedia('(max-width: 760px)').matches);
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          await route.reflow?.(page);
          await assertSingleDialog(page, `${route.name} at ${cssWidth}px`);
          const issues = await page.evaluate(() => {
            const issues = [];
            for (const root of [document.documentElement, document.body]) if (root.scrollWidth > innerWidth + 1) issues.push({ issue: 'page-overflow', tag: root.tagName, width: root.scrollWidth, viewport: innerWidth });
            const surface = [...document.querySelectorAll('dialog[open], [role=dialog][aria-modal=true]')].at(-1) ?? document;
            for (const el of surface.querySelectorAll('button, input:not([type=hidden]), select, textarea, a[href]')) {
              if (!el.checkVisibility() || el.closest('[inert]')) continue;
              const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
              // Ignore controls in a closed native dialog or intentionally offscreen drawer.
              if (el.closest('dialog:not([open])')) continue;
              if (r.left < -1 || r.right > innerWidth + 1) issues.push({ issue: 'control-overflow', tag: el.tagName, class: el.className, text: el.textContent?.trim().slice(0, 100), rect: [r.left, r.right] });
              if (el.tagName === 'BUTTON' && el.textContent.trim() && el.scrollWidth > el.clientWidth + 1) issues.push({ issue: 'clipped-label', text: el.textContent?.trim(), class: el.className });
            }
            return issues;
          });
          item.reflow.push({ cssWidth, displayWidth: scale > 1 ? 1280 : 320, scale, issues });
          if (scale === 4) await cdp.send('Emulation.clearDeviceMetricsOverride');
          await cdp.detach();
        }
        await page.setViewportSize({ width, height: width < 760 ? 844 : 900 });
        await page.waitForFunction(() => document.querySelector('.app')?.classList.contains('is-mobile') === matchMedia('(max-width: 760px)').matches);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await route.reflow?.(page);
        const scrollRegions = page.locator('[role=region][tabindex="0"]');
        item.keyboardScroll = 0;
        for (const region of await scrollRegions.all()) {
          if (!await region.isVisible() || !await region.evaluate(node => { const modal = [...document.querySelectorAll('dialog[open], [role=dialog][aria-modal=true]')].at(-1); return (!modal || modal.contains(node)) && node.scrollHeight > node.clientHeight + 1; })) continue;
          await region.scrollIntoViewIfNeeded(); await region.focus();
          await region.evaluate(node => { node.scrollTop = 0; });
          await page.keyboard.press('ArrowDown');
          await page.waitForTimeout(100);
          assert.ok(await region.evaluate(node => node.scrollTop > 0), 'Focused region scrolls with the keyboard');
          const focus = await region.evaluate(node => { const style = getComputedStyle(node); return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) }; });
          assert.ok(focus.style !== 'none' && focus.width >= 2, 'Scrollable region has a visible focus ring');
          item.keyboardScroll++;
        }
        if (route.name === '#tasks') {
          const regions = scrollRegions.filter({ visible: true });
          for (const region of await regions.all()) await region.evaluate(node => { node.scrollTop = 0; });
          if (await regions.count()) await regions.first().focus();
        }
        if (route.name === 'dashboard') {
          const table = page.getByRole('region', { name: 'Task table rows', exact: true });
          if (await table.count()) {
            await table.focus(); await table.evaluate(node => { node.scrollTop = 0; });
            await page.locator('.dashboard-surface').evaluate(node => { node.scrollTop = 0; });
          }
        }
        if (['#tasks', 'dashboard', 'about-you'].includes(route.name)) await page.screenshot({ path: path.join(out, `${file}.png`) });
        if (route.surface === 'menu') {
          const menu = page.getByRole('menu');
          await menu.getByRole('menuitem', { name: 'Usage', exact: true }).focus();
          await page.keyboard.press('Escape');
          await menu.waitFor({ state: 'hidden' });
          assert.equal(await page.getByRole('button', { name: /Account & settings$/ }).evaluate(node => node === document.activeElement), true, 'Usage menu returns focus to its trigger');
          item.keyboard = 'Usage menu Escape and focus return passed';
        }
        const dialog = page.locator(modalSelector);
        if (await dialog.count()) {
          const focusable = dialog.locator('button:enabled, input:enabled, select:enabled, textarea:enabled, a[href], [tabindex="0"]').filter({ visible: true });
          assert.ok(await focusable.count(), 'Dialog must have keyboard controls');
          await focusable.last().focus(); await page.keyboard.press('Tab');
          assert.equal(await dialog.evaluate(node => node.contains(document.activeElement)), true, 'Tab stays in the dialog');
          await focusable.first().focus(); await page.keyboard.press('Shift+Tab');
          assert.equal(await dialog.evaluate(node => node.contains(document.activeElement)), true, 'Shift+Tab stays in the dialog');
          const dialogName = await dialog.getAttribute('aria-label');
          await page.keyboard.press('Escape'); await page.getByRole('dialog', { name: dialogName, exact: true }).waitFor({ state: 'hidden' });
          await assertSingleDialog(page, `${route.name} after Escape`);
          assert.equal(await page.locator(modalSelector).count(), 0, 'Escape closes the sheet completely');
          assert.equal(await page.evaluate(() => !!window.__a11yOpener?.isConnected && document.activeElement === window.__a11yOpener), true, 'Escape returns focus to the opener');
          if (route.name === 'ask-agent') {
            await openAgentSheet(page);
            await page.getByRole('dialog', { name: 'Ask your agent', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click();
            await page.getByRole('dialog', { name: 'Ask your agent', exact: true }).waitFor({ state: 'hidden' });
            await assertSingleDialog(page, 'Ask your agent after Cancel');
            assert.equal(await page.locator(modalSelector).count(), 0, 'Cancel closes the sheet completely');
            assert.equal(await page.getByRole('button', { name: 'Add widget', exact: true }).evaluate(node => node === document.activeElement), true, 'Cancel returns focus to the Add widget button');
          }
          item.keyboard = 'single dialog, focus trap, Escape, focus return passed';
          if (route.name === 'ask-agent') item.keyboard += '; Cancel returns to Add widget';
        }
        item.maxOpenDialogs = await page.evaluate(() => window.__a11yMaxDialogs);
      } catch (error) { item.error = error.stack; }
      if (route.name.startsWith('usage-meter-') || route.usage) {
        await page.unroute('**/api/usage/summary');
        await page.evaluate(() => localStorage.setItem('swarm.sidebarCollapsed', '0'));
      }
      if (route.name === 'chat-preview') {
        try { await page.getByRole('region', { name: 'Review dashboard layout', exact: true }).getByRole('button', { name: 'Discard', exact: true }).click(); } catch (error) { item.error ??= error.stack; }
        server.db.prepare("DELETE FROM rows WHERE bot_id=? AND json_extract(body,'$.card')='ui_preview'").run(server.fixture.bot.id);
      }
      item.pass = !item.error && !item.violations.length && item.reflow.every(r => !r.issues.length);
      results.push(item);
      fs.writeFileSync(path.join(out, `${file}.json`), JSON.stringify(item, null, 2));
      console.log(`${item.pass ? 'PASS' : 'FAIL'} ${name}: ${item.violations.map(v => `${v.id}=${v.nodes.length}`).join(', ') || 'axe=0'}; reflow=${item.reflow.reduce((n, r) => n + r.issues.length, 0)}${item.error ? `; ${item.error.split('\n')[0]}` : ''}`);
    }
    await context.close();
  }
} finally { await browser.close(); await server.close(); }
assert.ok(results.length, 'Accessibility filters must select at least one screen');
const byRule = {}, byScreen = {}, byImpact = { critical: 0, serious: 0, moderate: 0, minor: 0 }, reflowByRule = {}, failedChecks = {};
for (const item of results) {
  byScreen[item.route] ??= {};
  if (item.error) {
    const check = item.error.split('\n')[0];
    failedChecks[check] = (failedChecks[check] || 0) + 1;
    byScreen[item.route][check] = (byScreen[item.route][check] || 0) + 1;
  }
  for (const v of item.violations) {
    byRule[v.id] = (byRule[v.id] || 0) + v.nodes.length;
    byScreen[item.route][v.id] = (byScreen[item.route][v.id] || 0) + v.nodes.length;
    byImpact[v.impact] = (byImpact[v.impact] || 0) + v.nodes.length;
  }
  for (const reflow of item.reflow) for (const issue of reflow.issues) {
    reflowByRule[issue.issue] = (reflowByRule[issue.issue] || 0) + 1;
    byScreen[item.route][`reflow-${issue.issue}`] = (byScreen[item.route][`reflow-${issue.issue}`] || 0) + 1;
  }
}
const report = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), counts: { pass: results.filter(r => r.pass).length, fail: results.filter(r => !r.pass).length, total: results.length }, byRule, byImpact, reflowByRule, failedChecks, byScreen, results };
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
console.log(`Accessibility: ${report.counts.pass}/${results.length} passed, ${report.counts.fail} failed. Report: ${out}/report.json`);
process.exitCode = report.counts.fail ? 1 : 0;
