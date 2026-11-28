import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServer } from '../web/node_modules/vite/dist/node/index.js';
const vite = await createServer({ root: `${process.cwd()}/web`, cacheDir: `${process.cwd()}/.context/r6-z-vite-cache`, server: { host: '127.0.0.1', port: 0 } });
await vite.listen();
process.env.UI_ORIGIN = `http://127.0.0.1:${vite.httpServer.address().port}`;
const { fixturePage, origin } = await import('./qa-r3-work-fixture.mjs');
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
await mkdir('.context/r6-z-ui', { recursive: true });
const catalog = { provider: 'codex-cli', billing: 'plan', canFast: false, models: [{ id: 'codex/default', name: 'Codex CLI default', short: 'Codex CLI default', author: 'openai', efforts: [], defaultEffort: null }], favourites: [], defaultModel: 'codex/default', plan: null, usage: { available: false, checkedAt: Date.now(), windows: [] } };
try {
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    const { page, fixture, errors, writes } = await fixturePage(browser, { width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript(theme => {
      localStorage.setItem('swarm.theme', theme);
      window.badLoadingLabels = [];
      new MutationObserver(() => {
        const chip = document.querySelector('.model-pill__name')?.textContent || '';
        const footer = document.querySelector('.sidebar-usage')?.textContent || '';
        if (/Models unavailable|Unavailable|Retry provider details/.test(chip + footer)) window.badLoadingLabels.push(chip + footer);
      }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-label'] });
    }, theme);
    fixture.bots[0].onboarding = { status: 'active', revision: 1 };
    let mode = 'ready', calls = 0, start = 0;
    await page.route('**/api/models', async route => {
      calls++;
      if (mode === 'aborted' && calls === 1) return route.abort('aborted');
      if (mode === 'auth-race' && calls === 1) return route.fulfill({ status: 401, json: { error: 'Session restoring' } });
      if (mode === 'cold' && Date.now() - start < 20_000) return route.fulfill({ json: { ...catalog, models: [], stale: true } });
      return route.fulfill({ json: catalog });
    });
    await page.goto(`${origin}/#bot/${fixture.bots[0].id}`);
    await page.waitForFunction(() => document.querySelector('.model-pill')?.getAttribute('aria-busy') === 'false');
    const name = page.locator('.model-pill__name');
    for (const scenario of ['cold', 'aborted', 'auth-race']) {
      mode = scenario; calls = 0; start = Date.now();
      await page.reload();
      await page.locator('.model-pill').waitFor();
      assert.equal(await name.innerText(), 'Codex · ChatGPT plan', 'cached resolved label survives reload');
      await page.waitForFunction(() => document.querySelector('.model-pill')?.getAttribute('aria-busy') === 'false', null, { timeout: 30_000 });
      assert.equal(await name.innerText(), 'Codex · ChatGPT plan');
      assert.equal(await page.locator('.sidebar-usage').and(page.getByRole('button', { name: /Codex plan.*Limits unavailable/ })).count(), 1);
      assert.ok(calls >= 2, `${scenario} retried automatically`);
      assert.equal(await page.locator('.model-menu').count(), 0, 'picker was never opened');
      assert.deepEqual(await page.evaluate(() => window.badLoadingLabels), []);
      await page.screenshot({ path: `.context/r6-z-ui/${width}-${theme}-${scenario}.png` });
    }
    // Focus immediately refreshes provider details, even after successful loading.
    const before = calls;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(() => document.querySelector('.model-pill')?.getAttribute('aria-busy') === 'false');
    assert.ok(calls > before);
    if (width === 390) {
      await page.getByRole('button', { name: 'All Bots', exact: true }).click();
      await page.locator('.sidebar-usage').waitFor({ state: 'visible' });
      assert.match(await page.locator('.sidebar-usage').innerText(), /Codex plan[\s\S]*Limits unavailable/);
      await page.screenshot({ path: `.context/r6-z-ui/${width}-${theme}-sidebar.png` });
    }
    assert.deepEqual(errors, []); assert.deepEqual(writes, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.context().close();
    console.log(`PASS reload recovery: slow cold status, abort, auth restore, focus, chip and usage ${width} ${theme}`);
  }
} finally { await browser.close(); await vite.close(); }
