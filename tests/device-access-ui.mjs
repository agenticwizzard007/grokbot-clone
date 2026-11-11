// Real settings UI with an isolated API fixture; no permission grants or live account.
// Run after npm run build -w web: node tests/device-access-ui.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';

const port = await new Promise(resolve => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(port)], { cwd: new URL('../web', import.meta.url), stdio: 'pipe' });
let logs = '', browser;
server.stdout.on('data', d => { logs += d; }); server.stderr.on('data', d => { logs += d; });
const base = `http://127.0.0.1:${port}`;
const output = new URL('../.context/device-access/', import.meta.url);
await fs.mkdir(output, { recursive: true });

async function fixture(context) {
  let policy = true;
  const mutations = [];
  await context.route('**/api/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    if (request.method() !== 'GET') mutations.push({ method: request.method(), pathname });
    let body = {};
    if (pathname === '/api/auth/me') body = { user: { id: 'test-user', name: 'Alex', email: 'alex@example.test' } };
    else if (pathname === '/api/bots') body = { bots: [], live: [] };
    else if (pathname === '/api/computer') body = { computer: { provider: 'cloudvm', status: 'asleep', screens: [] } };
    else if (pathname === '/api/computer/details') body = { computer: { provider: 'cloudvm', status: 'asleep', screens: [] }, screens: [], hibernation: { idleMinutes: 10 } };
    else if (pathname === '/api/policies') body = { policies: policy ? [{ tool: 'GMAIL_SEND_EMAIL', mode: 'always_allow' }] : [] };
    else if (pathname.startsWith('/api/policies/') && request.method() === 'DELETE') { policy = false; body = { ok: true }; }
    else if (pathname === '/api/mcp/servers') body = { servers: [] };
    else if (pathname === '/api/voice/options') body = { voices: [], languages: [], speeds: [], configured: false };
    else if (pathname === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"type":"hello"}\n\n' });
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  return mutations;
}

try {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await fetch(base).then(r => r.ok, () => false)) break;
    if (server.exitCode !== null) throw new Error(logs);
    await new Promise(r => setTimeout(r, 100));
  }
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  for (const width of [1486, 768, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    const mutations = await fixture(context);
    const page = await context.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${base}/#settings/permissions`);
    await page.getByRole('heading', { name: 'Actions you’ve always allowed' }).waitFor();
    assert.equal(await page.locator('.device-access, [data-swarm-mac-control-slot]').count(), 0, 'Permissions does not duplicate device access');
    for (const permission of ['Accessibility', 'Screen Recording', 'Full Disk Access', 'Automation']) {
      assert.equal(await page.getByText(permission, { exact: true }).count(), 0, `${permission} is only in Computer`);
    }
    if (width === 1486) await page.screenshot({ path: new URL('permissions-actions-only.png', output).pathname, fullPage: true });
    await page.getByRole('button', { name: 'Ask again', exact: true }).click();
    await page.getByText('Nothing here yet.', { exact: false }).waitFor();
    assert.deepEqual(mutations, [{ method: 'DELETE', pathname: '/api/policies/GMAIL_SEND_EMAIL' }], 'device guidance never pairs or starts a computer');
    await page.getByRole('button', { name: 'Computer settings', exact: false }).click();
    await page.getByRole('heading', { name: 'Computer', exact: true }).waitFor();
    await page.getByRole('heading', { name: 'Device access', exact: true }).waitFor();
    for (const permission of ['Accessibility', 'Screen Recording', 'Full Disk Access', 'Automation']) {
      assert.equal(await page.locator('.device-access__permissions').getByText(permission, { exact: true }).count(), 1);
    }
    assert.equal(await page.locator('.device-access').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, `${width}: permission rows fit`);
    const font = await page.locator('.device-access').evaluate(el => getComputedStyle(el).fontFamily);
    assert.match(font, /Instrument Sans/);
    if (width === 1486 || width === 390) await page.screenshot({ path: new URL(`computer-${width}.png`, output).pathname, fullPage: true });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    assert.equal(await page.locator('.device-access').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, `${width}: dark permission rows fit`);
    if (width === 1486) await page.screenshot({ path: new URL('computer-dark.png', output).pathname, fullPage: true });
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS ${width}px: Computer-only permissions, branded responsive rows, saved approval removal, no implicit pairing`);
  }
  const context = await browser.newContext({ userAgent: 'SwarmNative/1.0 (macOS)', viewport: { width: 1200, height: 900 } });
  const mutations = await fixture(context);
  const page = await context.newPage();
  await page.goto(`${base}/#settings/computer`);
  await page.getByRole('heading', { name: 'Device access', exact: true }).waitFor();
  await page.evaluate(() => { document.documentElement.dataset.swarmMacControl = 'available'; });
  await page.locator('[data-swarm-mac-control-slot]').waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Device access', exact: true }).count(), 0, 'native surface replaces browser-only guidance');
  assert.deepEqual(mutations, [], 'native placement does not grant or pair');
  await page.locator('.settings-nav__item').filter({ hasText: 'Permissions' }).click();
  await page.getByRole('heading', { name: 'Permissions', exact: true }).waitFor();
  assert.equal(await page.locator('[data-swarm-mac-control-slot]').count(), 0, 'native Permissions has no device controls');
  await page.getByRole('button', { name: 'Computer settings', exact: false }).click();
  await page.locator('[data-swarm-mac-control-slot]').waitFor();
  await page.getByRole('button', { name: 'Close settings' }).click();
  await page.locator('[data-swarm-mac-control-slot]').waitFor({ state: 'detached' });
  await context.close();
  console.log('PASS native availability: inline slot replaces guidance and is removed on settings close');
  // Run the shell's actual placement script against legacy pages as well as stale web slots.
  const swift = await fs.readFile(new URL('../apple/Swarm/MacControlView.swift', import.meta.url), 'utf8');
  const nativeScript = swift.split('static let script = #"""')[1]?.split('"""#')[0];
  assert.ok(nativeScript, 'read the actual native placement script');
  const legacy = await browser.newContext({ viewport: { width: 1000, height: 900 } });
  const legacyPage = await legacy.newPage();
  legacyPage.setDefaultTimeout(10_000);
  legacyPage.on('pageerror', error => console.error('Legacy placement script:', error.message));
  await legacyPage.route('**/legacy-settings', route => route.fulfill({ contentType: 'text/html', body: '<div class="app-settings__page"><h1>Computer</h1><div>Cloud status</div></div>' }));
  await legacyPage.addInitScript(() => {
    window.placements = [];
    window.webkit = { messageHandlers: { swarmComputerSettings: { postMessage: data => window.placements.push(data) } } };
  });
  await legacyPage.goto(`${base}/legacy-settings`);
  // The native shell injects atDocumentEnd, after documentElement exists.
  await legacyPage.evaluate(nativeScript);
  await legacyPage.waitForFunction(() => window.placements.at(-1)?.visible === true);
  assert.equal(await legacyPage.locator('[data-swarm-mac-control-fallback]').count(), 1, 'legacy Computer receives one native surface');
  await legacyPage.evaluate(() => { document.querySelector('.app-settings__page').innerHTML = '<h1>Permissions</h1><section data-swarm-mac-control-slot style="height:700px"></section>'; });
  await legacyPage.waitForFunction(() => window.placements.at(-1)?.visible === false);
  assert.equal(await legacyPage.locator('[data-swarm-mac-control-fallback]').count(), 0, 'Permissions has no legacy fallback');
  await legacyPage.evaluate(() => { document.querySelector('.app-settings__page').innerHTML = '<h1>Computer</h1><div>Cloud status</div>'; });
  await legacyPage.waitForFunction(() => window.placements.at(-1)?.visible === true);
  await legacyPage.evaluate(() => { document.querySelector('.app-settings__page h1').textContent = 'Permissions'; });
  await legacyPage.waitForFunction(() => window.placements.at(-1)?.visible === false);
  assert.equal(await legacyPage.locator('[data-swarm-mac-control-slot]').count(), 0, 'leaving Computer removes its fallback even when the page retains children');
  await legacy.close();
  console.log('PASS actual native placement script: legacy Computer only, stale Permissions slots ignored, fallback removed on navigation');

} finally { await browser?.close(); server.kill(); }
