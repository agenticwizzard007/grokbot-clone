// Local HTTP fixtures exercise cold load, cache restoration, failure, timeout and retry.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from '../web/node_modules/vite/dist/node/index.js';
import { chromium } from 'playwright';

const vite = await createServer({ root: `${process.cwd()}/web`, cacheDir: `${process.cwd()}/.context/model-loading-vite-cache`, server: { host: '127.0.0.1', port: 0 } });
await vite.listen();
process.env.UI_ORIGIN = `http://127.0.0.1:${vite.httpServer.address().port}`;
const { fixturePage, gate, origin } = await import('./qa-r3-work-fixture.mjs');
await mkdir('.context/composer-model-loading', { recursive: true });
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
try {
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    const { page, fixture, errors, writes } = await fixturePage(browser, { width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript(theme => localStorage.setItem('swarm.theme', theme), theme);
    const bot = fixture.bots[0];
    bot.onboarding = { status: 'active', revision: 1 };
    let pending = gate(), failed = false, requests = 0;
    fixture.respond = async ({ path }) => {
      if (path.endsWith('/suggested-apps')) return { json: { suggestions: [] } };
      if (path !== '/api/models') return null;
      requests++;
      const fail = failed;
      await pending.wait;
      return fail ? { status: 503, json: { error: 'Fixture catalog unavailable' } }
        : { json: { provider: 'codex-cli', billing: 'plan', canFast: false, models: [], favourites: [] } };
    };
    pending.release();
    const chip = page.locator('.model-pill');
    const name = chip.locator('.model-pill__name');
    const loading = page.getByRole('status').filter({ hasText: 'Loading models...' });
    const shot = label => page.screenshot({ path: `.context/composer-model-loading/${width}-${theme}-${label}.png` });
    await page.goto(`${origin}/#bot/${bot.id}`);
    await page.getByText('Codex · ChatGPT plan', { exact: true }).waitFor();
    await page.evaluate(() => { localStorage.removeItem('swarm.model-label:fixture-owner:coordinator'); });
    pending = gate(); requests = 0;
    await page.reload();
    await chip.waitFor();
    assert.equal(await name.innerText(), 'Loading model');
    assert.equal(await chip.getAttribute('aria-busy'), 'true');
    await chip.click();
    await loading.waitFor();
    await page.getByRole('searchbox', { name: 'Search models', exact: true }).fill('codex');
    // The delayed catalog must not turn a search into a false empty/error result.
    await page.waitForTimeout(1500);
    assert.equal(await name.innerText(), 'Loading model');
    assert.equal(await loading.count(), 1);
    assert.equal(requests, 1, 'opening during load shares the pending catalog');
    assert.doesNotMatch(await page.locator('body').innerText(), /Models unavailable|No models (found|match)|Couldn.t load models/);
    await shot('cold-loading');
    pending.release();
    await page.waitForFunction(() => document.querySelector('.model-pill')?.getAttribute('aria-busy') === 'false');
    assert.equal(await name.innerText(), 'Codex · ChatGPT plan');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('swarm.model-label:fixture-owner:coordinator') ?? 'null')?.label === 'Codex · ChatGPT plan');
    pending = gate();
    await page.reload();
    await chip.waitFor();
    assert.equal(await name.innerText(), 'Codex · ChatGPT plan', 'reload retains the complete account/Bot label');
    assert.equal(await chip.getAttribute('aria-busy'), 'true');
    assert.equal(await chip.locator('.model-billing, .model-pill__effort').count(), 0, 'cached copy never enables unverified billing or effort controls');
    await shot('cached-chip');
    await page.locator('.composer-area').screenshot({ path: `.context/composer-model-loading/${width}-${theme}-cached-composer.png` });
    await chip.click(); await loading.waitFor(); await shot('cached-loading');
    pending.release();
    await page.waitForFunction(() => document.querySelector('.model-pill')?.getAttribute('aria-busy') === 'false');
    await page.keyboard.press('Escape');

    failed = true; pending = gate();
    await chip.click(); await loading.waitFor(); pending.release();
    await page.getByRole('button', { name: 'Retry', exact: true }).waitFor();
    assert.equal(await name.innerText(), 'Models unavailable', 'only a settled failure shows unavailable');
    await shot('failed');
    failed = false; pending = gate();
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await loading.waitFor();
    assert.equal(await name.innerText(), 'Codex · ChatGPT plan');
    assert.doesNotMatch(await page.locator('body').innerText(), /Models unavailable/);
    pending.release();
    await page.waitForFunction(() => document.querySelector('.model-pill')?.getAttribute('aria-busy') === 'false');
    await page.keyboard.press('Escape');

    // A true deadline failure still surfaces and remains retryable.
    pending = gate();
    await chip.click(); await loading.waitFor();
    await page.getByRole('button', { name: 'Retry', exact: true }).waitFor({ timeout: 8000 });
    assert.equal(await name.innerText(), 'Models unavailable');
    pending.release();
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.model-pill')?.getAttribute('aria-busy') === 'false');
    assert.equal(await name.innerText(), 'Codex · ChatGPT plan');
    assert.deepEqual(errors, []); assert.deepEqual(writes, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.context().close();
    console.log(`PASS model chip and picker loading, cache, failure, timeout and retry ${width} ${theme}`);
  }
} finally { await browser.close(); await vite.close(); }
