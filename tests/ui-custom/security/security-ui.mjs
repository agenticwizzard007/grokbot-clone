import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runSuite, fixtureContext, configAvailable, api, open, until, requireModules } from '../fixtures/harness.mjs';
import { ROOT } from '../fixtures/server.mjs';
import { contracts } from '../fixtures/presets.mjs';
import { XSS, cssFuzz, HOSTILE_PATCHES } from './corpus.mjs';
import { widgets, corruptDocument } from '../fixtures/matrix.mjs';

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
  finally { await context.close(); }
}
const cases = [
  { name: 'no executable rendering sinks', run: async () => {
    requireModules('web/src/customization/applier.ts', 'web/src/dashboards/note-parser.ts', 'web/src/components/config/AppearanceSettings.tsx');
    const files = [];
    const walk = entry => { for (const item of fs.readdirSync(entry, { withFileTypes: true })) { const file = path.join(entry, item.name); if (item.isDirectory()) walk(file); else if (/\.[jt]sx?$/.test(file)) files.push(file); } };
    for (const dir of ['web/src/customization', 'web/src/dashboards', 'web/src/components/config/appearance']) if (fs.existsSync(path.join(ROOT, dir))) walk(path.join(ROOT, dir));
    files.push(path.join(ROOT, 'web/src/components/config/AppearanceSettings.tsx'));
    for (const file of files) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /dangerouslySetInnerHTML|\.innerHTML\s*=|insertAdjacentHTML|new\s+Function\s*\(/, file);
  } },
  { name: '5000 CSS strings in every registered color and primary enum field', run: async () => {
    const { DEFAULT_CONFIG, REGISTRY, uiConfigSchema } = await contracts();
    const tokens = Array.isArray(REGISTRY.tokens) ? REGISTRY.tokens : Object.values(REGISTRY.tokens);
    const paths = ['theme.mode', 'theme.font.ui', 'theme.font.heading', 'theme.font.scale', 'theme.density', 'theme.radius', 'theme.motion', 'theme.contrast', 'layout.sidebar.width', 'layout.chat.width', 'layout.home.kind'];
    for (const mode of ['light', 'dark']) for (const token of tokens) paths.push(`theme.${token.kind === 'derived' ? 'overrides' : 'colors'}.${mode}.${token.id}`);
    assert.ok(tokens.length > 0, 'Token registry must be populated');
    let assertions = 0;
    for (const pointer of paths) for (const value of cssFuzz()) {
      const doc = structuredClone(DEFAULT_CONFIG), keys = pointer.split('.'); let target = doc;
      for (const key of keys.slice(0, -1)) target = target[key] ??= {};
      target[keys.at(-1)] = value;
      assert.equal(uiConfigSchema.safeParse(doc).success, false, pointer); assertions++;
    }
    console.log(`CSS fuzz: ${assertions} rejected inputs across ${paths.length} fields`);
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
  { name: 'corrupt stored config falls back and safe mode remains reachable', run: args => withContext(args, async ({ context, server, current }) => {
    requireModules('web/src/customization/SafeModeBanner.tsx');
    await api(context.request, server.base, '/config', 'PUT', current.doc, 200, current.revision);
    server.withDb(db => db.prepare('UPDATE ui_config SET doc=? WHERE user_id=?').run(JSON.stringify(corruptDocument(current.doc)), server.fixture.userId));
    const fallback = await configAvailable(context.request, server.base); assert.equal(fallback.status, 'invalid_stored');
    const page = await context.newPage(); await open(page, server.base, '?ui=safe#settings/appearance');
    await page.getByText(/safe mode/i).first().waitFor();
    assert.ok(await page.getByRole('button', { name: 'Reset', exact: true }).count());
    await api(context.request, server.base, '/reset', 'POST', { scope: 'all' }, 200, fallback.revision);
  }) },
  { name: 'network and CSP retain same-origin asset boundaries', run: args => withContext(args, async ({ context, server, external }) => {
    requireModules('web/public/ui-boot.js', 'web/src/dashboards/DashboardGrid.tsx');
    const page = await context.newPage();
    await page.addInitScript(() => { window.__ucCsp = []; document.addEventListener('securitypolicyviolation', event => window.__ucCsp.push({ directive: event.violatedDirective, blocked: event.blockedURI })); });
    await open(page, server.base, '#settings/appearance');
    const boot = await context.request.get(`${server.base}/ui-boot.js`); assert.equal(boot.status(), 200);
    assert.deepEqual(external, []); assert.deepEqual(await page.evaluate(() => window.__ucCsp), []);
    const assets = await page.evaluate(() => [...document.querySelectorAll('script[src],link[rel="stylesheet"],img[src]')].map(el => el.src || el.href));
    assert.ok(assets.every(value => new URL(value, server.base).origin === server.base || value.startsWith('data:')));
  }) },
];
await runSuite('security', cases);
