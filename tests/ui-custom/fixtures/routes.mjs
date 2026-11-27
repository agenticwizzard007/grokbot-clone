import { seedWidgetData } from './widget-data.mjs';
import assert from 'node:assert/strict';
import { api, configAvailable, put, requireModules, open, agentPreview, until } from './harness.mjs';
import { contracts } from './contracts.mjs';
import { matrixDocument, LAYOUT_PATCH } from './matrix.mjs';

export const CUSTOM_ROUTES = [
  { name: 'navigation-tasks', fixture: 'navigation', hash: '#tasks', modules: ['web/src/customization/layout/useHome.ts'] },
  ...['seeded', 'empty', 'edit', 'widget-settings', 'add-widget'].map(state => ({ name: `dashboard-${state}`, fixture: state === 'empty' ? 'dashboard-empty' : 'dashboard-seeded', state, quality: true, phoneBack: true, hash: '#dash/d_00000001', dashboard: true,
    modules: ['web/src/dashboards/DashboardGrid.tsx', 'web/src/customization/layout/useHome.ts'] })),
  { name: 'preview-banner', fixture: 'default', hash: '#bot/{bot}', preview: true, modules: ['web/src/customization/PreviewBanner.tsx', 'server/src/agent/ui-tools.ts'] },
  { name: 'safe-mode-banner', fixture: 'default', hash: '?ui=safe#bots', safe: true, modules: ['web/src/customization/SafeModeBanner.tsx'] },
  { name: 'appearance', fixture: 'default', hash: '#settings/appearance', quality: true, phoneBack: true, modules: ['web/src/components/config/appearance/LayoutControls.tsx'] },
  { name: 'requirements', fixture: 'default', hash: '#settings/appearance/use', quality: true, phoneBack: true, modules: ['web/src/components/config/appearance/Requirements.tsx'] },
  { name: 'adaptive-home', fixture: 'default', hash: '', quality: true, adapt: true, phoneBack: true, modules: ['server/src/agent/ui-requirements-tools.ts', 'web/src/components/config/appearance/Requirements.tsx'] },
  { name: 'all-sections', fixture: 'navigation', hash: '#all', quality: true, phoneBack: true, modules: ['web/src/components/AllSections.tsx'] },
].map(route => ({ owner: 'UC-H', enforce: true, ...route }));

export async function prepareRoute(page, context, server, route) {
  // UC-B is merged, so even a later feature's gate must not conceal a broken API.
  await configAvailable(context.request, server.base);
  requireModules(...route.modules);
  if (route.fixture === 'dashboard-seeded') seedWidgetData(server);
  if (route.fixture === 'dashboard-empty') {
    await context.clearCookies();
    const login = await context.request.post(`${server.base}/api/auth/dev`, { data: { email: 'new-member@example.test', name: 'New member' } });
    assert.equal(login.status(), 200);
  }
  const { DEFAULT_CONFIG } = await contracts();
  await api(context.request, server.base, '/reset', 'POST', { scope: 'all' });
  await put(context, server.base, matrixDocument(DEFAULT_CONFIG, route.fixture));
  if (route.adapt) {
    const { adapt } = await import('../e2e/requirements-journeys.mjs');
    await adapt({ page, context, server }, 'operations');
  }
  await open(page, server.base, route.hash.replace('{bot}', server.fixture.bot.id));
  if (route.hash.endsWith('#bots')) await page.locator('.pb-bot-card__open').first().waitFor();
  if (route.hash === '#bot/{bot}') await page.getByRole('textbox', { name: `Message ${server.fixture.bot.name}`, exact: true }).waitFor();
  if (route.hash === '#tasks') await page.getByText('Draft the launch email', { exact: true }).first().waitFor();
  if (route.hash === '#all') await page.getByRole('heading', { name: /All sections/ }).waitFor();
  if (route.preview) await agentPreview(page, server, LAYOUT_PATCH, 'Open Tasks first');
  if (route.safe) await page.getByRole('status').filter({ hasText: /Safe mode/ }).waitFor();
  if (route.name === 'appearance') await until(() => page.locator('fieldset.appearance-fields').isEnabled(), 'Appearance controls did not load');
  if (route.name === 'requirements') await page.getByLabel('Role', { exact: true }).waitFor();
  if (route.adapt) await until(() => page.evaluate(() => location.hash.startsWith('#dash/')), 'Adapted home did not open');
  if (route.dashboard) {
    await page.getByRole('heading', { name: 'My week', exact: true }).waitFor();
    assert.equal(await page.locator('[data-layout="page"]').first().getAttribute('data-page-type'), 'wide');
    for (const widget of matrixDocument(DEFAULT_CONFIG, route.fixture).dashboards[0].widgets) {
      await page.getByText(widget.title, { exact: true }).first().waitFor();
    }
    if (route.fixture === 'dashboard-seeded') await page.getByText('Draft the launch email', { exact: true }).first().waitFor();
    else {
      const result = await api(context.request, server.base, '/data', 'POST', { requests: [{ key: 'tasks', source: 'tasks.list', params: { limit: 10 } }] });
      assert.equal(result.results.tasks.ok, true); assert.equal(result.results.tasks.count, 0);
      await until(async () => /No tasks|No .*yet|Nothing .*yet|No data/i.test(await page.locator('[data-layout="page"]').innerText()), 'Empty dashboard has no explanatory state');
      assert.equal(await page.getByText('Draft the launch email', { exact: true }).count(), 0);
    }
  }
  if (route.dashboard || route.adapt) {
    const widgets = page.locator('[data-widget-id]');
    if (route.dashboard) assert.equal(new Set(await widgets.evaluateAll(items => items.map(item => item.dataset.widgetType))).size, 10, 'All ten widget types are rendered');
    for (const widget of await widgets.all()) {
      await widget.scrollIntoViewIfNeeded();
      await until(async () => (await widget.getAttribute('data-widget-state')) !== 'loading', 'Widget data remained loading');
    }
    await page.getByRole('heading', { name: 'My week', exact: true }).scrollIntoViewIfNeeded().catch(error => { if (!route.adapt) throw error; });
    if (['edit', 'widget-settings', 'add-widget'].includes(route.state)) {
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      await page.getByRole('button', { name: 'Done', exact: true }).waitFor();
      if (route.state === 'widget-settings') await page.getByRole('button', { name: 'Settings: Working tasks', exact: true }).click();
      if (route.state === 'add-widget') await page.getByRole('button', { name: 'Add widget', exact: true }).click();
      if (route.state !== 'edit') await page.locator('dialog[open]').waitFor();
    }
  }
  await page.evaluate(() => document.fonts.ready);
}

export const QUALITY_VIEWPORTS = [320, 390, 500, 1280].flatMap(width => (width === 390 || width === 1280 ? ['light', 'dark'] : ['light']).map(theme => ({ width, theme })));
