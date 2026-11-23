// Local Vite fixture: delayed settings code must remain dismissible and reopen cleanly.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { fixturePage, origin, gate } from './qa-r3-work-fixture.mjs';
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
try {
  for (const width of [390, 1280]) {
    const { page, errors } = await fixturePage(browser, { width, height: 844 });
    const held = gate();
    await page.route('**/src/components/config/ConfigLayer.tsx*', async route => { await held.wait; await route.continue(); });
    try {
      await page.goto(origin);
      const open = async () => {
        await page.getByRole('button', { name: 'Account & settings', exact: true }).click({ timeout: 2000 });
        await page.getByRole('menuitem', { name: /^Settings/ }).click({ timeout: 2000 });
        await page.getByRole('menu').waitFor({ state: 'detached', timeout: 2000 });
      };
      await open();
      const loading = page.locator('.settings-loading');
      await loading.getByRole('status').waitFor({ timeout: 2000 });
      const box = await loading.boundingBox();
      assert.ok(box.width >= width - 272 && box.height >= 800);
      await loading.getByRole('button', { name: 'Close settings', exact: true }).click();
      await loading.waitFor({ state: 'detached' });
      await open();
      await loading.waitFor({ timeout: 2000 });
      held.release();
      await page.locator('.app-settings').waitFor();
      await loading.waitFor({ state: 'detached' });
      if (width === 390) await page.getByRole('button', { name: 'General', exact: true }).click();
      await page.getByRole('switch', { name: 'Compact sidebar', exact: true }).waitFor();
      await page.getByRole('heading', { name: 'Keyboard shortcuts', exact: true }).waitFor();
      assert.deepEqual(errors, []);
      console.log(`PASS delayed settings load ${width}px: visible loading panel, close, immediate reopen, full General page`);
    } finally { held.release(); await page.context().close(); }
  }
} finally { await browser.close(); }
