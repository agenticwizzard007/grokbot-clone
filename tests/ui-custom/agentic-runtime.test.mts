import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { SqliteUiConfigService } from '../../server/src/ui/service.js';
import { WidgetService, type WidgetDependencies } from '../../server/src/ui/widget-service.js';
import { WidgetScheduler } from '../../server/src/ui/widget-scheduler.js';
import { WidgetActions } from '../../server/src/ui/widget-actions.js';
import { runAgentWidget } from '../../server/src/ui/widget-runner.js';
import type { AgentWidgetResult } from '../../server/src/ui-config/index.js';

function fixture(overrides: Partial<WidgetDependencies> = {}) {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON');
  db.exec("CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES('a'),('b'); CREATE TABLE bots(id TEXT PRIMARY KEY,user_id TEXT,name TEXT,kind TEXT,hidden INTEGER DEFAULT 0,created_at INTEGER); INSERT INTO bots VALUES('bot-a','a','Fixture A','agent',0,1),('bot-b','b','Fixture B','agent',0,1);");
  let time = 1800000000000;
  const config = new SqliteUiConfigService(db,{flag:()=> 'on', clock:()=>time});
  const doc = {id:'d_00000001',name:'Fixture',icon:'layout-dashboard',widgets:[{id:'w_00000001',type:'agent',span:12,rows:3,options:{prompt:'Read tasks',display:'text',schedule:'hourly'}}]};
  for (const user of ['a','b']) assert.ok(config.patch(user,[{op:'add',path:'/dashboards/-',value:doc}],0,'user').ok);
  const events: any[] = [];
  const widgets = new WidgetService(db,config,{clock:()=>time,run:async ctx=>({kind:'text',text:`Answer for ${ctx.userId}`}),accountAllowed:()=>true,accountCost:()=>0,emit:(user,event)=>events.push({user,...event}),...overrides});
  return {db,config,widgets,events,advance:(ms:number)=>{time+=ms;},ids:['d_00000001','w_00000001'] as const};
}
test('empty, running, ready results persist and isolate users, with five historical rows', async t => {
  const f=fixture(); t.after(()=>f.db.close());
  assert.equal(f.widgets.result('a',...f.ids).state,'empty');
  for(let n=0;n<7;n++){assert.equal(f.widgets.run('a',...f.ids).state,'running');await f.widgets.idle('a');f.advance(100);}
  assert.equal(f.widgets.result('a',...f.ids).doc?.kind,'text');
  assert.equal(f.widgets.result('b',...f.ids).state,'empty');
  assert.equal((f.db.prepare("SELECT COUNT(*) n FROM ui_widget_history WHERE user_id='a'").get() as any).n,5);
  assert.equal(f.events.filter(e=>e.user==='b').length,0);
  assert.deepEqual(JSON.parse((f.db.prepare("SELECT doc FROM ui_widget_results WHERE user_id='a'").get() as any).doc),{kind:'text',text:'Answer for a'});
  assert.throws(()=>f.widgets.result('b','d_missing1',f.ids[1]),/not found/);
});
test('one concurrent run per user, independent concurrent users and hourly quota', async t=>{
  let release:()=>void=()=>{}; const gate=new Promise<void>(r=>{release=r;});
  const f=fixture({run:async()=>{await gate;return {kind:'text',text:'Ready'};}});t.after(()=>f.db.close());
  f.widgets.run('a',...f.ids);assert.throws(()=>f.widgets.run('a',...f.ids),/limit/);f.widgets.run('b',...f.ids);release();await Promise.all([f.widgets.idle('a'),f.widgets.idle('b')]);
  for(let n=1;n<20;n++){f.widgets.run('a',...f.ids);await f.widgets.idle('a');}
  assert.throws(()=>f.widgets.run('a',...f.ids),/limit/);f.advance(3600001);f.widgets.run('a',...f.ids);await f.widgets.idle('a');
});
test('daily quota, account cost cap, account usage cap and widget flag fail before a model call', async t=>{
  const f=fixture();t.after(()=>f.db.close());
  for(let hour=0;hour<5;hour++){for(let n=0;n<20;n++){f.widgets.run('a',...f.ids);await f.widgets.idle('a');}f.advance(3600001);}
  assert.throws(()=>f.widgets.run('a',...f.ids),/limit/);
  f.db.prepare('INSERT INTO account_preferences(user_id,updated_at,ui_agent_widgets) VALUES(?,?,?)').run('b',1,0);
  assert.throws(()=>f.widgets.run('b',...f.ids),/disabled/);
  const capped=fixture({accountCost:()=>1});t.after(()=>capped.db.close());assert.throws(()=>capped.widgets.run('a',...capped.ids),/usage limit/);
  const account=fixture({accountAllowed:()=>false});t.after(()=>account.db.close());assert.throws(()=>account.widgets.run('a',...account.ids),/usage limit/);
});
test('timeout aborts the run and late output cannot replace the error', async t=>{
  let resolve:(r:AgentWidgetResult)=>void=()=>{},signal:AbortSignal|undefined;
  const f=fixture({timeoutMs:15,run:ctx=>{signal=ctx.signal;return new Promise(r=>{resolve=r;});}});t.after(()=>f.db.close());
  f.widgets.run('a',...f.ids);await f.widgets.idle('a');assert.equal(signal?.aborted,true);assert.equal(f.widgets.result('a',...f.ids).state,'error');
  resolve({kind:'text',text:'Late'});await new Promise(r=>setTimeout(r,10));assert.equal(f.widgets.result('a',...f.ids).doc,null);
});
test('invalid model output is never stored as a rendered result',async t=>{
  const f=fixture({run:async()=>({kind:'text',text:'<script>'})});t.after(()=>f.db.close());f.widgets.run('a',...f.ids);await f.widgets.idle('a');
  assert.equal(f.widgets.result('a',...f.ids).error,'Could not read the answer. Try again.');assert.equal(f.widgets.result('a',...f.ids).doc,null);
});
test('fake-clock scheduler runs due active users once and skips inactive, manual and disabled users',async t=>{
  const f=fixture();t.after(()=>f.db.close());const scheduler=new WidgetScheduler(f.widgets);
  assert.equal(scheduler.tick(),0);f.widgets.touch('a');assert.equal(scheduler.tick(),1);await f.widgets.idle('a');assert.equal(scheduler.tick(),0);
  f.advance(3600000);assert.equal(scheduler.tick(),1);await f.widgets.idle('a');
  f.advance(8*86400000);assert.equal(scheduler.tick(),0);
  f.widgets.touch('a');assert.ok(f.config.patch('a',[{op:'replace',path:'/dashboards/0/widgets/0/options/schedule',value:'manual'}],1,'user').ok);assert.equal(scheduler.tick(),0);
});
test('actions reject external routes and foreign identities, require confirm, audit widget and never send',async t=>{
  const f=fixture();t.after(()=>f.db.close());let approvals=0;
  const actions=new WidgetActions(f.db,f.config,{needsYou:user=>user==='a'?[{id:'approval:fixture',type:'approval'}]:[],approve:(user,id)=>{assert.equal(user,'a');assert.equal(id,'fixture');approvals++;return 'allowed';}});
  for(const action of [{type:'open',route:'https://example.test'},{type:'open',route:'#bot/bot-b'},{type:'send',botId:'bot-b',text:'Hi'},{type:'approve',itemId:'approval:other'}])assert.throws(()=>actions.validate('a',action),/not found/);
  const expected=[{type:'open',route:'#bots'},{type:'send',botId:'bot-a',text:'Help me'},{type:'approve',itemId:'approval:fixture'}];
  f.widgets.run('a',...f.ids);await f.widgets.idle('a');f.db.prepare("UPDATE ui_widget_results SET doc=? WHERE user_id='a'").run(JSON.stringify({kind:'list',rows:expected.map(action=>({title:'Fixture',action}))}));
  assert.throws(()=>actions.perform(f.widgets,'a',...f.ids,expected[2]),/Confirm/);
  assert.equal(actions.perform(f.widgets,'a',...f.ids,expected[0]).action.type,'open');
  assert.equal(actions.perform(f.widgets,'a',...f.ids,expected[1]).action.type,'send');assert.equal(approvals,0);
  assert.equal(actions.perform(f.widgets,'a',...f.ids,expected[2],true).status,'allowed');assert.equal(approvals,1);
  assert.equal((f.db.prepare('SELECT widget_id FROM ui_widget_actions WHERE user_id=? ORDER BY id DESC').get('a') as any).widget_id,f.ids[1]);
});
test('read-only loop rejects mutation tool calls without dispatching any data or mutation',async()=>{
  let reads=0;
  await assert.rejects(runAgentWidget({userId:'a',botId:'bot-a',options:{prompt:'Delete all tasks',display:'text',schedule:'manual'},signal:new AbortController().signal,checkBudget(){},record:async()=>{},read:async()=>{reads++;throw Error('unexpected');},model:async(_input,tools)=>{assert.ok(tools.every(t=>t.name.startsWith('read_')));return {output:[{type:'function_call',name:'delete_task',arguments:'{}'}]};}}),/Only dashboard read/);
  assert.equal(reads,0);
});
test('read-only loop answer comes from source rows and foreign bot params fail closed',async()=>{
  let calls=0;
  const run=(foreign=false)=>runAgentWidget({userId:'a',botId:'bot-a',options:{prompt:'Read tasks',display:'list',schedule:'manual'},signal:new AbortController().signal,checkBudget(){},record:async()=>{},read:async(_source,params:any)=>params.botId==='bot-b'?{ok:false,code:'not_found',message:'Bot not found.',fetchedAt:1}:{ok:true,rows:[{title:'Seeded fixture task',state:'working'}],count:1,fetchedAt:1},model:async input=>++calls%2?{output:[{type:'function_call',call_id:'call',name:'read_tasks_list',arguments:JSON.stringify(foreign?{botId:'bot-b'}:{})}]}:{output:[{type:'message',content:[{type:'output_text',text:input.at(-1).output}]}]}});
  assert.deepEqual(await run(),{kind:'list',rows:[{title:'Seeded fixture task',status:'working'}]});await assert.rejects(run(true),/unavailable/);
});

