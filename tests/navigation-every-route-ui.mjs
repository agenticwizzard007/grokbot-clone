// npm run test:navigation. NAV_SIZES=390,500 selects widths. Local fixtures only.
import assert from 'node:assert/strict';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { preview } from '../web/node_modules/vite/dist/node/index.js';
import { chromium } from 'playwright';
import { APP_SECTIONS, BOT_TABS, parseScreen, parentScreen, resolveScreen, screenHash } from '../web/src/lib/navigation.ts';
const routes = [
 '',
 '#bots', '#bot/coordinator', '#bot/project-room', '#bot/coordinator/details',
 ...['activity','tasks','files','files/reports','setup','setup/responsibilities','setup/harness','setup/files','setup/history'].map(tab => `#bot/coordinator/details/${tab}`),
 '#bot/coordinator/settings', ...BOT_TABS.map(tab => `#bot/coordinator/settings/${tab}`),
 '#settings', '#settings/', ...APP_SECTIONS.map(section => `#settings/${section}`), ...APP_SECTIONS.map(section => `#${section}`),
 '#api-keys', '#whatsapp', '#settings/api-keys', '#settings/whatsapp', '#settings/unknown',
 ...['tasks','team','goals','reports'].flatMap(tab => [`#${tab}`,`#bot/coordinator/${tab}`]),
 '#search', '#new-bot', '#new-bot/group', '#apps/connect', '#unknown', '#bot/missing',
 ...['activity','tasks','files','setup'].map(tab => `#bot/project-room/details/${tab}`),
 ...BOT_TABS.map(tab => `#bot/project-room/settings/${tab}`),
];
const widths = (process.env.NAV_SIZES || '320,390,500,768,1280').split(',').map(Number);
assert.ok(widths.every(width => Number.isInteger(width) && width > 0));
const started = Date.now();
await mkdir('.context/pb-b', { recursive: true });
const outDir = `${process.cwd()}/.context/navigation-route-dist`;
await cp('web/dist', outDir, { recursive: true });
const vite = await preview({ root: `${process.cwd()}/web`, build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
process.env.UI_ORIGIN = `http://127.0.0.1:${vite.httpServer.address().port}`;
const { shellFixture } = await import('./paper-shell-fixture.mjs');
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const results = [];
let last;
try {
 async function checkWidth(width) { for (const theme of ['light','dark']) {
  const { page, fixture, errors, writes } = await shellFixture(browser, width, theme); last = page; page.on('pageerror', e => console.error(page.url(), e.message));
  const canonical = hash => screenHash(resolveScreen(parseScreen(hash), fixture.bots, true));
  const hashIs = async hash => { try { await page.waitForFunction(hash => location.hash === hash, hash); } catch (e) { console.error('Expected', hash, 'at', page.url(), await page.evaluate(() => history.state)); throw e; } };
  const cold = async hash => {
   await page.goto('about:blank');
   await page.goto(`${process.env.UI_ORIGIN}/${hash}`);
   await page.locator('.shell-header').waitFor();
   if (parseScreen(hash)) await hashIs(canonical(hash));
   else await page.waitForFunction(() => location.hash.startsWith('#') && location.hash !== '#unknown');
   assert.deepEqual(await page.evaluate(() => history.state?.swarmNavigation?.trail), [], `${hash}: cold entry has no app history`);
  };
  const snapshot = name => page.screenshot({ path: `.context/pb-b/navigation-${name}-${width}-${theme}.png` });
  const home = async () => {
   let taps = 0;
   if (width <= 760) {
    const tab = page.locator('.phone-tabs').getByRole('button', { name: 'Bots', exact: true });
    if (await tab.isVisible()) { await tab.click(); taps++; }
    else { await page.getByRole('button', { name: 'Open navigation', exact: true }).click(); taps++; await page.locator('.phone-drawer').getByRole('button', { name: 'All Bots', exact: true }).click(); taps++; }
   } else { await page.locator('.sidebar__brand').click(); taps++; }
   await hashIs('#bots'); await page.locator('.bots-view').waitFor(); assert.ok(taps <= 3); return taps;
  };
  const openArea = async target => {
   let clicks = 0;
   const click = async control => { await control.click(); clicks++; };
   if (width <= 760) await click(page.getByRole('button', { name: 'Open navigation', exact: true }));
   const sidebar = page.locator(width <= 760 ? '.phone-drawer .sidebar' : '.sidebar');
   if (['Settings', 'Connect apps'].includes(target)) {
    await click(sidebar.getByRole('button', { name: 'Account & settings', exact: true }));
    await click(page.getByRole('menuitem', { name: new RegExp(`^${target}`) }));
   } else await click(sidebar.getByRole('button', { name: target === 'Create a Bot' ? 'New Bot' : target, exact: true }));
   assert.ok(clicks <= 3, `${target}: reachable in at most three clicks`);
  };
  const historyFlows = async () => {
   await cold('#tasks');
   for (const [label, hash] of [['Team','#team'],['Goals','#goals'],['Files','#reports']]) {
    await page.getByRole('navigation', { name: 'Work sections' }).getByRole('button', { name: label, exact: true }).click(); await hashIs(hash);
   }
   for (const hash of ['#goals','#team','#tasks']) { await page.goBack(); await hashIs(hash); }
   for (const hash of ['#team','#goals','#reports']) { await page.goForward(); await hashIs(hash); }
   await cold('#bot/coordinator'); await page.locator('.composer__input').waitFor();
   await page.getByRole('button', { name: 'Show details', exact: true }).first().click();
   await hashIs(canonical('#bot/coordinator/details/activity'));
   await page.goBack(); await hashIs(canonical('#bot/coordinator'));
   await page.goForward(); await hashIs(canonical('#bot/coordinator/details/activity'));
   for (const target of ['Settings','Search','Create a Bot']) {
    await cold('#bots'); await openArea(target);
    const expected = target === 'Settings' ? width <= 760 ? '#settings' : '#settings/general' : target === 'Search' ? '#search' : '#new-bot';
    await hashIs(expected);
    await page.goBack(); await hashIs('#bots');
    await page.goForward(); await hashIs(expected);
   }
   console.log(`PASS ${width} ${theme}: browser Back and Forward retain Tasks tabs, details, Settings, Search and Create a Bot`);
  };
  const dismissals = async () => {
   if (width <= 760) {
    await cold('#tasks');
    const trigger = page.getByRole('button', { name: 'Open navigation', exact: true });
    const drawer = page.getByRole('dialog', { name: 'App navigation', exact: true });
    for (const method of ['Escape','outside']) {
     await trigger.click(); await drawer.waitFor();
     assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
     if (width === 390 && method === 'Escape') await snapshot('drawer');
     await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
     if (method === 'Escape') await page.keyboard.press('Escape');
     else await page.mouse.click(width - 2, 100);
     await drawer.waitFor({ state: 'detached' });
     assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
     await page.waitForFunction(() => document.activeElement?.matches('.shell-menu')).catch(async () => {
      assert.fail(`drawer ${method}: expected focus on Open navigation, got ${await page.evaluate(() => document.activeElement?.tagName)}`);
     });
     assert.ok(await trigger.evaluate(el => el === document.activeElement), `drawer ${method}: focus returns to trigger`);
    }
   }
   for (const method of ['Escape','outside']) {
    await cold('#bot/coordinator'); await page.locator('.composer__input').waitFor();
    for (const selector of ['.chat__pill', '.composer__plus-anchor > button', '.model-pill']) {
     const trigger = page.locator(selector);
     await trigger.click();
     const surface = selector === '.model-pill' ? page.getByRole('dialog', { name: 'Model and effort', exact: true }) : page.getByRole('menu');
     await surface.waitFor(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
     if (method === 'Escape') await page.keyboard.press('Escape');
     else if (selector === '.model-pill' && await page.locator('.mm-scrim').isVisible()) await page.locator('.mm-scrim').click({ position: { x: 2, y: 2 } });
     else await page.mouse.click(width - 2, selector === '.chat__pill' ? 500 : 100);
     await surface.waitFor({ state: 'detached' });
     if (method === 'Escape') assert.ok(await trigger.evaluate(el => el === document.activeElement), `${selector}: Escape returns focus`);
    }
    if (width <= 760) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    await page.getByRole('button', { name: 'Account & settings', exact: true }).click();
    await page.getByRole('menu').waitFor();
    if (method === 'Escape') await page.keyboard.press('Escape');
    else await page.mouse.click(width - 2, 100);
    await page.getByRole('menu').waitFor({ state: 'detached' });
    if (width <= 760) await page.getByRole('dialog', { name: 'App navigation', exact: true }).waitFor({ state: 'detached' });
    for (const [target, label] of [['Search','Search'], ['Connect apps','Connect Apps']]) {
     await cold('#bots'); await openArea(target);
     const surface = page.getByRole('dialog', { name: label, exact: true });
     await surface.waitFor(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
     if (method === 'Escape') await page.keyboard.press('Escape');
     // Paper renders these as full page routes without a backdrop. The shared
     // Back control outside their surface remains clickable and closes them.
     else await page.locator('.shell-back').click();
     await surface.waitFor({ state: 'detached' }); await hashIs('#bots');
    }
   }
   await cold('#new-bot'); await page.getByRole('heading', { name: 'Create a Bot', exact: true }).waitFor();
   await page.keyboard.press('Escape'); await hashIs('#bots');
   console.log(`PASS ${width} ${theme}: Escape and outside dismissal, focus return, and page exits`);
  };
  for (const hash of routes) {
   await cold(hash);
   const current = parseScreen(new URL(page.url()).hash);
   const target = parentScreen(current) ?? { kind: 'bots' };
   if (current.kind === 'details' || current.kind === 'bot-settings') {
    assert.equal(await page.locator('.shell-header > .bot-avatar').count(), 1, `${hash}: Bot avatar in top bar`);
    assert.equal(await page.locator('.shell-header > .bot-avatar').evaluate(el => el.getBoundingClientRect().width), 32);
    assert.equal(await page.locator('.shell-header__subtitle').innerText() !== '', true);
   }
   assert.equal(await page.locator('.shell-header').evaluate(el => el.scrollWidth <= el.clientWidth), true, `${hash}: header fits`);
   assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && document.body.scrollWidth <= innerWidth + 1), true, `${hash}: no horizontal page overflow`);
   assert.deepEqual(await page.locator('.shell-header').evaluate(header => [...header.querySelectorAll('*')].filter(el => el.checkVisibility() && [...el.childNodes].some(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim()) && parseFloat(getComputedStyle(el).fontSize) < 11).map(el => el.textContent)), [], `${hash}: header text at least 11px`);
   const back = page.locator('.shell-back');
   assert.ok(await back.isVisible() || await page.locator('.sidebar').isVisible() || await page.locator('.phone-tabs').isVisible(), `${hash}: visible navigation`);
   if (width > 760) {
    assert.equal(await page.locator('.sidebar').isVisible(), true, `${hash}: desktop app navigation stays visible`);
    assert.equal(await page.locator('.sidebar').evaluate(el => !!el.closest('[inert]')), false);
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
    assert.equal(await page.locator('.sidebar').evaluate(el => el.getBoundingClientRect().width), 76);
    await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
   }
   if (width <= 760 && ['#bots','#tasks','#team','#goals','#reports','#search','#settings'].includes(hash)) assert.equal(await page.locator('.phone-tabs').isVisible(), true, `${hash}: top-level tabs`);
   if (current.kind !== 'bots') {
    await back.waitFor();
    if (width <= 760) {
     // The bottom tabs must not replace visible Back text, including Tasks.
     assert.equal(await back.innerText(), 'Back'); assert.equal(await back.locator('span').isVisible(), true);
     assert.ok(await back.evaluate(el => {
      const r = el.getBoundingClientRect(), label = el.querySelector('span'), text = label.getBoundingClientRect();
      return r.width >= 44 && r.height >= 44 && el.scrollWidth <= el.clientWidth && label.scrollWidth <= label.clientWidth && getComputedStyle(label).textOverflow !== 'ellipsis' && text.left >= 0 && text.right <= innerWidth;
     }), `${hash}: whole Back label and 44px target`);
    }
    if (hash === '#tasks' && [320,390,500].includes(width)) { await page.locator('.work-tabs').waitFor(); await snapshot('tasks'); }
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
   results.push({ route: hash || '/', width, theme, back: 'pass', homeTaps: taps });
   console.log(`PASS ${width} ${theme} ${hash || '/'}: previous or parent Back, home in ${taps} taps`);
  }
  await historyFlows();
  await dismissals();
  assert.deepEqual(errors, [], `${width} ${theme}: no browser errors`);
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
  const failure = await shellFixture(browser, width, theme);
  const respond = failure.fixture.respond;
  failure.fixture.respond = request => request.path === '/api/bots' ? { status: 503, json: { error: 'Unavailable' } } : respond(request);
  await failure.page.goto(`${process.env.UI_ORIGIN}/#bot/coordinator`);
  await failure.page.locator('.shell-header').waitFor();
  if (width > 760) await failure.page.locator('.sidebar__brand').click();
  else { await failure.page.getByRole('button', { name: 'Open navigation', exact: true }).click(); await failure.page.getByRole('button', { name: 'All Bots', exact: true }).click(); }
  await failure.page.waitForFunction(() => location.hash === '#bots');
  console.log(`PASS ${width}: roster failure retains navigation to Bots`);
  await failure.page.context().close();
 } }
 // Independent contexts keep the expanded matrix within a few minutes.
 const queue = [...widths];
 const completed = await Promise.allSettled(Array.from({ length: Math.min(5, queue.length) }, async () => {
  while (queue.length) {
   const width = queue.shift();
   try { await checkWidth(width); }
   catch (error) { console.error(`FAIL navigation ${width}: ${error.message}`); throw error; }
  }
 }));
 for (const result of completed) if (result.status === 'rejected') throw result.reason;
} catch (e) { await last?.screenshot({ path: '.context/pb-b/navigation-failure.png' }).catch(() => {}); throw e; }
finally { await writeFile('.context/pb-b/navigation-results.json', JSON.stringify(results,null,2)); await browser.close(); await new Promise(r => vite.httpServer.close(r)); }
console.log(`PASS navigation: ${results.length} route/size/theme cases in ${((Date.now() - started) / 1000).toFixed(1)}s`);
