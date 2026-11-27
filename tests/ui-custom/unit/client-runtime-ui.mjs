import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { clientFixture, signedInPage, patch, style } from './client-fixture.mjs';
const output = path.resolve('.context/ui-custom/client-runtime'); fs.mkdirSync(output, { recursive: true });
const server = await clientFixture(), browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const results = [];
const pass = name => { results.push(name); console.log(`PASS ${name}`); };
const state = page => page.evaluate(async () => { const state = (await import('/src/customization/store.ts')).useCustomization.getState(); return { status: state.status, revision: state.revision, preview: state.preview?.id, mode: state.effective.theme.mode, safe: state.safe }; });
const waitStyle = (page, name, value) => page.waitForFunction(({name,value}) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() === value, {name,value});
try {
  const { page, context } = await signedInPage(browser, server);
  const errors=[]; page.on('pageerror', error => errors.push(error.message));
  assert.equal((await state(page)).revision,0); assert.equal(await style(page,'--color-primary'),'#3043AB');pass('default config performs no migration write');
  await patch(page,[
    {op:'replace',path:'/theme/mode',value:'dark'},
    {op:'add',path:'/theme/colors/light/primary',value:'#0F766E'},
    {op:'add',path:'/theme/colors/dark/primary',value:'#5EEAD4'},
    {op:'add',path:'/theme/colors/dark/pane',value:'#142831'},
    {op:'replace',path:'/theme/font/ui',value:'serif'},
    {op:'replace',path:'/theme/font/scale',value:'xlarge'},
    {op:'replace',path:'/theme/density',value:'comfortable'},
    {op:'replace',path:'/theme/radius',value:'round'},
    {op:'replace',path:'/theme/motion',value:'reduced'},
    {op:'replace',path:'/layout/sidebar/width',value:'wide'},
    {op:'replace',path:'/layout/chat/width',value:'wide'},
  ]);
  for(const [name,value] of Object.entries({'--color-primary':'#5EEAD4','--font-scale':'1.25','--control-h':'48px','--stack-gap':'24px','--card-pad':'24px','--radius-card':'20px','--ui-sidebar-width':'320px','--ui-content-width':'920px'}))assert.equal(await style(page,name),value,name);
  assert.match(await style(page,'--font-stack'),/^Georgia/);assert.equal(await page.locator('html').getAttribute('data-motion'),'reduced');pass('API changes seeds font scale density radius motion and layout widths without reload');
  await patch(page,[{op:'add',path:'/theme/overrides/dark/hover',value:'#283A50'},{op:'replace',path:'/theme/contrast',value:'high'}]);
  assert.equal(await style(page,'--color-bg-hover'),'#283A50');assert.equal(await page.locator('html').getAttribute('data-contrast'),'high');pass('derived override and high contrast apply');
  await page.emulateMedia({forcedColors:'active'});await page.waitForFunction(()=>!document.documentElement.style.getPropertyValue('--color-primary'));assert.equal(await style(page,'--font-scale'),'1.25');await page.emulateMedia({forcedColors:'none'});await waitStyle(page,'--color-primary','#5EEAD4');pass('forced colors remove only customized colors');
  const second=await signedInPage(browser,server);const syncStart=performance.now();
  await patch(page,[{op:'replace',path:'/theme/radius',value:'sharp'}]);await waitStyle(second.page,'--radius-card','6px');const syncMs=performance.now()-syncStart;assert.ok(syncMs<2000,`Sync ${syncMs}ms`);pass(`independent tabs converge via SSE in ${Math.round(syncMs)}ms`);
  await page.route('**/api/ui/config',route=>route.abort());await page.reload();await page.locator('.shell-header').waitFor();await page.waitForFunction(async()=>(await import('/src/customization/store.ts')).useCustomization.getState().status==='offline');assert.equal(await style(page,'--font-scale'),'1.25');pass('offline config fetch preserves cached appearance and first render');await page.unroute('**/api/ui/config');
  await page.addInitScript(()=>{window.__firstAppearance=null;const record=()=>{if(document.body){const style=getComputedStyle(document.documentElement);window.__firstAppearance={pane:style.getPropertyValue('--color-bg-pane').trim(),font:style.getPropertyValue('--font-stack').trim(),scale:style.getPropertyValue('--font-scale').trim()};}else requestAnimationFrame(record);};requestAnimationFrame(record);});
  // Keep React from running until the classic boot script has painted.
  await page.route('**/src/main.tsx',async route=>{await new Promise(resolve=>setTimeout(resolve,150));await route.continue();});await page.reload();await page.locator('.shell-header').waitFor();
  const first=await page.evaluate(()=>window.__firstAppearance);assert.equal(first.pane,'#142831');assert.match(first.font,/Georgia/);assert.equal(first.scale,'1.25');await page.unroute('**/src/main.tsx');pass('first animation frame already has cached custom background font and scale');
  await page.goto(`${server.base}/#bot/${server.fixture.bot.id}`);await page.locator('.composer__input:not([disabled])').waitFor();
  const before=await style(page,'--font-stack');await server.preview([{op:'replace',path:'/theme/font/ui',value:'mono'}],'Readable preview');
  const banner=page.getByRole('status',{name:'Appearance preview'});await banner.waitFor();await waitStyle(page,'--font-stack','ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace');assert.equal(await second.page.getByRole('status',{name:'Appearance preview'}).count(),0);pass('real preview SSE applies only to the matching conversation');
  await banner.getByRole('button',{name:'Show before',exact:true}).focus();await page.keyboard.press('Enter');await banner.getByRole('button',{name:'Show before',exact:true}).and(page.locator('[aria-pressed="true"]')).waitFor();await waitStyle(page,'--font-stack',before);await page.keyboard.press('Enter');await waitStyle(page,'--font-stack','ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace');pass('keyboard Show before toggles saved and preview appearances');
  await banner.getByRole('button',{name:'Discard',exact:true}).click();await banner.waitFor({state:'hidden'});assert.equal(await style(page,'--font-stack'),before);pass('Discard reverts preview');
  await server.preview([{op:'replace',path:'/theme/font/ui',value:'mono'}]);await banner.waitFor();await page.reload();await page.locator('.composer__input:not([disabled])').waitFor();assert.equal(await banner.count(),0);assert.equal(await style(page,'--font-stack'),before);pass('reload drops previews');
  await page.clock.install();await server.preview([{op:'replace',path:'/theme/font/ui',value:'mono'}]);await banner.waitFor();await page.clock.fastForward(15*60_000+1);await banner.waitFor({state:'hidden'});assert.equal(await style(page,'--font-stack'),before);pass('15 minute expiry reverts preview');await page.clock.setSystemTime(new Date());
  await server.preview([{op:'replace',path:'/theme/font/ui',value:'mono'}]);await banner.waitFor();await banner.getByRole('button',{name:'Apply',exact:true}).click();await banner.waitFor({state:'hidden'});assert.match(await style(page,'--font-stack'),/^ui-monospace/);await page.getByRole('status',{name:'Appearance updated'}).getByRole('button',{name:'Undo',exact:true}).click();await waitStyle(page,'--font-stack',before);pass('Apply persists and Undo restores the previous revision');
  await page.keyboard.press('Control+Alt+0');await page.getByRole('status',{name:'Appearance recovery'}).waitFor();assert.equal((await state(page)).safe,true);assert.equal(await style(page,'--font-scale'),'1');pass('reserved keyboard chord opens safe mode');
  await page.goto(`${server.base}/?ui=safe#bots`);await page.getByRole('status',{name:'Appearance recovery'}).waitFor();assert.equal(await style(page,'--font-scale'),'1');await page.getByRole('button',{name:'Reset',exact:true}).click();await page.getByRole('button',{name:'Confirm reset',exact:true}).click();await page.getByRole('status',{name:'Appearance recovery'}).waitFor({state:'hidden'});assert.equal(await style(page,'--font-scale'),'1');pass('safe URL persists for the tab and confirmed Reset recovers');
  await patch(page,[{op:'replace',path:'/theme/density',value:'compact'},{op:'add',path:'/device',value:{phone:{scale:'xlarge'}}}]);await page.setViewportSize({width:390,height:844});await waitStyle(page,'--control-h','44px');assert.equal(await style(page,'--font-scale'),'1.25');pass('phone overlay scales text and enforces the 44px floor');
  const fontRequests=[];page.on('request',request=>{if(request.url().includes('/fonts/'))fontRequests.push(request.url());});await patch(page,[{op:'replace',path:'/theme/font/ui',value:'atkinson'}]);await page.evaluate(()=>document.fonts.ready);assert.ok(await page.evaluate(()=>document.fonts.check('14px "Atkinson Hyperlegible"')));assert.ok(fontRequests.length>0&&fontRequests.every(url=>new URL(url).origin===new URL(server.base).origin));pass('Atkinson loads only on selection from same-origin WOFF2');
  server.db.prepare('UPDATE ui_config SET doc=? WHERE user_id=?').run('{"version":99}', server.fixture.userId);
  await page.reload();await page.getByRole('status',{name:'Appearance recovery'}).waitFor();assert.equal(await style(page,'--font-scale'),'1');
  await page.getByRole('button',{name:'Reset',exact:true}).click();await page.getByRole('button',{name:'Confirm reset',exact:true}).click();await page.getByRole('status',{name:'Appearance recovery'}).waitFor({state:'hidden'});pass('corrupt stored config replaces a same-revision cache with defaults and recovery');
  await page.goto(`${server.base}/#bot/${server.fixture.bot.id}`);await page.locator('.composer__input:not([disabled])').waitFor();await server.preview([{op:'replace',path:'/theme/font/ui',value:'mono'}]);await banner.waitFor();await page.evaluate(async()=>{const {useStore}=await import('/src/store.ts');useStore.setState({user:null,authChecked:true});});await banner.waitFor({state:'hidden'});assert.equal(await page.evaluate(()=>localStorage.getItem('swarm.ui.v1')),null);pass('sign out drops previews and clears the account cache');
  await context.close();await second.context.close();
  // A fresh seeded identity with a legacy preference migrates once.
  const migrationContext=await browser.newContext({viewport:{width:1280,height:900}});const migrationPage=await migrationContext.newPage();
  const login=await migrationPage.request.post(`${server.base}/api/auth/dev`,{data:{email:'qa-temp-migration@example.test',name:'QA-Temp-Migration'}});assert.equal(login.status(),200);
  await migrationContext.addInitScript(()=>localStorage.setItem('swarm.theme','dark'));await migrationPage.goto(server.base+'/#bots');await migrationPage.waitForFunction(async()=>(await import('/src/customization/store.ts')).useCustomization.getState().revision===1);await migrationPage.reload();await migrationPage.locator('.shell-header').waitFor();assert.equal((await state(migrationPage)).revision,1);pass('nondefault legacy theme migrates once per account');await migrationContext.close();
  assert.deepEqual(errors,[]);pass('no browser runtime errors');
} finally { await browser.close();await server.close();fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({passed:results.length,tests:results},null,2)); }
console.log(`Client runtime browser: ${results.length}/${results.length} passed`);
