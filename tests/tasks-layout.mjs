// Paper v3 Tasks behavior and layout against local API fixtures.
// The approved Open/Done/All control replaces the earlier three-state toolbar.
import assert from 'node:assert/strict';
import path from 'node:path';
import { preview } from '../web/node_modules/vite/dist/node/index.js';
import { chromium } from 'playwright';
const vite=await preview({root:path.resolve('web'),preview:{host:'127.0.0.1',port:0}});
process.env.UI_ORIGIN=`http://127.0.0.1:${vite.httpServer.address().port}`;
const {shellFixture}=await import('./paper-shell-fixture.mjs');
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']});
try {
 for(const width of [320,390,500,768,1280])for(const theme of ['light','dark']) {
  const {page,fixture,errors}=await shellFixture(browser,width,theme);
  const original=fixture.respond,now=Date.now();
  let tasks=[
   {id:'older',botId:'research-bot',title:'Review launch plan',state:'needs_input',note:'',updatedAt:now-60000},
   {id:'newer',botId:'coordinator',title:'Approve checklist',state:'needs_input',note:'',updatedAt:now},
   {id:'active',botId:'coordinator',title:'Draft launch note',state:'working',note:'',updatedAt:now},
   {id:'done',botId:'research-bot',title:'Collect references',state:'done',note:'',updatedAt:now},
  ],failing=false;
  fixture.respond=args=>{
   if(args.path.endsWith('/tasks'))return failing?{status:503,json:{error:'Unavailable'}}:{json:{tasks:args.path.includes('/bots/')?tasks.filter(t=>t.botId===args.path.split('/')[3]):tasks}};
   return original(args);
  };
  const changed=()=>page.evaluate(()=>window.dispatchEvent(new CustomEvent('swarm:event',{detail:{type:'tasks',botId:'coordinator'}})));
  const work=page.locator('.tasks-view');
  const filter=name=>work.locator('.task-filters').getByRole('button',{name:new RegExp(`^${name}`)});
  const fits=async()=>assert.ok(await work.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'No horizontal overflow');
  await page.goto(process.env.UI_ORIGIN+'/#tasks');await work.getByText('Review launch plan',{exact:true}).waitFor();
  assert.equal(await work.locator('.task-card').count(),4);
  assert.equal(await work.locator('.task-column.is-needs_input .task-card__title').first().innerText(),'Review launch plan','Oldest pending task first');
  if(width>760)assert.equal(await work.locator('.task-column').count(),4);
  await fits();
  await filter('Open').click();assert.equal(await work.locator('.task-card').count(),3);
  await work.locator('.task-column.is-needs_input').getByRole('button',{name:/Blocked/}).click();
  assert.equal(await work.locator('.task-card').count(),2);
  await work.getByRole('combobox',{name:'Filter tasks by bot'}).selectOption('coordinator');
  await page.waitForFunction(()=>document.querySelectorAll('.task-card').length===1);
  await filter('Done').click();await work.getByRole('heading',{name:'Nothing finished yet'}).waitFor();
  await filter('All').click();assert.equal(await work.locator('.task-card').count(),2,'Resetting state preserves Bot scope');
  await work.getByRole('combobox',{name:'Filter tasks by bot'}).selectOption('all');
  await page.waitForFunction(()=>document.querySelectorAll('.task-card').length===4);
  await work.locator('.task-column.is-needs_input').getByRole('button',{name:/Blocked/}).click();
  tasks[1].state='done';await changed();await page.waitForFunction(()=>document.querySelectorAll('.task-card').length===1);
  failing=true;await changed();await work.getByRole('alert').waitFor();
  assert.equal(await work.locator('.task-card').count(),1,'Stale cards remain actionable');
  failing=false;await work.getByRole('button',{name:'Retry',exact:true}).click();await work.getByRole('alert').waitFor({state:'hidden'});
  await work.locator('.task-card').focus();await page.keyboard.press('Enter');await page.locator('.composer__input').waitFor();
  assert.equal(await page.locator('.chat__pill-name').innerText(),'Research Bot','Keyboard action opens the owner');
  await page.goto(process.env.UI_ORIGIN+'/#tasks');await work.locator('.task-card').waitFor();
  tasks=[];await changed();await work.getByRole('heading',{name:'No pending tasks'}).waitFor();
  await filter('All').click();await work.getByRole('heading',{name:'No tasks yet'}).waitFor();
  tasks=[{id:'orphan',botId:'missing',title:'Unavailable teammate',state:'working',note:'',updatedAt:now},{id:'long',botId:'coordinator',title:'Reference '+ 'identifier'.repeat(12),state:'working',note:'',updatedAt:now}];
  await changed();await work.getByRole('button',{name:/Unavailable teammate/}).waitFor();
  assert.ok(await work.getByRole('button',{name:/Unavailable teammate/}).isDisabled());
  const long=work.getByRole('button',{name:/Reference identifier/});
  assert.equal(await long.locator('.task-card__title').innerText(),'Task details','Oversized identifiers use a complete label');
  assert.ok((await long.getAttribute('title')).includes(tasks[1].title),'Full title is available');await fits();
  const tabs=work.getByRole('navigation',{name:'Work sections'});
  const tabRect=await tabs.boundingBox();
  for(const tab of ['Team','Goals','Files','Tasks']) {
   await tabs.getByRole('button',{name:tab,exact:true}).click();
   await work.getByRole('heading',{name:tab,exact:true}).first().waitFor();
   const current=await tabs.boundingBox();assert.ok(Math.abs(current.x-tabRect.x)<=1&&Math.abs(current.y-tabRect.y)<=1&&Math.abs(current.width-tabRect.width)<=1,'Tabs keep their position');
  }
  await work.getByRole('button',{name:'Add task',exact:true}).click();await page.locator('.composer__input').waitFor();
  assert.match(await page.locator('.composer__input').inputValue(),/Create a task:/,'Add task opens a draft without sending');
  assert.deepEqual(errors,[]);await page.close();console.log(`PASS Tasks ${width} ${theme}: filters, scope, ordering, updates, stale data, retry, keyboard, empty state, long identifiers, tabs and add task`);
 }
}finally{await browser.close();await vite.close();}
