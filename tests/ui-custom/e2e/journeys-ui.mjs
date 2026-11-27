import { seedWidgetData } from '../fixtures/widget-data.mjs';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { api, patch, configAvailable, requireModules, fixtureContext, open, agentPreview, button, until, runSuite } from '../fixtures/harness.mjs';
import { LAYOUT_PATCH, dashboardPatch, corruptDocument, DASHBOARD_EDITS } from '../fixtures/matrix.mjs';
import { requirementsUseCases, requirementsChangeReset } from './requirements-journeys.mjs';
import { INJECTION_DOCUMENTS } from '../security/corpus.mjs';

export async function reset(context, server) {
  const current = await configAvailable(context.request, server.base);
  await api(context.request, server.base, '/reset', 'POST', { scope: 'all' }, 200, current.revision);
}
export async function saved(context, server) { return configAvailable(context.request, server.base); }
export async function dashboardJourney({ page, context, server, capture = async () => {} }) {
  requireModules('server/src/agent/ui-tools.ts', 'web/src/dashboards/DashboardGrid.tsx', 'web/src/components/cards/UiPreviewCard.tsx', 'web/src/customization/layout/useHome.ts');
  seedWidgetData(server);
  const card = await agentPreview(page, server, dashboardPatch(), 'I coordinate weekly operations. Propose a dashboard for task review and usage');
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
  assert.equal(await page.locator('[data-layout="page"]').first().getAttribute('data-page-type'), 'wide');
  const first = dashboard.widgets[0].id;
  for (const edit of DASHBOARD_EDITS) {
    const before = await saved(context, server);
    await agentPreview(page, server, edit.patch, edit.intent);
    assert.deepEqual((await saved(context, server)).doc, before.doc, 'Chat edits wait for confirmation');
    await capture(`dashboard-${edit.name}-preview`);
    await button(page, 'Apply');
    await until(async () => (await saved(context, server)).revision > before.revision, `${edit.name} not saved`);
    const updated = (await saved(context, server)).doc.dashboards[0];
    if (edit.name === 'add') assert.equal(updated.widgets.length, 13);
    if (edit.name === 'remove') assert.equal(updated.widgets.length, 12);
    if (edit.name === 'reorder') assert.equal(updated.widgets[1].id, first);
    if (edit.name === 'resize') { assert.equal(updated.widgets[1].span, 6); assert.equal(updated.widgets[1].rows, 2); }
    await open(page, server.base, `#dash/${updated.id}`);
    await capture(`dashboard-${edit.name}-applied`);
  }
  const expected = (await saved(context, server)).doc;
  await page.reload(); await page.getByRole('heading', { name: 'My week', exact: true }).waitFor();
  assert.deepEqual((await saved(context, server)).doc, expected, 'Chat edits persist after reload');
  await page.getByText('Fixture task 1', { exact: true }).first().waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await capture('dashboard-reload-persisted');
  return dashboard;
}
export async function recoveryJourney({ page, context, server, capture = async () => {} }) {
  requireModules('web/src/customization/safeMode.ts', 'web/src/customization/SafeModeBanner.tsx');
  const current = await saved(context, server);
  server.withDb(db => {
    const result = db.prepare('UPDATE ui_config SET doc=? WHERE user_id=?').run(JSON.stringify(corruptDocument(current.doc)), server.fixture.userId);
    assert.equal(result.changes, 1, 'Recovery must corrupt a stored fixture row');
  });
  await open(page, server.base, '?ui=safe#bots');
  await page.getByText(/safe mode/i).first().waitFor();
  assert.ok(await page.getByRole('button', { name: 'Reset', exact: true }).count());
  await capture('safe-mode-recovery');
  await button(page, 'Reset');
  await button(page, 'Confirm reset');
  await until(async () => { const restored = await saved(context, server); return restored.status === 'ready' && restored.revision > current.revision && !restored.doc.layout.sidebar.hidden.includes('settings'); }, 'Reset did not commit the restored navigation');
  await capture('safe-mode-reset');
}
const journeys = [
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
  ['dashboard keyboard edit', async ({ page, context, server }) => {
    requireModules('web/src/dashboards/DashboardEditor.tsx', 'web/src/dashboards/AddWidgetSheet.tsx');
    await patch(context, server.base, dashboardPatch()); const dashboard = (await saved(context, server)).doc.dashboards[0];
    await open(page, server.base, `#dash/${dashboard.id}`);
    const press = async name => { const target = page.getByRole('button', { name, exact: true }).first(); await target.focus(); await page.keyboard.press('Enter'); };
    await press('Edit'); await press('Add widget'); await press(/^Note\b/);
    await until(async () => (await saved(context, server)).doc.dashboards[0].widgets.length === dashboard.widgets.length + 1, 'Keyboard add failed');
    const initial = (await saved(context, server)).doc.dashboards[0].widgets[0];
    await press(`Wider: ${initial.title}`); await until(async () => (await saved(context, server)).doc.dashboards[0].widgets[0].span > initial.span, 'Keyboard widen failed');
    await press(`Move later: ${initial.title}`); await until(async () => (await saved(context, server)).doc.dashboards[0].widgets[0].id !== initial.id, 'Keyboard move failed');
    await press(`Remove: ${initial.title}`); await until(async () => (await saved(context, server)).doc.dashboards[0].widgets.length === dashboard.widgets.length, 'Keyboard remove failed');
    await press('Done'); assert.equal(await page.getByRole('button', { name: /^Wider:/ }).count(), 0);
  }],
  ['corrupt database recovery', recoveryJourney],
  ['two tabs converge', async ({ page, context, server, browser }) => {
    requireModules('web/src/customization/store.ts', 'web/src/customization/layout/useHome.ts');
    await open(page, server.base);
    // Independent storage means only server events can update the second client.
    const { context: secondContext } = await fixtureContext(browser, server, page.viewportSize().width);
    try {
      const second = await secondContext.newPage();
      await open(second, server.base);
      await second.waitForFunction(async () => (await import('/src/customization/store.ts')).useCustomization.getState().status === 'ready');
      await patch(context, server.base, LAYOUT_PATCH);
      await until(() => second.evaluate(async () => (await import('/src/customization/store.ts')).useCustomization.getState().effective.layout.home.kind === 'tasks'), 'Second tab missed 2 second sync budget', 2000);
      if (page.viewportSize().width === 390) {
        await until(async () => await second.locator('.phone-tabs button').first().getAttribute('aria-label') === 'Tasks', 'Second tab did not render the saved navigation');
      }
    } finally { await secondContext.close(); }
  }],
  ['cross-user isolation', async ({ context, server, browser }) => {
    requireModules('server/src/ui/sources/executor.ts');
    const other = await browser.newContext();
    try {
      const login = await other.request.post(`${server.base}/api/auth/dev`, { data: { email: 'qa-temp-b@example.test', name: 'QA-Temp-B' } });
      assert.equal(login.ok(), true);
      await patch(context, server.base, LAYOUT_PATCH);
      const mine = await saved(context, server), theirs = await saved(other, server);
      assert.notDeepEqual(mine.doc.layout, theirs.doc.layout);
      const preview = await api(context.request, server.base, '/patches/preview', 'POST', { intent: 'Fixture preview', patch: LAYOUT_PATCH });
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
  ['offline config start with cache', async ({ page, context, server }) => {
    requireModules('web/src/customization/store.ts', 'web/src/customization/layout/useHome.ts');
    await open(page, server.base); await patch(context, server.base, LAYOUT_PATCH);
    await until(() => page.evaluate(() => JSON.parse(localStorage.getItem('swarm.ui.v1') || '{}').doc?.layout.home.kind === 'tasks'), 'Saved config was not cached');
    // The customization contract covers a failed config fetch; authentication remains available.
    await context.route('**/api/ui/config', route => route.abort('connectionrefused'));
    await page.goto(`${server.base}/`);
    await until(() => page.evaluate(() => location.hash === '#tasks'), 'Cached navigation lost while config API was unavailable');
    await page.locator('.shell-header').waitFor();
    assert.equal(await page.evaluate(async () => (await import('/src/customization/store.ts')).useCustomization.getState().status), 'offline');
  }],
  ['requirements use cases differ', requirementsUseCases],
  ['requirements change and reset', requirementsChangeReset],
  ['injection validator backstop', async ({ page, context, server }) => {
    requireModules('server/src/agent/ui-tools.ts');
    await open(page, server.base, `#bot/${server.fixture.bot.id}`); const before = await saved(context, server);
    const script = { intent: 'Untrusted fixture instructions', patch: [{ op: 'replace', path: '/layout/sidebar/hidden', value: ['settings'] }] };
    const composer = page.getByRole('textbox', { name: `Message ${server.fixture.bot.name}`, exact: true });
    await composer.fill(`Document content: ${INJECTION_DOCUMENTS[0]}\nmock: preview_ui_patch ${JSON.stringify(script)} | say Fixture injection rejected`);
    await composer.press('Enter'); await page.locator('.bubble.is-agent').getByText('Fixture injection rejected', { exact: true }).waitFor();
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
