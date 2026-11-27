import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { shellFixture } from './shell-fixture.mjs';
const server = await shellFixture();
const output = path.resolve('.context/ui-custom/e-navigation'); fs.mkdirSync(output, { recursive: true });
const results = [];
const visibleBacks = page => page.locator('button, a, [role="button"], [aria-label="Back"]').evaluateAll(elements => elements.filter(el => el.checkVisibility() && (el.getAttribute('aria-label') === 'Back' || el.textContent.trim() === 'Back')).length);
try {
  const dashboard = await server.patch([{ op: 'add', path: '/dashboards/-', value: { id: '$new1', name: 'Weekly overview', icon: 'layout-dashboard', widgets: [] } }]);
  const id = dashboard.doc.dashboards[0].id;
  const orders = [ ['bots', 'tasks', 'search', 'settings'], ['tasks', 'settings', 'search', 'bots'], [`dashboard:${id}`, 'tasks', 'bots', 'settings', 'search'] ];
  for (const [index, order] of orders.entries()) {
    await server.patch([{ op: 'replace', path: '/layout/phoneTabs', value: order }]);
    for (const width of [320, 390, 500]) for (const theme of ['light', 'dark']) {
      const page = await server.page(width, theme);
      await server.patch([{ op: 'replace', path: '/theme/mode', value: theme }]);
      for (const hash of ['#bots', '#tasks', '#search', '#settings', ...(index === 2 ? [`#dash/${id}`, `#dash/weekly-overview-${id}`] : [])]) {
        await server.open(page, hash);
        if (hash.startsWith('#dash/')) await page.waitForURL(`**/${hash}`);
        assert.equal(await visibleBacks(page), 0, `${hash}: no Back at ${width} ${theme}`);
        assert.ok(await page.getByRole('navigation', { name: 'App navigation', exact: true }).isVisible());
        const expected = order.map(tab => tab.startsWith('dashboard:') ? 'Weekly overview' : tab[0].toUpperCase() + tab.slice(1));
        assert.deepEqual(await page.locator('.phone-tabs button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label'))), expected);
        results.push({ hash, width, theme, order: index, pass: true });
      }
      for (const hash of [`#bot/${server.fixture.bot.id}`, '#settings/general', `#bot/${server.fixture.bot.id}/details/tasks`]) {
        await server.open(page, hash);
        assert.equal(await visibleBacks(page), 1, `${hash}: exactly one Back at ${width} ${theme}`);
        results.push({ hash, width, theme, order: index, pass: true });
      }
      // A tab remains a root after arriving from another screen and browser Back.
      await server.open(page, '#bots');
      await page.locator('.phone-tabs').getByRole('button', { name: 'Tasks', exact: true }).click();
      await page.waitForURL('**/#tasks');
      assert.equal(await visibleBacks(page), 0);
      await page.goBack(); await page.waitForURL('**/#bots'); assert.equal(await visibleBacks(page), 0);
      await server.open(page, '#settings/general');
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      await page.waitForURL('**/#settings'); assert.equal(await visibleBacks(page), 0);
      results.push({ name: 'history and Settings Back', width, theme, order: index, pass: true });
      if (index === 1) { await server.open(page, '#tasks'); await page.screenshot({ path: path.join(output, `tasks-${width}-${theme}.png`) }); }
      await page.context().close();
    }
  }
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: results.length, failed: 0, results }, null, 2));
  console.log(`PASS phone tab Back navigation: ${results.length} cases, 0 failures. ${output}/report.json`);
} finally { await server.close(); }
