// Local regression evidence for the Flow route, including unavailable responses.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { layoutServer } from '../layout-fixture.mjs';
import { inspectAlignment } from '../layout-alignment-ui.mjs';
import { readableWords } from '../paper-label-geometry.mjs';

const { DEFAULT_CONFIG } = await tsImport('../../server/src/ui-config/index.ts', import.meta.url);
const { fixtures } = await tsImport('../flow/fixtures.mts', import.meta.url);
const { buildFlowModel } = await tsImport('../../server/src/flow/build.ts', import.meta.url);
const output = path.resolve('.context/ui-custom/demo-fix-1');
fs.mkdirSync(output, { recursive: true });
const app = await layoutServer();
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const report = { checks: [], screenshots: [] };
const widths = (process.env.FIX_1_WIDTHS || '320,390,500,768,1280').split(',').map(Number);
try {
  for (const width of widths) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: width <= 760 ? 844 : 900 }, colorScheme: theme, reducedMotion: 'reduce' });
    await context.addCookies([{ name: 'swarm_session', value: 'layout-test-token', url: app.base }]);
    await context.addInitScript(theme => { if (location.origin === 'null') return; localStorage.setItem('swarm.theme', theme); localStorage.setItem('swarm.sidebarCollapsed', '0'); }, theme);
    const page = await context.newPage(), errors = [];
    const network = await context.newCDPSession(page);
    await network.send('Network.setCacheDisabled', { cacheDisabled: false });
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.route('**/*', route => {
      if (new URL(route.request().url()).origin !== app.base) { errors.push('Unexpected external request'); return route.abort(); }
      return route.fallback();
    });
    // Keep customization at defaults without the disabled feature endpoint's network 404.
    await page.route('**/api/ui/config', route => route.fulfill({ status: 200, json: { doc: DEFAULT_CONFIG, revision: 0 } }));
    for (const state of ['rich', 'empty', 'missing-lanes', 'null']) {
      const input = structuredClone(fixtures[state === 'rich' ? 'rich' : 'empty']);
      input.bot.id = app.fixture.bot.id;
      const model = state === 'null' ? null : state === 'missing-lanes' ? {} : buildFlowModel(input);
      await page.unroute('**/api/bots/*/flow');
      await page.route('**/api/bots/*/flow', route => route.fulfill({ json: model, headers: { 'Cache-Control': 'no-store', 'X-Flow-Has-Runs': state === 'rich' ? '1' : '0' } }));
      const hash = `#bot/${app.fixture.bot.id}/details/flow`;
      await page.goto('about:blank');
      await page.goto(`${app.base}/${hash}`);
      if (model?.lanes) {
        await page.locator('.flow-chart').waitFor();
        assert.equal(await page.locator('.flow-lane').count(), 5);
        assert.equal(await page.locator('[data-flow-node]').count(), model.lanes.reduce((count, lane) => count + lane.nodes.length, 0));
        assert.deepEqual(await page.evaluate(inspectAlignment), []);
        await readableWords(page.locator('.flow-lanes'));
      } else await page.getByRole('button', { name: 'Retry', exact: true }).waitFor();
      assert.equal(await page.locator('.shell-header > .bot-avatar').count(), 1);
      assert.ok(await page.locator('.shell-header > .bot-avatar').isVisible());
      assert.equal(await page.locator('.shell-header__subtitle').innerText(), 'Flow');
      assert.equal(await page.locator('.shell-back:visible').count(), 1);
      assert.equal(await page.locator('.phone-tabs:visible').count(), width <= 760 ? 1 : 0);
      assert.deepEqual(errors, []);
      if (model?.lanes && [390, 1280].includes(width)) {
        const screenshot = path.join(output, `${state}-${width}-${theme}.png`);
        await page.screenshot({ path: screenshot, fullPage: true }); report.screenshots.push(screenshot);
      }
      // Cold entry, reload and unrelated history all use the same Back path.
      await page.reload();
      await page.locator('.flow-tab').waitFor();
      await page.locator('.shell-back').click();
      await page.waitForFunction(() => /^#bot\/[^/]+$/.test(location.hash));
      await page.locator('.phone-tabs').waitFor({ state: 'hidden' });
      await page.evaluate(() => { location.hash = '#reports'; });
      await page.locator('.work-tabs').waitFor();
      await page.evaluate(hash => { location.hash = hash; }, hash);
      await page.locator('.flow-tab').waitFor();
      await page.locator('.shell-back').click();
      await page.waitForFunction(() => location.hash === '#reports');
      await page.goForward();
      await page.locator('.flow-tab').waitFor();
      assert.deepEqual(errors, []);
      const check = `${width}-${theme}-${state}: Flow, avatar, navigation, Back/Forward, reload, no errors`;
      report.checks.push(check); console.log(`PASS ${check}`);
    }
    await context.close();
  }
} finally {
  await browser.close(); await app.close();
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(`FIX-1 demo: ${report.checks.length}/${widths.length * 8} passed, 0 failed. Output: ${path.join(output, 'report.json')}`);
