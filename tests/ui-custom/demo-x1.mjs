import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { agentFixture } from './agent-fixture.mjs';

const output=path.resolve('.context/ui-custom/demo-x1');fs.mkdirSync(output,{recursive:true});
const server=await agentFixture();
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']});
const transcript=[],screenshots=[];let passed=0;
const check=(name,details)=>{passed++;transcript.push({name,details});console.log(`PASS ${name}`);};
const wait=async predicate=>{for(let n=0;n<300;n++){const result=await predicate();if(result)return result;await new Promise(r=>setTimeout(r,100));}throw Error(`Timed out: ${server.logs.slice(-12).join('')}`);};
const bot=server.fixture.bot;
const userId=server.db.prepare('SELECT user_id FROM bots WHERE id=?').get(bot.id).user_id;
// Fixture-only account cap. Do not let seeded historic usage consume this demo's budget.
server.db.prepare('INSERT INTO account_preferences(user_id,updated_at,ui_widget_cost_cap_usd) VALUES(?,?,100) ON CONFLICT(user_id) DO UPDATE SET ui_widget_cost_cap_usd=100').run(userId,Date.now());
const propose=async(tool,args)=>{
  const before=server.db.prepare('SELECT COALESCE(MAX(seq),0) seq FROM rows WHERE bot_id=?').get(bot.id).seq;
  // Protect nested widget scripts from the outer mock script separator.
  const json=JSON.stringify(args).replace(/\|/g,'\\u007c');
  const sent=await server.request('POST',`/bots/${bot.id}/messages`,{text:`Build the dashboard I requested. mock: ${tool} ${json} | say Review the dashboard preview.`});
  assert.equal(sent.status,200,JSON.stringify(sent));
  const row=await wait(()=>server.db.prepare("SELECT body FROM rows WHERE bot_id=? AND seq>? AND kind='card' AND json_extract(body,'$.card')='ui_preview' ORDER BY seq DESC LIMIT 1").get(bot.id,before));
  const card=JSON.parse(row.body);await wait(()=>server.db.prepare('SELECT state FROM agent_jobs WHERE id=?').get(card.jobId)?.state==='completed');
  return card;
};
const apply=async card=>{const before=(await server.request('GET','/ui/config')).body;const result=await server.request('POST',`/ui/previews/${card.previewId}/apply`,{},before.revision);assert.equal(result.status,200,JSON.stringify(result));return (await server.request('GET','/ui/config')).body;};
try{
  const context=await browser.newContext({viewport:{width:1280,height:900}});
  await context.addCookies([{name:'swarm_session',value:'layout-test-token',url:server.base}]);
  await context.route('**/*',route=>['localhost','127.0.0.1'].includes(new URL(route.request().url()).hostname)?route.continue():route.abort());
  const page=await context.newPage();await page.goto(`${server.base}/#bot/${bot.id}`);
  const initial=(await server.request('GET','/ui/config')).body;
  const card=await propose('preview_ui_patch',{intent:'Add my work dashboard',patch:[{op:'add',path:'/dashboards/-',value:{id:'$new1',name:'My work',icon:'layout-dashboard',widgets:[
    {id:'$new2',type:'agent',title:'Latest task',span:12,rows:3,options:{prompt:`mock: read_tasks_counts {"botId":"${bot.id}"} | say {last}`,botId:bot.id,display:'list',schedule:'manual'}},
    {id:'$new3',type:'list',title:'Tasks',span:12,rows:3,source:{id:'tasks.list',params:{botId:bot.id}},options:{limit:5}},
  ]}}]});
  assert.equal((await server.request('GET','/ui/config')).body.revision,initial.revision);
  assert.equal((await server.request('GET',`/ui/previews/${card.previewId}`)).body.result.dashboards.at(-1).widgets[0].type,'agent');
  await page.reload();await page.getByText('Add my work dashboard',{exact:true}).first().waitFor();
  for(const width of [390,1280]){await page.setViewportSize({width,height:900});await page.waitForTimeout(200);const file=path.join(output,`chat-preview-${width}.png`);await page.getByRole('region',{name:'Add my work dashboard',exact:true}).screenshot({path:file});screenshots.push(file);}
  check('chat creates an agent widget preview and waits for Apply',{previewId:card.previewId});
  let config=await apply(card);const dashboard=config.doc.dashboards.at(-1),widget=dashboard.widgets[0];
  assert.deepEqual(config.doc.layout,initial.doc.layout);check('apply persists the dashboard without changing layout',{dashboardId:dashboard.id});
  const endpoint=`/ui/widgets/${dashboard.id}/${widget.id}`;
  assert.equal((await server.request('GET',`${endpoint}/result`)).body.state,'empty');
  let run=await server.request('POST',`${endpoint}/run`,{});assert.equal(run.status,202,JSON.stringify(run));
  const result=await wait(async()=>{const r=(await server.request('GET',`${endpoint}/result`)).body;return r.state!=='running'?r:null;});
  assert.equal(result.state,'ready',JSON.stringify(result));
  const expectedTitle=()=>{const counts=server.db.prepare("SELECT SUM(state='working') working,SUM(state='needs_input') needs_input,SUM(state='done') done,COUNT(*) total FROM tasks WHERE bot_id=?").get(bot.id);return Object.entries(counts).map(([k,v])=>`${k}: ${v}`).join(', ');};
  const expected=expectedTitle();
  assert.equal(result.doc.rows[0].title,expected);assert.ok(result.runAt);check('widget result comes from seeded database rows through the mock read tool',result);
  // Change a fixture row: the second result must reflect the database, not a provider literal.
  server.db.prepare("UPDATE tasks SET state=CASE WHEN state='done' THEN 'working' ELSE 'done' END WHERE id=(SELECT id FROM tasks WHERE bot_id=? ORDER BY updated_at DESC,id LIMIT 1)").run(bot.id);
  run=await server.request('POST',`${endpoint}/run`,{});assert.equal(run.status,202);
  const refreshed=await wait(async()=>{const r=(await server.request('GET',`${endpoint}/result`)).body;return r.state==='ready'?r:null;});
  assert.equal(refreshed.doc.rows[0].title,expectedTitle());assert.notEqual(refreshed.doc.rows[0].title,expected);await page.reload();
  assert.deepEqual((await server.request('GET',`${endpoint}/result`)).body.doc,refreshed.doc);check('refresh reads changed data and result persists across reload',refreshed);
  config=await apply(await propose('duplicate_dashboard',{dashboardId:dashboard.id,name:'Work copy'}));
  const copy=config.doc.dashboards.at(-1);assert.notEqual(copy.id,dashboard.id);assert.notEqual(copy.widgets[0].id,widget.id);check('chat duplicates with independent ids',{dashboardId:copy.id});
  config=await apply(await propose('rename_dashboard',{dashboardId:copy.id,name:'Weekly work'}));assert.equal(config.doc.dashboards.at(-1).name,'Weekly work');
  config=await apply(await propose('reorder_dashboards',{dashboardIds:[copy.id,dashboard.id]}));assert.equal(config.doc.dashboards[0].id,copy.id);check('chat renames and reorders dashboards',config.doc.dashboards.map(d=>({id:d.id,name:d.name})));
  config=await apply(await propose('delete_dashboard',{dashboardId:copy.id}));assert.equal(config.doc.dashboards.length,1);check('chat deletes the duplicated dashboard',config.revision);
  const foreign='qa-temp-widget-other',token='fixture-widget-other',at=Date.now();
  server.db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(foreign,'other@example.test','Other workspace',at);
  server.db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(?,?,?,?)').run(createHash('sha256').update(token).digest('hex'),foreign,at,at+3600000);
  for(const suffix of ['result','run','action']){
    const response=await fetch(`${server.api}/api${endpoint}/${suffix}`,{method:suffix==='result'?'GET':'POST',headers:{cookie:`swarm_session=${token}`,origin:server.base,'content-type':'application/json'},...(suffix==='result'?{}:{body:JSON.stringify(suffix==='action'?{action:{type:'open',route:'#bots'}}:{})})});
    assert.equal(response.status,404);
  }
  check('other accounts cannot read, run or act on widget results',{status:404});
  // Twenty admitted runs in the same rolling hour, including the two above.
  for(let n=2;n<20;n++){const r=await server.request('POST',`${endpoint}/run`,{});assert.equal(r.status,202,JSON.stringify(r));await wait(async()=>(await server.request('GET',`${endpoint}/result`)).body.state!=='running');}
  const limited=await server.request('POST',`${endpoint}/run`,{});assert.equal(limited.status,429);assert.equal(limited.body.code,'rate_limited');check('twenty runs per hour quota is enforced',limited);
  const modelRequests=await fetch(`${server.model}/_requests`).then(r=>r.json());
  fs.writeFileSync(path.join(output,'model-requests.json'),JSON.stringify(modelRequests,null,2));
  fs.writeFileSync(path.join(output,'transcript.json'),JSON.stringify({passed,transcript,screenshots},null,2));
  console.log(`Demo X1: ${passed}/${passed} scenarios passed; output ${output}`);
}finally{await browser.close();fs.writeFileSync(path.join(output,'server.log'),server.logs.join(''));await server.close();}
