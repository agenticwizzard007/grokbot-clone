// Measure local fixture copy. Pass --baseline-root /path/to/untouched/repo for the before count.
import assert from 'node:assert/strict';
import { preview } from '../web/node_modules/vite/dist/node/index.js';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
const baselineRoot = process.argv[process.argv.indexOf('--baseline-root') + 1];
const baseline = process.argv.includes('--baseline-root');
const root = `${baseline ? baselineRoot : process.cwd()}/web`;
const vite = await preview({ root, preview: { host: '127.0.0.1', port: 0 } });
process.env.UI_ORIGIN = `http://127.0.0.1:${vite.httpServer.address().port}`;
const { shellFixture } = await import('./paper-shell-fixture.mjs');
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const counts = [];
try {
 for (const width of [1280,390]) {
  const { page } = await shellFixture(browser, width);
  for (const [name, hash, scope] of [
   ['Chat','#bot/coordinator','.chat'], ['Bots','#bots',width === 390 && baseline ? '.sidebar' : '.bots-view'],
   ['Tasks','#tasks','.tasks-view'], ['Search','#search','.search-modal'], ['Settings home','#settings','.settings-nav'],
   ...['general','account','messaging','usage','learning','computer','permissions','subscriptions','keys','apps','mcp'].map(s => [`Settings ${s}`,`#settings/${s}`,'.app-settings__page']),
  ]) {
   await page.goto(`${process.env.UI_ORIGIN}/${hash}`); await page.locator(scope).first().waitFor(); await page.waitForTimeout(600);
   const words = await page.evaluate(() => {
    // Settings navigation belongs to the main region even when the old frame put it in the app sidebar.
    const settingsNav = document.querySelector('.sidebar .settings-nav');
    const extra = settingsNav?.innerText ?? '';
    const hidden = [...document.querySelectorAll('.sidebar, .phone-tabs, .sr-only')].map(el => [el, el.style.display]);
    hidden.forEach(([el]) => { el.style.display = 'none'; });
    const text = `${document.body.innerText} ${extra}`.trim();
    hidden.forEach(([el, display]) => { el.style.display = display; });
    return text.split(/\s+/).filter(Boolean).length;
   });
   if (!baseline && ['Settings home', 'Settings general'].includes(name)) assert.ok(words <= (width === 1280 ? 40 : 22), `${name}: Paper v2 copy budget`);
   counts.push({ screen: name, width, words });
   if (name === 'Chat' && width === 1280) {
    counts.push({ screen: 'Sidebar', width, words: await page.locator('.sidebar').evaluate(el => el.innerText.trim().split(/\s+/).filter(Boolean).length) });
    await page.getByRole('button', { name: /Account & settings$/ }).click();
    counts.push({ screen: 'Account menu', width, words: await page.getByRole('menu').evaluate(el => el.innerText.trim().split(/\s+/).filter(Boolean).length) });
   }
  }
  await page.context().close();
 }
 await mkdir('.context/pb-b', { recursive: true });
 await writeFile(`.context/pb-b/copy-${baseline ? 'before' : 'after'}.json`, JSON.stringify(counts,null,2));
 console.log(counts);
} finally { await browser.close(); await new Promise(r => vite.httpServer.close(r)); }
