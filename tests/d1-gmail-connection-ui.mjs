// Gmail connection availability is independent of Google login configuration.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { layoutServer } from './layout-fixture.mjs';
const server = await layoutServer();
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const failures = [];
const phase = process.env.D1_SHOT_PHASE || 'after';
const shots = '/workspace/swarm-qa/livewalk-fix/shots';
fs.mkdirSync(shots, { recursive: true });
try {
  for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
    await context.addCookies([{ name: 'swarm_session', value: 'layout-test-token', url: server.base }]);
    await context.addInitScript(() => localStorage.setItem('swarm.theme', 'light'));
    await context.route('**/*', route => new URL(route.request().url()).origin === server.base ? route.continue() : route.abort());
    await context.route('**/api/auth/me', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), googleLogin: false, googleLinked: false } });
    });
    await context.route('**/api/apps?*', route => route.fulfill({ json: {
      apps: [], connected: [], connectedApps: [], categories: [], total: 0, notConfigured: false,
    } }));
    let connects = 0;
    await context.route('**/api/apps/gmail/connect', route => { connects++; return route.fulfill({ json: { redirectUrl: `${server.base}/fixture-gmail-consent` } }); });
    await context.route('**/fixture-gmail-consent', route => route.fulfill({ contentType: 'text/html', body: '<p>Local Gmail consent fixture</p>' }));
    const page = await context.newPage();
    await page.goto(`${server.base}/#settings/messaging`);
    await page.locator('.access-messaging summary').filter({ hasText: 'Learn more' }).click();
    const connect = page.getByRole('button', { name: 'Connect Gmail', exact: true });
    await connect.waitFor();
    await connect.scrollIntoViewIfNeeded();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `${shots}/D1-gmail-${phase}-${width}.png`, fullPage: true });
    try {
      assert.equal(await page.getByText('Google sign-in is unavailable on this server. You can still sign in with your phone.', { exact: true }).isVisible(), true);
      assert.equal(await connect.isEnabled(), true, 'Gmail must remain connectable without a Google login client');
      assert.equal(await page.getByText('Connected apps need a Composio project key from the server owner.', { exact: true }).count(), 0);
      const popupReady = page.waitForEvent('popup');
      await connect.click();
      const popup = await popupReady;
      await popup.waitForURL(`${server.base}/fixture-gmail-consent`);
      assert.equal(connects, 1, 'only the explicit Gmail action starts connect-apps authorization');
      await popup.close();
      console.log(`PASS D1 Gmail available independently of Google login at ${width}px`);
    } catch (error) { failures.push(`${width}: ${error.message}`); }
    await context.unrouteAll({ behavior: 'wait' });
    await context.close();
  }
  assert.deepEqual(failures, []);
} finally { await browser.close(); await server.close(); }
