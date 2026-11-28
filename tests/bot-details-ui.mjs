// Restored bot sidebar: chat continuity, scoped controls, keyboard return and responsive layout.
// All API interactions are local fixtures; provider/device operations are blocked.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
const origin = process.env.UI_ORIGIN ?? 'http://127.0.0.1:5198';
assert.match(origin, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/);
const out = new URL('../.context/bot-details/', import.meta.url);
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const results = [];
try {
  for (const [width,height] of [[1440,900],[1100,900],[844,390],[390,844],[320,568]]) for (const theme of ['light','dark']) {
    const bots = ['Quinn','Nia'].map((name,i) => ({id:name.toLowerCase(),name,label:i?'Research':'Chief of Staff',kind:'agent',isPrimary:!i,avatarShape:i?'heart':'blob',avatarColor:i?'orange':'blue',description:'Your teammate',mode:'personal',instructions:'',model:null,effort:'medium',generation:1,unread:0,lastActivityAt:0,createdAt:0,voice:'ara',voiceSpeed:1,voiceLanguage:'auto'}));
    let routine = {id:'morning',botId:'quinn',name:'Morning product walk',description:'Review the latest product changes',schedule:'Every weekday at 9 AM',enabled:false};
    const tasks = [{id:'task-review',botId:'quinn',title:'Review the launch summary',state:'needs_input',note:'Confirm the next milestone',updatedAt:Date.now(),createdAt:Date.now()}];
    const page = await browser.newPage({viewport:{width,height},colorScheme:theme,reducedMotion:'reduce'});
    const errors=[],writes=[];
    page.on('pageerror',e=>{errors.push(e.message);console.error(e.message);});
    page.setDefaultTimeout(8000);
    await page.addInitScript(theme=>{
      localStorage.setItem('swarm.theme',theme); localStorage.setItem('swarm.selectedBot','quinn');
      window.EventSource=class {static CLOSED=2;constructor(){setTimeout(()=>this.onopen?.(),0)}close(){}};
    },theme);
    await page.route('**/*',async route=>{
      const req=route.request(),url=new URL(req.url()),p=url.pathname;
      if(url.origin!==origin) { errors.push(`external ${url.href}`); return route.abort(); }
      if(!p.startsWith('/api/')) return route.continue();
      if(p.endsWith('/suggested-apps')) return route.fulfill({json:{suggestions:[]}});
      if(req.method()!=='GET') {
        const body=req.postDataJSON(); writes.push({path:p,method:req.method(),body});
        if(p==='/api/routines/morning'){routine={...routine,...body};return route.fulfill({json:{routine}});}
        if(p==='/api/bots/quinn' && req.method()==='PATCH'){Object.assign(bots[0],body);return route.fulfill({json:{bot:bots[0]}});}
        if(p==='/api/bots/quinn/messages')return route.fulfill({json:{row:{botId:'quinn',generation:1,seq:2,updatedSeq:2,kind:'message',body:{type:'message',role:'user',text:body.text},createdAt:Date.now()}}});
        errors.push(`Unexpected mutation ${p}`);return route.abort();
      }
      let body={};
      if(p==='/api/auth/me')body={user:{id:'owner',name:'Alex',email:'alex@example.test'}};
      else if(p==='/api/bots')body={bots,live:[]};
      else if(p.endsWith('/rows'))body={generation:1,rows:[{botId:p.split('/')[3],generation:1,seq:1,updatedSeq:1,kind:'message',body:{type:'message',role:'assistant',text:'The launch summary is ready for review.'},createdAt:Date.now()}]};
      else if(p.endsWith('/routines'))body={routines:p.includes('/quinn/')?[routine]:[]};
      else if(/^\/api\/bots\/[^/]+\/settings$/.test(p))body={memories:[],skills:[],routines:p.includes('/quinn/')?[routine]:[],tasks:[],memory:{lastConsolidatedAt:null,historyChars:0,compactAtChars:1000,lastCompaction:null}};
      else if(p.endsWith('/tasks'))body={tasks:p.includes('/nia/')?[]:tasks};
      else if(p==='/api/team/exchanges')body={exchanges:[],nextBefore:null};
      else if(p.endsWith('/coworker-setups'))body={setups:[]};
      else if(p==='/api/computer')body={computer:{status:'running',provider:'local',screens:[]}};
      else if(p==='/api/models')body={models:[],favourites:[],provider:'openrouter',billing:'api'};
      else if(p==='/api/settings')body={settings:{},computer:{provider:'local'}};
      else if(p==='/api/voice/options')body={voices:[{id:'ara',name:'Ara'},{id:'rex',name:'Rex'}],speeds:[1,1.25],languages:[{code:'auto',name:'Auto-detect'},{code:'en',name:'English'}]};
      else if(p.endsWith('/setup'))return route.fulfill({status:404,json:{error:'No saved setup'}});
      else if(p.endsWith('/history'))body={entries:[],through:0,latestVersion:0,nextBefore:null,coverage:'Recorded changes'};
      else if(p.endsWith('/files'))body={status:'ok',path:'',files:[]};
      return route.fulfill({json:body});
    });
    await page.goto(origin);
    if(width<=760)await page.locator('.pinned__tile').click();
    const composer=page.locator('.composer__input');
    await composer.fill('Keep this draft while reviewing details');
    await page.getByRole('button',{name:'Open Quinn details',exact:true}).click();
    const panel=page.getByRole('complementary',{name:'Conversation details'});
    await panel.waitFor();
    await panel.getByRole('switch',{name:'Morning product walk'}).waitFor();
    await panel.getByRole('button',{name:/Review the launch summary/}).waitFor();
    await panel.getByRole('combobox',{name:'Voice',exact:true}).waitFor();
    assert.equal(await composer.isVisible(),width>1100,'chat remains alongside wide-screen details');
    assert.equal(await panel.getByRole('heading',{name:'Quinn',exact:true}).count(),1);
    const geometry=await panel.evaluate(el=>({x:el.getBoundingClientRect().x,width:el.getBoundingClientRect().width,scrollWidth:el.scrollWidth,clientWidth:el.clientWidth}));
    assert.ok(geometry.scrollWidth<=geometry.clientWidth+1,JSON.stringify(geometry));
    await panel.evaluate(el=>el.scrollTo(0,0));
    await page.screenshot({path:new URL(`sidebar-${width}-${theme}.png`,out).pathname});
    await panel.getByRole('switch',{name:'Morning product walk'}).click();
    await page.waitForFunction(()=>document.querySelector('.details [role="switch"]')?.getAttribute('aria-checked')==='true');
    assert.deepEqual(writes.at(-1),{path:'/api/routines/morning',method:'PATCH',body:{enabled:true}});
    await panel.getByRole('combobox',{name:'Voice',exact:true}).selectOption('rex');
    await page.waitForFunction(()=>document.querySelector('.details select[aria-label="Voice"]')?.value==='rex');
    assert.deepEqual(writes.at(-1),{path:'/api/bots/quinn',method:'PATCH',body:{voice:'rex'}});
    await panel.getByRole('button',{name:'Start voice chat',exact:true}).scrollIntoViewIfNeeded();
    await page.screenshot({path:new URL(`voice-${width}-${theme}.png`,out).pathname});
    if(width>1100){
      await composer.fill('Send while the details sidebar is open'); await composer.press('Enter');
      await page.waitForFunction(()=>document.querySelector('.composer__input')?.value==='');
      assert.deepEqual({ ...writes.at(-1), body: { ...writes.at(-1).body, submissionId: undefined } },{path:'/api/bots/quinn/messages',method:'POST',body:{text:'Send while the details sidebar is open',submissionId:undefined}});
      assert.match(writes.at(-1).body.submissionId, /^[a-f0-9-]{36}$/);
      await composer.fill('Keep this draft while reviewing details');
    }
    // R2F-022: the tab bar and the close button keep their boxes (within 1 px) on every tab.
    const detailTabs=panel.getByRole('navigation',{name:'Conversation details sections'});
    const tabBoxes=()=>page.evaluate(()=>[...document.querySelectorAll('.details nav[aria-label="Conversation details sections"] button, .details .setup-paper__close')].map(el=>{const r=el.getBoundingClientRect();return [r.x,r.y,r.width,r.height];}));
    const sameBoxes=(a,b,label)=>{assert.equal(a.length,b.length,label);a.forEach((box,i)=>box.forEach((v,j)=>assert.ok(Math.abs(v-b[i][j])<=1,`${label}: ${JSON.stringify(a[i])} vs ${JSON.stringify(b[i])}`)));};
    await panel.evaluate(el=>el.scrollTo(0,0));
    const activityBoxes=await tabBoxes();
    // R2F-011: Details links straight to Settings > Computer.
    assert.equal(await panel.getByRole('button',{name:'Computer settings',exact:true}).count(),1);
    await detailTabs.getByRole('button',{name:'Tasks',exact:true}).click();
    await panel.getByRole('button',{name:/Review the launch summary/}).waitFor();
    await panel.evaluate(el=>el.scrollTo(0,0));
    sameBoxes(await tabBoxes(),activityBoxes,`${width} Tasks tab`);
    await detailTabs.getByRole('button',{name:'Files',exact:true}).click();
    await panel.getByRole('region',{name:'Computer files'}).waitFor();
    await panel.evaluate(el=>el.scrollTo(0,0));
    sameBoxes(await tabBoxes(),activityBoxes,`${width} Files tab`);
    await detailTabs.getByRole('button',{name:'Setup',exact:true}).click();
    await panel.getByRole('button',{name:'Start setup interview',exact:true}).waitFor();
    await panel.evaluate(el=>el.scrollTo(0,0));
    sameBoxes(await tabBoxes(),activityBoxes,`${width} Setup tab`);
    // R2F-021: the Setup tab has a one-line computer status in every state, worded like Activity.
    await panel.getByText('Computer: Connected',{exact:true}).waitFor();
    await page.keyboard.press('Escape');
    await panel.waitFor({state:'detached'});
    assert.equal(await composer.inputValue(),'Keep this draft while reviewing details');
    await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Open Quinn details');
    // The transient menu item must return to its persistent bot-name trigger.
    const menuTrigger=page.locator('.chat__pill');
    await menuTrigger.focus(); await page.keyboard.press('Enter');
    await page.getByRole('menu').waitFor();
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
    await panel.waitFor();
    await panel.getByRole('navigation',{name:'Conversation details sections'}).getByRole('button',{name:'Setup',exact:true}).click();
    await page.keyboard.press('Escape');
    await panel.waitFor({state:'detached'});
    await page.waitForFunction(()=>document.activeElement?.classList.contains('chat__pill'));
    assert.equal(await composer.inputValue(),'Keep this draft while reviewing details');
    await page.getByRole('button',{name:'Show details',exact:true}).click();
    await panel.getByRole('navigation',{name:'Conversation details sections'}).getByRole('button',{name:'Tasks',exact:true}).click();
    await panel.getByRole('button',{name:/Review the launch summary/}).click();
    await panel.waitFor({state:'detached'});
    assert.equal(await composer.inputValue(),'Keep this draft while reviewing details');
    if(width<=760){await page.getByRole('button',{name:'All Bots',exact:true}).click();await page.locator('.bot-row').filter({hasText:'Nia'}).click();}
    else await page.locator('.bot-row').filter({hasText:'Nia'}).click();
    await page.getByRole('button',{name:'Open Nia details',exact:true}).click();
    await panel.getByRole('heading',{name:'Nia',exact:true}).waitFor();
    assert.equal(await panel.getByRole('switch',{name:'Morning product walk'}).count(),0);
    assert.equal(await panel.getByRole('button',{name:/Review the launch summary/}).count(),0,'a different bot never inherits the previous tasks');
    await panel.getByRole('button',{name:'Close details',exact:true}).click();
    if(width===1440&&theme==='light'){
      // R2F-004: an unsaved Bot settings edit asks before every way out; Keep editing keeps the text.
      await page.goto(`${origin}/#bot/quinn/settings/general`);
      const about=page.locator('#cfg-about');
      await about.fill('An unsaved About edit');
      const guard=page.getByRole('alertdialog',{name:'Discard unsaved changes?'});
      const keep=async(label)=>{
        await guard.waitFor();
        await guard.getByText('Your edits on General have not been saved.',{exact:true}).waitFor();
        await guard.getByRole('button',{name:'Keep editing',exact:true}).click();
        await guard.waitFor({state:'detached'});
        assert.equal(await about.inputValue(),'An unsaved About edit',`${label}: the draft is kept`);
        assert.equal(await page.getByRole('main',{name:'Quinn settings'}).count(),1,`${label}: still on Bot settings`);
      };
      await page.locator('.bot-row').filter({hasText:'Nia'}).click();
      await keep('sidebar Bot');
      await page.getByRole('button',{name: 'Create a Bot',exact:true}).click();
      await keep('Create a Bot');
      await page.keyboard.press('Control+k');
      await page.getByRole('textbox',{name:'Search',exact:true}).fill('Nia');
      await page.keyboard.press('Enter');
      await keep('search result');
      await page.locator('.sidebar').getByRole('button',{name: /^Tasks(?: \d|$)/}).click();
      await keep('Tasks island');
      await page.getByRole('button',{name:'Your Bots',exact:true}).first().click();
      await keep('brand button');
      // Discard leaves and drops the draft; with nothing changed, no question is asked.
      await page.locator('.bot-row').filter({hasText:'Nia'}).click();
      await guard.getByRole('button',{name:'Discard',exact:true}).click();
      await page.locator('.chat__pill-name').getByText('Nia',{exact:true}).waitFor();
      assert.match(await page.evaluate(()=>location.hash),/^#bot\/nia~[^/]+$/,'leaving Bot settings names the destination chat');
      assert.ok(!writes.some(w=>w.path==='/api/bots/quinn'&&w.body?.description),'nothing was saved');
      await page.goto(`${origin}/#bot/quinn/settings/general`);
      await about.waitFor();
      await page.locator('.bot-row').filter({hasText:'Nia'}).click();
      await page.locator('.chat__pill-name').getByText('Nia',{exact:true}).waitFor();
      assert.equal(await guard.count(),0,'no question without changes');
    }
    assert.deepEqual(errors,[]);
    results.push({width,height,theme,geometry,writes: writes.length,passed:true});
    await page.close();
    console.log(`PASS bot details ${width}x${height} ${theme}: scoped tasks/routines/voice, chat continuity, files/setup and focus`);
  }
  await fs.writeFile(new URL('verification.json',out),JSON.stringify(results,null,2)+'\n');
}finally{await browser.close();}
