import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { api, patch, configAvailable, requireModules, fixtureContext, open, agentPreview, button, until, snapshot, runSuite } from '../fixtures/harness.mjs';
import { THEME_PATCH, LAYOUT_PATCH, dashboardPatch, corruptDocument } from '../fixtures/matrix.mjs';
import { INJECTION_DOCUMENTS } from '../security/corpus.mjs';

export async function reset(context, server) {
  const current = await configAvailable(context.request, server.base);
  await api(context.request, server.base, '/reset', 'POST', { scope: 'all' }, 200, current.revision);
}
export async function saved(context, server) { return configAvailable(context.request, server.base); }
export async function themeJourney({ page, context, server, capture = async () => {} }) {
  requireModules('server/src/agent/ui-tools.ts', 'web/src/customization/PreviewBanner.tsx', 'web/src/components/cards/UiPreviewCard.tsx');
  const before = await saved(context, server);
  const card = await agentPreview(page, server, THEME_PATCH, 'Dark mode with a teal accent');
  assert.equal(card.card, 'ui_preview');
  await until(() => page.evaluate(() => document.documentElement.dataset.theme === 'dark'), 'Theme preview never became dark');
  assert.equal((await saved(context, server)).revision, before.revision, 'Preview must not commit');
  await capture('theme-request-preview');
  await button(page, 'Apply');
  await until(async () => (await saved(context, server)).revision > before.revision, 'Apply did not advance revision');
  await page.reload(); await page.locator('.shell-header').waitFor();
  assert.equal((await saved(context, server)).doc.theme.mode, 'dark');
  await until(() => page.evaluate(() => document.documentElement.dataset.theme === 'dark'), 'Applied theme lost after reload');
  await capture('theme-applied-reload');
  await button(page, 'Undo');
  await until(async () => JSON.stringify((await saved(context, server)).doc) === JSON.stringify(before.doc), 'Undo did not restore document');
  await capture('theme-undo');
}
export async function dashboardJourney({ page, context, server, capture = async () => {} }) {
  requireModules('server/src/agent/ui-tools.ts', 'web/src/dashboards/DashboardGrid.tsx', 'web/src/components/cards/UiPreviewCard.tsx');
  const card = await agentPreview(page, server, dashboardPatch(), 'Build My week from fixture data');
  await capture('dashboard-request-preview');
  const preview = await api(context.request, server.base, `/previews/${card.previewId}`);
  const previewDashboard = preview.result.dashboards.at(-1);
  await page.evaluate(id => { location.hash = `#dash/${id}`; }, previewDashboard.id);
  await page.getByRole('heading', { name: 'My week', exact: true }).waitFor();
  await capture('dashboard-live-preview');
  await button(page, 'Apply');
  await until(async () => (await saved(context, server)).doc.dashboards.length === 1, 'Dashboard was not applied');
  const dashboard = (await saved(context, server)).doc.dashboards[0];
  await open(page, server.base, `#dash/${dashboard.id}`);
  await page.getByText('Fixture task 1', { exact: true }).first().waitFor();
  assert.ok(dashboard.widgets.length >= 10);
  for (const width of [1280, 390]) for (const mode of ['light', 'dark']) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await patch(context, server.base, [{ op: 'replace', path: '/theme/mode', value: mode }]);
    await until(() => page.evaluate(m => document.documentElement.dataset.theme === m, mode), 'Dashboard mode did not update');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await capture(`dashboard-${width}-${mode}`);
  }
  return dashboard;
}
export async function recoveryJourney({ page, context, server, capture = async () => {} }) {
  requireModules('web/src/customization/safeMode.ts', 'web/src/customization/SafeModeBanner.tsx');
  const current = await saved(context, server);
  server.withDb(db => {
    const result = db.prepare('UPDATE ui_config SET doc=? WHERE user_id=?').run(JSON.stringify(corruptDocument(current.doc)), server.fixture.userId);
    assert.equal(result.changes, 1, 'Recovery must corrupt a stored fixture row');
  });
  await open(page, server.base, '?ui=safe#settings/appearance');
  await page.getByText(/safe mode/i).first().waitFor();
  assert.ok(await page.getByRole('button', { name: 'Reset', exact: true }).count());
  await capture('safe-mode-recovery');
  await button(page, 'Reset');
  const dialog = page.getByRole('dialog');
  if (await dialog.isVisible()) await dialog.getByRole('button', { name: /Reset/, exact: false }).last().click();
  await until(async () => !(await saved(context, server)).doc.layout.sidebar.hidden.includes('settings'), 'Reset did not restore Settings');
  await capture('safe-mode-reset');
}
const journeys = [
  ['theme by chat', themeJourney],
  ['dashboard by chat', dashboardJourney],
  ['layout by chat', async ({ page, context, server }) => {
    requireModules('server/src/agent/ui-tools.ts', 'web/src/customization/layout/useHome.ts');
    await agentPreview(page, server, LAYOUT_PATCH, 'Open Tasks first'); await button(page, 'Apply');
    await until(async () => (await saved(context, server)).doc.layout.home.kind === 'tasks', 'Layout not applied');
    await open(page, server.base, ''); await until(() => page.evaluate(() => location.hash === '#tasks'), 'Tasks home redirect missing');
    assert.deepEqual((await saved(context, server)).doc.layout.phoneTabs, ['tasks', 'bots', 'search', 'settings']);
    if (page.viewportSize().width === 390) {
      const tabs = page.locator('.phone-tabs').getByRole('button');
      assert.match(await tabs.first().getAttribute('aria-label') || await tabs.first().innerText(), /Tasks/i);
    }
  }],
  ['manual appearance', async ({ page, context, server }) => {
    requireModules('web/src/components/config/AppearanceSettings.tsx');
    await open(page, server.base, '#settings/appearance');
    await button(page, 'Paper');
    if (await page.getByRole('button', { name: 'Apply', exact: true }).isVisible()) await button(page, 'Apply');
    await until(async () => (await saved(context, server)).doc.preset === 'paper', 'Preset not saved');
    for (const [label, value, check] of [
      ['Font', 'serif', d => d.theme.font.ui === 'serif'],
      ['Size', 'xlarge', d => d.theme.font.scale === 'xlarge'],
      ['Density', 'comfortable', d => d.theme.density === 'comfortable'],
      ['Corners', 'round', d => d.theme.radius === 'round'],
    ]) {
      const control = page.getByLabel(label, { exact: true });
      if (await control.count() && await control.evaluate(el => el.tagName === 'SELECT')) await control.selectOption(value);
      else await button(page, ({ xlarge: 'Extra large', comfortable: 'Comfortable', round: 'Round', serif: 'Serif' })[value]);
      await until(async () => check((await saved(context, server)).doc), `${label} not persisted`);
    }
    const accent = page.getByRole('textbox', { name: /Accent|Custom.*hex/i }).first();
    await accent.fill('#0F766E'); await accent.press('Enter');
    await until(async () => JSON.stringify((await saved(context, server)).doc.theme.colors).includes('#0F766E'), 'Accent not saved');
    const before = await saved(context, server); await accent.fill('#FFFFFF'); await accent.press('Enter');
    await page.getByText(/low contrast|contrast.*(?:too|below|minimum)/i).first().waitFor();
    assert.equal((await saved(context, server)).revision, before.revision);
    await page.reload(); assert.equal((await saved(context, server)).doc.theme.font.scale, 'xlarge');
  }],
  ['dashboard keyboard edit', async ({ page, context, server }) => {
    requireModules('web/src/dashboards/DashboardEditor.tsx', 'web/src/dashboards/AddWidgetSheet.tsx');
    await patch(context, server.base, dashboardPatch()); const dashboard = (await saved(context, server)).doc.dashboards[0];
    await open(page, server.base, `#dash/${dashboard.id}`);
    const press = async name => { const target = page.getByRole('button', { name, exact: true }).first(); await target.focus(); await page.keyboard.press('Enter'); };
    await press('Edit'); await press('Add widget'); await press('Note');
    await until(async () => (await saved(context, server)).doc.dashboards[0].widgets.length === dashboard.widgets.length + 1, 'Keyboard add failed');
    const initial = (await saved(context, server)).doc.dashboards[0].widgets[0];
    await press('Wider'); await until(async () => (await saved(context, server)).doc.dashboards[0].widgets[0].span > initial.span, 'Keyboard widen failed');
    await press('Move later'); await until(async () => (await saved(context, server)).doc.dashboards[0].widgets[0].id !== initial.id, 'Keyboard move failed');
    await press('Remove'); await until(async () => (await saved(context, server)).doc.dashboards[0].widgets.length === dashboard.widgets.length, 'Keyboard remove failed');
    await press('Done'); assert.equal(await page.getByRole('button', { name: 'Wider', exact: true }).count(), 0);
  }],
  ['corrupt database recovery', recoveryJourney],
  ['two tabs converge', async ({ page, context, server }) => {
    requireModules('web/src/customization/store.ts');
    await open(page, server.base); const second = await context.newPage();
    try {
      await open(second, server.base);
      await patch(context, server.base, THEME_PATCH);
      await until(() => second.evaluate(() => document.documentElement.dataset.theme === 'dark'), 'Second tab missed 2 second sync budget', 2000);
    } finally { await second.close(); }
  }],
  ['cross-user isolation', async ({ context, server, browser }) => {
    requireModules('server/src/ui/sources/executor.ts');
    const other = await browser.newContext();
    try {
      const login = await other.request.post(`${server.base}/api/auth/dev`, { data: { email: 'qa-temp-b@example.test', name: 'QA-Temp-B' } });
      assert.equal(login.ok(), true);
      await patch(context, server.base, THEME_PATCH);
      const mine = await saved(context, server), theirs = await saved(other, server);
      assert.notDeepEqual(mine.doc.theme, theirs.doc.theme);
      const preview = await api(context.request, server.base, '/patches/preview', 'POST', { intent: 'Fixture preview', patch: THEME_PATCH });
      for (const [method, route] of [['GET', `/previews/${preview.previewId}`], ['POST', `/previews/${preview.previewId}/apply`], ['POST', `/previews/${preview.previewId}/discard`]]) {
        const denied = await api(other.request, server.base, route, method, undefined, 404, theirs.revision);
        assert.equal(denied.code, 'not_found');
      }
      const result = await api(other.request, server.base, '/data', 'POST', { requests: [{ key: 'foreign', source: 'tasks.list', params: { botId: server.fixture.bot.id, limit: 10 } }] });
      assert.equal(result.results.foreign.ok, false);
      assert.match(JSON.stringify(result.results.foreign), /not_found/);
      assert.doesNotMatch(JSON.stringify(result), /Fixture task|PRIVATE_FIXTURE/);
      assert.deepEqual((await saved(other, server)).doc, theirs.doc);
    } finally { await other.close(); }
  }],
  ['offline API start with cache', async ({ page, context, server }) => {
    requireModules('web/public/ui-boot.js', 'web/src/customization/store.ts');
    await open(page, server.base); await patch(context, server.base, THEME_PATCH);
    await until(() => page.evaluate(() => JSON.parse(localStorage.getItem('swarm.ui.v1') || '{}').doc?.theme.mode === 'dark'), 'Saved config was not cached');
    await context.route('**/api/**', route => route.abort('connectionrefused'));
    await page.reload();
    await until(() => page.evaluate(() => document.documentElement.dataset.theme === 'dark'), 'Cached theme lost while API was unavailable');
    await page.locator('.shell-header').waitFor();
  }],
  ['injection validator backstop', async ({ page, context, server }) => {
    requireModules('server/src/agent/ui-tools.ts');
    await open(page, server.base, `#bot/${server.fixture.bot.id}`); const before = await saved(context, server);
    const script = { intent: 'Untrusted fixture instructions', patch: [{ op: 'replace', path: '/layout/sidebar/hidden', value: ['settings'] }] };
    const composer = page.getByRole('textbox', { name: `Message ${server.fixture.bot.name}`, exact: true });
    await composer.fill(`Document content: ${INJECTION_DOCUMENTS[0]}\nmock: preview_ui_patch ${JSON.stringify(script)} | say Fixture injection rejected`);
    await composer.press('Enter'); await page.getByText('Fixture injection rejected', { exact: true }).waitFor();
    assert.deepEqual((await saved(context, server)).doc, before.doc);
    assert.equal(await page.getByRole('status').filter({ hasText: /Previewing/i }).count(), 0);
  }],
];
export async function runJourneys() {
  return runSuite('journeys', [390, 1280].flatMap(width => journeys.map(([name, run]) => ({ name: `${name} ${width}`, run: async args => {
    const { context, external } = await fixtureContext(args.browser, args.server, width);
    try {
      await configAvailable(context.request, args.server.base); await reset(context, args.server);
      const page = await context.newPage(); page.setDefaultTimeout(15000);
      await run({ ...args, page, context }); assert.deepEqual(external, [], 'No outside browser requests');
    } finally { await context.close(); }
  } }))));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runJourneys();
