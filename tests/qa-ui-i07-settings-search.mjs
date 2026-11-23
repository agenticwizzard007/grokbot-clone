// Local dev frontend with seeded API fixtures only.
// Gate: UI_ORIGIN=http://127.0.0.1:5193 node --test tests/qa-ui-i07-settings-search.mjs
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { fixturePage, origin } from './qa-r3-work-fixture.mjs';

const query = 'unknown_setting_'.repeat(9);
const evidence = new URL('../.context/qa-ui-i07/', import.meta.url);
let browser;

before(async () => {
  await mkdir(evidence, { recursive: true });
  browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN ?? process.env.CHROME_PATH ?? '/usr/bin/google-chrome',
    args: ['--no-sandbox'],
  });
});
after(async () => { await browser?.close(); });

for (const width of [1280, 1024, 768, 390]) {
  test(`I07: settings search empty state stays inside its column at ${width}px`, async () => {
    const { page, fixture, errors, writes } = await fixturePage(browser, { width, height: 900 });
    fixture.respond = ({ path }) => path.endsWith('/suggested-apps') ? { json: { suggestions: [] } } : null;
    try {
      await page.goto(`${origin}/#settings/general`);
      if (width <= 760) await page.getByRole('button', { name: 'Back to Settings', exact: true }).click();
      const nav = page.getByRole('navigation', { name: 'Settings sections', exact: true });
      const search = nav.getByRole('searchbox', { name: 'Search settings', exact: true });
      await search.fill(query);
      const empty = nav.getByRole('status');
      await empty.waitFor();
      await page.evaluate(() => document.fonts.ready);
      assert.equal(await empty.innerText(), `No settings match “${query}”.`);

      const geometry = await empty.evaluate(element => {
        const nav = element.closest('.settings-nav');
        const column = nav.closest('#app-settings-sidebar-slot, .app-settings__nav, .app-settings__main');
        const bounds = target => {
          const { left, right } = target.getBoundingClientRect();
          return { left, right, clientWidth: target.clientWidth, scrollWidth: target.scrollWidth };
        };
        return {
          empty: bounds(element), nav: bounds(nav), column: bounds(column),
          page: bounds(document.scrollingElement), viewportWidth: innerWidth,
        };
      });
      await page.screenshot({ path: new URL(`${width}.png`, evidence).pathname, animations: 'disabled' });
      console.log(`${width}px: ${JSON.stringify(geometry)}`);
      for (const name of ['empty', 'nav', 'column', 'page']) {
        const box = geometry[name];
        assert.ok(box.clientWidth > 0, `${name} must be visible at ${width}px`);
        assert.ok(box.scrollWidth <= box.clientWidth, `${name} must not scroll horizontally at ${width}px: ${JSON.stringify(box)}`);
      }
      assert.ok(geometry.empty.left >= geometry.nav.left && geometry.empty.right <= geometry.nav.right,
        'The empty state must stay within the settings navigation.');
      assert.ok(geometry.nav.left >= geometry.column.left && geometry.nav.right <= geometry.column.right,
        'The settings navigation must stay within its column.');
      assert.ok(geometry.column.left >= 0 && geometry.column.right <= geometry.viewportWidth,
        'The settings column must stay within the viewport.');

      // Search still recovers from the empty state and finds a matching section.
      await search.fill('theme');
      await nav.getByRole('button', { name: 'General', exact: true }).waitFor();
      assert.equal(await empty.count(), 0);
      assert.deepEqual(errors, []);
      assert.deepEqual(writes, []);
    } finally {
      await page.context().close();
    }
  });
}
