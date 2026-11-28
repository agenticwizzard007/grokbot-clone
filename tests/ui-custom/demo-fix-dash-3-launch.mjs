import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { dashboardLaunchServer } from './fixtures/dashboard-launch.mjs';
import { inspectAlignment } from '../layout-alignment-ui.mjs';
import { inspectDashboardPolish } from './dashboard-polish-guards.mjs';

export async function runDashboardLaunch({ output = path.resolve('.context/ui-custom/fix-dash-3-launch/after'), views = [[320,'light'],[390,'light'],[500,'light'],[1280,'light'],[390,'dark'],[1280,'dark']], before = false, root = process.cwd() } = {}) {
  fs.mkdirSync(output, { recursive: true });
  const server = await dashboardLaunchServer({ root }), checks = [], screenshots = [], axe = [];
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const check = label => { checks.push(label); console.log(`PASS ${label}`); };
  let page;
  try {
    for (const [width, theme] of views) {
      const { context, request } = await server.context(browser, width, theme), height = width <= 760 ? 844 : 720;
      const tag = `${width}x${height}-${theme}`;
      page = await context.newPage(); page.setDefaultTimeout(15000);
      const manager = async () => { await page.goto(`${server.base}/#dashboards`); await page.locator('.dashboards-manager').waitFor(); };
      const capture = async (state, selector = '.dashboard-page', audit = true) => {
        await page.evaluate(() => document.fonts.ready);
        const file = path.join(output, `${state}-${tag}.png`); await page.screenshot({ path: file, animations: 'disabled' }); screenshots.push(file);
        if (before || !audit) return;
        assert.doesNotMatch(await page.locator('body').innerText(), /mock|Fixture|PRIVATE|QA-|undefined|null|\[object|[\u2013\u2014]/i, `${state}: clean visible text`);
        assert.deepEqual(await page.evaluate(inspectAlignment, { selector, requirePage: !selector.includes('sidebar') }), [], `${state}: alignment`);
        assert.deepEqual(await page.evaluate(inspectDashboardPolish), [], `${state}: polish`);
        const typography = await page.locator(selector).evaluateAll(roots => roots.flatMap(root => [...root.querySelectorAll('p,label,button,input,textarea,[role=radio]')].filter(el => el.checkVisibility() && el.textContent.trim()).filter(el => parseFloat(getComputedStyle(el).fontSize) < 14).map(el => el.textContent)));
        assert.deepEqual(typography, [], `${state}: body type is at least 14px`);
        const scan = await new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();
        axe.push({ state, tag, violations: scan.violations }); assert.deepEqual(scan.violations, [], `${state}: axe`);
        if (width <= 760 && selector === 'dialog[open]') {
          assert.equal(await page.getByRole('button', { name: 'Back', exact: true }).count(), 1);
          assert.equal(await page.getByRole('button', { name: 'Close', exact: true }).count(), 0);
        }
        check(`${state} ${tag}: layout, readable copy and zero axe violations`);
      };
      if (before) {
        await manager(); await page.waitForTimeout(500); await capture('manager-unavailable');
        assert.equal((await request('GET', '/ui/config')).status, 404);
        assert.equal(await page.getByRole('button', { name: 'Create', exact: true }).isDisabled(), true);
        assert.doesNotMatch(await page.locator('.dashboards-manager').innerText(), /not available|Could not load|Retry/);
        if (width <= 760) await page.getByRole('button', { name: 'Open navigation', exact: true }).click(); await capture('sidebar-unavailable');
        assert.equal(await page.locator('.sidebar__dashboards').getByRole('button', { name: 'Dashboards', exact: true }).count(), 1);
        check(`baseline reproduces config 404, unexplained disabled Create and plain Dashboards link ${tag}`);
        await context.close(); continue;
      }
      let config = await request('GET', '/ui/config'); assert.equal(config.status, 200); assert.equal(config.body.doc.dashboards.length, 0);
      const primary = (await request('GET', '/bots')).body.bots.find(bot => bot.isPrimary);
      const created = await request('POST', '/bots', { name: 'Research' }); assert.equal(created.status, 200, JSON.stringify(created)); const other = created.body.bot;
      assert.equal((await request('POST', `/bots/${other.id}/setup/skip`, {})).status, 200);
      await manager(); await page.getByRole('button', { name: 'Create', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Create', exact: true }).isEnabled(), true);
      await capture('manager-enabled');
      if (width <= 760) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
      const disclosure = page.locator('.sidebar__disclosure');
      if (await disclosure.getAttribute('aria-expanded') !== 'true') await disclosure.click();
      assert.equal(await page.locator('.sidebar__dashboards .sidebar-island').count(), 1);
      assert.equal(await page.locator('.sidebar__dashboards [aria-current=page]').getAttribute('aria-label'), 'All dashboards');
      assert.equal(await page.locator('.sidebar .bot-row.is-selected, .sidebar .pinned__tile.is-selected').count(), 0);
      await capture('sidebar-expanded', '.sidebar', false);
      await disclosure.press('Enter'); assert.equal(await disclosure.getAttribute('aria-expanded'), 'false'); await capture('sidebar-collapsed', '.sidebar', false);
      await disclosure.press('Space'); assert.equal(await disclosure.getAttribute('aria-expanded'), 'true');
      if (width <= 760) await page.locator('.sidebar__dashboards').getByRole('button', { name: 'All dashboards', exact: true }).click();
      check(`zero dashboards retain the accessible group, keyboard disclosure and All dashboards ${tag}`);
      await page.getByRole('button', { name: 'Create', exact: true }).click();
      let dialog = page.getByRole('dialog');
      assert.equal(await dialog.locator('form button').first().innerText(), 'Suggest a dashboard for me');
      await capture('create-dialog', 'dialog[open]');
      await page.getByLabel('Name', { exact: true }).fill(' ');
      assert.equal(await dialog.getByRole('button', { name: 'Create', exact: true }).isDisabled(), true);
      await dialog.getByText('Enter a dashboard name.', { exact: true }).waitFor(); await capture('empty-name', 'dialog[open]');
      await page.getByLabel('Name', { exact: true }).fill('Daily summary');
      let release; const hold = new Promise(resolve => { release = resolve; });
      await page.route('**/api/ui/config', async route => { if (route.request().method() === 'PATCH') await hold; await route.continue(); });
      await dialog.getByRole('button', { name: 'Create', exact: true }).click();
      await dialog.getByText('Saving your dashboard...', { exact: true }).waitFor(); assert.equal(await dialog.getByRole('button', { name: 'Create', exact: true }).isDisabled(), true);
      release(); await page.getByRole('button', { name: 'Add widget', exact: true }).waitFor(); await page.unroute('**/api/ui/config');
      assert.match(page.url(), /#dash\/daily-summary-/); check(`empty name and saving have visible reasons; first client dashboard creates ${tag}`);
      await capture('empty-dashboard');
      await page.getByRole('button', { name: 'Create with your agent', exact: true }).click();
      await page.getByRole('dialog', { name: 'Create with your agent', exact: true }).waitFor();
      await page.getByRole('dialog').getByRole('button', { name: width <= 760 ? 'Back' : 'Close', exact: true }).click();
      await page.getByRole('button', { name: 'Suggest a dashboard for me', exact: true }).click();
      await page.getByLabel('Role', { exact: true }).waitFor(); await capture('suggest-about-you', 'dialog[open]');
      await page.getByLabel('Role', { exact: true }).fill('Project coordinator'); await page.getByLabel('Goals', { exact: true }).fill('Draft the launch email');
      config = await request('GET', '/ui/config');
      await page.getByRole('button', { name: 'Preview dashboard', exact: true }).click();
      await page.getByRole('button', { name: 'Apply', exact: true }).waitFor();
      assert.equal((await request('GET', '/ui/config')).body.revision, config.body.revision);
      await capture('suggest-preview', 'dialog[open]');
      await page.getByRole('button', { name: 'Apply', exact: true }).click(); await page.getByRole('dialog').waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: 'Edit dashboard', exact: true }).waitFor();
      assert.equal((await request('GET', '/ui/config')).body.doc.dashboards.length, 2); check(`suggestion saves About you, waits for Apply and opens the new dashboard ${tag}`);
      await manager(); await page.getByRole('button', { name: 'Create with your agent', exact: true }).click(); dialog = page.getByRole('dialog');
      let sends = []; const observe = req => { if (req.method() === 'POST' && /\/messages$/.test(new URL(req.url()).pathname)) sends.push({ url: req.url(), body: req.postDataJSON() }); }; page.on('request', observe);
      assert.equal(await dialog.getByRole('radio').count(), 2); assert.equal(await dialog.locator('.bot-avatar svg').count(), 2);
      assert.equal(await dialog.getByRole('radio', { name: primary.name, exact: true }).getAttribute('aria-checked'), 'true');
      assert.equal(await dialog.getByRole('button', { name: `Send to ${primary.name}`, exact: true }).isDisabled(), true);
      await dialog.getByLabel('Request', { exact: true }).fill(' '); await dialog.locator('form').dispatchEvent('submit'); assert.equal(sends.length, 0);
      await dialog.getByRole('radio', { name: other.name, exact: true }).click(); await dialog.getByLabel('Request', { exact: true }).fill(''); await capture('agent-sheet-picker', 'dialog[open]');
      const prompt = 'Make me a dashboard for my daily summary';
      server.scripts.set(prompt, 'mock: create_dashboard {"name":"Team summary","template":"blank"} | say Review the dashboard preview.');
      await dialog.getByLabel('Request', { exact: true }).fill(prompt);
      await dialog.getByRole('button', { name: `Send to ${other.name}`, exact: true }).click();
      await page.locator('.composer__input').waitFor();
      assert.equal(sends.length, 1); assert.ok(sends[0].url.endsWith(`/bots/${other.id}/messages`)); assert.equal(sends[0].body.text, prompt);
      await page.getByRole('region', { name: 'Create dashboard: Team summary', exact: true }).getByRole('button', { name: 'Apply', exact: true }).click({ timeout: 30000 });
      await page.getByRole('button', { name: 'Add widget', exact: true }).waitFor(); assert.match(page.url(), /#dash\/team-summary-/);
      page.off('request', observe); check(`agent picker sends only explicit nonempty text to the selected Bot, Apply opens dashboard ${tag}`);
      for (const route of ['/settings?section=dashboards', '/#settings/dashboards', '/#settings/appearance/dashboards']) {
        await page.goto(`${server.base}${route}`); await page.locator('#appearance-dashboards').waitFor();
        await page.waitForFunction(async () => { const { navigation } = await import('/src/configStore.ts'); return navigation.screen?.kind === 'settings' && navigation.screen.section === 'appearance' && navigation.screen.dashboards; });
        if (width <= 760) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
        assert.equal(await page.locator('.sidebar__dashboards .is-active, .sidebar__dashboards [aria-current]').count(), 0);
        if (route === '/#settings/dashboards') await capture('settings-dashboards-unhighlighted', '.sidebar', false);
        if (width <= 760) await page.getByRole('dialog', { name: 'App navigation' }).press('Escape');
      }
      check(`every dashboard Settings alias opens Appearance with no dashboard selection ${tag}`);
      await manager();
      let loaded; const loading = new Promise(resolve => { loaded = resolve; });
      const delayConfig = async route => { await loading; await route.continue(); };
      await page.route('**/api/ui/config', delayConfig); await page.reload();
      await page.getByText('Loading dashboards...', { exact: true }).waitFor();
      assert.equal(await page.locator('.sidebar__dashboards').count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Create', exact: true }).count(), 0);
      loaded(); await page.getByRole('button', { name: 'Create', exact: true }).waitFor(); await page.unroute('**/api/ui/config', delayConfig);
      check(`loading has a visible status and hides the group until config is ready ${tag}`);
      for (const state of ['disabled', 'unauthorized', 'network']) {
        const failure = route => state === 'network' ? route.abort('failed') : route.fulfill({ status: state === 'disabled' ? 404 : 401, contentType: 'text/plain', body: 'Unavailable' });
        await page.route('**/api/ui/config', failure); await page.reload();
        await page.getByText(state === 'disabled' ? 'Dashboards are not available for your account yet.' : 'Could not load your dashboards.', { exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: 'Create', exact: true }).count(), 0);
        if (width <= 760) { await page.getByRole('button', { name: 'Open navigation', exact: true }).click(); assert.equal(await page.locator('.sidebar__dashboards').count(), 0); await page.getByRole('dialog', { name: 'App navigation' }).press('Escape'); }
        else assert.equal(await page.locator('.sidebar__dashboards').count(), 0);
        await capture(`config-${state}`);
        await page.unroute('**/api/ui/config', failure); await page.getByRole('button', { name: 'Retry', exact: true }).click();
        await page.getByRole('button', { name: 'Create', exact: true }).waitFor(); assert.equal(await page.getByRole('button', { name: 'Create', exact: true }).isEnabled(), true);
      }
      check(`404, 401 and network failures explain availability, hide group and Retry recovers ${tag}`);
      config = await request('GET', '/ui/config');
      const full = Array.from({ length: 12 }, (_, i) => ({ id: `$new${i + 1}`, name: `Weekly review ${i + 1}`, icon: 'layout-dashboard', widgets: [] }));
      const filled = await request('PATCH', '/ui/config', [{ op: 'replace', path: '/dashboards', value: full }], config.body.revision); assert.equal(filled.status, 200, JSON.stringify(filled));
      await page.reload(); await page.getByText('You have 12 dashboards, the maximum. Delete one to create another.', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Create', exact: true }).isDisabled(), true);
      assert.doesNotMatch(await page.locator('.dashboards-manager').innerText(), /0 widgets/);
      assert.equal(await page.getByText('Empty dashboards are ready for widgets. Open one and tap Add widget.', { exact: true }).count(), 1);
      await capture('dashboard-limit'); check(`dashboard limit explains disabled Create and empty rows share one hint ${tag}`);
      await context.close();
    }
  } catch (error) { if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png') }); throw error; }
  finally { await browser.close(); fs.writeFileSync(path.join(output, 'server.log'), server.logs.join('')); await server.close(); fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ passed: checks.length, checks, axe, screenshots }, null, 2)); }
  console.log(`FIX-DASH-3 LAUNCH: ${checks.length} passed; ${axe.length} axe scans, zero violations. ${output}/results.json`);
  return { checks, screenshots, axe };
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) await runDashboardLaunch({ ...(process.env.LAUNCH_ROOT ? { root: process.env.LAUNCH_ROOT } : {}), ...(process.argv.includes('--before') ? { before: true, output: path.resolve('.context/ui-custom/fix-dash-3-launch/before') } : {}), ...(process.env.LAUNCH_QUICK ? { views: [[390,'light']] } : {}) });
