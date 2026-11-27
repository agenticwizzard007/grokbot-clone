import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from '../../web/node_modules/vite/dist/node/index.js';
import { chromium } from 'playwright';
import { serverFixture } from './server-fixture.mjs';

export async function shellFixture() {
  const api = await serverFixture();
  let vite, browser;
  try {
    vite = await createServer({ root: path.resolve('web'), server: { host: '127.0.0.1', port: 0, proxy: { '/api': api.base } } });
    await vite.listen();
    const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
    const account = { cookie: 'swarm_session=layout-test-token', userId: api.fixture.userId };
    async function patch(ops) {
      const current = await api.request(account, 'GET', '/config');
      assert.equal(current.status, 200);
      const result = await api.request(account, 'PATCH', '/config', ops, current.body.revision);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      return result.body;
    }
    async function page(width = 390, theme = 'light') {
      const context = await browser.newContext({ viewport: { width, height: width <= 760 ? 844 : 900 }, colorScheme: theme, reducedMotion: 'reduce' });
      await context.addCookies([{ name: 'swarm_session', value: 'layout-test-token', url: base }]);
      await context.addInitScript(userId => { localStorage.setItem(`swarm.ui.migrated:${userId}`, '1'); localStorage.setItem('swarm.sidebarCollapsed', '0'); }, account.userId);
      // No browser requests may reach a provider or any other remote host.
      await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      return page;
    }
    async function open(page, hash = '') {
      await page.goto('about:blank');
      await page.goto(`${base}/${hash}`);
      await page.locator('.shell-header').waitFor();
      await page.waitForFunction(async () => (await import('/src/customization/store.ts')).useCustomization.getState().status === 'ready');
      await page.evaluate(() => document.fonts.ready);
      await page.locator('[data-layout="page"]:visible').first().waitFor();
    }
    return { api, base, browser, account, fixture: api.fixture, patch, page, open,
      close: async () => { await browser.close(); await vite.close(); await api.close(); } };
  } catch (error) { await browser?.close(); await vite?.close(); await api.close(); throw error; }
}
