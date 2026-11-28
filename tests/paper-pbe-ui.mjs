// Paper v3 PB-E matrix. All accounts, calls and mutations are local fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { build, preview } from '../web/node_modules/vite/dist/node/index.js';
import { chromium } from 'playwright';
import { inspectAlignment } from './layout-alignment-ui.mjs';
const outDir=path.resolve(process.env.PBE_DIST || process.env.PBE_BUILD_DIR || '.context/pb-e/dist');
if (!process.env.PBE_DIST) await build({ root: path.resolve('web'), build: { outDir, emptyOutDir: true }, plugins: [{ name: 'pbe-local-fixtures', enforce: 'pre', transform(code, id) {
  if (id.endsWith('/voice/call.ts')) return code + '\nwindow.__pbeVoice = useVoice;';
  if (id.endsWith('/src/store.ts')) return code + '\nwindow.__pbeStore = useStore;';
} }] });
const vite=await preview({root:path.resolve('web'),build:{outDir},preview:{host:'127.0.0.1',port:0}});
process.env.UI_ORIGIN=`http://127.0.0.1:${vite.httpServer.address().port}`;
const {pbeFixture}=await import('./paper-pbe-fixture.mjs');
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']});
const evidence=process.env.PBE_EVIDENCE || 'docs/design/paper/build/pb-e';
fs.mkdirSync(evidence,{recursive:true});fs.mkdirSync('.context/pb-e',{recursive:true});
const widths=(process.env.PBE_WIDTHS || '320,390,500,768,1280').split(',').map(Number);
const themes=(process.env.PBE_THEMES || 'light,dark').split(',');
const routes={ 'chat-rest':'#bot/coordinator','chat-run':'#bot/coordinator','chat-voice':'#bot/coordinator',loading:'#bot/coordinator',empty:'#bot/coordinator',error:'#bot/coordinator',tasks:'#tasks',team:'#team',goals:'#goals',files:'#reports',search:'#search',landing:'', 'signin-code':'', 'first-run':'#first-run', join:'join/pbe-fixture'};
const screenshots=['chat-rest','chat-run','empty','error','tasks','search','landing'];
const results=[];
// BUILD-SPEC 0b budgets, desktop then phone. Fixture message content is retained.
// Tasks now includes visible next actions, update times, and explicit status filters.
const budgets = { 'chat-rest': [72,64], 'chat-run': [82,74], 'chat-voice': [78,71], loading: [15,12], empty: [35,27], error: [56,53], tasks: [64,56], team: [35,29], goals: [20,14], files: [41,38], search: [117,44], landing: [34,32], 'signin-code': [34,32], 'first-run': [33,37], join: [11,11] };

