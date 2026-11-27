import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runSuite, fixtureContext, configAvailable, api, open, until, requireModules } from '../fixtures/harness.mjs';
import { ROOT } from '../fixtures/server.mjs';
import { contracts } from '../fixtures/contracts.mjs';
import { fuzzTargets } from './fuzz-targets.mjs';
import { XSS, cssFuzz, HOSTILE_PATCHES } from './corpus.mjs';
import { widgets, corruptDocument, LAYOUT_PATCH, dashboardPatch } from '../fixtures/matrix.mjs';

function xssDocument(defaults, value, index) {
  const doc = structuredClone(defaults);
  const dashboard = { id: 'd_00000001', name: 'Security fixture', icon: 'layout-dashboard', description: '', widgets: widgets() };
  const target = index % 5;
  if (target === 0) dashboard.name = value;
  if (target === 1) dashboard.description = value;
  if (target === 2) dashboard.widgets[0].title = value;
  if (target === 3) dashboard.widgets.find(w => w.type === 'note').options.text = value;
  if (target === 4) dashboard.widgets.find(w => w.type === 'shortcuts').options.items[0].label = value;
  doc.dashboards = [dashboard]; return doc;
}
async function withContext(args, fn) {
  const { context, external } = await fixtureContext(args.browser, args.server);
  try { const current = await configAvailable(context.request, args.server.base); await fn({ ...args, context, current, external }); }
  catch (error) {
    for (const [index, page] of context.pages().entries()) {
      await page.screenshot({ path: path.join(args.out, `failure-${Date.now()}-${index}.png`), fullPage: true }).catch(() => {});
      fs.writeFileSync(path.join(args.out, 'last-browser-failure.txt'), await page.locator('body').innerText().catch(() => 'Page unavailable'));
    }
    throw error;
  } finally { await context.close(); }
}
const cases = [
  { name: 'no executable rendering sinks', run: async () => {
    requireModules('web/src/dashboards/note-parser.ts');
    const files = [];
    const walk = entry => { for (const item of fs.readdirSync(entry, { withFileTypes: true })) { const file = path.join(entry, item.name); if (item.isDirectory()) walk(file); else if (/\.[jt]sx?$/.test(file)) files.push(file); } };
    for (const dir of ['web/src/customization', 'web/src/dashboards', 'web/src/components/config/appearance']) if (fs.existsSync(path.join(ROOT, dir))) walk(path.join(ROOT, dir));
    for (const file of files) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /dangerouslySetInnerHTML|\.innerHTML\s*=|insertAdjacentHTML|new\s+Function\s*\(/, file);
  } },
  { name: '5000 injection strings in dashboard and navigation enums', run: async () => {
    const shared = await contracts(), { uiConfigSchema } = shared;
    const { doc: template, paths, parameterSchemas } = fuzzTargets(shared);
    assert.equal(uiConfigSchema.safeParse(template).success, true, 'Fuzz starts from a valid document');
    assert.ok(paths.length > 20, 'Dashboard and navigation enums must come from registries');
    let assertions = 0;
    const values = cssFuzz();
    console.log(`Fuzzing ${values.length} inputs in ${paths.length} contract paths`);
    for (const keys of paths) {
      const doc = structuredClone(template); let target = doc;
      for (const key of keys.slice(0, -1)) target = target[key] ??= {};
      for (const value of values) {
        target[keys.at(-1)] = value;
        assert.equal(uiConfigSchema.safeParse(doc).success, false, keys.join('/')); assertions++;
      }
    }
    for (const { name, schema, data, paths: sourcePaths } of parameterSchemas) {
      assert.equal(schema.safeParse(data).success, true, name);
      for (const keys of sourcePaths) for (const value of values) {
        assert.equal(schema.safeParse({ ...data, [keys[0]]: value }).success, false, name); assertions++;
      }
    }
    const fieldCount = paths.length + parameterSchemas.reduce((sum, source) => sum + source.paths.length, 0);
    console.log(`CSS fuzz: ${assertions} rejected inputs across ${fieldCount} fields`);
  } },
  ...['API', 'import', 'agent'].map(ingress => ({ name: `50 XSS payloads through ${ingress}`, run: args => withContext(args, async ({ context, current, server, external }) => {
    if (ingress === 'agent') requireModules('server/src/agent/ui-tools.ts');
    const page = await context.newPage(), dialogs = [];
    page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
    await page.addInitScript(() => { window.__ucXss = 0; window.__ucCssWrites = []; const original = CSSStyleDeclaration.prototype.setProperty; CSSStyleDeclaration.prototype.setProperty = function(name, value, priority) { window.__ucCssWrites.push(String(value)); return original.call(this, name, value, priority); }; });
    await open(page, server.base, `#bot/${server.fixture.bot.id}`);
    for (const [index, value] of XSS.entries()) {
      const doc = xssDocument(current.doc, value, index);
      if (ingress === 'API') await api(context.request, server.base, '/config', 'PUT', doc, 422, current.revision);
      if (ingress === 'import') await api(context.request, server.base, '/import/preview', 'POST', doc, 422);
      if (ingress === 'agent') {
        const composer = page.getByRole('textbox', { name: `Message ${server.fixture.bot.name}`, exact: true });
        const payload = { intent: 'Check fixture validation', patch: [{ op: 'replace', path: '/dashboards', value: doc.dashboards }] };
        await composer.fill(`mock: preview_ui_patch ${JSON.stringify(payload)} | say Security fixture ${index} checked`);
        await composer.press('Enter'); await page.getByText(`Security fixture ${index} checked`, { exact: true }).waitFor();
        const previews = server.withDb(db => db.prepare("SELECT count(*) n FROM ui_previews WHERE user_id=? AND status='pending'").get(server.fixture.userId).n);
        assert.equal(previews, 0, 'Invalid tool input must not create a preview');
      }
      const after = await configAvailable(context.request, server.base);
      assert.equal(after.revision, current.revision); assert.deepEqual(after.doc, current.doc);
    }
    assert.deepEqual(dialogs, []); assert.deepEqual(external, []);
    assert.equal(await page.locator('[data-uc-injected]').count(), 0);
    assert.equal(await page.evaluate(() => window.__ucXss), 0);
    const writes = await page.evaluate(() => window.__ucCssWrites);
    assert.equal(writes.some(value => XSS.includes(value)), false);
  }) })),
  { name: 'lockout, privilege, prototype and resource abuse rejected', run: args => withContext(args, async ({ context, server, current }) => {
    for (const attack of HOSTILE_PATCHES) {
      const response = await api(context.request, server.base, '/patches/preview', 'POST', { intent: attack.name, patch: attack.patch }, 422);
      assert.ok(Array.isArray(response.details ?? response.errors) && (response.details ?? response.errors).length, 'Machine-readable validation errors');
      assert.deepEqual((await configAvailable(context.request, server.base)).doc, current.doc);
    }
    assert.equal({}.polluted, undefined);
    const tooLarge = { ...current.doc, unexpected: 'x'.repeat(256 * 1024) };
    await api(context.request, server.base, '/import/preview', 'POST', tooLarge, 413);
  }) },
  { name: 'corrupt stored config falls back without overwrite and API reset preserves history', run: args => withContext(args, async ({ context, server, current }) => {
    const { DEFAULT_CONFIG } = await contracts();
    await api(context.request, server.base, '/config', 'PUT', current.doc, 200, current.revision);
    const hostile = JSON.stringify(corruptDocument(current.doc));
    server.withDb(db => assert.equal(db.prepare('UPDATE ui_config SET doc=? WHERE user_id=?').run(hostile, server.fixture.userId).changes, 1));
    try {
      const fallback = await configAvailable(context.request, server.base);
      assert.equal(fallback.status, 'invalid_stored'); assert.deepEqual(fallback.doc, DEFAULT_CONFIG);
      assert.equal(server.withDb(db => db.prepare('SELECT doc FROM ui_config WHERE user_id=?').get(server.fixture.userId).doc), hostile, 'Reading cannot overwrite invalid stored data');
      const before = await api(context.request, server.base, '/history');
      await api(context.request, server.base, '/reset', 'POST', { scope: 'all' }, 200, fallback.revision);
      const restored = await configAvailable(context.request, server.base);
      assert.equal(restored.status, 'ready'); assert.equal(restored.revision, fallback.revision + 1); assert.deepEqual(restored.doc, DEFAULT_CONFIG);
      const after = await api(context.request, server.base, '/history');
      for (const item of before.history) assert.ok(after.history.some(row => row.revision === item.revision), 'Reset preserves prior history');
    } finally { await api(context.request, server.base, '/reset', 'POST', { scope: 'all' }); }
  }) },
  { name: 'safe mode remains reachable with corrupt stored config', run: args => withContext(args, async ({ context, server, current }) => {
    requireModules('web/src/customization/SafeModeBanner.tsx');
    await api(context.request, server.base, '/config', 'PUT', current.doc, 200, current.revision);
    server.withDb(db => db.prepare('UPDATE ui_config SET doc=? WHERE user_id=?').run(JSON.stringify(corruptDocument(current.doc)), server.fixture.userId));
    const fallback = await configAvailable(context.request, server.base); assert.equal(fallback.status, 'invalid_stored');
    const page = await context.newPage(); await open(page, server.base, '?ui=safe#bots');
    await page.getByText(/safe mode/i).first().waitFor();
    assert.ok(await page.getByRole('button', { name: 'Reset', exact: true }).count());
    await api(context.request, server.base, '/reset', 'POST', { scope: 'all' }, 200, fallback.revision);
  }) },
  { name: 'required controls cannot be registered as hideable widgets', run: async () => {
    const { REGISTRY } = await contracts();
    const components = Array.isArray(REGISTRY.components) ? REGISTRY.components : Object.values(REGISTRY.components);
    for (const id of ['settings', 'chat.composer', 'chat.approvals', 'chat.questions', 'preview.banner', 'safeMode.banner', 'errors', 'signOut']) assert.equal(components.some(item => item.id === id), false, id);
    const widgetIds = (Array.isArray(REGISTRY.widgets) ? REGISTRY.widgets : Object.values(REGISTRY.widgets)).map(item => item.id);
    for (const id of ['html', 'iframe', 'image', 'script', 'approval', 'connect', 'question']) assert.equal(widgetIds.includes(id), false, id);
  } },
  { name: 'two-user config, preview, history and export isolation', run: args => withContext(args, async ({ context, server, current, browser }) => {
    const other = await browser.newContext();
    try {
      assert.ok((await other.request.post(`${server.base}/api/auth/dev`, { data: { email: 'qa-temp-isolation-b@example.test', name: 'QA-Temp-Isolation-B' } })).ok());
      const beforeB = await configAvailable(other.request, server.base);
      const preview = await api(context.request, server.base, '/patches/preview', 'POST', { intent: 'PRIVATE_PREVIEW_SENTINEL', patch: LAYOUT_PATCH });
      for (const [method, suffix] of [['GET', ''], ['POST', '/apply'], ['POST', '/discard']]) {
        const denied = await api(other.request, server.base, `/previews/${preview.previewId}${suffix}`, method, undefined, 404);
        assert.equal(denied.code, 'not_found');
      }
      const applied = await api(context.request, server.base, `/previews/${preview.previewId}/apply`, 'POST', {});
      assert.equal(applied.doc.layout.home.kind, 'tasks');
      assert.notDeepEqual(applied.doc.layout, beforeB.doc.layout, 'The fixture accounts must have different navigation');
      assert.deepEqual((await configAvailable(other.request, server.base)).doc, beforeB.doc);
      assert.deepEqual((await api(other.request, server.base, `/config?userId=${server.fixture.userId}`)).doc, beforeB.doc, 'Query input cannot select another account');
      assert.ok((await api(context.request, server.base, '/history')).history.some(row => row.revision === applied.revision));
      assert.deepEqual((await api(other.request, server.base, '/history')).history, []);
      assert.equal((await api(other.request, server.base, `/history/${applied.revision}/restore`, 'POST', {}, 404)).code, 'not_found');
      assert.doesNotMatch(JSON.stringify(await api(other.request, server.base, '/history')), /PRIVATE_PREVIEW_SENTINEL/);
      assert.deepEqual((await configAvailable(other.request, server.base)).doc, beforeB.doc);
      const exported = await api(context.request, server.base, '/export');
      const allowed = new Set([...Object.keys(current.doc), 'exportedAt']);
      for (const key of Object.keys(exported)) assert.ok(allowed.has(key), `Export key ${key}`);
      assert.doesNotMatch(JSON.stringify(exported), /PRIVATE_|FOREIGN_TASK_SENTINEL/);
    } finally { await other.close(); }
  }) },
  { name: 'two-user source isolation and field allowlists', run: args => withContext(args, async ({ context, server, browser }) => {
    requireModules('server/src/ui/sources/executor.ts');
    const other = await browser.newContext();
    try {
      assert.ok((await other.request.post(`${server.base}/api/auth/dev`, { data: { email: 'qa-temp-sources-b@example.test', name: 'QA-Temp-Sources-B' } })).ok());
      const foreignUser = server.withDb(db => db.prepare('SELECT id FROM users WHERE email=?').get('qa-temp-sources-b@example.test'));
      const response = await other.request.post(`${server.base}/api/bots`, { data: { name: 'Fixture foreign Bot', mode: 'personal' } });
      assert.ok(response.ok()); const { bot: foreignBot } = await response.json();
      server.withDb(db => db.prepare('INSERT INTO tasks(id,bot_id,title,state,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
        .run('task_foreign_sentinel', foreignBot.id, 'FOREIGN_TASK_SENTINEL', 'done', 'PRIVATE_FOREIGN_NOTE', Date.now(), Date.now()));
      const { REGISTRY } = await contracts();
      const sources = Array.isArray(REGISTRY.sources) ? REGISTRY.sources : Object.values(REGISTRY.sources);
      const requests = sources.map(source => ({ key: source.id, source: source.id, params: {
        ...(['tasks.series', 'usage.summary', 'usage.series', 'runs.counts', 'runs.series'].includes(source.id) ? { range: '7d' } : {}),
        ...(source.id === 'usage.series' ? { metric: 'cost' } : {}), ...(source.id === 'runs.series' ? { group: 'day' } : {}),
      } }));
      const result = await api(context.request, server.base, '/data', 'POST', { requests });
      assert.doesNotMatch(JSON.stringify(result), /FOREIGN_TASK_SENTINEL|PRIVATE_|"(?:instructions|prompt|memory|apiKey|note)"/);
      for (const source of sources) {
        const entry = result.results[source.id]; assert.equal(entry.ok, true, source.id);
        for (const row of entry.rows || []) for (const key of Object.keys(row)) assert.ok(source.fields.includes(key), `${source.id}.${key}`);
      }
      const denied = await api(context.request, server.base, '/data', 'POST', { requests: [{ key: 'foreign', source: 'tasks.list', params: { botId: foreignBot.id } }] });
      assert.equal(denied.results.foreign.ok, false); assert.match(JSON.stringify(denied.results.foreign), /not_found/);
      assert.ok(foreignUser.id !== server.fixture.userId);
    } finally { await other.close(); }
  }) },
  { name: 'network and CSP retain same-origin asset boundaries', run: args => withContext(args, async ({ context, server, external }) => {
    requireModules('web/src/dashboards/DashboardGrid.tsx', 'web/src/customization/layout/useHome.ts');
    const page = await context.newPage();
    await page.addInitScript(() => { window.__ucCsp = []; document.addEventListener('securitypolicyviolation', event => window.__ucCsp.push({ directive: event.violatedDirective, blocked: event.blockedURI })); });
    const written = await api(context.request, server.base, '/config', 'PATCH', { patch: dashboardPatch() });
    await open(page, server.base, `#dash/${written.doc.dashboards.at(-1).id}`);
    assert.deepEqual(external, []); assert.deepEqual(await page.evaluate(() => window.__ucCsp), []);
    const assets = await page.evaluate(() => [...document.querySelectorAll('script[src],link[rel="stylesheet"],img[src]')].map(el => el.src || el.href));
    assert.ok(assets.every(value => new URL(value, server.base).origin === server.base || value.startsWith('data:')));
  }) },
];
await runSuite('security', cases);
