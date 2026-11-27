import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { inspectAlignment } from '../../layout-alignment-ui.mjs';
import { readableWords } from '../../paper-label-geometry.mjs';

/** Real UI, seeded SQLite, and the local mock provider. No provider credentials inherited. */
export async function runAdaptUi(directory = '.context/ui-custom/adapt-ui') {
  const { agentFixture } = await import('../agent-fixture.mjs');
  const fixture = await agentFixture();
  const evidence = path.resolve(directory); fs.mkdirSync(evidence, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const report = [], screenshots = [];
  let active;
  const pass = (name, width, theme, details = {}) => { report.push({ name, width, theme, ...details }); console.log(`PASS UC-I ${width} ${theme}: ${name}`); };
  const signedIn = async name => {
    const response = await fetch(`${fixture.api}/api/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json', origin: fixture.base }, body: JSON.stringify({ email: `${name.toLowerCase()}@example.test`, name }) });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie').split(';')[0], value = cookie.slice(cookie.indexOf('=') + 1);
    const me = await fetch(`${fixture.api}/api/auth/me`, { headers: { cookie } }).then(r => r.json());
    return { id: me.user.id, cookie: value };
  };
  const accounts = { sales: { id: fixture.fixture.userId, cookie: 'layout-test-token' }, operations: await signedIn('QA-Temp-Operations') };
  fixture.db.prepare('UPDATE users SET name=? WHERE id=?').run('QA-Temp-Sales', accounts.sales.id);
  for (const account of Object.values(accounts)) fixture.db.prepare(`INSERT INTO account_preferences(user_id,updated_at,ui_custom_enabled,ui_adapt) VALUES(?,?,1,1)
    ON CONFLICT(user_id) DO UPDATE SET ui_custom_enabled=1,ui_adapt=1`).run(account.id, Date.now());
  const request = async (page, method, route, data, revision) => {
    const response = await page.request.fetch(`/api/ui${route}`, { method, ...(data === undefined ? {} : { data }), headers: { ...(revision === undefined ? {} : { 'If-Match': `"${revision}"` }) } });
    assert.equal(response.status(), 200, `${method} ${route}: ${await response.text()}`); return response.json();
  };
  const capture = async (page, name, width, theme) => {
    await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(150);
    const filename = `${width}-${theme}-${name}.png`;
    await page.screenshot({ path: path.join(evidence, filename), fullPage: true }); screenshots.push(filename);
  };
  try {
    for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
      const contexts = [];
      try {
        const pages = {};
        for (const [kind, account] of Object.entries(accounts)) {
          // These are freshly seeded fixture accounts in a temporary database only.
          for (const table of ['ui_previews', 'ui_config_history', 'ui_config', 'ui_requirements']) fixture.db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(account.id);
          const context = await browser.newContext({ baseURL: fixture.base, viewport: { width, height: width === 390 ? 844 : 1000 }, colorScheme: theme, reducedMotion: 'reduce' }); contexts.push(context);
          await context.addCookies([{ name: 'swarm_session', value: account.cookie, url: fixture.base }]);
          await context.route('**/*', route => ['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
          await context.addInitScript(id => { if (location.origin !== 'null') { localStorage.setItem(`swarm.ui.migrated:${id}`, '1'); localStorage.setItem('swarm.sidebarCollapsed', '0'); } }, account.id);
          const page = await context.newPage(); pages[kind] = page; active = page; page.setDefaultTimeout(20000);
          const errors = []; page.on('pageerror', e => errors.push(e.message));
          await page.goto('/#settings/appearance/use');
          const screen = page.getByRole('region', { name: 'About your use', exact: true }); await screen.waitFor();
          const saved = await request(page, 'GET', '/config');
          await request(page, 'PATCH', '/config', [{ op: 'replace', path: '/theme/mode', value: theme }], saved.revision);
          await screen.getByLabel('Role', { exact: true }).fill(kind === 'sales' ? 'Sales' : 'Operations manager');
          await screen.getByLabel('Goals', { exact: true }).fill(kind === 'sales' ? 'Outreach and pipeline' : 'Daily report\nUsage review');
          for (const focus of kind === 'sales' ? ['Tasks', 'Routines', 'Bots'] : ['Routines', 'Usage', 'Apps']) await screen.getByRole('button', { name: focus, exact: true }).click();
          const revision = (await request(page, 'GET', '/config')).revision;
          await screen.getByRole('button', { name: 'Save changes', exact: true }).click();
          await screen.getByText('Saved', { exact: true }).waitFor();
          assert.equal((await request(page, 'GET', '/config')).revision, revision, 'Saving requirements does not change appearance');
          assert.deepEqual(await page.evaluate(inspectAlignment, { selector: '.app-settings' }), []);
          await readableWords(screen); await capture(page, `${kind}-requirements`, width, theme);
          pass(`${kind} profile edit and alignment`, width, theme);
          await screen.getByRole('button', { name: 'Re-adapt', exact: true }).click();
          const card = screen.locator('.ui-preview-card'); await card.getByRole('button', { name: 'Apply', exact: true }).waitFor();
          await capture(page, `${kind}-preview`, width, theme);
          await card.getByRole('button', { name: 'Apply', exact: true }).click();
          await card.getByText('Applied', { exact: true }).waitFor();
          await page.goto('/');
          await page.waitForURL(/#dash\//); await page.getByText('Suggested Bots', { exact: true }).waitFor();
          const config = await request(page, 'GET', '/config');
          fs.writeFileSync(path.join(evidence, `${width}-${theme}-${kind}-config.json`), JSON.stringify(config, null, 2));
          await capture(page, `${kind}-home`, width, theme);
          if (width === 390) { await page.getByRole('navigation', { name: 'App navigation', exact: true }).waitFor(); assert.ok(await page.getByRole('button', { name: 'More', exact: true }).isVisible()); }
          assert.deepEqual(errors, []); pass(`${kind} home, navigation and suggestions`, width, theme);
        }
        const sales = await request(pages.sales, 'GET', '/config'), ops = await request(pages.operations, 'GET', '/config');
        assert.notEqual(sales.doc.dashboards[0].name, ops.doc.dashboards[0].name);
        assert.notDeepEqual(sales.doc.layout.phoneTabs, ops.doc.layout.phoneTabs);
        assert.notDeepEqual(sales.doc.layout.sidebar.order, ops.doc.layout.sidebar.order);
        pass('use cases produce distinct apps', width, theme);
        const page = pages.operations; active = page;
        await capture(page, 'operations-before-support', width, theme);
        // A normal manual edit must survive the next requirements change.
        await request(page, 'PATCH', '/config', [{ op: 'replace', path: '/layout/sidebar/width', value: 'wide' }], ops.revision);
        await page.goto('/#settings/appearance/use');
        const screen = page.getByRole('region', { name: 'About your use', exact: true }); await screen.waitFor();
        await screen.getByLabel('Role', { exact: true }).fill('Support team'); await screen.getByLabel('Goals', { exact: true }).fill('Response queue');
        for (const button of await screen.getByRole('button', { pressed: true }).all()) await button.click();
        for (const name of ['Tasks', 'Chat', 'Team']) await screen.getByRole('button', { name, exact: true }).click();
        await screen.getByRole('button', { name: 'Save changes', exact: true }).click(); await screen.getByText('Saved', { exact: true }).waitFor();
        await screen.getByRole('button', { name: 'Re-adapt', exact: true }).click();
        const card = screen.locator('.ui-preview-card'); await card.getByRole('button', { name: 'Apply', exact: true }).waitFor();
        await capture(page, 'support-preview', width, theme); await card.getByRole('button', { name: 'Apply', exact: true }).click(); await card.getByText('Applied', { exact: true }).waitFor();
        await page.goto('/'); await page.waitForURL(/#dash\//); await page.getByText('Suggested Bots', { exact: true }).waitFor();
        await capture(page, 'support-after', width, theme);
        const support = await request(page, 'GET', '/config'); assert.equal(support.doc.dashboards[0].name, 'Support queue'); assert.equal(support.doc.layout.sidebar.width, 'wide');
        pass('operations to support preserves a hand edit', width, theme);
        await page.goto('/#all'); await page.getByRole('heading', { name: 'All sections', exact: true }).waitFor();
        for (const name of ['Bots', 'Tasks', 'Files', 'Routines', 'Settings']) assert.ok(await page.getByRole('link', { name, exact: true }).count());
        await capture(page, 'all-sections', width, theme); pass('All sections remains reachable', width, theme);
        await page.goto('/#settings/appearance/use'); await screen.waitFor();
        await screen.getByRole('button', { name: 'Reset', exact: true }).click();
        await card.getByRole('button', { name: 'Apply', exact: true }).waitFor(); await card.getByRole('button', { name: 'Apply', exact: true }).click();
        await card.getByText('Applied', { exact: true }).waitFor();
        assert.equal((await request(page, 'GET', '/requirements')).profile, null);
        await capture(page, 'reset', width, theme);
        await screen.getByRole('button', { name: 'Undo reset', exact: true }).click();
        await screen.getByText('Reset undone', { exact: true }).waitFor();
        assert.equal((await request(page, 'GET', '/requirements')).profile.role, 'Support team');
        assert.deepEqual((await request(page, 'GET', '/config')).doc, support.doc);
        await capture(page, 'reset-undone', width, theme); pass('Reset and Undo restore the profile and app', width, theme);
        // Finish the story on Reset, with the default arrangement visible.
        await screen.getByRole('button', { name: 'Reset', exact: true }).click(); await card.getByRole('button', { name: 'Apply', exact: true }).click(); await card.getByText('Applied', { exact: true }).waitFor();
        await page.goto('/#bots'); await capture(page, 'reset-home', width, theme);
      } finally { for (const context of contexts) await context.close(); }
    }
  } catch (error) {
    if (active && !active.isClosed()) await active.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true });
    fs.writeFileSync(path.join(evidence, 'failure.txt'), String(error.stack)); throw error;
  } finally {
    await browser.close(); await fixture.close();
    fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify({ passed: report.length, checks: report, screenshots }, null, 2));
  }
  console.log(`${report.length} passed, 0 failed. Demo: ${evidence}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await runAdaptUi();
