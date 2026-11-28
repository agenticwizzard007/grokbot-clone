// npm run test:navigation. NAV_SIZES=390,500 selects widths. Local fixtures only.
import assert from 'node:assert/strict';
import { cp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { preview } from '../web/node_modules/vite/dist/node/index.js';
import { chromium } from 'playwright';
import { APP_SECTIONS, BOT_TABS, parseScreen, parentScreen, resolveScreen, screenHash } from '../web/src/lib/navigation.ts';
import { output, handoff, events as handoffEvents } from './handoffs/ui-d-fixture.mjs';
import { recordedRun } from './handoffs/ui-e-fixture.mjs';
const flow = JSON.parse(await readFile(new URL('./flow/golden/empty.json', import.meta.url), 'utf8'));
const run = recordedRun();
const routes = [
 '#loops', '#loop/lp_converged', '#handoff/ho_fixture', `#output/${output.id}`, `#output/${output.id}?part=p_body`,
 '#bot/coordinator/details/flow',
 '',
 '#bots', '#bot/coordinator', '#bot/project-room', '#bot/coordinator/details',
 ...['activity','tasks','files','files/reports','setup','setup/responsibilities','setup/harness','setup/files','setup/history'].map(tab => `#bot/coordinator/details/${tab}`),
 '#bot/coordinator/settings', ...BOT_TABS.map(tab => `#bot/coordinator/settings/${tab}`),
 '#settings', '#settings/', ...APP_SECTIONS.map(section => `#settings/${section}`), ...APP_SECTIONS.map(section => `#${section}`),
 '#api-keys', '#whatsapp', '#settings/api-keys', '#settings/whatsapp', '#settings/unknown',
 ...['tasks','team','goals','reports'].flatMap(tab => [`#${tab}`,`#bot/coordinator/${tab}`]),
 '#first-run', '#search', '#new-bot', '#new-bot/group', '#apps/connect', '#unknown', '#bot/missing',
 ...['activity','tasks','files','setup'].map(tab => `#bot/project-room/details/${tab}`),
 ...BOT_TABS.map(tab => `#bot/project-room/settings/${tab}`),
];
const widths = (process.env.NAV_SIZES || '320,390,500,768,1280').split(',').map(Number);
assert.ok(widths.every(width => Number.isInteger(width) && width > 0));
const started = Date.now();
await mkdir('.context/pb-b', { recursive: true });
const outDir = `${process.cwd()}/.context/navigation-route-dist`;
await cp('web/dist', outDir, { recursive: true });
const vite = await preview({ root: `${process.cwd()}/web`, build: { outDir }, preview: { host: '127.0.0.1', port: 0, headers: { 'Cache-Control': 'public, max-age=3600' } } });
process.env.UI_ORIGIN = `http://127.0.0.1:${vite.httpServer.address().port}`;
const { shellFixture } = await import('./paper-shell-fixture.mjs');
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const results = [];
let last;
try {
 async function checkCase(width, theme) {
  const { page, fixture, errors, writes } = await shellFixture(browser, width, theme); last = page; page.on('pageerror', e => console.error(page.url(), e.message));
  // Established Bots keep the Activity bookmark stable; explicit Flow routes use the same model.
  for (const bot of fixture.bots) { bot.createdAt = 1; bot.lastActivityAt = Date.now(); }
  const baseRespond = fixture.respond;
  fixture.respond = request => {
   const path = request.path;
   if (/^\/api\/bots\/[^/]+\/flow$/.test(path)) return { headers: { 'X-Flow-Has-Runs': '1' }, json: { ...flow, botId: path.split('/')[3] } };
   if (path === '/api/handoff-settings') return { json: { settings: { enabled: true, agentHandoffs: 'team' } } };
   if (path === '/api/handoff-links') return { json: { links: [] } };
   if (path === '/api/loops') return { json: { loops: [run.detail.loop], next: null } };
   if (path === '/api/loops/lp_converged') return { json: run.detail };
   if (path === '/api/loops/lp_converged/events') return { json: { events: run.events, next: null } };
   if (path === '/api/handoffs/ho_fixture') return { json: { handoff, events: handoffEvents } };
   if (/^\/api\/outputs\/[^/]+$/.test(path)) return { json: { output } };
   if (path.includes('/parts/')) return { json: { output, part: output.parts[0], text: 'Placeholder output body.', next: null } };
   return baseRespond(request);
  };
  // Cold documents may reuse this immutable local build, as bookmarks do.
  // Playwright routing otherwise disables caching for every static asset too.
  const network = await page.context().newCDPSession(page);
  await network.send('Network.setCacheDisabled', { cacheDisabled: false });
  const canonical = hash => screenHash(resolveScreen(parseScreen(hash), fixture.bots, true));
  const hashIs = async hash => { try { await page.waitForFunction(hash => location.hash === hash, hash); } catch (e) { console.error('Expected', hash, 'at', page.url(), await page.evaluate(() => history.state)); throw e; } };
  const cold = async hash => {
   await page.goto('about:blank');
   await page.goto(`${process.env.UI_ORIGIN}/${hash}`);
   await page.locator('.shell-header').waitFor();
   if (parseScreen(hash)) await hashIs(canonical(hash));
   else await page.waitForFunction(() => location.hash.startsWith('#') && location.hash !== '#unknown');
   if (parseScreen(hash)?.flow) await page.locator('.flow-tab').waitFor();
   assert.deepEqual(await page.evaluate(() => history.state?.swarmNavigation?.trail), [], `${hash}: cold entry has no app history`);
  };
  const snapshot = name => page.screenshot({ path: `.context/pb-b/navigation-${name}-${width}-${theme}.png` });
  const phoneTabsWithoutBack = async label => {
   const tabs = page.getByRole('navigation', { name: 'App navigation', exact: true });
   assert.ok(await tabs.isVisible(), `${label}: phone tab bar is visible`);
   assert.equal(await page.locator('.shell-back').isVisible(), false, `${label}: no shell Back on a phone tab root`);
   assert.equal(await page.getByRole('button', { name: /^Back(?: |$)/ }).count(), 0, `${label}: no visible Back control`);
   return tabs;
  };
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
    await click(sidebar.getByRole('button', { name: /Account & settings$/ }));
    await click(page.getByRole('menuitem', { name: new RegExp(`^${target}`) }));
   } else await click(sidebar.getByRole('button', { name: target === 'Search' ? /^Search(?: |$)/ : target === 'Tasks' ? /^Tasks(?: \d|$)/ : target, exact: true }));
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
   const outsideClick = async (x, y) => {
    // Menu defers its outside listener until after the opening click. Wait for
    // the rendered menu to settle before sending an immediate synthetic click.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.mouse.click(x, y);
   };
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
     else await outsideClick(width - 2, selector === '.chat__pill' ? 500 : 100);
     await surface.waitFor({ state: 'detached' });
     if (method === 'Escape') assert.ok(await trigger.evaluate(el => el === document.activeElement), `${selector}: Escape returns focus`);
    }
    if (width <= 760) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    await page.getByRole('button', { name: /Account & settings$/ }).click();
    await page.getByRole('menu').waitFor();
    await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
    if (method === 'Escape') await page.keyboard.press('Escape');
    else await outsideClick(width - 2, 100);
    await page.getByRole('menu').waitFor({ state: 'detached' }).catch(() => assert.fail(`Account menu: ${method} must close it`));
    if (width <= 760) {
     const drawer = page.getByRole('dialog', { name: 'App navigation', exact: true });
     if (method === 'Escape') {
      assert.ok(await drawer.isVisible(), 'First Escape closes only the nested account menu');
      assert.ok(await page.getByRole('button', { name: /Account & settings$/ }).evaluate(el => el === document.activeElement), 'Account menu returns focus inside the drawer');
      await page.keyboard.press('Escape');
     }
     await drawer.waitFor({ state: 'detached' });
    }
    for (const [target, label] of [['Search','Search'], ['Connect apps','Connect Apps']]) {
     await cold('#bots'); await openArea(target);
     const surface = page.getByRole('dialog', { name: label, exact: true });
     await surface.waitFor(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
     const tabs = width <= 760 && target === 'Search' ? await phoneTabsWithoutBack(label) : null;
     if (method === 'Escape') await page.keyboard.press('Escape');
     // Phone Search exits through its visible Bots tab. Connect Apps and desktop
     // surfaces retain the shared Back control outside their full page surface.
     else if (tabs) await tabs.getByRole('button', { name: 'Bots', exact: true }).click();
     else await page.locator('.shell-back').click();
     await surface.waitFor({ state: 'detached' }); await hashIs('#bots');
    }
   }
   await cold('#new-bot'); await page.getByRole('heading', { name: 'Create a Bot', exact: true }).waitFor();
   await page.keyboard.press('Escape'); await hashIs('#bots');
   await cold('#bot/project-room');
   const addBot = page.getByRole('button', { name: 'Add Bot', exact: true });
   await addBot.click();
   await page.getByRole('dialog', { name: 'Room members', exact: true }).waitFor();
   await page.keyboard.press('Escape');
   await page.getByRole('dialog', { name: 'Room members', exact: true }).waitFor({ state: 'detached' });
   assert.ok(await addBot.evaluate(el => el === document.activeElement), 'Room members restores focus');
   console.log(`PASS ${width} ${theme}: Escape and outside dismissal, focus return, and page exits`);
  };
  for (const hash of routes) {
   await cold(hash);
   const current = parseScreen(new URL(page.url()).hash);
   const target = parentScreen(current) ?? { kind: 'bots' };
   const phoneRoot = width <= 760 && (['bots', 'search'].includes(current.kind)
    || current.kind === 'settings' && !current.section || current.kind === 'work' && !current.route.botSlug);
   if (current.kind === 'details' || current.kind === 'bot-settings') {
    const avatar = page.locator('.shell-header > .bot-avatar:visible');
    assert.equal(await avatar.count(), 1, `${hash}: Bot avatar in top bar`);
    assert.equal(await avatar.evaluate(el => el.getBoundingClientRect().width), 32);
    assert.equal(await page.locator('.shell-header__subtitle:visible').innerText() !== '', true);
   }
   assert.equal(await page.locator('.shell-header').evaluate(el => el.scrollWidth <= el.clientWidth), true, `${hash}: header fits`);
   assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && document.body.scrollWidth <= innerWidth + 1), true, `${hash}: no horizontal page overflow`);
   assert.deepEqual(await page.locator('.shell-header').evaluate(header => [...header.querySelectorAll('*')].filter(el => el.checkVisibility() && [...el.childNodes].some(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim()) && parseFloat(getComputedStyle(el).fontSize) < 11).map(el => el.textContent)), [], `${hash}: header text at least 11px`);
   const back = page.locator('.shell-back:visible');
   assert.ok(await back.isVisible() || await page.locator('.sidebar').isVisible() || await page.locator('.phone-tabs').isVisible(), `${hash}: visible navigation`);
   if (width > 760) {
    assert.equal(await page.locator('.sidebar').isVisible(), true, `${hash}: desktop app navigation stays visible`);
    assert.equal(await page.locator('.sidebar').evaluate(el => !!el.closest('[inert]')), false);
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
    assert.equal(await page.locator('.sidebar').evaluate(el => el.getBoundingClientRect().width), 76);
    await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
   }
   if (width <= 760 && ['#bots','#tasks','#team','#goals','#reports','#search','#settings'].includes(hash)) assert.equal(await page.locator('.phone-tabs').isVisible(), true, `${hash}: top-level tabs`);
   if (phoneRoot) await phoneTabsWithoutBack(hash);
   if (current.kind !== 'bots') {
    if (!phoneRoot) await back.waitFor();
    if (width <= 760 && !phoneRoot) {
     // Non-root phone routes retain their visible Back text and target size.
     if (['details', 'bot-settings', 'create'].includes(current.kind)) {
      const controls = await page.getByRole('button', { name: /^Back(?: |$)/ }).all();
      assert.equal((await Promise.all(controls.map(control => control.isVisible()))).filter(Boolean).length, 1, `${hash}: one Back control`);
     }
     assert.equal(await back.innerText(), 'Back'); assert.equal(await back.locator('span').isVisible(), true);
     assert.ok(await back.evaluate(el => {
      const r = el.getBoundingClientRect(), label = el.querySelector('span'), text = label.getBoundingClientRect();
      return r.width >= 44 && r.height >= 44 && el.scrollWidth <= el.clientWidth && label.scrollWidth <= label.clientWidth && getComputedStyle(label).textOverflow !== 'ellipsis' && text.left >= 0 && text.right <= innerWidth;
     }), `${hash}: whole Back label and 44px target`);
    }
    if (hash === '#tasks' && [320,390,500].includes(width)) { await page.locator('.work-tabs').waitFor(); await snapshot('tasks'); }
    if (phoneRoot) await page.locator('.phone-tabs').getByRole('button', { name: 'Bots', exact: true }).click();
    else await back.click();
    await hashIs(width > 760 && current.kind === 'settings' ? canonical('#bot/coordinator') : canonical(screenHash(target)));
   }
   const taps = await home() + Number(current.kind !== 'bots');
   assert.ok(taps <= 3, 'Home remains within three taps including Back');
   // Browser history follows the previous entry. In-app chat Back follows its
   // parent, as separately asserted above and in livewalk-b-ui (#294).
   if (parseScreen(hash) && hash !== '#bot/missing') {
    const from = hash === '#reports' ? '#bot/research-bot' : '#reports';
    await page.evaluate(hash => { location.hash = hash; }, from); await hashIs(canonical(from));
    await page.evaluate(hash => { location.hash = hash; }, hash); await hashIs(canonical(hash));
    if (phoneRoot) await phoneTabsWithoutBack(hash);
    await page.goBack(); await hashIs(canonical(from));
    await page.goForward(); await hashIs(canonical(hash));
    if (parentScreen(current) && current.kind !== 'settings') {
      await back.click(); await hashIs(canonical(screenHash(parentScreen(current))));
    }
   }
   assert.deepEqual(errors, [], `${hash}: no page errors`);
   results.push({ route: hash || '/', width, theme, back: 'pass', homeTaps: taps });
   console.log(`PASS ${width} ${theme} ${hash || '/'}: previous or parent Back, home in ${taps} taps`);
  }
  await historyFlows();
  await dismissals();
  const originalRespond = fixture.respond;
  fixture.respond = request => {
   if (request.path.endsWith('/tasks')) return { json: { tasks: [{ id: 'waiting-task', botId: 'coordinator', title: 'Review the launch plan', state: 'needs_input', updatedAt: Date.now() }] } };
   if (request.path === '/api/needs-you') return { json: { items: [{ id: 'waiting-approval', botId: 'coordinator', type: 'approval', title: 'Review the draft email', createdAt: Date.now(), seq: 1 }] } };
   return originalRespond(request);
  };
  await cold('#tasks');
  const notice = page.getByTestId('tasks-needs-input');
  await notice.getByText('2 tasks need your input', { exact: true }).waitFor();
  await page.locator('.task-filters .is-done').click();
  await notice.getByRole('button', { name: 'Review', exact: true }).click();
  for (const title of ['Review the launch plan', 'Review the draft email']) {
   await page.locator('.task-card').filter({ hasText: title }).click();
   await hashIs(canonical('#bot/coordinator'));
   await page.goBack();
   await hashIs('#tasks');
  }
  fixture.respond = originalRespond;
  results.push({ route: 'Tasks waiting notice, task chat and approval chat', width, theme, back: 'pass' });
  await cold('#settings/subscriptions');
  await page.locator('.subscription-settings [data-layout="row"][data-provider="claude"]').getByRole('button',{name:'Connect',exact:true}).click();
  const sheet = page.getByRole('dialog',{name:'Connect Claude',exact:true}); await sheet.waitFor();
  if(width<=760) { assert.equal(await page.locator('button[aria-label="Back"]:not([inert] *)').count(),1); await sheet.getByRole('button',{name:'Back',exact:true}).click(); }
  else await sheet.getByRole('button',{name:'Close',exact:true}).click();
  await sheet.waitFor({state:'detached'});
  await page.getByRole('button',{name:'Paste key',exact:true}).click();
  assert.equal(await page.getByLabel('OpenRouter API key',{exact:true}).getAttribute('type'),'password');
  if(width<=760) assert.equal(await page.locator('button[aria-label="Back"]:not([inert] *)').count(),1);
  await cold('#settings/apps');await page.getByRole('button',{name:'Connect',exact:true}).click();
  await page.getByRole('button',{name:'Close catalog',exact:true}).waitFor();
  if(width<=760) assert.equal(await page.locator('button[aria-label="Back"]:not([inert] *)').count(),1);
  await page.getByRole('button',{name:'Close catalog',exact:true}).click();
  results.push({route:'Settings connection sheet, masked key and app catalog',width,theme,back:'pass'});

  assert.deepEqual(errors, [], `${width} ${theme}: no browser errors`);
  // Suggestions use POST to query draft context, without saving Bot changes.
  assert.deepEqual(writes.filter(({ method, path }) => method !== 'POST' || !/^\/api\/bots\/[^/]+\/suggested-apps$/.test(path)), [], 'Navigation does not mutate account data');
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
 }
 // Independent contexts keep the expanded matrix within a few minutes.
 const queue = widths.flatMap(width => ['light', 'dark'].map(theme => ({ width, theme })));
 const completed = await Promise.allSettled(Array.from({ length: Math.min(10, queue.length) }, async () => {
  while (queue.length) {
   const { width, theme } = queue.shift();
   try { await checkCase(width, theme); }
   catch (error) { console.error(`FAIL navigation ${width} ${theme}: ${error.message}`); throw error; }
  }
 }));
 for (const result of completed) if (result.status === 'rejected') throw result.reason;
} catch (e) { await last?.screenshot({ path: '.context/pb-b/navigation-failure.png' }).catch(() => {}); throw e; }
finally { await writeFile('.context/pb-b/navigation-results.json', JSON.stringify(results,null,2)); await browser.close(); await new Promise(r => vite.httpServer.close(r)); }
console.log(`PASS navigation: ${results.length} route/size/theme cases in ${((Date.now() - started) / 1000).toFixed(1)}s`);
