// Deterministic local app scenes. No live account or provider requests.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';

const phase = process.env.REDESIGN_PHASE || 'all';
const shellChecks = phase !== 'baseline';
const chatChecks = ['chat', 'settings', 'all'].includes(phase);
const settingsChecks = ['settings', 'all'].includes(phase);
const capture = phase === 'baseline' ? 'before' : 'after';
const root = process.cwd();
const evidence = `${root}/.context/redesign/${capture}`;
await fs.mkdir(evidence, { recursive: true });
const port = await new Promise(resolve => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: `${root}/web`, stdio: 'pipe' });
let logs = '';
server.stdout.on('data', d => logs += d); server.stderr.on('data', d => logs += d);
const wait = async (fn, name) => { for (let i=0;i<150;i++) { if (await fn()) return; await new Promise(r=>setTimeout(r,100)); } throw Error(`Timed out: ${name}\n${logs}`); };
const now = Date.UTC(2026,10,23,12);
const botBase = { description: 'A thoughtful partner for the work ahead.', instructions: '', mode: 'personal', pinned: false, effort: 'medium', model: null, generation: 1, unread: 0, lastPreview: 'Ready for your next task', lastActivityAt: now, createdAt: now, voice: 'ara', voiceSpeed: 1, voiceLanguage: 'auto', kind: 'agent', onboarding: { status: 'active' } };
const bots = [
  { ...botBase, id: 'quinn', name: 'Quinn', label: 'Chief of Staff', isPrimary: true, avatarColor: 'blue', avatarShape: 'bird-flock' },
  { ...botBase, id: 'research', name: 'Research', label: 'Find the signal', avatarColor: 'purple', avatarShape: 'bird-soar' },
  { ...botBase, id: 'studio', name: 'Studio', label: 'Make good ideas clear', avatarColor: 'green', avatarShape: 'bird-glide' },
  { ...botBase, id: 'room', name: 'Launch team', label: 'Shared conversation', kind: 'room', members: ['quinn','research','studio'], avatarColor: 'purple', avatarShape: 'bird-vee' },
];
const model = { id: 'claude/sonnet', name: 'Claude Sonnet', short: 'Sonnet', author: 'anthropic', efforts: ['low','medium','high'], defaultEffort: 'medium', billing: 'plan', vision: true, reasoning: true, context: 200000 };
const row = (seq, text, role = seq % 2 ? 'user' : 'assistant', botId = 'quinn') => ({ botId, seq, updatedSeq: seq, generation: 1, createdAt: now - (50-seq)*60000, kind: 'message', body: { type: 'message', role, text } });
const rows = Array.from({length:32}, (_,i) => row(i+1, i%2 ? 'The launch is on track. Research is ready, the draft is in review, and the next step is to confirm the schedule.\n\nI can turn the open questions into a short checklist.' : i===30 ? 'What should we focus on next?' : 'Help me plan the next step for our launch.'));
const gmail = { slug: 'gmail', name: 'Gmail', description: 'Read and organize email, find important conversations, and draft replies with the context your team needs.', connected: true, categories: ['productivity'], managedAuth: true, noAuth: false };
const slack = { ...gmail, slug: 'slack', name: 'Slack', description: 'Keep the team in sync.', connected: false };
const cli = { runtime: 'server', serverLoginAvailable: true, selected: 'claude', connected: true, device: 'Bot computer', providers: { claude: { installed: true, authenticated: true, subscription: true }, codex: { installed: true, authenticated: false, subscription: false } } };
let browser;
let passes = 0;
try {
  await wait(()=>fetch(origin).then(r=>r.ok,()=>false),'preview');
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const width of [390,1280,1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', colorScheme: 'dark', timezoneId: 'UTC' });
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    const errors = [];
    page.on('pageerror', e=>errors.push(e.message));
    let signedOut = false;
    await context.addInitScript(() => {
      localStorage.setItem('swarm.theme','dark'); localStorage.setItem('swarm.selectedBot','quinn'); localStorage.setItem('swarm.detailsOpen','0');
      window.EventSource = class { static CLOSED=2; constructor(){ window.emitRedesignEvent=e=>this.onmessage?.({data:JSON.stringify(e)}); setTimeout(()=>this.onopen?.(),0); } close(){} };
    });
    await context.route('**/api/**', async route=>{
      const url = new URL(route.request().url()), p=url.pathname;
      const send = json=>route.fulfill({json});
      if(p==='/api/auth/me') return send({user:signedOut ? null : {id:'design-owner',name:'Workspace owner',email:'owner@example.test'},devLogin:false,googleLogin:true,appleLogin:true});
      if(p==='/api/bots') return send({bots,live:[]});
      if(p.endsWith('/suggested-apps')) return send({suggestions:[]});
      if(p.endsWith('/rows')) return send({generation:1,rows: p.includes('/room/') ? rows.slice(-6).map(r=>({...r,botId:'room',body:{...r.body,...(r.body.role==='assistant'?{from:{kind:'bot',id:'research',name:'Research'}}:{})}})) : rows.map(r=>({...r,botId:p.split('/')[3]}))});
      if(p==='/api/models'||p==='/api/settings/models') return send({provider:'claude-cli',billing:'plan',models:[model],defaultModel:model.id,favourites:[model.id],canFast:false,plan:'Max',usage:{available:false,windows:[],checkedAt:now}});
      if(p==='/api/cli') return send(cli);
      if(p.endsWith('/routines')) return send({routines:[]});
      if(p.endsWith('/tasks')) return send({tasks:[]});
      if(p.endsWith('/coworker-setups')) return send({setups:[]});
      if(p==='/api/team/exchanges') return send({exchanges:[],nextBefore:null});
      if(p==='/api/needs-you') return send({items:[]});
      if(p==='/api/computer') return send({computer:{provider:'local',status:'absent',screens:[],error:null}});
      if(p==='/api/settings') return send({settings:{},computer:{provider:'orgo'}});
      if(p==='/api/voice/options') return send({voices:[],languages:[],speeds:[],configured:false});
      if(p==='/api/apps') return send({apps:[gmail,slack],connected:['gmail'],connectedApps:[gmail],categories:['productivity'],total:2,nextOffset:null});
      if(p==='/api/apps/connections') return send({connections:[{id:'design-gmail',toolkit:'gmail',toolkitName:'Gmail',accountLabel:'owner@example.test',displayStatus:'active',label:'owner@example.test',email:'owner@example.test',status:'ACTIVE',enabled:true,isDefault:true,createdAt:now-86400000,connectedAt:new Date(now-86400000).toISOString()}]});
      if(p==='/api/providers/openrouter') return send({connected:false,active:false,defaultModel:'',settingsUrl:'https://openrouter.ai/settings/keys'});
      if(p==='/api/settings/keys') return send({isolated:true});
      if(p==='/api/mcp/servers') return send({servers:[],canManage:true,stdioAvailable:false});
      if(p.endsWith('/settings')) return send({bot:bots.find(b=>p.includes(`/${b.id}/`))||bots[0],skills:[],memories:[],routines:[]});
      return send({});
    });
    await context.route('**/*',route=>new URL(route.request().url()).origin===origin ? route.fallback() : route.abort());
    const snap=async name=>{await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:`${evidence}/${name}-${width}.png`,animations:'disabled'});};
    const goto=async hash=>{await page.goto(`${origin}/?scene=${encodeURIComponent(hash)}${hash}`);await page.locator('.app').waitFor();};
    const openChat=async()=>{await goto('');if(width<=760)await page.locator('.pinned__tile').click();await page.locator('.composer__input').waitFor();await page.locator('.bubble').last().waitFor();await page.getByRole('button',{name:/Model: /}).waitFor();await page.evaluate(()=>document.fonts.ready);};
    await openChat();
    if(width<=760){await page.getByRole('button',{name:'All Bots',exact:true}).click();await snap('sidebar');await page.locator('.sidebar__brand').click();await snap('bot-list');await page.locator('.pinned__tile').click();}
    else {await snap('sidebar');await page.locator('.sidebar__brand').click();await page.locator('.bots-view').waitFor();await snap('bot-list');await page.locator('.pinned__tile').click();}
    await page.locator('.composer__input').waitFor();
    const composer=page.locator('.composer');
    const input=page.locator('.composer__input');
    if (shellChecks) {
      const shell = await page.locator('.chat').boundingBox();
      const column = await page.locator('.composer-area').boundingBox();
      assert.ok(column.width <= 752.5, `${width}: chat maximum width`);
      assert.ok(Math.abs(column.x + column.width/2 - (shell.x + shell.width/2)) <= 1, `${width}: centred column`);
      if (width === 390) { assert.equal(Math.round(column.x),16); assert.equal(Math.round(width-column.x-column.width),16); }
      else { assert.equal(Math.round((await page.locator('.sidebar').boundingBox()).width),272); assert.equal(Math.round(column.width),752); }
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth), `${width}: no horizontal page overflow`);
    }
    await snap('chat-rest');
    const mic=await page.locator('.composer__voice').boundingBox();
    if (chatChecks) {
      const rest=await composer.boundingBox();
      assert.ok(rest.height<=64, `${width}: rest height ${rest.height}`);
      assert.ok(Math.abs(rest.x+rest.width-mic.x-mic.width-9)<=2, `${width}: mic at the far right`);
      assert.equal(await page.getByRole('button',{name:'Send',exact:true}).count(),0);
      const chip=await page.locator('.model-pill').evaluate(el=>({height:el.getBoundingClientRect().height,lineHeight:parseFloat(getComputedStyle(el).lineHeight),nowrap:getComputedStyle(el).whiteSpace,nameHeight:el.querySelector('.model-pill__name').getBoundingClientRect().height}));
      assert.ok(chip.height<=44 && chip.nameHeight<=chip.lineHeight+1,`${width}: one-line model chip ${JSON.stringify(chip)}`);
    }
    await input.fill('Hello');
    if (chatChecks) {
      const send=await page.getByRole('button',{name:'Send',exact:true}).boundingBox();
      for(const key of ['x','y','width','height'])assert.ok(Math.abs(send[key]-mic[key])<=2,`${width}: mic/send same ${key}`);
      assert.equal(await page.locator('.composer__voice:visible').count(),0,'send replaces mic');
      assert.ok((await composer.boundingBox()).height<=64,'short draft stays on one line');
    }
    await snap('composer-typed');
    if(chatChecks){
      await input.fill('A longer draft with room for thought.\n'.repeat(20));
      await wait(async()=> (await composer.boundingBox()).height>64,'multiline growth');
      assert.ok((await composer.boundingBox()).height<=240,'multiline composer cap');
      assert.ok(await input.evaluate(el=>el.scrollHeight>el.clientHeight),'long drafts scroll inside textarea');
      await input.fill('Hello');
      await wait(async()=> (await composer.boundingBox()).height<=64,'shortened draft returns to single-line height');
    }
    await input.fill('');
    if(chatChecks) await wait(async()=> (await composer.boundingBox()).height<=64,'cleared draft returns to single-line height');
    const transcript=page.locator('.transcript');
    await transcript.evaluate(el=>{el.scrollTop=Math.max(0,el.scrollHeight-el.clientHeight-500);});
    await page.locator('.jump-btn').waitFor();
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    if(chatChecks){
      const before=await transcript.evaluate(el=>el.scrollTop);
      const next=row(33,'An update arrived while you were reading.','assistant');
      await page.evaluate(next=>window.emitRedesignEvent({type:'rows',botId:'quinn',generation:1,rows:[next]}),next);
      await page.locator('[data-row-seq="33"]').waitFor({state:'attached'});
      const after=await transcript.evaluate(el=>el.scrollTop);
      assert.ok(Math.abs(after-before)<=2,`incoming row preserves scroll position: ${before} to ${after}`);
      await page.getByRole('button',{name:'Jump to latest',exact:true}).waitFor();
      const anchor=page.locator('[data-row-seq="28"]');
      const anchorTop=(await anchor.boundingBox()).y;
      const changed={...row(2,'Earlier content expands after formatting.\n\n'.repeat(14),'assistant'),updatedSeq:35};
      await page.evaluate(next=>window.emitRedesignEvent({type:'rows',botId:'quinn',generation:1,rows:[next]}),changed);
      await page.getByText('Earlier content expands after formatting.',{exact:false}).first().waitFor();
      await wait(async()=>Math.abs((await anchor.boundingBox()).y-anchorTop)<=2,'earlier content preserves visible anchor');
      await page.mouse.move(0,0);
      await input.blur();
      await wait(()=>transcript.evaluate(el=>!el.dataset.scrolling),'scroll thumb settles');
      assert.equal(await transcript.evaluate(el=>getComputedStyle(el).getPropertyValue('--scroll-thumb').trim()),'transparent','thumb hidden at rest');
      await transcript.hover();
      assert.notEqual(await transcript.evaluate(el=>getComputedStyle(el).getPropertyValue('--scroll-thumb').trim()),'transparent','thumb visible on hover');
      await page.mouse.move(0,0);
      await transcript.evaluate(el=>el.scrollTop-=24);
      await wait(()=>transcript.evaluate(el=>el.dataset.scrolling==='true'),'thumb visible while scrolling');
      const geometry=await transcript.evaluate(el=>{
        const r=el.getBoundingClientRect(),s=getComputedStyle(el),edge=r.left+el.clientLeft+el.clientWidth-parseFloat(s.paddingRight);
        return {edge,rights:[...el.querySelectorAll('.bubble')].map(b=>b.getBoundingClientRect().right),gutter:s.scrollbarGutter};
      });
      assert.ok(geometry.rights.every(right=>right<=geometry.edge+.5),`bubbles clear the scroll content edge ${JSON.stringify(geometry)}`);
      assert.match(geometry.gutter,/stable/,'gutter reserves scrollbar space');
    }
    await snap('chat-scrolled');
    if(chatChecks){
      await page.getByRole('button',{name:'Jump to latest',exact:true}).click();
      await wait(()=>transcript.evaluate(el=>el.scrollHeight-el.scrollTop-el.clientHeight<2),'jump reaches bottom');
      const next=row(34,'Latest update stays visible when already at the bottom.','assistant');
      await page.evaluate(next=>window.emitRedesignEvent({type:'rows',botId:'quinn',generation:1,rows:[next]}),next);
      await page.locator('[data-row-seq="34"]').waitFor({state:'attached'});
      await wait(()=>transcript.evaluate(el=>el.scrollHeight-el.scrollTop-el.clientHeight<2),'new message follows bottom');
    }
    await goto('#settings/subscriptions');
    await page.getByRole('heading',{name:'Choose how models are billed',exact:true}).waitFor();
    await page.getByRole('tab',{name:'Claude Code',exact:true}).click();
    const assertPlanSpacing=async()=>{
      const gaps=await page.locator('.subscription-settings').evaluate(el=>{
        const blocks=[...el.children].filter(c=>c.getBoundingClientRect().height>0 && getComputedStyle(c).position!=='absolute');
        return blocks.slice(1).map((b,i)=>b.getBoundingClientRect().top-blocks[i].getBoundingClientRect().bottom);
      });
      assert.ok(gaps.length>=3,'plan blocks are present');
      assert.ok(gaps.every(g=>Math.abs(g-24)<1),`${width}: consistent 24px plan gaps ${gaps}`);
      const rows=await page.locator('.subscription-settings .access-row').evaluateAll(rows=>rows.map(row=>{
        const s=getComputedStyle(row),text=row.querySelector('.cfg-row__text'),icon=row.querySelector('.settings-row__icon');
        return {gap:parseFloat(s.columnGap),pad:parseFloat(s.paddingBottom),textGap:parseFloat(getComputedStyle(text).rowGap),iconX:icon.getBoundingClientRect().right,textX:text.getBoundingClientRect().left};
      }));
      assert.ok(rows.length>=6,'plan, CLI, API and provider rows retain controls');
      for(const row of rows){assert.equal(row.gap,16);assert.equal(row.pad,16);assert.equal(row.textGap,4);assert.ok(Math.abs(row.textX-row.iconX-16)<1,'icon and label share 16px gap');}
    };
    if(settingsChecks)await assertPlanSpacing();
    await snap('models-access');
    await page.getByRole('tab',{name:'Codex',exact:true}).click();
    if(settingsChecks)await assertPlanSpacing();
    await snap('models-codex');
    if(settingsChecks){
      await page.locator('.subscription-settings__context > summary').click();
      const details=await page.locator('.subscription-settings__details').evaluate(el=>({x:getComputedStyle(el).columnGap,y:getComputedStyle(el).rowGap}));
      assert.deepEqual(details,{x:'24px',y:'16px'});
      await page.locator('.subscription-settings__advanced > summary').click();
      const advanced=await page.locator('.subscription-settings__advanced-content').evaluate(el=>({gap:getComputedStyle(el).rowGap,pad:getComputedStyle(el).paddingTop}));
      assert.deepEqual(advanced,{gap:'24px',pad:'24px'});
    }
    await goto('#settings/apps');await page.getByRole('heading',{name:'Connected apps',exact:true}).waitFor();await page.getByRole('button',{name:'Disconnect',exact:true}).waitFor();await snap('connections');
    await goto('#settings/general');await page.getByRole('heading',{name:'General',exact:true}).waitFor();await snap('settings-home');
    if(width<=760){await page.getByRole('button',{name:'Back to Settings',exact:true}).click();await snap('settings-list');}
    await openChat();
    await page.locator('.chat__pill').click();await page.getByRole('menuitem',{name:'Bot settings',exact:true}).click();
    await page.locator('.bot-settings-page').waitFor();await page.getByLabel('Name',{exact:true}).waitFor();await snap('bot-settings');
    await openChat();
    if(width<=760)await page.getByRole('button',{name:'All Bots',exact:true}).click();
    await page.getByRole('button',{name: 'Create a Bot',exact:true}).click();await page.getByRole('main',{name:'Create a Bot',exact:true}).waitFor();await snap('create-bot');
    await goto('');if(width<=760)await page.locator('.sidebar').waitFor();
    await page.locator('.bot-row').filter({hasText:'Launch team'}).click();await page.locator('.composer__input').waitFor();await snap('group-chat');
    if(chatChecks){
      const groupMic=await page.locator('.composer__voice').boundingBox();
      await input.fill('Hello');
      const groupSend=await page.getByRole('button',{name:'Send',exact:true}).boundingBox();
      for(const key of ['x','y','width','height'])assert.ok(Math.abs(groupSend[key]-groupMic[key])<=2,`${width}: group mic/send same ${key}`);
      assert.equal(await page.locator('.composer__voice:visible').count(),0,'group send replaces mic');
      await input.fill('');
    }
    signedOut=true;await page.goto(`${origin}/?signed-out-fixture`);await page.getByRole('heading',{name:'Welcome to Swarm',exact:true}).waitFor();await snap('sign-in');
    assert.deepEqual(errors,[],`${width}px browser errors`);
    console.log(`PASS ${width}px ${phase}: complete screen capture, no browser errors`);passes++;
    await context.close();
  }
  console.log(`Redesign checks: ${passes} passed, 0 failed`);
} finally {await browser?.close();server.kill();}
