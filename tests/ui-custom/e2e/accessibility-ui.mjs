import assert from 'node:assert/strict';
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs';
import path from 'node:path';
import { runSuite, fixtureContext, configAvailable, patch, open, requireModules, api, until } from '../fixtures/harness.mjs';
import { contracts } from '../fixtures/presets.mjs';
import { dashboardPatch } from '../fixtures/matrix.mjs';

const cases = [];
for (const preset of ['swarm', 'midnight', 'paper', 'contrast']) for (const mode of ['light', 'dark']) for (const width of [390, 1280]) {
  for (const route of ['appearance', 'dashboard', 'chat', 'bots']) cases.push({ name: `axe ${preset} ${mode} ${width} ${route}`, run: async ({ server, browser, out }) => {
    const { context } = await fixtureContext(browser, server, width);
    try {
      const current = await configAvailable(context.request, server.base);
      requireModules('web/src/components/config/AppearanceSettings.tsx', 'web/src/dashboards/DashboardGrid.tsx', 'web/src/customization/applier.ts');
      await api(context.request, server.base, '/reset', 'POST', { scope: 'all' }, 200, current.revision);
      const { presetPatch } = await contracts();
      await patch(context, server.base, [...presetPatch(preset), { op: 'replace', path: '/theme/mode', value: mode }, ...dashboardPatch()]);
      const { doc } = await configAvailable(context.request, server.base);
      const page = await context.newPage();
      const hash = { appearance: '#settings/appearance', dashboard: `#dash/${doc.dashboards[0].id}`, chat: `#bot/${server.fixture.bot.id}`, bots: '#bots' }[route];
      await open(page, server.base, hash);
      await until(() => page.evaluate(m => document.documentElement.dataset.theme === m, mode), 'Requested axe mode did not render');
      await page.locator('[data-layout="page"]').first().waitFor();
      const results = await new AxeBuilder({ page }).analyze();
      fs.writeFileSync(path.join(out, `${preset}-${mode}-${width}-${route}.json`), JSON.stringify(results, null, 2));
      const violations = results.violations.filter(v => ['serious', 'critical'].includes(v.impact));
      assert.deepEqual(violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.map(n => n.target) })), []);
      // Reflow is a separate condition; axe does not establish this guarantee.
      await page.setViewportSize({ width: 320, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, '320px reflow');
      await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, '200 percent zoom reflow');
    } finally { await context.close(); }
  } });
}
for (const width of [390, 1280]) cases.push({ name: `colorblind status cues ${width}`, run: async ({ server, browser }) => {
  const { context } = await fixtureContext(browser, server, width);
  try {
    await configAvailable(context.request, server.base);
    requireModules('web/src/customization/applier.ts');
    const { presetPatch } = await contracts();
    await patch(context, server.base, presetPatch('colorblind'));
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setEmulatedVisionDeficiency', { type: 'deuteranopia' });
    await open(page, server.base, '#tasks');
    const cues = page.locator('.task-filters button:visible');
    assert.ok(await cues.count() >= 3, 'Seeded task status controls must exist');
    for (const cue of await cues.all()) {
      assert.ok((await cue.innerText()).trim(), 'Status must have a text cue');
      assert.ok(await cue.locator('svg').count(), 'Status must have an icon cue');
    }
  } finally { await context.close(); }
} });
await runSuite('accessibility', cases);
