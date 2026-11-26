// I12: local dev UI with synthetic routines. Cancel every confirmation; never run a routine.
// Run: node tests/qa-ui-i12-confirmation-title.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const requireWeb = createRequire(new URL('../web/package.json', import.meta.url));
const { createServer } = await import(requireWeb.resolve('vite'));
const server = await createServer({
  root: fileURLToPath(new URL('../web', import.meta.url)),
  server: { host: '127.0.0.1', port: 0, open: false },
});
const evidence = new URL('../.context/qa-ui-i12/', import.meta.url);
const routineName = 'W'.repeat(64);
let browser;
try {
  await server.listen();
  process.env.UI_ORIGIN = `http://127.0.0.1:${server.httpServer.address().port}`;
  const { fixturePage, origin } = await import('./qa-r3-work-fixture.mjs');
  await fs.mkdir(evidence, { recursive: true });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const width of [1280, 1024, 768, 390]) {
    const { page, fixture, errors, writes } = await fixturePage(browser, { width, height: 844 });
    fixture.routines = [{
      id: 'routine-title-fixture', botId: 'research-bot', name: routineName,
      description: 'Synthetic routine', prompt: 'Local layout fixture only',
      schedule: '0 9 * * *', timezone: 'UTC', enabled: false, createdAt: 0,
    }];
    try {
      for (const entry of ['work', 'settings']) {
        if (entry === 'work') {
          await page.goto(origin);
          await page.locator('.sidebar').getByRole('button', { name: 'Tasks', exact: true }).click();
          const work = page.locator('.tasks-view');
          await work.getByRole('navigation', { name: 'Work sections' }).getByRole('button', { name: 'Files', exact: true }).click();
          await work.getByRole('combobox', { name: 'Bot' }).selectOption('research-bot');
          await work.getByRole('button', { name: 'Routines', exact: true }).click();
        } else {
          await page.goto(`${origin}/#bot/research-bot/settings/routines`);
        }
        await page.getByRole('button', { name: `Run ${routineName} now`, exact: true }).click();
        const dialog = page.getByRole('dialog', { name: `Run ${routineName} now?`, exact: true });
        const title = dialog.getByRole('heading', { name: `Run ${routineName} now?`, exact: true });
        await title.waitFor({ state: 'visible' });
        try {
          await page.evaluate(() => document.fonts.ready);
          await dialog.evaluate(async element => {
            await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished));
          });
          const geometry = await title.evaluate(element => {
            const box = element.getBoundingClientRect();
            const modal = element.closest('.modal').getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(element);
            const inside = rect => rect.left >= modal.left && rect.right <= modal.right
              && rect.top >= modal.top && rect.bottom <= modal.bottom;
            return {
              titleInside: inside(box),
              textInside: [...range.getClientRects()].every(inside),
              overflow: element.scrollWidth > element.clientWidth + 1,
              modalInside: modal.left >= 0 && modal.right <= innerWidth && modal.top >= 0 && modal.bottom <= innerHeight,
            };
          });
          await page.screenshot({ path: new URL(`${entry}-${width}.png`, evidence).pathname });
          assert.deepEqual(geometry, { titleInside: true, textInside: true, overflow: false, modalInside: true }, `${entry} title fits at ${width}px`);
          for (const name of ['Cancel', 'Run now']) {
            const button = dialog.getByRole('button', { name, exact: true });
            assert.equal(await button.isVisible(), true, `${name} is visible at ${width}px`);
            assert.equal(await button.evaluate(element => {
              const box = element.getBoundingClientRect(), modal = element.closest('.modal').getBoundingClientRect();
              return box.left >= modal.left && box.right <= modal.right && box.top >= modal.top && box.bottom <= modal.bottom;
            }), true, `${name} stays inside the modal at ${width}px`);
            await button.click({ trial: true });
          }
        } finally {
          await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
          await dialog.waitFor({ state: 'detached' });
          assert.deepEqual(writes, [], 'Cancel must not send a routine run or any other mutation');
        }
        assert.deepEqual(errors, []);
        console.log(`PASS I12 ${entry} at ${width}px: title contained, actions reachable, cancelled without writes`);
      }
    } finally { await page.close(); }
  }
} finally {
  await browser?.close();
  await server.close();
}
