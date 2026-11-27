// Run with node --import tsx. All navigation uses local fixtures, never a live account.
import assert from 'node:assert/strict';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { preview } from '../web/node_modules/vite/dist/node/index.js';
import { chromium } from 'playwright';
import { APP_SECTIONS, BOT_TABS, parseScreen, parentScreen, resolveScreen, screenHash } from '../web/src/lib/navigation.ts';
const routes = [
 '#bots', '#bot/coordinator', '#bot/project-room', '#bot/coordinator/details',
 ...['activity','tasks','files','files/reports','setup','setup/responsibilities','setup/harness','setup/files','setup/history'].map(tab => `#bot/coordinator/details/${tab}`),
 '#bot/coordinator/settings', ...BOT_TABS.map(tab => `#bot/coordinator/settings/${tab}`),
 '#settings', '#settings/', ...APP_SECTIONS.map(section => `#settings/${section}`), ...APP_SECTIONS.map(section => `#${section}`),
 '#api-keys', '#whatsapp', '#settings/api-keys', '#settings/whatsapp', '#settings/unknown',
 ...['tasks','team','goals','reports'].flatMap(tab => [`#${tab}`,`#bot/coordinator/${tab}`]),
 '#search', '#new-bot', '#new-bot/group', '#apps/connect', '#unknown', '#bot/missing',
];
await mkdir('.context/pb-b', { recursive: true });
const outDir = `${process.cwd()}/.context/navigation-route-dist`;
await cp('web/dist', outDir, { recursive: true });
const vite = await preview({ root: `${process.cwd()}/web`, build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
process.env.UI_ORIGIN = `http://127.0.0.1:${vite.httpServer.address().port}`;
const { shellFixture } = await import('./paper-shell-fixture.mjs');
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const results = [];
let last;
try {
 for (const width of [390,1280]) {
  const { page, fixture, errors, writes } = await shellFixture(browser, width); last = page; page.on('pageerror', e => console.error(page.url(), e.message));
  const canonical = hash => screenHash(resolveScreen(parseScreen(hash), fixture.bots, true));
  const hashIs = async hash => { try { await page.waitForFunction(hash => location.hash === hash, hash); } catch (e) { console.error('Expected', hash, 'at', page.url(), await page.evaluate(() => history.state)); throw e; } };
  const home = async () => {
   let taps = 0;
   if (width <= 760) {
    const tab = page.locator('.phone-tabs').getByRole('button', { name: 'Bots', exact: true });
    if (await tab.isVisible()) { await tab.click(); taps++; }
    else { await page.getByRole('button', { name: 'Open navigation', exact: true }).click(); taps++; await page.locator('.phone-drawer').getByRole('button', { name: 'All Bots', exact: true }).click(); taps++; }
   } else { await page.locator('.sidebar__brand').click(); taps++; }
   await hashIs('#bots'); await page.locator('.bots-view').waitFor(); assert.ok(taps <= 3); return taps;
  };
  for (const hash of routes) {
   await page.goto(`${process.env.UI_ORIGIN}/navigation-test-reset`);
   await page.evaluate(() => history.replaceState(null, '', location.pathname));
   await page.goto(`${process.env.UI_ORIGIN}/${hash}`);
   await page.locator('.shell-header').waitFor();
   if (hash.includes('/settings') || hash.startsWith('#settings')) await page.waitForTimeout(100);
   if (parseScreen(hash)) await hashIs(canonical(hash));
   if (!parseScreen(hash)) await page.waitForFunction(() => location.hash !== '#unknown');
   const current = parseScreen(new URL(page.url()).hash);
   const target = parentScreen(current) ?? { kind: 'bots' };
   if (current.kind === 'details' || current.kind === 'bot-settings') {
    assert.equal(await page.locator('.shell-header > .bot-avatar').count(), 1, `${hash}: Bot avatar in top bar`);
    assert.equal(await page.locator('.shell-header > .bot-avatar').evaluate(el => el.getBoundingClientRect().width), 32);
    assert.equal(await page.locator('.shell-header__subtitle').innerText() !== '', true);
   }
   assert.equal(await page.locator('.shell-header').evaluate(el => el.scrollWidth <= el.clientWidth), true, `${hash}: header fits`);
   const back = page.locator('.shell-back');
   assert.ok(await back.isVisible() || await page.locator('.sidebar').isVisible() || await page.locator('.phone-tabs').isVisible(), `${hash}: visible navigation`);
   if (width > 760) {
    assert.equal(await page.locator('.sidebar').isVisible(), true, `${hash}: desktop app navigation stays visible`);
    assert.equal(await page.locator('.sidebar').evaluate(el => !!el.closest('[inert]')), false);
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
    assert.equal(await page.locator('.sidebar').evaluate(el => el.getBoundingClientRect().width), 76);
    await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
   }
   if (width <= 760 && ['#bots','#tasks','#search','#settings'].includes(hash)) assert.equal(await page.locator('.phone-tabs').isVisible(), true, `${hash}: top-level tabs`);
   if (current.kind !== 'bots') {
    await back.waitFor();
    if (width <= 760) { assert.equal(await back.innerText(), 'Back'); assert.equal(await back.locator('span').isVisible(), true); assert.ok(await back.evaluate(el => el.getBoundingClientRect().width >= 44 && el.getBoundingClientRect().height >= 44)); }
    await back.click(); await hashIs(canonical(screenHash(target)));
   }
   const taps = await home() + Number(current.kind !== 'bots');
   assert.ok(taps <= 3, 'Home remains within three taps including Back');
   // An unrelated previous screen takes precedence over the structural parent.
   if (parseScreen(hash) && hash !== '#bot/missing') {
    const from = hash === '#reports' ? '#bot/research-bot' : '#reports';
    await page.evaluate(hash => { location.hash = hash; }, from); await hashIs(canonical(from));
    await page.evaluate(hash => { location.hash = hash; }, hash); await hashIs(canonical(hash));
    await back.waitFor(); await back.click(); await hashIs(canonical(from));
   }
   assert.deepEqual(errors, [], `${hash}: no page errors`);
   results.push({ route: hash, width, back: 'pass', homeTaps: taps });
   console.log(`PASS ${width} ${hash}: previous or parent Back, home in ${taps} taps`);
  }
  assert.deepEqual(writes, [], 'Navigation does not mutate account data');
  // Opening a route must retain the unsaved Bot settings guard.
  await page.goto(`${process.env.UI_ORIGIN}/#bot/coordinator/settings/general`);
  const name = page.getByRole('textbox', { name: 'Name', exact: true });
  await name.waitFor();
  {
   await name.fill('Changed local Bot');
   await page.locator('.shell-back').click();
   await page.getByRole('alertdialog', { name: 'Discard unsaved changes?' }).waitFor();
   assert.match(new URL(page.url()).hash, /\/settings\/general$/);
  }
  await page.context().close();
  const failure = await shellFixture(browser, width);
  const respond = failure.fixture.respond;
  failure.fixture.respond = request => request.path === '/api/bots' ? { status: 503, json: { error: 'Unavailable' } } : respond(request);
  await failure.page.goto(`${process.env.UI_ORIGIN}/#bot/coordinator`);
  await failure.page.locator('.shell-header').waitFor();
  if (width > 760) await failure.page.locator('.sidebar__brand').click();
  else { await failure.page.getByRole('button', { name: 'Open navigation', exact: true }).click(); await failure.page.getByRole('button', { name: 'All Bots', exact: true }).click(); }
  await failure.page.waitForFunction(() => location.hash === '#bots');
  console.log(`PASS ${width}: roster failure retains navigation to Bots`);
  await failure.page.context().close();
 }
} catch (e) { await last?.screenshot({ path: '.context/pb-b/navigation-failure.png' }); throw e; }
finally { await writeFile('.context/pb-b/navigation-results.json', JSON.stringify(results,null,2)); await browser.close(); await new Promise(r => vite.httpServer.close(r)); }
