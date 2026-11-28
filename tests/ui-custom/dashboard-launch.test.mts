import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';
import { dashboardLaunchServer, flyUiEnvironment } from './fixtures/dashboard-launch.mjs';
import { APP_SECTIONS, parseScreen, screenHash, settingsLocationHash } from '../../web/src/lib/navigation.ts';

let server: any, browser: any;
before(async () => { server = await dashboardLaunchServer(); browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] }); });
after(async () => { await browser?.close(); await server?.close(); });

test('Fly stage two flags give a fresh real session config and POST dashboard preview/apply', async () => {
  assert.deepEqual(flyUiEnvironment(), { UI_CUSTOMIZATION: 'on', UI_ADAPT: 'on' });
  const account = await server.context(browser);
  try {
    const db = new Database(server.dbPath, { readonly: true });
    const prefs: any = db.prepare('SELECT * FROM account_preferences WHERE user_id=?').get(account.user.id);
    assert.equal(prefs?.ui_custom_enabled ?? null, null, 'No per-account launch override');
    assert.equal(prefs?.ui_adapt ?? null, null, 'No suggestion override'); db.close();
    const saved = await account.request('GET', '/ui/config');
    assert.equal(saved.status, 200); assert.equal(saved.body.doc.version, 1); assert.deepEqual(saved.body.doc.dashboards, []);
    const preview = await account.request('POST', '/ui/patches/preview', { intent: 'Create daily summary', patch: [{ op: 'add', path: '/dashboards/-', value: { id: '$new1', name: 'Daily summary', icon: 'layout-dashboard', widgets: [] } }] }, saved.body.revision);
    assert.equal(preview.status, 200, JSON.stringify(preview));
    const applied = await account.request('POST', `/ui/previews/${preview.body.previewId}/apply`, {}, saved.body.revision);
    assert.equal(applied.status, 200, JSON.stringify(applied)); assert.equal(applied.body.doc.dashboards[0].name, 'Daily summary');
    assert.equal((await account.request('GET', '/ui/requirements')).status, 200);
  } finally { await account.context.close(); }
});

test('fresh signed-in account creates its first dashboard from the client', async () => {
  const account = await server.context(browser), page = await account.context.newPage();
  try {
    await page.goto(`${server.base}/#dashboards`);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.getByLabel('Name', { exact: true }).fill('Daily summary');
    await page.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click();
    await page.getByRole('button', { name: 'Add widget', exact: true }).waitFor();
    assert.match(page.url(), /#dash\/daily-summary-/);
    const saved = await account.request('GET', '/ui/config');
    assert.equal(saved.body.doc.dashboards.length, 1); assert.equal(saved.body.doc.dashboards[0].name, 'Daily summary');
  } finally { await account.context.close(); }
});

test('every Settings registry section and dashboard Settings link resolves, including query aliases', () => {
  const registry = fs.readFileSync('web/src/components/config/settingsNavigation.tsx', 'utf8');
  const ids = [...registry.matchAll(/\{ id: '([^']+)'/g)].map(match => match[1]);
  const sources = ['web/src/dashboards', 'web/src/components/config/appearance'];
  const linked = sources.flatMap(dir => fs.readdirSync(dir, { recursive: true }).filter(file => /\.tsx?$/.test(String(file))).flatMap(file => [...fs.readFileSync(`${dir}/${file}`, 'utf8').matchAll(/#settings\/([a-z/-]+)/g)].map(match => match[1])));
  for (const id of new Set([...APP_SECTIONS, ...ids, ...linked, 'dashboards', 'appearance/dashboards', 'appearance/use'])) {
    const parsed = parseScreen(`#settings/${id}`);
    assert.equal(parsed?.kind, 'settings', id); assert.ok(parsed && 'section' in parsed && parsed.section, `${id} must not fall back to General`);
    assert.deepEqual(parseScreen(settingsLocationHash({ pathname: '/settings', search: `?section=${id}`, hash: '' })), parsed);
    assert.deepEqual(parseScreen(screenHash(parsed!)), parsed);
  }
  assert.deepEqual(parseScreen('#settings/dashboards'), { kind: 'settings', section: 'appearance', dashboards: true });
  assert.equal(settingsLocationHash({ pathname: '/settings', search: '?section=dashboards', hash: '#tasks' }), '#tasks');
});
