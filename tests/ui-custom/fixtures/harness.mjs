import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { qualityServer, ROOT } from './server.mjs';

export class MissingFeature extends Error {}
export function requireFeature(available, message) {
  if (available) return;
  if (process.env.UC_REQUIRE_FULL === '1') throw new Error(`Required feature unavailable: ${message}`);
  throw new MissingFeature(message);
}
export function requireModules(...files) {
  for (const file of files) {
    const alternate = file.endsWith('.tsx') ? file.slice(0, -1) : file.endsWith('.ts') ? file + 'x' : file;
    requireFeature(fs.existsSync(path.join(ROOT, file)) || fs.existsSync(path.join(ROOT, alternate)), file);
  }
}
function localOnly(base) { assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname), 'Quality checks only target loopback fixture servers'); }
export async function configAvailable(request, base) {
  localOnly(base);
  const response = await request.get(`${base}/api/ui/config`);
  // UC-B is merged. A missing or disabled fixture API is a regression, never a skip.
  assert.equal(response.status(), 200, `Config probe failed: ${response.status()} ${await response.text()}`);
  const body = await response.json();
  assert.ok(body.doc && Number.isInteger(body.revision), 'Config envelope must contain doc and revision');
  return body;
}
export async function api(request, base, route, method = 'GET', data, expected = 200, revision) {
  localOnly(base);
  if (method !== 'GET' && route !== '/data' && revision === undefined) revision = (await configAvailable(request, base)).revision;
  if (method !== 'GET' && data === undefined) data = {};
  const headers = { Origin: base, ...(revision === undefined ? {} : { 'If-Match': `"${revision}"` }) };
  const response = await request.fetch(`${base}/api/ui${route}`, { method, data, headers });
  assert.equal(response.status(), expected, `${method} ${route}: ${response.status()} ${await response.text()}`);
  return response.status() === 204 ? null : response.json();
}
export async function patch(context, base, ops) {
  const { revision } = await configAvailable(context.request, base);
  return api(context.request, base, '/config', 'PATCH', { patch: ops }, 200, revision);
}
export async function put(context, base, doc) {
  const { revision } = await configAvailable(context.request, base);
  return api(context.request, base, '/config', 'PUT', doc, 200, revision);
}
export async function until(check, message, timeout = 10000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.fail(message);
}
export async function fixtureContext(browser, server, width = 1280, token = 'layout-test-token', theme = 'light') {
  const context = await browser.newContext({ viewport: { width, height: width <= 760 ? 844 : 900 }, reducedMotion: 'reduce', colorScheme: theme, serviceWorkers: 'block' });
  const external = [];
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === server.base || ['data:', 'blob:', 'about:'].includes(url.protocol)) return route.continue();
    external.push(url.origin); return route.abort();
  });
  await context.addCookies([{ name: 'swarm_session', value: token, url: server.base }]);
  await context.addInitScript(theme => { if (location.origin !== 'null') { localStorage.setItem('swarm.sidebarCollapsed', '0'); localStorage.setItem('swarm.theme', theme); } }, theme);
  return { context, external };
}
export async function open(page, base, hash = '#bots') {
  await page.goto(`${base}/${hash}`); await page.locator('.shell-header').first().waitFor(); await page.evaluate(() => document.fonts.ready);
}
export async function agentPreview(page, server, ops, intent = 'Open Tasks first') {
  await open(page, server.base, `#bot/${server.fixture.bot.id}`);
  const composer = page.getByRole('textbox', { name: `Message ${server.fixture.bot.name}`, exact: true });
  const previousIds = server.withDb(db => db.prepare("SELECT generation || ':' || seq AS id FROM rows WHERE bot_id=? AND json_extract(body,'$.card')='ui_preview'").all(server.fixture.bot.id).map(row => row.id));
  const payload = { intent, patch: ops, autofix: true };
  server.script(intent, `preview_ui_patch ${JSON.stringify(payload, null, 2)} | say ${intent}`);
  await composer.fill(intent);
  await composer.press('Enter');
  await page.getByRole('status').filter({ hasText: /Previewing/i }).waitFor();
  const row = await untilPreviewRow(server, previousIds);
  await page.getByText(intent, { exact: true }).first().waitFor();
  return row;
}
export async function untilPreviewRow(server, previousIds = []) {
  let body;
  await until(() => {
    body = server.withDb(db => db.prepare("SELECT generation || ':' || seq AS id,body FROM rows WHERE bot_id=? AND json_extract(body,'$.card')='ui_preview' ORDER BY created_at DESC").all(server.fixture.bot.id).find(row => !previousIds.includes(row.id)));
    return !!body;
  }, 'Agent did not create a ui_preview card');
  return JSON.parse(body.body);
}
export async function button(page, name) { await page.getByRole('button', { name, exact: true }).filter({ visible: true }).first().click(); }
export async function snapshot(page, out, name) {
  fs.mkdirSync(out, { recursive: true }); const file = path.join(out, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true }); return file;
}
export async function runSuite(name, cases, { server: needsServer = true, casesPerServer = Infinity } = {}) {
  const out = path.join(ROOT, '.context/ui-custom', name); fs.mkdirSync(out, { recursive: true });
  let server, browser; const results = [];
  try {
    if (needsServer) { server = await qualityServer(); browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] }); }
    for (const [index, item] of cases.entries()) {
      // Independent screen cases get fresh rate-limit windows and disposable data.
      // Production limits and responses stay intact.
      if (needsServer && index > 0 && index % casesPerServer === 0) {
        fs.appendFileSync(path.join(out, 'server-shards.log'), server.logs.join(''));
        await server.close(); server = await qualityServer();
      }
      const start = performance.now();
      try { await item.run({ server, browser, out }); results.push({ name: item.name, status: 'pass', ms: performance.now() - start }); }
      catch (error) { results.push({ name: item.name, status: error instanceof MissingFeature ? 'skip' : 'fail', reason: error.message, stack: error instanceof MissingFeature ? undefined : error.stack }); }
      const result = results.at(-1); console.log(`${result.status.toUpperCase()} ${result.name}${result.reason ? `: ${result.reason}` : ''}`);
    }
  } finally {
    if (server) fs.writeFileSync(path.join(out, 'server.log'), server.logs.join(''));
    await browser?.close(); await server?.close();
  }
  const counts = Object.fromEntries(['pass', 'fail', 'skip'].map(status => [status, results.filter(r => r.status === status).length]));
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ suite: name, counts, results }, null, 2) + '\n');
  console.log(`${name}: ${counts.pass} passed, ${counts.fail} failed, ${counts.skip} skipped. Report: ${out}/report.json`);
  if (counts.fail) process.exitCode = 1;
  return { counts, results, out };
}
