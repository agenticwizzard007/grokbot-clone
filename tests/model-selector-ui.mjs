// Real selector components with controlled account catalogs; no provider authentication/inference.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import http from 'node:http';
const port = await new Promise(r=>{const s=http.createServer().listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
const origin=`http://127.0.0.1:${port}`;
const vite=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(port)],{cwd:`${process.cwd()}/web`,stdio:'pipe'});
let logs='';vite.stdout.on('data',d=>logs+=d);vite.stderr.on('data',d=>logs+=d);
let browser;
try {
 await mkdir('.context/model-fix',{recursive:true});
 for(let i=0;i<100;i++){if(await fetch(origin).then(r=>r.ok,()=>false))break;await new Promise(r=>setTimeout(r,100));}
 browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
 for(const width of [1440,390,320])for(const theme of ['light','dark']) {
  const page=await browser.newPage({viewport:{width,height:width===320?568:900},deviceScaleFactor:1});
  const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('BROWSER',e.message);});page.on('console',m=>{if(m.type()==='error')console.error(m.text());});
  let source='openrouter', unavailable=false;
  let bot={id:'model-test',name:'Quinn',model:'api/old',effort:'xhigh',fast:true};
  const patches=[];
  const catalog=()=>{
   const plan=source!=='openrouter';
   const id=plan?`${source}/account-special`:'api/old';
   const model={id,name:plan?'Account model':'API model',short:plan?'Account model':'API model',author:source==='claude'?'anthropic':'openai',efforts:['low','high'],defaultEffort:'low',vision:true,reasoning:true,context:0,billing:plan?'plan':'api',...(source==='claude'?{resolvedModel:'claude-account-special'}:{})};
   return {provider:plan?`${source}-cli`:source,billing:plan?'plan':'api',models:[model],favourites:[id],defaultModel:id,canFast:!plan,plan:plan?'max':null,usage:plan?{available:!unavailable,checkedAt:Date.now(),windows:unavailable?[]:[{label:'Weekly account window',usedPercent:39.2,resetsAt:1800000000000}]}:null};
  };
  await page.route('**/api/**',async route=>{
   const url=new URL(route.request().url());
   if(url.pathname==='/api/models')return route.fulfill({json:catalog()});
   if(url.pathname==='/api/bots/model-test') {const patch=route.request().postDataJSON();patches.push(patch);bot={...bot,...patch};return route.fulfill({json:{bot}});}
   if(url.pathname.includes('/models/icon/'))return route.fulfill({status:404});
   return route.fulfill({json:{}});
  });
  await page.route('**/src/main.tsx',route=>route.fulfill({contentType:'application/javascript',body:`
import React from '/node_modules/.vite/deps/react.js';
import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
const {createRoot}=ReactDOM;
import {ComposerModelMenu} from '/src/components/ComposerModelMenu.tsx';
import {useStore} from '/src/store.ts';
import {refreshModels} from '/src/components/config/ModelPicker.tsx';
import '/src/styles/tokens.css';import '/src/styles/base.css';import '/src/styles/composer-models.css';import '/src/styles/mobile.css';
document.documentElement.dataset.theme=${JSON.stringify(theme)};
useStore.setState({mobile:innerWidth<760,bots:[${JSON.stringify(bot)}]});
window.refreshModels=refreshModels;
function Harness(){const bot=useStore(s=>s.bots[0]);return React.createElement('div',{style:{position:'fixed',left:'16px',right:'16px',bottom:'24px',maxWidth:'500px'}},React.createElement(ComposerModelMenu,{bot}));}
createRoot(document.getElementById('root')).render(React.createElement(Harness));
` }));
  await page.goto(origin);
  await page.locator('.model-pill .model-billing').getByText('API',{exact:true}).waitFor();
  for(const provider of ['codex','claude']) {
   source=provider;await page.evaluate(()=>window.refreshModels());
   await page.locator('.model-pill .model-billing').getByText('Plan',{exact:true}).waitFor();
   await page.locator('.model-pill').click();
   await page.getByRole('dialog',{name:'Choose a model'}).waitFor();
   await page.locator('.mm-row__name').getByText('Account model',{exact:false}).waitFor();
   assert.equal(await page.locator('.mm-row__name').count(),1);
   assert.match(await page.locator('.mm-plan-usage').innerText(),/39\.2% used/);
   assert.equal(await page.getByText('API model',{exact:true}).count(),0);
   await page.locator('.mm-row__main').click();
   await page.waitForFunction(id=>document.querySelector('.model-pill__name')?.textContent==='Account model',`${provider}/account-special`);
   assert.equal(bot.model,`${provider}/account-special`);assert.equal(bot.effort,'high');assert.equal(bot.fast,false);
   await page.locator('.model-pill').click();
   await page.getByRole('button',{name:'Effort',exact:true}).click();
   const choices=await page.getByRole('option').allTextContents();
   assert.equal(choices.length,2);assert.ok(choices.some(x=>x.startsWith('High')));assert.ok(choices.some(x=>x.startsWith('Low')));assert.ok(choices.every(x=>!x.includes('Ultracode')));
   await page.keyboard.press('Escape');
   if(width>=760) await page.screenshot({path:`.context/model-fix/selector-${width}-${theme}-${provider}.png`});
   else await page.screenshot({path:`.context/model-fix/selector-${width}-${theme}-${provider}.png`});
   const over=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
   assert.equal(over,false,`${width} ${theme} overflow`);
   await page.keyboard.press('Escape');
  }
  unavailable=true;await page.locator('.model-pill').click();
  await page.getByText('Plan usage unavailable from the CLI.',{exact:true}).waitFor();
  assert.doesNotMatch(await page.locator('.mm-plan-usage').innerText(),/0% used/);
  await page.keyboard.press('Escape');source='openrouter';await page.evaluate(()=>window.refreshModels());
  await page.locator('.model-pill .model-billing').getByText('API',{exact:true}).waitFor();
  assert.equal(await page.locator('.model-pill__name').innerText(),'API model','returning to API mode shows its default, not the old CLI alias');
  assert.deepEqual(errors,[]);
  await page.close();console.log(`PASS ${width}px ${theme}: API/Plan switching, live catalog, correct PATCH, reported quota, supported efforts, unknown usage, no overflow`);
 }
 // Exercise Bot settings too: this path uses ModelPicker rather than ComposerModelMenu.
 for(const width of [1440,390,320])for(const theme of ['light','dark']) {
  const page=await browser.newPage({viewport:{width,height:width===320?568:900},deviceScaleFactor:1});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  let current='old', fail=false, holdNext=false, held=null, catalogRequests=0, explicitRequests=0;
  const catalog=(name=current, billing='plan')=>({billing,models:[{id:`${billing==='plan'?'codex':'api'}/${name}`,name:`Model ${name}`,billing,vision:true,reasoning:true,context:0,price:null}]});
  const until=async(check)=>{for(let i=0;i<100&&!check();i++)await new Promise(r=>setTimeout(r,25));assert.ok(check(),'expected held catalog request');};
  const settle=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  await page.route('**/api/**',async route=>{
   const url=new URL(route.request().url());
   if(url.pathname==='/api/cli')return route.fulfill({json:{selected:'codex',connected:true,providers:{codex:{installed:true,authenticated:true,subscription:true}}}});
   if(url.pathname==='/api/models') {
    catalogRequests++;
    if(holdNext){holdNext=false;held={route,data:catalog()};return;}
    return route.fulfill(fail?{status:503,json:{error:'Catalog temporarily unavailable'}}:{json:catalog()});
   }
   if(url.pathname==='/api/settings/models') {
    explicitRequests++;assert.equal(url.searchParams.get('provider'),'direct');
    return route.fulfill({json:catalog('explicit','api')});
   }
   return route.fulfill({json:{}});
  });
  await page.route('**/src/main.tsx',route=>route.fulfill({contentType:'application/javascript',body:`
import React from '/node_modules/.vite/deps/react.js';
import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
import {BotModelField} from '/src/components/config/BotModelField.tsx';
import {ModelPicker} from '/src/components/config/ModelPicker.tsx';
import {useStore} from '/src/store.ts';
import '/src/styles/tokens.css';import '/src/styles/base.css';import '/src/styles/config.css';import '/src/styles/composer-models.css';import '/src/styles/mobile.css';
document.documentElement.dataset.theme=${JSON.stringify(theme)};
useStore.setState({user:{id:'picker-alice'},mobile:innerWidth<760});
window.changes=[];window.changeAccount=()=>useStore.setState({user:{id:'picker-bob'}});
function Harness(){
 const [value,setValue]=React.useState('codex/old');const [explicit,setExplicit]=React.useState(false);
 window.showExplicit=()=>setExplicit(true);
 const onChange=v=>{window.changes.push(v);setValue(v);};
 return React.createElement('div',{className:'cfg-field',style:{position:'fixed',left:'16px',right:'16px',top:'24px',maxWidth:'500px'}},
  React.createElement('label',{className:'cfg-field__label'},'Bot model'),
  explicit?React.createElement(ModelPicker,{provider:'direct',value:null,onChange}):React.createElement(BotModelField,{value,onChange}));
}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Harness));
` }));
  await page.goto(origin);
  const button=page.getByRole('button',{name:'Bot model',exact:true});
  await page.locator('.model-picker__current').getByText('Model old',{exact:true}).waitFor();
  await button.click();await page.getByRole('option').filter({hasText:'Model old'}).waitFor();
  await page.keyboard.press('Escape');await settle();
  const before=catalogRequests;current='new';
  await button.click();await page.getByRole('option').filter({hasText:'Model new'}).waitFor();
  assert.equal(catalogRequests,before+1,'reopening fetches the active catalog again');
  assert.equal(await page.getByRole('option').filter({hasText:'Model old'}).count(),0,'removed model is gone');
  assert.equal(await page.locator('.model-picker__row .model-billing').innerText(),'Plan');
  await page.getByRole('option').filter({hasText:'Model new'}).click();
  assert.deepEqual(await page.evaluate(()=>window.changes),['codex/new']);

  // A transient catalog error must not stick for the lifetime of the page.
  fail=true;await button.click();await page.getByText('Could not load models.',{exact:true}).waitFor();
  assert.equal(await page.getByText('Add a model key in Settings → API keys first.',{exact:true}).count(),0);
  assert.equal(await page.locator('.model-picker__button .model-billing').count(),0,'unknown billing is not mislabeled API');
  await page.keyboard.press('Escape');fail=false;current='recovered';
  await button.click();await page.getByRole('option').filter({hasText:'Model recovered'}).waitFor();
  await page.keyboard.press('Escape');

  // An older request that finishes after reopening cannot replace the newer catalog.
  current='late';holdNext=true;held=null;
  await button.click();await until(()=>held!==null);await page.getByText('Loading models…',{exact:true}).waitFor();
  await page.keyboard.press('Escape');current='fresh';
  await button.click();await page.getByRole('option').filter({hasText:'Model fresh'}).waitFor();
  let response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/models');
  await held.route.fulfill({json:held.data});await response;await settle();
  assert.equal(await page.getByRole('option').filter({hasText:'Model late'}).count(),0);
  assert.equal(await page.getByRole('option').filter({hasText:'Model fresh'}).count(),1);
  await page.keyboard.press('Escape');

  // Account changes invalidate both the visible data and an outstanding request.
  current='alice-private';holdNext=true;held=null;
  await button.click();await until(()=>held!==null);current='bob-current';
  await page.evaluate(()=>window.changeAccount());
  await page.getByRole('option').filter({hasText:'Model bob-current'}).waitFor();
  response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/models');
  await held.route.fulfill({json:held.data});await response;await settle();
  assert.equal(await page.getByRole('option').filter({hasText:'Model alice-private'}).count(),0);
  assert.equal(await page.getByRole('option').filter({hasText:'Model bob-current'}).count(),1);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:`.context/model-fix/bot-selector-${width}-${theme}.png`});
  await page.keyboard.press('Escape');

  // API-key settings intentionally request their explicit provider, even with a Plan active.
  const activeBefore=catalogRequests;
  await page.evaluate(()=>window.showExplicit());
  await page.locator('.model-picker__button .model-billing').getByText('API',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Model',exact:true}).click();
  await page.getByRole('option').filter({hasText:'Model explicit'}).waitFor();
  assert.equal(await page.locator('.model-picker__row .model-billing').innerText(),'API');
  assert.equal(catalogRequests,activeBefore,'explicit API picker never fetches the Plan catalog');
  assert.equal(explicitRequests,2,'explicit API picker also refreshes on opening');
  assert.deepEqual(errors,[]);
  await page.close();console.log(`PASS Bot settings ${width}px ${theme}: fresh reopen, selection, failure recovery, response/account races, API/Plan labels, explicit provider, no overflow`);
 }
} finally {await browser?.close();vite.kill();await new Promise(r=>vite.exitCode!==null?r():vite.once('exit',r));}