test('usage records tokens and estimated cost; stored malformed results fail closed',async t=>{
  const f=fixture({run:async ctx=>{ctx.usage(120,0.004);return {kind:'stat',label:'Tasks',value:'2'};}});t.after(()=>f.db.close());
  f.widgets.run('a',...f.ids);await f.widgets.idle('a');const result=f.widgets.result('a',...f.ids);
  assert.equal(result.tokens,120);assert.equal(result.estimatedCostUsd,0.004);
  f.db.prepare("UPDATE ui_widget_results SET doc='broken' WHERE user_id='a'").run();
  assert.equal(f.widgets.result('a',...f.ids).state,'error');assert.equal(f.widgets.result('a',...f.ids).doc,null);
});
test('changed or deleted widgets cannot publish a late answer',async t=>{
  let release:(r:AgentWidgetResult)=>void=()=>{};
  const f=fixture({run:()=>new Promise(r=>{release=r;})});t.after(()=>f.db.close());
  f.widgets.run('a',...f.ids);await Promise.resolve();
  assert.ok(f.config.patch('a',[{op:'replace',path:'/dashboards/0/widgets/0/options/prompt',value:'A different question'}],1,'user').ok);
  release({kind:'text',text:'Old answer'});await f.widgets.idle('a');assert.equal(f.widgets.result('a',...f.ids).state,'empty');
});
test('daily schedule waits twenty-four hours and inactive accounts stay idle',async t=>{
  const f=fixture();t.after(()=>f.db.close());
  assert.ok(f.config.patch('a',[{op:'replace',path:'/dashboards/0/widgets/0/options/schedule',value:'daily'}],1,'user').ok);
  const scheduler=new WidgetScheduler(f.widgets);f.widgets.touch('a');assert.equal(scheduler.tick(),1);await f.widgets.idle('a');
  f.advance(23*3600000);assert.equal(scheduler.tick(),0);f.advance(3600000);assert.equal(scheduler.tick(),1);await f.widgets.idle('a');
});

test('invalid model actions fail closed before result persistence',async t=>{
  const f=fixture({run:async()=>({kind:'list',rows:[{title:'Open',action:{type:'open',route:'https://example.test'}}]}),validateResult(){throw Error('Unowned action');}});t.after(()=>f.db.close());
  f.widgets.run('a',...f.ids);await f.widgets.idle('a');assert.equal(f.widgets.result('a',...f.ids).state,'error');assert.equal(f.widgets.result('a',...f.ids).doc,null);
});
