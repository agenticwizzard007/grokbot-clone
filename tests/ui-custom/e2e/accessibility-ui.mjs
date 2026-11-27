import assert from 'node:assert/strict';
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs';
import path from 'node:path';
import { runSuite, fixtureContext } from '../fixtures/harness.mjs';
import { CUSTOM_ROUTES, prepareRoute } from '../fixtures/routes.mjs';

const routes = [
  { name: 'default-bots', fixture: 'default', hash: '#bots', modules: [] },
  { name: 'default-chat', fixture: 'default', hash: '#bot/{bot}', modules: [] },
  ...CUSTOM_ROUTES,
];
await runSuite('accessibility', [390, 1280].flatMap(width => ['light', 'dark'].flatMap(theme => routes.map(route => ({ name: `axe ${width} ${theme} ${route.name}`, run: async ({ server, browser, out }) => {
  const { context } = await fixtureContext(browser, server, width, 'layout-test-token', theme);
  try {
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    await prepareRoute(page, context, server, route);
    const results = await new AxeBuilder({ page }).analyze();
    fs.writeFileSync(path.join(out, `${width}-${theme}-${route.name}.json`), JSON.stringify(results, null, 2));
    const violations = results.violations.filter(v => ['serious', 'critical'].includes(v.impact));
    assert.deepEqual(violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.map(n => n.target) })), []);
    await page.setViewportSize({ width: 320, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, '320px reflow');
    await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, '200 percent zoom reflow');
  } finally { await context.close(); }
} })))), { casesPerServer: 3 });