function inspectLabels() {
 const root=document.querySelector('.shell-content') || document.querySelector('main');
 const issues=[];
 for(const el of root.querySelectorAll('button, label, h1, h2, h3, p, span, a, input, .provider-icon')) {
  if(!el.checkVisibility()||el.closest('[hidden],.phone-tabs,.sr-only'))continue;
  const r=el.getBoundingClientRect(); if(r.width<1||r.height<1)continue;
  const name=(el.innerText||el.getAttribute('aria-label')||el.tagName).trim().slice(0,60);
  if([...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && !el.matches('input') && el.clientWidth && el.scrollWidth>el.clientWidth+1) issues.push(`Clipped label: ${name}`);
  if(el.matches('.provider-icon')) {const p=el.parentElement.getBoundingClientRect();if(Math.abs(r.width-16)>1||Math.abs(r.height-16)>1||r.left<p.left-1||r.right>p.right+1||r.top<p.top-1||r.bottom>p.bottom+1)issues.push(`Provider slot: ${name}`);}
  for(const node of el.childNodes) {
   if(node.nodeType!==Node.TEXT_NODE)continue;
   for(const match of node.textContent.matchAll(/\S+/g)) {
    const range=document.createRange();range.setStart(node,match.index);range.setEnd(node,match.index+match[0].length);
    const rects=[...range.getClientRects()];if(rects.length>1&&rects.some(r=>Math.abs(r.top-rects[0].top)>2))issues.push(`Split word: ${match[0]}`);
   }
  }
 }
 return [...new Set(issues)];
}
try {
for(const width of widths)for(const theme of themes) {
 const f=await pbeFixture(browser,width,theme);const {page,state,errors}=f;
 for(const [name,hash] of Object.entries(routes)) {
  if(process.env.PBE_SCREENS&&!process.env.PBE_SCREENS.split(',').includes(name))continue;
  state.screen=name;
  await page.goto('about:blank');await page.goto(process.env.UI_ORIGIN+'/'+hash);
  await page.locator(['landing','signin-code'].includes(name)?'.signin':name==='join'?'.join':'.shell-header').waitFor();
  await page.waitForTimeout(500);
  if(name==='chat-voice') await page.evaluate(() => window.__pbeVoice.setState({status:'live',botId:'coordinator',callId:'fixture',startedAt:Date.now(),listening:true}));
  if(name==='error') { await page.evaluate(() => window.__pbeStore.setState({sseConnected:false})); await page.getByText('Connection lost',{exact:true}).waitFor(); }
  if(name==='chat-run') await page.getByRole('button',{name:/Run log/}).click();
  if(name==='search') {await page.getByRole('textbox',{name:'Search',exact:true}).fill('launch');await page.waitForTimeout(450);}
  if(name==='signin-code') {await page.locator('input[type=tel]').fill('+15555550123');await page.getByRole('button',{name:'Continue with phone'}).click();await page.getByRole('textbox',{name:'6-digit code'}).evaluate(input => { const clipboardData = new DataTransfer(); clipboardData.setData('text','481 900'); input.dispatchEvent(new ClipboardEvent('paste',{clipboardData,bubbles:true,cancelable:true})); }); assert.equal(await page.getByRole('textbox',{name:'6-digit code'}).inputValue(),'481900');await page.getByRole('button',{name:'Verify',exact:true}).click();await page.getByRole('alert').waitFor();}
  if(name==='chat-rest' || name==='chat-run') await page.locator('.transcript').evaluate(el => { el.scrollTop=el.scrollHeight; });
  const alignment=await page.evaluate(inspectAlignment,{});
  const labels=await page.evaluate(inspectLabels);
  const words=await page.evaluate(()=>{const root=document.querySelector('.shell-content')||document.querySelector('main');const text=[...root.querySelectorAll('*')].filter(el=>el.checkVisibility()&&!el.closest('.phone-tabs,.sr-only,[hidden]')).flatMap(el=>[...el.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent));return text.join(' ').trim().split(/\s+/).filter(Boolean).length;});
  if(name.startsWith('chat') || name==='empty' || name==='error') {
    const column=await page.locator('.transcript__col').boundingBox(),dock=await page.locator('.composer').boundingBox();
    assert.ok(Math.abs(column.x-dock.x)<=1&&Math.abs(column.width-dock.width)<=1,'Thread and dock share both edges');
  }
  if(name==='tasks') assert.equal(await page.locator('.task-column').count(),3,'Three real task states, with pending work first');
  if(name==='search') { await page.getByText('Files and tasks',{exact:true}).waitFor(); assert.equal(await page.getByRole('option').count(),4); const list = await page.locator('.search-modal__results').boundingBox(); const last = await page.getByRole('option').last().boundingBox(); assert.ok(list.height >= 300 && last.y + last.height <= list.y + list.height + 1, 'Search results are visible inside the panel'); }
  // PB-F restores the approved six-word waiting-task notice and Review action.
  const waitingCopy = name === 'tasks' && await page.getByTestId('tasks-needs-input').isVisible() ? 6 : 0;
  if ([390,1280].includes(width)) assert.ok(words <= budgets[name][width === 1280 ? 0 : 1] + waitingCopy, `${name} copy stays within the Paper budget: ${words} words`);
  results.push({name,width,theme,words,alignment,labels});
  console.log(`${alignment.length||labels.length?'FAIL':'PASS'} ${name} ${width} ${theme}: ${words} words`,alignment,labels);
  if(screenshots.includes(name)&&([390,1280].includes(width)||(width===320&&theme==='light')))await page.screenshot({path:`${evidence}/${name}-${width}-${theme}.png`});
  if(name==='search') {
    state.longFile = 'launch' + 'Long'.repeat(30) + '.md';
    await page.reload();
    await page.getByRole('textbox',{name:'Search',exact:true}).fill('launch');
    await page.getByText('Saved file',{exact:true}).waitFor();
    assert.equal(await page.getByRole('option',{name:new RegExp(state.longFile)}).count(),1,'Full filename remains accessible');
    assert.deepEqual(await page.evaluate(inspectLabels),[],'Long search labels fit without splitting words');
    assert.deepEqual(await page.evaluate(inspectAlignment,{}),[],'Long search labels retain alignment');
    state.longFile = null;
    await page.reload();
    await page.getByRole('textbox',{name:'Search',exact:true}).fill('launch');
    await page.getByText('Launch plan.md',{exact:true}).waitFor();
  }
  if(width===390&&theme==='light') {
    if(name==='chat-run') { await page.getByRole('button',{name:"Don't allow",exact:true}).click(); await page.locator('.card__outcome.is-denied').waitFor(); assert.ok(state.denied);
      for (const [label, decision] of [['Allow','allow'],['Always allow','always']]) {
        state.denied = false;
        await page.reload();
        await page.getByRole('button',{name:label,exact:true}).click();
        await page.locator('.card__outcome').waitFor();
        assert.equal(state.decision, decision);
      }
    }
    if(name==='signin-code') { assert.equal(await page.getByRole('button',{name:'Back',exact:true}).count(),1); await page.getByRole('button',{name:'Back',exact:true}).click(); await page.locator('input[type=tel]').waitFor(); }
    if(name==='search') {
      await page.getByRole('option').filter({hasText:'Launch plan.md'}).click();
      await page.waitForURL(/\/#bot\/coordinator~[^/]+\/reports$/);
      await page.goto(process.env.UI_ORIGIN+'/#search');
      await page.getByRole('textbox',{name:'Search',exact:true}).fill('launch');
      await page.getByRole('option').filter({hasText:'Draft launch note'}).click();
      await page.waitForURL(/\/#bot\/coordinator~[^/]+\/tasks$/); await page.waitForFunction(() => document.querySelector('.tasks-bot-filter')?.value === 'coordinator');
    }
    if(name==='empty') { await page.getByRole('button',{name:'Plan my day',exact:true}).click(); assert.equal(await page.locator('.composer__input').inputValue(),'Plan my day'); }
    if(name==='error') { await page.getByRole('button',{name:'Retry',exact:true}).click(); await page.getByRole('button',{name:'Retried',exact:true}).waitFor(); assert.ok(state.retry); }
    if(name==='first-run') { await page.getByRole('button',{name:/ChatGPT plan/}).click(); await page.getByRole('button',{name:'Continue',exact:true}).click(); await page.waitForURL('**/#settings/subscriptions'); }
  }
 }
 assert.deepEqual(errors,[],'No browser errors or external requests');await page.close();
}
}finally{await browser.close();await vite.close();fs.writeFileSync(process.env.PBE_REPORT || '.context/pb-e/matrix.json',JSON.stringify(results,null,2));}
assert.equal(results.filter(r=>r.alignment.length||r.labels.length).length,0,'Every PB-E screen meets layout and label rules');
console.log(`${results.length} PB-E screen checks passed`);
