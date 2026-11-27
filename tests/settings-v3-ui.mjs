// Local seeded Settings geometry, copy and navigation matrix.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { layoutServer } from './layout-fixture.mjs';
import { inspectAlignment } from './layout-alignment-ui.mjs';
import { readableWords } from './paper-label-geometry.mjs';
import { boxFullyVisible } from './ui-box-assertions.mjs';
const sections = (process.env.SETTINGS_SECTIONS || 'general,subscriptions,keys,usage,permissions,apps,account,computer,messaging,mcp,learning').split(',');
const server = await layoutServer();
const browser = await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']});
const out = 'docs/design/paper/build/pb-c'; fs.mkdirSync(out,{recursive:true});fs.mkdirSync('.context/settings-v3',{recursive:true});
const report=[];
try {
for(const width of (process.env.SETTINGS_WIDTHS || '320,390,500,768,1280').split(',').map(Number)) for(const theme of ['light','dark']) {
 const context=await browser.newContext({viewport:{width,height:width<=760?844:900},reducedMotion:'reduce'});
 await context.addCookies([{name:'swarm_session',value:'layout-test-token',url:server.base}]);
 await context.addInitScript(theme=>{if(location.origin==='null') return;localStorage.setItem('swarm.theme',theme); localStorage.setItem('swarm.sidebarCollapsed','0');},theme);
 const page=await context.newPage(); page.setDefaultTimeout(15000);
 for(const section of sections) {
  const issues=[]; const errors=[]; const onError=e=>errors.push(e.message); page.on('pageerror',onError);
  let counts;
  try {
   await page.goto('about:blank');await page.goto(server.base+'/#settings/'+section);
   const surface=page.locator('.app-settings__page'); await surface.waitFor(); await page.waitForTimeout(700);
   if(['subscriptions','usage'].includes(section)) await page.waitForFunction(() => ![...document.querySelectorAll('.app-settings__page .cfg-chip')].some(el => el.textContent.trim() === 'Checking'));
   issues.push(...await page.evaluate(inspectAlignment,{selector:'.app-settings'}));
   try { await readableWords(surface); } catch(e) {issues.push(e.message);}
   for(const logo of await surface.locator('.provider-icon').all()) if(await logo.isVisible()) { try {await boxFullyVisible(logo,{width:16,height:16});}catch(e){issues.push(e.message);}}
   if(width<=760) assert.equal(await page.locator('button[aria-label="Back"]:not([inert] *)').count(),1,'one phone Back');
   else assert.equal(await page.locator('.sidebar').isVisible(),true,'desktop sidebar stays reachable');
   counts=await page.evaluate(()=>{
    const words=t=>t.trim().split(/\s+/).filter(Boolean).length;
    const main=document.querySelector('.shell-content').cloneNode(true);
    main.querySelectorAll('.phone-tabs,.sr-only').forEach(e=>e.remove());
    const visibleText=root=>{let text='';const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);for(let n=walker.nextNode();n;n=walker.nextNode()){if(n.parentElement.checkVisibility()&&!n.parentElement.closest('.sr-only,.phone-tabs'))text+=' '+n.textContent;}return text;};
    return {page:words(visibleText(document.querySelector('.app-settings__page'))),main:words(visibleText(document.querySelector('.shell-content')))};
   });
   await page.locator('.app-settings__main').evaluate(el=>el.scrollTop=0);
   if([320,390,1280].includes(width)) await page.screenshot({path:`${out}/after-${section}-${width}-${theme}.png`});
   const checkState = async (name, scope=surface) => {
    issues.push(...(await page.evaluate(inspectAlignment,{selector:'.app-settings, .settings-connect-sheet'})).map(issue=>`${name}: ${issue}`));
    try {await readableWords(scope);}catch(e){issues.push(`${name}: ${e.message}`);}
    for(const logo of await scope.locator('.provider-icon').all()) if(await logo.isVisible()) {try{await boxFullyVisible(logo,{width:16,height:16});}catch(e){issues.push(`${name}: ${e.message}`);}}
    if(width<=760)assert.equal(await page.locator('button[aria-label="Back"]:not([inert] *)').count(),1,`${name}: one Back`);
   };
   for(const info of await surface.locator('.settings-info__button').all()) {
    if(!await info.isVisible()) continue;
    await info.focus(); await surface.getByRole('tooltip').waitFor(); await checkState('Info');
    await info.press('Escape'); assert.equal(await surface.getByRole('tooltip').count(),0);
   }
   if(section==='general') {await surface.getByRole('button',{name:'View',exact:true}).click();await checkState('Shortcuts');}
   if(section==='subscriptions') {
    await surface.getByRole('button',{name:'Paste key',exact:true}).click();await checkState('Paste key');
    assert.equal(await surface.getByLabel('OpenRouter API key',{exact:true}).getAttribute('type'),'password');
    await surface.getByRole('button',{name:'Cancel',exact:true}).click();
    await surface.locator('[data-layout="row"][data-provider="claude"]').getByRole('button',{name:'Connect',exact:true}).click();
    const sheet=page.getByRole('dialog',{name:'Connect Claude',exact:true});await checkState('Connect sheet',sheet);
    await sheet.locator('summary').filter({hasText:'Learn more'}).click();await checkState('Plan details',sheet);
    await sheet.getByRole('button',{name:'Close',exact:true}).click();
   }
   if(section==='keys') {await surface.locator('.openrouter-settings').getByRole('button',{name:'Add key',exact:true}).click();await checkState('Add API key');}
   if(section==='learning') {await surface.locator('summary').filter({hasText:'Review limits'}).click();await checkState('Review limits');}
   if(section==='mcp') {await surface.getByRole('button',{name:'Add MCP server',exact:true}).click();await checkState('Add MCP server');}

  } catch(e) {issues.push(e.message);}
  page.off('pageerror',onError);issues.push(...errors);
  report.push({section,width,theme,...counts,issues});fs.writeFileSync('.context/settings-v3/report.json',JSON.stringify(report,null,2));console.log(`${issues.length?'FAIL':'PASS'} ${section} ${width} ${theme}: ${issues.length}`);
 }
 await context.close();
}
}finally{await browser.close();await server.close();}
fs.writeFileSync('.context/settings-v3/report.json',JSON.stringify(report,null,2));
const oldCounts = fs.existsSync(`${out}/after-word-counts.json`) ? JSON.parse(fs.readFileSync(`${out}/after-word-counts.json`,'utf8')) : [];
const refreshed = report.map(({issues,...row})=>row);
fs.writeFileSync(`${out}/after-word-counts.json`,JSON.stringify([...oldCounts.filter(old => !refreshed.some(row => row.section===old.section && row.width===old.width && row.theme===old.theme)),...refreshed],null,2));
assert.equal(report.filter(row=>row.issues.length).length,0,JSON.stringify(report.filter(row=>row.issues.length),null,2));
console.log(`${report.length} Settings views passed`);
