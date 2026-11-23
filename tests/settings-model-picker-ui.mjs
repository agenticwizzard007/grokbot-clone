// Local Vite app with synthetic API responses only.
// Gate: node tests/settings-model-picker-ui.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';

let vite;
let logs = '';
if (!process.env.UI_ORIGIN) {
  const port = await new Promise(resolve => {
    const server = http.createServer().listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
  process.env.UI_ORIGIN = `http://127.0.0.1:${port}`;
  vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: `${process.cwd()}/web`, stdio: 'pipe' });
  vite.stdout.on('data', data => { logs += data; });
  vite.stderr.on('data', data => { logs += data; });
}
const { origin, fixturePage } = await import('./qa-r3-work-fixture.mjs');
const screenshots = '.context/settings-model-picker';
const shortModels = Array.from({ length: 16 }, (_, index) => ({
  id: `test/model-${index}`, name: `Model ${index}`, short: `Model ${index}`, author: 'test',
  vision: true, reasoning: false, context: 32000,
  price: { input: 0.25, output: 12 },
}));
const longModel = {
  ...shortModels[0], id: `test/${'unbrokenidentifier'.repeat(14)}`, name: 'Long identifier model',
  price: { input: 123456789.12, output: 987654321.98 },
};
const missingKey = { set: false, source: null, hint: null };
let browser, page, activeFixture;

// Check the actual scroll container, since document width alone misses this bug.
async function assertPaneFits(labelLeft, label) {
  const geometry = await page.locator('.app-settings__main').evaluate(pane => {
    const bounds = pane.getBoundingClientRect();
    const popup = pane.querySelector('.model-picker__pop').getBoundingClientRect();
    const label = [...pane.querySelectorAll('.cfg-row__title')].find(el => el.textContent === 'Default model').getBoundingClientRect();
    return {
      paneLeft: bounds.left, paneRight: bounds.left + pane.clientWidth,
      popupLeft: popup.left, popupRight: popup.right,
      clientWidth: pane.clientWidth, scrollWidth: pane.scrollWidth, scrollLeft: pane.scrollLeft,
      labelLeft: label.left, labelRight: label.right,
    };
  });
  assert.ok(geometry.popupLeft >= geometry.paneLeft - 1 && geometry.popupRight <= geometry.paneRight + 1, `${label}: popup stays inside pane: ${JSON.stringify(geometry)}`);
  assert.ok(geometry.scrollWidth <= geometry.clientWidth + 1, `${label}: settings must not grow horizontally: ${JSON.stringify(geometry)}`);
  assert.equal(geometry.scrollLeft, 0, `${label}: focusing search must not scroll settings sideways`);
  assert.ok(Math.abs(geometry.labelLeft - labelLeft) <= 1, `${label}: label stays in place`);
  assert.ok(geometry.labelLeft >= geometry.paneLeft && geometry.labelRight <= geometry.paneRight, `${label}: label remains inside the visible pane`);
  return geometry;
}

