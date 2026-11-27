// Local production app and fixture data only. Run after npm run build -w web.
import assert from 'node:assert/strict';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { preview } from '../web/node_modules/vite/dist/node/index.js';
import { chromium } from 'playwright';
const evidence = 'docs/design/paper/build/pb-b';
await mkdir(evidence, { recursive: true });
await mkdir('.context/pb-b', { recursive: true });
const outDir = `${process.cwd()}/.context/paper-shell-dist`;
await cp('web/dist', outDir, { recursive: true });
const vite = await preview({ root: `${process.cwd()}/web`, build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
process.env.UI_ORIGIN = `http://127.0.0.1:${vite.httpServer.address().port}`;
const { shellFixture } = await import('./paper-shell-fixture.mjs');
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const results = [];
let last;
async function audit(page, selector) {
 const issues = await page.locator(selector).evaluateAll(roots => {
  const issues = [];
  const visible = el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[hidden]');
  for (const root of roots) {
   if (!visible(root)) continue;
   for (const el of [root, ...root.querySelectorAll('*')]) {
    if (!visible(el) || el.closest('.sr-only') || ['svg','path','progress','input'].includes(el.tagName.toLowerCase())) continue;
    const nodes = [...el.childNodes].filter(n => n.nodeType === 3 && n.textContent.trim());
    if (!nodes.length) continue;
    const style = getComputedStyle(el);
    if (el.clientWidth && el.scrollWidth > el.clientWidth + 1) issues.push(`Overflow: ${el.className}: ${el.textContent}`);
    if (style.textOverflow === 'ellipsis' || style.webkitLineClamp !== 'none' && Number(style.webkitLineClamp) > 0) issues.push(`Truncation: ${el.className}`);
    for (const node of nodes) for (const word of node.textContent.matchAll(/\S+/g)) {
     const range = document.createRange(); range.setStart(node, word.index); range.setEnd(node, word.index + word[0].length);
     const rects = [...range.getClientRects()].filter(r => r.width > 0);
     if (new Set(rects.map(r => Math.round(r.y))).size > 1) issues.push(`Split word: ${word[0]}`);
    }
   }
   for (const logo of root.querySelectorAll('.provider-icon[data-provider]')) {
    if (!visible(logo)) continue;
    const r = logo.getBoundingClientRect(), p = logo.parentElement.getBoundingClientRect();
    if (Math.abs(r.width - 16) > 0.1 || Math.abs(r.height - 16) > 0.1 || r.left < p.left - 1 || r.right > p.right + 1 || r.top < p.top - 1 || r.bottom > p.bottom + 1) issues.push(`Logo box: ${JSON.stringify({ r: r.toJSON(), p: p.toJSON() })}`);
   }
  }
  return issues;
 });
 assert.deepEqual(issues, [], `label and logo audit ${selector}`);
 assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'No viewport overflow');
}
async function screenshot(page, slug, width, theme) {
 if ([320,390,1280].includes(width)) await page.screenshot({ path: `${evidence}/${slug}-${width}-${theme}.png` });
}
try {
 for (const width of [320,390,500,768,1280]) for (const theme of ['light','dark']) {
  const { page, errors } = await shellFixture(browser, width, theme); last = page;
  await page.goto(`${process.env.UI_ORIGIN}/#bot/coordinator`);
  await page.locator('.composer__input').waitFor();
  await page.waitForFunction(() => document.querySelector('.model-pill')?.getAttribute('aria-busy') === 'false');
  if (width > 760) {
   assert.equal(await page.locator('.sidebar-usage .provider-icon[data-provider]').count(), 1, 'Usage has a real provider mark');
   assert.equal(await page.locator('.sidebar-usage .provider-icon[data-provider=claude]').evaluate(el => getComputedStyle(el).color), 'rgb(217, 119, 87)');
  }
  if (width <= 760) {
   const back = page.locator('.shell-back');
   assert.equal(await back.innerText(), 'Back');
   assert.equal(await back.locator('span').isVisible(), true);
   assert.ok(await back.evaluate(el => el.getBoundingClientRect().height >= 44));
   assert.equal(await back.evaluate(el => getComputedStyle(el).color), await back.evaluate(el => { const probe = document.createElement('span'); probe.style.color = 'var(--color-primary)'; el.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; }));
  }
  await audit(page, '.shell-header, .sidebar');
  await screenshot(page, 'chat-sidebar', width, theme);
  if (width > 760) {
   assert.equal(await page.locator('.sidebar').evaluate(el => el.getBoundingClientRect().width), 272);
   assert.deepEqual(await page.locator('.sidebar__nav button').allTextContents(), ['All Bots','Tasks','Files']);
   await page.keyboard.press('Control+b');
   assert.equal(await page.locator('.sidebar').evaluate(el => el.getBoundingClientRect().width), 76);
   await page.getByRole('button', { name: /Account & settings$/ }).click();
   assert.deepEqual(await page.getByRole('menuitem').allTextContents(), ['SettingsCtrl+,','Usage','Models and access','Connect apps','Log out']);
   await audit(page, '.sidebar, .menu');
   await screenshot(page, 'rail-account-menu', width, theme);
   await page.keyboard.press('Escape'); await page.keyboard.press('Control+b');
   await page.locator('.sidebar__nav').getByRole('button', { name: 'Files', exact: true }).click();
   await page.waitForFunction(() => location.hash === '#reports');
   assert.deepEqual(await page.locator('.sidebar__nav .is-active').allTextContents(), ['Files']);
   assert.equal(await page.locator('.sidebar__nav').getByRole('button', { name: /^Tasks(?: \d|$)/ }).getAttribute('aria-pressed'), 'false');
   await page.locator('.sidebar__search').click();
   await page.locator('.search-modal').waitFor();
   assert.equal(await page.locator('.sidebar .is-selected, .sidebar__nav .is-active').count(), 0);

  } else {
   await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
   assert.equal(await page.locator('.phone-drawer').evaluate(el => el.getBoundingClientRect().width), Math.min(312, width-8));
   await audit(page, '.phone-drawer');
   await screenshot(page, 'phone-drawer', width, theme);
   await page.keyboard.press('Escape');
  }
  await page.evaluate(() => { location.hash = '#bots'; });
  await page.locator('.bots-view').waitFor();
  if (width <= 760) {
   assert.deepEqual(await page.locator('.phone-tabs button').allTextContents(), ['Bots','Tasks','Search','Settings']);
   await audit(page, '.phone-tabs, .shell-header');
  }
  await screenshot(page, 'bots-tab', width, theme);
  await page.evaluate(() => { location.hash = '#settings'; });
  await page.locator('.settings-nav__item').first().waitFor();
  await audit(page, '.settings-nav, .shell-header, .sidebar, .phone-tabs');
  await screenshot(page, 'settings-home', width, theme);
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await page.locator('.settings-general').waitFor();
  await audit(page, '.settings-general, .settings-nav, .shell-header, .sidebar');
  if (width > 760) assert.equal(await page.locator('.app-settings__nav').evaluate(el => el.getBoundingClientRect().width), 220);
  if (width > 760) { assert.equal(await page.locator('.sidebar .pinned__tile').isVisible(), true, 'Bot list stays visible in Settings'); }
  await screenshot(page, 'settings-general', width, theme);
  await page.getByRole('button', { name: 'View', exact: true }).click();
  await audit(page, '.settings-shortcuts');
  assert.deepEqual(errors, []);
  results.push({ width, theme, pass: true }); console.log(`PASS Paper shell ${width} ${theme}`);
  await page.context().close();
 }
} catch (e) { await last?.screenshot({ path: '.context/pb-b/failure.png' }); throw e; }
finally { await writeFile('.context/pb-b/results.json', JSON.stringify(results,null,2)); await browser.close(); await new Promise(r => vite.httpServer.close(r)); }
