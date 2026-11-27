import { seedWidgetData } from './widget-data.mjs';
import assert from 'node:assert/strict';
import { api, configAvailable, put, requireModules, open, agentPreview, until } from './harness.mjs';
import { contracts } from './contracts.mjs';
import { matrixDocument, LAYOUT_PATCH } from './matrix.mjs';

export const CUSTOM_ROUTES = [
  { name: 'navigation-tasks', fixture: 'navigation', hash: '#tasks', modules: ['web/src/customization/layout/useHome.ts'] },
  ...['seeded', 'empty'].map(state => ({ name: `dashboard-${state}`, fixture: `dashboard-${state}`, hash: '#dash/d_00000001', dashboard: true,
    modules: ['web/src/dashboards/DashboardGrid.tsx', 'web/src/customization/layout/useHome.ts'] })),
  { name: 'preview-banner', fixture: 'default', hash: '#bot/{bot}', preview: true, modules: ['web/src/customization/PreviewBanner.tsx', 'server/src/agent/ui-tools.ts'] },
  { name: 'safe-mode-banner', fixture: 'default', hash: '?ui=safe#bots', safe: true, modules: ['web/src/customization/SafeModeBanner.tsx'] },
  { name: 'all-sections', fixture: 'navigation', hash: '#all', modules: ['web/src/components/AllSections.tsx'] },
].map(route => ({ owner: 'UC-H', enforce: true, ...route }));

export async function prepareRoute(page, context, server, route) {
  // UC-B is merged, so even a later feature's gate must not conceal a broken API.
  await configAvailable(context.request, server.base);
  requireModules(...route.modules);
  if (route.fixture === 'dashboard-seeded') seedWidgetData(server);
  if (route.fixture === 'dashboard-empty') {
    await context.clearCookies();
    const login = await context.request.post(`${server.base}/api/auth/dev`, { data: { email: 'qa-temp-empty@example.test', name: 'QA-Temp-Empty' } });
    assert.equal(login.status(), 200);
  }
  const { DEFAULT_CONFIG } = await contracts();
  await api(context.request, server.base, '/reset', 'POST', { scope: 'all' });
  await put(context, server.base, matrixDocument(DEFAULT_CONFIG, route.fixture));
  await open(page, server.base, route.hash.replace('{bot}', server.fixture.bot.id));
  if (route.hash.endsWith('#bots')) await page.locator('.pb-bot-card__open').first().waitFor();
  if (route.hash === '#bot/{bot}') await page.getByRole('textbox', { name: `Message ${server.fixture.bot.name}`, exact: true }).waitFor();
  if (route.hash === '#all') await page.getByRole('heading', { name: /All sections/ }).waitFor();
  if (route.preview) await agentPreview(page, server, LAYOUT_PATCH, 'Open Tasks first');
  if (route.safe) await page.getByRole('status').filter({ hasText: /Safe mode/ }).waitFor();
  if (route.dashboard) {
    await page.getByRole('heading', { name: 'Fixture dashboard', exact: true }).waitFor();
    assert.equal(await page.locator('[data-layout="page"]').first().getAttribute('data-page-type'), 'wide');
    for (const widget of matrixDocument(DEFAULT_CONFIG, route.fixture).dashboards[0].widgets) {
      await page.getByText(widget.title, { exact: true }).first().waitFor();
    }
    if (route.fixture === 'dashboard-seeded') await page.getByText('Fixture task 1', { exact: true }).first().waitFor();
    else {
      const result = await api(context.request, server.base, '/data', 'POST', { requests: [{ key: 'tasks', source: 'tasks.list', params: { limit: 10 } }] });
      assert.equal(result.results.tasks.ok, true); assert.equal(result.results.tasks.count, 0);
      await until(async () => /No tasks|No .*yet|Nothing .*yet|No data/i.test(await page.locator('[data-layout="page"]').innerText()), 'Empty dashboard has no explanatory state');
      assert.equal(await page.getByText('Fixture task 1', { exact: true }).count(), 0);
    }
  }
  await page.evaluate(() => document.fonts.ready);
}
