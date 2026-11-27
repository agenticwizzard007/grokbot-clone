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
const routes = [...navigationRoutes.map(hash => ({ name: hash || 'home', hash })),
  { name: 'about-you', hash: '#settings/appearance/use', action: async page => { await page.getByRole('button', { name: 'Add workflow', exact: true }).click(); await page.getByLabel('Role', { exact: true }).fill('Project coordinator'); } },
  { name: 'shortcut-recording', hash: '#settings/appearance', action: async page => page.getByRole('button', { name: 'Change Focus composer shortcut', exact: true }).click() },
  { name: 'layout-reset', hash: '#settings/appearance', action: async page => { await page.getByRole('button', { name: 'Manage layout', exact: true }).click(); await page.getByRole('menuitem', { name: 'Reset', exact: true }).click(); } },
  { name: 'chat-preview', hash: '#bot/coordinator', action: page => server.previewCard(page) },
  { name: 'dashboards-manager', hash: '#dashboards' },
  { name: 'dashboard', hash: '#dash/d_a11y0001' },
  { name: 'dashboard-empty', hash: '#dash/d_a11y0002' },
  { name: 'dashboard-edit', hash: '#dash/d_a11y0001', action: async page => page.getByRole('button', { name: 'Edit', exact: true }).click() },
  { name: 'add-widget', hash: '#dash/d_a11y0001', action: async page => { await page.getByRole('button', { name: 'Edit', exact: true }).click(); await page.getByRole('button', { name: 'Add widget', exact: true }).click(); } },
  { name: 'widget-settings', hash: '#dash/d_a11y0001', action: async page => { await page.getByRole('button', { name: 'Edit', exact: true }).click(); await page.getByRole('button', { name: 'Settings: Task table', exact: true }).click(); } },
  { name: 'dashboard-switcher', hash: '#dash/d_a11y0001', action: async page => page.getByRole('button', { name: 'Switch dashboard: My week', exact: true }).click() },
  { name: 'create-dashboard', hash: '#dashboards', action: async page => page.getByRole('button', { name: 'Create', exact: true }).click() },
  { name: 'confirm-dialog', hash: '#dashboards', action: async page => { await page.getByRole('button', { name: 'Manage My week', exact: true }).click(); await page.getByRole('menuitem', { name: 'Delete', exact: true }).click(); } },
];
const server = await accessibilityFixture();
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
try {
  for (const width of (process.env.A11Y_WIDTHS || '390,1280').split(',').map(Number)) for (const theme of (process.env.A11Y_THEMES || 'light,dark').split(',')) {
    const context = await server.context(browser, width, theme);
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    for (const route of routes.filter(route => !process.env.A11Y_ROUTES || new RegExp(process.env.A11Y_ROUTES).test(route.name))) {
      const name = `${width}-${theme}-${route.name}`, file = name.replace(/[^a-z0-9-]/gi, '_');
      const item = { name, width, theme, route: route.name, violations: [], reflow: [] };
      try {
        await page.setViewportSize({ width, height: width < 760 ? 844 : 900 });
        await server.open(page, route.hash);
        await page.evaluate(() => {
          window.__a11yOpener = null;
          document.addEventListener('click', event => {
            const button = event.target.closest?.('button');
            if (button && !button.closest('dialog[open], [role=dialog][aria-modal=true], [role=menu]')) window.__a11yOpener = button;
          }, true);
        });
        await route.action?.(page);
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
          const issues = await page.evaluate(() => {
            const issues = [];
            for (const root of [document.documentElement, document.body]) if (root.scrollWidth > innerWidth + 1) issues.push({ issue: 'page-overflow', tag: root.tagName, width: root.scrollWidth, viewport: innerWidth });
            for (const el of document.querySelectorAll('button, input:not([type=hidden]), select, textarea, a[href]')) {
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
        if (['#tasks', 'dashboard', 'about-you'].includes(route.name)) {
          await page.setViewportSize({ width, height: width < 760 ? 844 : 900 });
          await page.screenshot({ path: path.join(out, `${file}.png`) });
        }
        const dialog = page.locator('dialog[open], [role=dialog][aria-modal=true]').last();
        if (await dialog.count()) {
          const focusable = dialog.locator('button:enabled, input:enabled, select:enabled, textarea:enabled, a[href], [tabindex="0"]').filter({ visible: true });
          assert.ok(await focusable.count(), 'Dialog must have keyboard controls');
          await focusable.last().focus(); await page.keyboard.press('Tab');
          assert.equal(await dialog.evaluate(node => node.contains(document.activeElement)), true, 'Tab stays in the dialog');
          await focusable.first().focus(); await page.keyboard.press('Shift+Tab');
          assert.equal(await dialog.evaluate(node => node.contains(document.activeElement)), true, 'Shift+Tab stays in the dialog');
          await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
          assert.equal(await page.evaluate(() => !!window.__a11yOpener?.isConnected && document.activeElement === window.__a11yOpener), true, 'Escape returns focus to the opener');
          item.keyboard = 'focus trap, Escape, focus return passed';
        }
      } catch (error) { item.error = error.stack; }
      if (route.name === 'chat-preview') {
        await page.getByRole('region', { name: 'Review dashboard layout', exact: true }).getByRole('button', { name: 'Discard', exact: true }).click();
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
const byRule = {}, byScreen = {};
for (const item of results) for (const v of item.violations) { byRule[v.id] = (byRule[v.id] || 0) + v.nodes.length; (byScreen[item.route] ??= {})[v.id] = ((byScreen[item.route] ?? {})[v.id] || 0) + v.nodes.length; }
const report = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), counts: { pass: results.filter(r => r.pass).length, fail: results.filter(r => !r.pass).length, total: results.length }, byRule, byScreen, results };
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
console.log(`Accessibility: ${report.counts.pass}/${results.length} passed, ${report.counts.fail} failed. Report: ${out}/report.json`);
process.exitCode = report.counts.fail ? 1 : 0;
