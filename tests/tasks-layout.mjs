// Refined Paper Tasks: real status groups, search, owner scope, and responsive navigation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { preview } from '../web/node_modules/vite/dist/node/index.js';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
const vite=await preview({root:path.resolve('web'),preview:{host:'127.0.0.1',port:0}});
process.env.UI_ORIGIN=`http://127.0.0.1:${vite.httpServer.address().port}`;
const {shellFixture}=await import('./paper-shell-fixture.mjs');
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']});
fs.mkdirSync('.context/tasks-refined', { recursive: true });
try {
 for(const width of [320,390,500,768,1280,1440])for(const theme of ['light','dark']) {
  const {page,fixture,errors}=await shellFixture({newPage:async options=>(await browser.newContext(options)).newPage()},width,theme);
  const original=fixture.respond,now=Date.now();
  let tasks=[
   {id:'older',botId:'research-bot',title:'Review launch plan',state:'needs_input',note:'',updatedAt:now-60000},
   {id:'newer',botId:'coordinator',title:'Approve checklist',state:'needs_input',note:'',updatedAt:now},
   {id:'active',botId:'coordinator',title:'Draft launch note',state:'working',note:'',updatedAt:now},
   {id:'done',botId:'research-bot',title:'Collect references',state:'done',note:'',updatedAt:now},
  ],failing=false, attentionFailing=false, items=[], handoffsEnabled=false;
  fixture.respond=args=>{
   if(args.path.endsWith('/tasks'))return failing?{status:503,json:{error:'Unavailable'}}:{json:{tasks:args.path.includes('/bots/')?tasks.filter(t=>t.botId===args.path.split('/')[3]):tasks}};
   if(args.path==='/api/needs-you')return attentionFailing?{status:503,json:{error:'Unavailable'}}:{json:{items}};
   if(args.path==='/api/handoff-settings')return {json:{settings:{enabled:handoffsEnabled}}};
   if(args.path==='/api/handoff-task-links')return {json:{links:{done:{kind:'loop',loopId:'fixture-loop'}}}};
   if(args.path==='/api/handoff-links')return {json:{links:[]}};
   return original(args);
  };
  const changed=()=>page.evaluate(()=>window.dispatchEvent(new CustomEvent('swarm:event',{detail:{type:'tasks',botId:'coordinator'}})));
  const work=page.locator('.tasks-view');
  const filter=name=>work.locator('.task-filters').getByRole('button',{name:new RegExp(`^${name}`)});
  const fits=async()=>assert.ok(await work.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'No horizontal overflow');
  await page.goto(process.env.UI_ORIGIN+'/#tasks');await work.getByText('Review launch plan',{exact:true}).waitFor();
  assert.equal(await work.locator('.task-card').count(),4);
  assert.equal(await work.locator('.task-column.is-needs_input .task-card__title').first().innerText(),'Review launch plan','Oldest pending task first');
  assert.equal(await work.locator('.task-column').count(),3,'Only real task states have columns');
  const heading=await work.locator('#tasks-heading').boundingBox(), shell=await page.locator('.shell-header').boundingBox();
  assert.ok(heading.y>=shell.y+shell.height,'Page heading stays below the shell header');
  await fits();
  await page.screenshot({path:`.context/tasks-refined/tasks-${width}-${theme}.png`});
  if([390,1440].includes(width)&&theme==='light') {
   const audit=await new AxeBuilder({page}).include('.tasks-view').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
   assert.deepEqual(audit.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})),[],'Task view passes automated accessibility checks');
  }
  const search=work.getByRole('searchbox',{name:'Search tasks'});
  await search.fill('LAUNCH');assert.equal(await work.locator('.task-card').count(),2,'Search matches titles without case sensitivity');
  await search.fill('research');assert.equal(await work.locator('.task-card').count(),2,'Search also matches the owning Bot');
  await search.fill('no matching task');await work.getByRole('heading',{name:'No matching tasks'}).waitFor();
  await work.getByRole('button',{name:'Clear search',exact:true}).click();assert.equal(await work.locator('.task-card').count(),4);
  await filter('In progress').click();assert.equal(await work.locator('.task-card').count(),1);
  await filter('Needs input').click();
  assert.equal(await work.locator('.task-card').count(),2);
  if(width===390)await page.screenshot({path:`.context/tasks-refined/tasks-pending-${width}-${theme}.png`});
  await work.getByRole('combobox',{name:'Filter tasks by bot'}).selectOption('coordinator');
  await page.waitForFunction(()=>document.querySelectorAll('.task-card').length===1);
  await filter('Done').click();await work.getByRole('heading',{name:'Nothing finished yet'}).waitFor();
  await search.fill('not found');await work.getByTestId('tasks-needs-input').getByRole('button',{name:'Review',exact:true}).click();
  assert.equal(await search.inputValue(),'','Review clears search so urgent tasks are visible');
  assert.equal(await work.locator('.task-card').count(),1,'Review preserves the selected Bot');
  await filter('All').click();assert.equal(await work.locator('.task-card').count(),2,'Resetting state preserves Bot scope');
  await work.getByRole('combobox',{name:'Filter tasks by bot'}).selectOption('all');
  await page.waitForFunction(()=>document.querySelectorAll('.task-card').length===4);
  await work.locator('.task-column.is-needs_input').getByRole('button',{name:/Needs input/}).click();
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
  const long=work.getByRole('button',{name:/Task details/});
  assert.equal(await long.locator('.task-card__title').innerText(),'Task details','Oversized identifiers use a complete label');
  assert.ok((await long.getAttribute('title')).includes(tasks[1].title),'Full title is available');await fits();
  if([390,1440].includes(width)&&theme==='light') {
   items=[{id:'approval',botId:'coordinator',botName:'Coordinator',type:'approval',title:'Allow reading the team source?',createdAt:now,seq:null}];
   await changed();await work.getByText(items[0].title,{exact:true}).waitFor();
   await search.fill('team source');assert.equal(await work.locator('.task-card').count(),1,'Search includes approval items');
   await work.getByRole('button',{name:/Review approval/}).click();await page.locator('.composer__input').waitFor();
   assert.equal(await page.locator('.chat__pill-name').innerText(),'Coordinator','Approval review opens the owning conversation');
   await page.goto(process.env.UI_ORIGIN+'/#tasks');await work.getByText(items[0].title,{exact:true}).waitFor();
   attentionFailing=true;await changed();await work.getByText('Pending input could not refresh.',{exact:true}).waitFor();
   await search.fill('missing');assert.equal(await work.getByRole('heading',{name:'No matching tasks'}).count(),0,'Unknown pending input is never reported as a successful empty search');
   await work.getByText('Search results may be incomplete.',{exact:true}).waitFor();
   // Let the transcript's debounced attention refresh settle before retrying.
   await page.waitForTimeout(350);
   await work.getByRole('button',{name:'Retry pending input',exact:true}).waitFor();
   attentionFailing=false;await work.getByRole('button',{name:'Retry pending input',exact:true}).click();await work.getByRole('heading',{name:'No matching tasks'}).waitFor();
   await work.getByRole('button',{name:'Clear task search'}).click();assert.ok(await search.evaluate(el=>el===document.activeElement),'Clearing search restores input focus');
   handoffsEnabled=true;tasks=[{id:'done',botId:'coordinator',title:'Finished release draft',state:'done',note:'',updatedAt:now}];
   await page.reload();await work.getByText('Finished release draft',{exact:true}).waitFor();
   assert.match(await work.getByRole('link',{name:'View loop',exact:true}).getAttribute('href'),/#loop\/fixture-loop$/);
   const send=work.getByRole('button',{name:'Send to agent',exact:true});await send.click();
   await page.getByRole('dialog',{name:'Send to agent',exact:true}).waitFor();await page.keyboard.press('Escape');
   await page.getByRole('dialog',{name:'Send to agent',exact:true}).waitFor({state:'hidden'});
   await page.waitForFunction(()=>document.activeElement?.textContent==='Send to agent');
   failing=true;await page.reload();await work.getByText('Tasks couldn’t load.',{exact:true}).waitFor();
   assert.equal(await work.getByRole('heading',{name:'No tasks yet'}).count(),0,'Initial failure is not an empty success');
   failing=false;await work.getByRole('button',{name:'Retry',exact:true}).click();await work.getByText('Finished release draft',{exact:true}).waitFor();
   handoffsEnabled=false;items=[];await page.reload();await work.getByText('Finished release draft',{exact:true}).waitFor();
  }
  const tabs=work.getByRole('navigation',{name:'Work sections'});
  const tabRect=await tabs.boundingBox();
  for(const tab of ['Team','Goals','Artifacts','Tasks']) {
   await tabs.getByRole('button',{name:tab,exact:true}).click();
   await work.getByRole('heading',{name:tab,exact:true}).first().waitFor();
   const current=await tabs.boundingBox();assert.ok(Math.abs(current.x-tabRect.x)<=1&&Math.abs(current.y-tabRect.y)<=1&&Math.abs(current.width-tabRect.width)<=1,'Tabs keep their position');
  }
  await work.getByRole('button',{name:'Add task',exact:true}).click();await page.locator('.composer__input').waitFor();
  await page.waitForFunction(()=>document.querySelector('.composer__input')?.value.includes('Create a task:'));
  assert.match(await page.locator('.composer__input').inputValue(),/Create a task:/,'Add task opens a draft without sending');
  assert.deepEqual(errors,[]);await page.context().close();console.log(`PASS Tasks ${width} ${theme}: search, filters, scope, ordering, updates, stale data, retry, keyboard, empty state, long identifiers, tabs and add task`);
 }
}finally{await browser.close();await vite.close();}
