import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { agenticFixture } from './e2e/agentic-fixture.mjs';
import { widgetProviderReplay } from './fix-dash-4-provider.mjs';
import { inspectAlignment } from '../layout-alignment-ui.mjs';

export const FIX_DASH_4_STATES = ['prompt-running', 'prompt-answer', 'prompt-failure', 'toast', 'preview-pending', 'preview-applied', 'preview-discarded', 'declined-skill'];
export async function runFixDash4({ before = false, output = path.resolve(`.context/fix-dash-4/${before ? 'before' : 'after'}`), views = [[320,'light'],[390,'light'],[500,'light'],[1280,'light'],[390,'dark'],[1280,'dark']] } = {}) {
  fs.mkdirSync(output, { recursive: true });
  const server = await agenticFixture(), checks = [], screenshots = [];
  let page, replay;
  const check = (name, passed, detail) => { checks.push({ name, passed, detail }); console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${detail ? ': ' + JSON.stringify(detail) : ''}`); };
  try {
    for (const [width, theme] of views) {
      const tag = `${width}-${theme}`, account = await server.account({ bot: true });
      const request = (method, route, input, revision) => server.request(account, method, route, input, revision);
      server.db.prepare('INSERT INTO account_preferences(user_id,updated_at,ui_widget_cost_cap_usd) VALUES(?,?,100) ON CONFLICT(user_id) DO UPDATE SET ui_widget_cost_cap_usd=100').run(account.userId, Date.now());
      let config = (await request('GET','/ui/config')).body;
      const patch = await request('PATCH','/ui/config',{patch:[{op:'add',path:'/dashboards/-',value:{id:'$new1',name:'Daily summary',icon:'layout-dashboard',widgets:[{id:'$new2',type:'agent',title:'Ask your agent',span:12,rows:3,options:{botId:account.bot.id,prompt:'Say hi in five words.',display:'text',schedule:'manual'}}]}}]},config.revision);
      assert.equal(patch.status,200,JSON.stringify(patch));
      config = (await request('GET','/ui/config')).body;
      const dashboard = config.doc.dashboards[0], widget = dashboard.widgets[0], route = `/ui/widgets/${dashboard.id}/${widget.id}`;
      replay = await widgetProviderReplay({ api:server.api, request });
      replay.set({text:'Hello there, nice to meet you.',hold:true});
      page = await server.page(account,width);
      await page.emulateMedia({colorScheme:theme});
      await page.evaluate(async theme => (await import('/src/configStore.ts')).useConfigUI.getState().setTheme(theme),theme);
      await page.evaluate(async () => (await import('/src/customization/store.ts')).dismissUndo());
      const capture = async (name, selector = '.dashboard-surface', requirePage = true) => {
        await page.evaluate(() => document.fonts.ready);
        const file = path.join(output,`${name}-${tag}.png`); await page.screenshot({path:file}); screenshots.push(file);
        const text = await page.locator('body').innerText();
        check(`${name} clean visible text ${tag}`, !/mock|Fixture|PRIVATE|QA-|undefined|null|\[object/.test(text));
        const issues = await page.evaluate(inspectAlignment,{selector,requirePage});
        check(`${name} alignment ${tag}`,issues.length===0,issues);
      };
      await page.goto(`${server.base}/#dash/${dashboard.id}`);
      await page.getByRole('button',{name:'Run',exact:true}).waitFor();
      await page.evaluate(() => {
        window.answerFlashes=[];
        const widget = document.querySelector('.dashboard-widget--agent');
        window.answerObserver = new MutationObserver(() => { if (widget.innerText.includes('No answer yet')) window.answerFlashes.push(widget.innerText); });
        window.answerObserver.observe(widget,{childList:true,subtree:true,characterData:true});
      });
      await page.getByRole('button',{name:'Run',exact:true}).click();
      await page.locator('.dashboard-agent-state').waitFor();
      check(`first Run says Running ${tag}`,(await page.locator('.dashboard-agent-state').innerText())==='Running');
      await capture('prompt-running');
      // Replay a stale GET while the POST is accepted; Running must survive it.
      let stale = true;
      await page.route(`**/api${route}/result`,async intercepted => {
        if (stale) { stale=false; await intercepted.fulfill({json:{dashboardId:dashboard.id,widgetId:widget.id,state:'empty',doc:null,runAt:null,durationMs:null,tokens:0,estimatedCostUsd:0}}); }
        else await intercepted.continue();
      });
      await page.evaluate(async () => { window.dispatchEvent(new CustomEvent('swarm:event',{detail:{type:'reconnect'}})); });
      await page.waitForTimeout(200);
      replay.release();
      await server.wait(async ()=>(await request('GET',`${route}/result`)).body.state!=='running');
      await page.waitForFunction(()=>!document.querySelector('.dashboard-agent-state'));
      check(`plain Codex answer ${tag}`,await page.getByText('Hello there, nice to meet you.',{exact:true}).count()===1);
      check(`no No answer yet flash ${tag}`,await page.evaluate(()=>window.answerFlashes.length)===0);
      await page.evaluate(()=>window.answerObserver.disconnect());
      await page.unroute(`**/api${route}/result`);
      await capture('prompt-answer');
      replay.set({error:'CLI generation timed out'});
      await page.getByRole('button',{name:'Refresh Ask your agent',exact:true}).click();
      await page.locator('.dashboard-widget--agent [role=alert]').waitFor();
      check(`specific failure ${tag}`,(await page.locator('.dashboard-widget--agent [role=alert]').innerText())==='The answer took too long. Try again.');
      await capture('prompt-failure');
      await request('PUT','/cli',{provider:null}); await replay.close(); replay=null;
      await page.getByRole('button',{name:'Edit dashboard',exact:true}).click();
      const tops = () => page.evaluate(()=>({done:[...document.querySelectorAll('button')].find(button=>button.textContent==='Done').getBoundingClientRect().top,grid:document.querySelector('.dashboard-grid').getBoundingClientRect().top}));
      const pre = await tops();
      await page.evaluate(async()=>{const {patchUiConfig,useCustomization}=await import('/src/customization/store.ts'); const w=useCustomization.getState().saved.dashboards[0].widgets[0]; await patchUiConfig([{op:'replace',path:'/dashboards/0/widgets/0/title',value:w.title==='Daily greeting'?'Ask your agent':'Daily greeting'}]);});
      await page.getByRole('status',{name:'Dashboard updated',exact:true}).waitFor();
      const during=await tops(); await capture('toast');
      await page.evaluate(async()=>(await import('/src/customization/store.ts')).dismissUndo());
      const post=await tops(); check(`toast zero layout shift ${tag}`,JSON.stringify(pre)===JSON.stringify(during)&&JSON.stringify(pre)===JSON.stringify(post),{pre,during,post});
      const chat = `#bot/${account.bot.id}`;
      await page.goto(`${server.base}/${chat}`); await page.locator('.composer__input').waitFor();
      const saved = (await request('GET','/ui/config')).body;
      const goal='Create a dashboard for my open tasks.';
      // Registered ask-mode tool flow through the real chat route and local provider.
      server.scripts.set(goal,'mock: create_dashboard {"name":"Open tasks","template":"tasks"} | say Here is your dashboard. Press Apply to save it.');
      await page.locator('.composer__input').fill(goal); await page.getByRole('button',{name:'Send',exact:true}).click();
      let card=page.getByRole('region',{name:'Create dashboard: Open tasks',exact:true});
      await card.getByRole('button',{name:'Apply',exact:true}).waitFor({timeout:30000});
      await page.getByText('Here is your dashboard. Press Apply to save it.',{exact:true}).waitFor();
      check(`ask mode persisted config unchanged ${tag}`,JSON.stringify((await request('GET','/ui/config')).body.doc)===JSON.stringify(saved.doc));
      const effective=await page.evaluate(async()=>(await import('/src/customization/store.ts')).useCustomization.getState().effective.dashboards.map(d=>d.name));
      check(`Pending absent from navigation ${tag}`,!effective.includes('Open tasks'),effective);
      if(width>760) { await page.locator('.sidebar__disclosure').click(); check(`Pending absent from sidebar ${tag}`,await page.locator('.sidebar__dashboards').getByText('Open tasks',{exact:true}).count()===0); }
      await capture('preview-pending','.ui-preview-card',false);
      await card.getByRole('button',{name:'Apply',exact:true}).click();
      await page.waitForURL(/#dash\//);
      await page.goto(`${server.base}/${chat}`);
      card=page.getByRole('region',{name:'Create dashboard: Open tasks',exact:true});
      await card.getByText('Applied',{exact:true}).waitFor();
      await card.scrollIntoViewIfNeeded();
      check(`Applied has Open dashboard ${tag}`,await card.getByRole('button',{name:'Open dashboard',exact:true}).count()===1);
      check(`Applied reply no stale instruction ${tag}`,!(await page.locator('.transcript').innerText()).includes('Press Apply'));
      check(`Apply persists exactly one dashboard ${tag}`,(await request('GET','/ui/config')).body.doc.dashboards.length===saved.doc.dashboards.length+1);
      await capture('preview-applied','.ui-preview-card',false);
      const discardGoal='Create a dashboard for weekly planning.';
      server.scripts.set(discardGoal,'mock: create_dashboard {"name":"Weekly planning","template":"blank"} | say Here is another dashboard. Press Apply to save it.');
      await page.locator('.composer__input').fill(discardGoal); await page.getByRole('button',{name:'Send',exact:true}).click();
      card=page.getByRole('region',{name:'Create dashboard: Weekly planning',exact:true});
      await card.getByRole('button',{name:'Discard',exact:true}).waitFor({timeout:30000});
      await page.getByText('Here is another dashboard. Press Apply to save it.',{exact:true}).waitFor();
      await card.getByRole('button',{name:'Discard',exact:true}).click(); await card.getByText('Discarded',{exact:true}).waitFor();
      await page.waitForTimeout(100);
      check(`Discard leaves no dashboard ${tag}`,!(await request('GET','/ui/config')).body.doc.dashboards.some(d=>d.name==='Weekly planning'));
      check(`Discarded reply no stale instruction ${tag}`,!(await page.locator('.transcript').innerText()).includes('Press Apply'));
      await capture('preview-discarded','.ui-preview-card',false);
      // The production skill decision is a notice/event, not an assistant bubble.
      await page.evaluate(async id=>{const {useStore}=await import('/src/store.ts'); const state=useStore.getState(), prior=state.transcripts[id]; const rows=[['notice','Skill creation was declined: **Daily summary** with `draft`.'],['event','Skill creation was declined: **Launch planning** with `review`.']].map(([type,text],i)=>({botId:id,generation:prior.generation,seq:10000+i,updatedSeq:10000+i,createdAt:Date.now()+i,kind:type,body:{type,text}}));useStore.setState({transcripts:{...state.transcripts,[id]:{...prior,bySeq:Object.fromEntries(rows.map(row=>[row.seq,row]))}}});},account.bot.id);
      await page.locator('[data-row-seq="10001"]').scrollIntoViewIfNeeded(); await page.waitForTimeout(250);
      check(`declined safe bold and code ${tag}`,await page.locator('[data-row-seq="10000"] strong').count()===1&&await page.locator('[data-row-seq="10000"] code').count()===1&&await page.locator('[data-row-seq="10001"] strong').count()===1);
      await capture('declined-skill','.transcript',true);
      await page.context().close();
    }
  } catch(error) { if(page&&!page.isClosed())await page.screenshot({path:path.join(output,'failure.png')}); throw error; }
  finally { if(replay)await replay.close(); fs.writeFileSync(path.join(output,'server.log'),server.logs.join(''));await server.close();fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({passed:checks.filter(c=>c.passed).length,failed:checks.filter(c=>!c.passed).length,checks,screenshots},null,2)); }
  console.log(`FIX-DASH-4: ${checks.filter(c=>c.passed).length} passed, ${checks.filter(c=>!c.passed).length} failed. ${output}/results.json`);
  if(!before)assert.equal(checks.filter(c=>!c.passed).length,0,JSON.stringify(checks.filter(c=>!c.passed)));
  return checks;
}
if (process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) await runFixDash4({before:process.argv.includes('--before'),...(process.env.FIX_DASH4_OUTPUT?{output:process.env.FIX_DASH4_OUTPUT}:{}),...(process.env.FIX_DASH4_QUICK?{views:[[390,'light'],[1280,'light']]}:{})});
