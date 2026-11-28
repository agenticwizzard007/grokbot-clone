// Local fixture only. All browser requests stay on loopback; provider responses are fakes.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { layoutServer } from './layout-fixture.mjs';
const baseline = process.env.MT_UI_BASELINE === '1';
const evidence = path.resolve('.context/mt/onboarding-ui');
await fs.mkdir(evidence, { recursive: true });
const server = await layoutServer({ root: process.env.MT_UI_ROOT || process.cwd() });
let browser;
try {
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', chromiumSandbox: true });
  for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await context.addInitScript(theme => localStorage.setItem('swarm.theme', theme), theme);
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    let state = null, joined = 0, phoneStart;
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== server.base) throw new Error('Unexpected external browser request.');
      if (state && url.pathname === '/api/auth/me') return route.fulfill({ json: { user: null, platform: true, devLogin: false, googleLogin: true, appleLogin: true } });
      if (url.pathname === '/api/auth/onboarding') return route.fulfill({ json: { platform: true, state } });
      if (url.pathname === '/api/auth/waitlist') { joined++; assert.equal(route.request().postDataJSON().contact, 'fixture@example.test'); return route.fulfill({ json: { platform: true, state: 'waitlist_joined' } }); }
      if (state && url.pathname === '/api/auth/phone/start') { phoneStart = route.request().postDataJSON(); return route.fulfill({ json: { id: 'fixture-phone', delivery: 'sent' } }); }
      return route.continue();
    });
    await page.goto(`${server.base}/?invite=0123456789ABCDEF0123456789ABCDEF&onboarding=invite_needed`);
    await page.getByRole('heading', { name: 'Welcome', exact: true }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    const filename = `standalone-${width}-${theme}.png`;
    const screenshot = await page.screenshot({ path: path.join(evidence, `${baseline ? 'before' : 'after'}-${filename}`), fullPage: true });
    assert.equal(await page.locator('.platform-onboarding').count(), 0);
    if (!baseline) {
      assert.equal(screenshot.equals(await fs.readFile(path.join(evidence, `before-${filename}`))), true, `Standalone pixels unchanged at ${width} ${theme}`);
      for (const [value, copy] of [
        ['invite_accepted', 'Invite accepted'], ['invite_needed', 'Swarm is invite only right now'],
        ['invite_invalid', 'This invite has expired or been used up'], ['at_capacity', 'Swarm is at capacity right now'], ['closed', 'New accounts are paused right now'],
      ]) {
        state = value;
        await page.goto(`${server.base}/?invite=0123456789ABCDEF0123456789ABCDEF`);
        await page.getByText(copy, { exact: true }).waitFor();
        assert.equal(await page.getByRole('link', { name: 'Continue with Google' }).getAttribute('href'), '/api/auth/google/start?invite=0123456789ABCDEF0123456789ABCDEF');
        for (const element of await page.locator('.platform-onboarding input,.platform-onboarding button').all()) assert.ok((await element.boundingBox()).height >= 44);
        for (const element of await page.locator('.platform-onboarding p,.platform-onboarding label').all()) assert.ok(await element.evaluate(e => parseFloat(getComputedStyle(e).fontSize) >= 13));
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({ path: path.join(evidence, `${value}-${width}-${theme}.png`), fullPage: true });
      }
      await page.getByLabel('Email or phone number').fill('fixture@example.test');
      await page.getByRole('button', { name: 'Join waitlist', exact: true }).click();
      await page.getByText('You are on the waitlist', { exact: true }).waitFor();
      assert.equal(joined, 1);
      await page.screenshot({ path: path.join(evidence, `waitlist-joined-${width}-${theme}.png`), fullPage: true });
      state = 'invite_accepted';
      await page.goto(`${server.base}/?invite=0123456789ABCDEF0123456789ABCDEF`);
      await page.getByText('Invite accepted', { exact: true }).waitFor();
      await page.getByLabel('Phone number', { exact: true }).fill('+15550000001');
      await page.getByRole('button', { name: 'Continue with phone' }).click();
      await page.getByText('Check your phone', { exact: true }).waitFor();
      assert.equal(phoneStart.inviteCode, '0123456789ABCDEF0123456789ABCDEF');
    }
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS ${baseline ? 'baseline' : 'standalone pixel comparison and 6 onboarding states'}: ${width} ${theme}`);
  }
} finally { await browser?.close(); await server.close(); }