try {
  await mkdir(screenshots, { recursive: true });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    ready = await fetch(origin).then(response => response.ok, () => false);
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, `Local frontend did not start: ${logs}`);
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? process.env.CHROME_PATH ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const width of [1280, 1024, 768, 390]) {
    const fixture = await fixturePage(browser, { width, height: 900 });
    activeFixture = fixture;
    page = fixture.page;
    let models = shortModels;
    fixture.fixture.respond = ({ path, method, url }) => {
      if (method !== 'GET') return null;
      if (path === '/api/settings/keys') return { json: {
        isolated: false, canEdit: true,
        provider: { value: 'openrouter', chosen: 'openrouter' },
        model: { value: 'test/model-0' }, openrouterModel: { value: 'test/model-0' },
        voice: missingKey, direct: missingKey, composio: missingKey,
        openrouter: { set: true, source: 'env', hint: 'fixture' },
      } };
      if (path === '/api/settings/models' || path === '/api/models') {
        if (path === '/api/settings/models') assert.equal(url.searchParams.get('provider'), 'openrouter');
        return { json: { models, provider: 'openrouter', billing: 'api', favourites: [], defaultModel: 'test/model-0' } };
      }
      if (path === '/api/providers/openrouter') return { json: { connected: false, linked: false, active: false, selected: false, settingsUrl: 'https://example.test/credits' } };
      if (path === '/api/cli') return { json: { connected: false, selected: null, providers: { claude: {}, codex: {} } } };
      if (path === '/api/apps/suggestions') return { json: { suggestions: [], pending: false } };
      return null;
    };
    await page.addInitScript(() => localStorage.setItem('swarm.sidebarCollapsed', '0'));
    await page.goto(`${origin}/#settings/keys`);
    const button = page.getByRole('button', { name: 'Default model', exact: true });
    await button.waitFor();
    assert.equal(await button.isEnabled(), true, 'synthetic server defaults are editable');
    if (width >= 768) {
      assert.equal(await page.locator('.sidebar:not(.is-collapsed)').isVisible(), true, 'desktop sidebar stays expanded');
      assert.equal(await page.getByRole('navigation', { name: 'Settings sections', exact: true }).isVisible(), true);
    }
    await button.scrollIntoViewIfNeeded();
    const labelLeft = await page.getByText('Default model', { exact: true }).evaluate(el => el.getBoundingClientRect().left);
    const search = page.getByRole('textbox', { name: 'Search models', exact: true });
    const list = page.getByRole('listbox', { name: 'Default model options', exact: true });

    // I09 uses ordinary short names and IDs, independent of I17's long metadata.
    await button.click();
    await search.and(page.locator(':focus')).waitFor();
    await list.getByRole('option').last().waitFor();
    const shortGeometry = await assertPaneFits(labelLeft, `${width}px short models autofocus`);
    await button.focus();
    await search.focus();
    await assertPaneFits(labelLeft, `${width}px short models refocus`);
    assert.equal(await list.evaluate(el => el.scrollHeight > el.clientHeight), true, 'catalog keeps vertical scrolling');
    await page.screenshot({ path: `${screenshots}/short-${width}.png` });
    await page.keyboard.press('Escape');
    await button.and(page.locator(':focus')).waitFor();

    // Opening the picker refreshes its catalog with a long ID and pricing metadata.
    models = [shortModels[0], longModel, ...shortModels.slice(1)];
    await button.click();
    const metadata = list.locator('.model-picker__meta').filter({ hasText: longModel.id });
    await metadata.waitFor();
    await assertPaneFits(labelLeft, `${width}px long identifier`);
    const dimensions = await metadata.evaluate(meta => {
      const list = meta.closest('.model-picker__list');
      const row = meta.closest('.model-picker__row');
      return { metaWidth: meta.clientWidth, metaScrollWidth: meta.scrollWidth, metaHeight: meta.clientHeight, fontSize: parseFloat(getComputedStyle(meta).fontSize), rowWidth: row.clientWidth, rowScrollWidth: row.scrollWidth, listWidth: list.clientWidth, listScrollWidth: list.scrollWidth };
    });
    assert.ok(dimensions.metaScrollWidth <= dimensions.metaWidth + 1, `${width}px: metadata wraps inside its own box: ${JSON.stringify(dimensions)}`);
    assert.ok(dimensions.rowScrollWidth <= dimensions.rowWidth + 1, `${width}px: option stays within its row`);
    assert.ok(dimensions.listScrollWidth <= dimensions.listWidth + 1, `${width}px: no horizontal catalog scroller`);
    assert.ok(dimensions.metaScrollWidth <= dimensions.listWidth, `${width}px: metadata fits the list`);
    assert.ok(dimensions.metaHeight > dimensions.fontSize * 2, `${width}px: full identifier and price wrap over multiple lines`);
    await search.fill('unbrokenidentifier');
    assert.equal(await list.getByRole('option').count(), 1, 'wrapped IDs remain searchable');
    await page.keyboard.press('ArrowDown');
    await list.getByRole('option').and(page.locator(':focus')).waitFor();
    await assertPaneFits(labelLeft, `${width}px option keyboard focus`);
    await page.screenshot({ path: `${screenshots}/long-${width}.png` });
    await page.keyboard.press('Escape');
    await button.and(page.locator(':focus')).waitFor();
    assert.deepEqual(fixture.errors, []);
    assert.deepEqual(fixture.writes, [], 'picker layout checks need no API mutations');
    console.log(`PASS ${width}px: I09 pane ${shortGeometry.clientWidth}px, scroll ${shortGeometry.scrollWidth}px, offset ${shortGeometry.scrollLeft}px; I17 list ${dimensions.listWidth}px, scroll ${dimensions.listScrollWidth}px`);
    await page.close();
    page = null;
  }
} catch (error) {
  console.error({ errors: activeFixture?.errors, reads: activeFixture?.reads, vite: logs });
  if (page && !page.isClosed()) await page.screenshot({ path: `${screenshots}/failure.png` });
  throw error;
} finally {
  await browser?.close();
  vite?.kill('SIGTERM');
}
