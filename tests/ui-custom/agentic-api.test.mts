import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createHash } from 'node:crypto';
import { agentFixture } from './agent-fixture.mjs';
const server=await agentFixture();after(()=>server.close());
const bot=server.fixture.bot,userId=server.fixture.userId;
const foreign='qa-temp-agentic-api',token='fixture-agentic-other',at=Date.now();
server.db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(foreign,'other-api@example.test','Other workspace',at);
server.db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(?,?,?,?)').run(createHash('sha256').update(token).digest('hex'),foreign,at,at+3600000);
server.db.prepare('INSERT INTO account_preferences(user_id,updated_at,ui_widget_cost_cap_usd) VALUES(?,?,100) ON CONFLICT(user_id) DO UPDATE SET ui_widget_cost_cap_usd=100').run(userId,at);
const request=server.request;
const patch=[{op:'add',path:'/dashboards/-',value:{id:'$new1',name:'My work',icon:'layout-dashboard',widgets:[{id:'$new2',type:'agent',span:12,rows:3,options:{botId:bot.id,prompt:'mock: read_tasks_counts {} | say {last}',display:'text',schedule:'manual'}}]}}];
const configured=await request('PATCH','/ui/config',patch,0);assert.equal(configured.status,200,JSON.stringify(configured));
const saved=(await request('GET','/ui/config')).body,dashboard=saved.doc.dashboards[0],widget=dashboard.widgets[0];
const endpoint=`/ui/widgets/${dashboard.id}/${widget.id}`;
const wait=async()=>{for(let n=0;n<300;n++){const r=(await request('GET',`${endpoint}/result`)).body;if(r.state!=='running')return r;await new Promise(r=>setTimeout(r,50));}throw Error('Widget did not finish');};

test('widget REST inherits authentication, ownership, bounded JSON and strict bodies',async()=>{
  assert.equal((await fetch(`${server.api}/api${endpoint}/result`)).status,401);
  for(const [suffix,method] of [['result','GET'],['run','POST'],['action','POST']]){
    const r=await fetch(`${server.api}/api${endpoint}/${suffix}`,{method,headers:{cookie:`swarm_session=${token}`,origin:server.base,'content-type':'application/json'},...(method==='POST'?{body:JSON.stringify(suffix==='action'?{action:{type:'open',route:'#bots'}}:{})}:{})});assert.equal(r.status,404);
  }
  assert.equal((await request('POST',`${endpoint}/run`,{userId:foreign})).status,422);
  assert.equal((await fetch(`${server.api}/api${endpoint}/run`,{method:'POST',headers:{cookie:'swarm_session=layout-test-token',origin:server.base,'content-type':'application/json',connection:'close'},body:JSON.stringify({payload:'x'.repeat(300000)})})).status,413);
});
test('malicious mutation prompt causes no database mutation or unoffered tool dispatch',async()=>{
  const before=server.db.prepare('SELECT id,title,state,note FROM tasks ORDER BY id').all();
  const current=(await request('GET','/ui/config')).body;
  assert.equal((await request('PATCH','/ui/config',[{op:'replace',path:'/dashboards/0/widgets/0/options/prompt',value:'mock: delete_task {"id":"task_phoneqaPress"} | say deleted'}],current.revision)).status,200);
  assert.equal((await request('POST',`${endpoint}/run`,{})).status,202);
  const result=await wait();assert.equal(result.state,'error');assert.equal(result.doc,null);
  assert.deepEqual(server.db.prepare('SELECT id,title,state,note FROM tasks ORDER BY id').all(),before);
  const calls=await fetch(`${server.model}/_requests`).then(r=>r.json());
  const requests=Array.isArray(calls)?calls:calls.requests;
  const run=requests.find((r:any)=>r.body?.input?.some((item:any)=>item.role==='user'&&String(item.content).includes('mock: delete_task')));
  assert.ok(run);assert.ok(run.body.tools.every((tool:any)=>tool.name.startsWith('read_')));
});
test('open and send validate at the server and do not create a chat message',async()=>{
  const actions=[{type:'open',route:'#bots'},{type:'send',botId:bot.id,text:'Help with my tasks'}];
  server.db.prepare('UPDATE ui_widget_results SET state=?,doc=? WHERE user_id=? AND dashboard_id=? AND widget_id=?').run('ready',JSON.stringify({kind:'list',rows:actions.map(action=>({title:'Next step',action}))}),userId,dashboard.id,widget.id);
  const count=()=>server.db.prepare("SELECT COUNT(*) n FROM rows WHERE bot_id=? AND kind='message'").get(bot.id).n;
  const before=count();for(const action of actions){const response=await request('POST',`${endpoint}/action`,{action});assert.equal(response.status,200,JSON.stringify(response));assert.deepEqual(response.body.action,action);}
  assert.equal(count(),before);
  assert.equal((await request('POST',`${endpoint}/action`,{action:{type:'open',route:'https://example.test'}})).status,404);
  assert.equal((await request('POST',`${endpoint}/action`,{action:{type:'send',botId:'foreign',text:'Hi'}})).status,404);
});
test('approve requires confirmation, uses existing approval flow and audits the widget',async()=>{
  const seq=server.db.prepare('SELECT COALESCE(MAX(seq),0)+1 seq FROM rows').get().seq;
  const generation=server.db.prepare('SELECT generation FROM bots WHERE id=?').get(bot.id).generation;
  const approvalId='fixture-widget-approval',action={type:'approve',itemId:`approval:${approvalId}`};
  server.db.prepare('UPDATE bots SET next_seq=MAX(next_seq,?) WHERE id=?').run(seq+1,bot.id);
  server.db.prepare('INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES(?,?,?,?,?,?,?)').run(bot.id,generation,seq,seq,'card',JSON.stringify({type:'card',card:'approval',approvalId,title:'Review a local draft',tool:'fixture_read',args:{},status:'pending'}),Date.now());
  server.db.prepare("INSERT INTO approvals(id,bot_id,row_seq,call_id,tool,status,created_at) VALUES(?,?,?,?,?,'pending',?)").run(approvalId,bot.id,seq,'fixture-call','fixture_read',Date.now());
  server.db.prepare('UPDATE ui_widget_results SET doc=? WHERE user_id=? AND dashboard_id=? AND widget_id=?').run(JSON.stringify({kind:'list',rows:[{title:'Review draft',action}]}),userId,dashboard.id,widget.id);
  const unconfirmed=await request('POST',`${endpoint}/action`,{action});assert.equal(unconfirmed.status,422);assert.equal(unconfirmed.body.code,'confirmation_required');
  assert.equal(server.db.prepare('SELECT status FROM approvals WHERE id=?').get(approvalId).status,'pending');
  const confirmed=await request('POST',`${endpoint}/action`,{action,confirm:true});assert.equal(confirmed.status,200,JSON.stringify(confirmed));assert.equal(confirmed.body.status,'allowed');
  assert.equal(server.db.prepare('SELECT status FROM approvals WHERE id=?').get(approvalId).status,'allowed');
  assert.equal(JSON.parse(server.db.prepare('SELECT body FROM rows WHERE bot_id=? AND seq=?').get(bot.id,seq).body).status,'allowed');
  assert.equal(server.db.prepare('SELECT widget_id FROM ui_widget_actions WHERE user_id=? AND item_id=?').get(userId,action.itemId).widget_id,widget.id);
});
test('widget SSE invalidations reach only the owning session',async()=>{
  const controller=new AbortController(),own:string[]=[],other:string[]=[];
  const listen=async(cookie:string,received:string[])=>{
    const response=await fetch(`${server.api}/api/events`,{headers:{cookie:`swarm_session=${cookie}`},signal:controller.signal});
    assert.equal(response.status,200);const reader=response.body!.getReader();
    return (async()=>{try{while(true){const chunk=await reader.read();if(chunk.done)break;received.push(new TextDecoder().decode(chunk.value));}}catch{ /* Aborted after assertions. */ }})();
  };
  const first=listen('layout-test-token',own),second=listen(token,other);
  try{
    for(let n=0;n<100 && (!own.join('').includes('hello') || !other.join('').includes('hello'));n++)await new Promise(r=>setTimeout(r,10));
    assert.ok(own.join('').includes('hello'));assert.ok(other.join('').includes('hello'));
    assert.equal((await request('POST',`${endpoint}/run`,{})).status,202);await wait();
    for(let n=0;n<100 && !own.join('').includes('ui_widget');n++)await new Promise(r=>setTimeout(r,10));
    assert.match(own.join(''),/ui_widget/);assert.match(own.join(''),new RegExp(widget.id));assert.doesNotMatch(other.join(''),/ui_widget/);
  }finally{controller.abort();await Promise.all([first,second]);}
});
test('disabled flag and cost cap reject before admitting new runs',async()=>{
  const count=()=>server.db.prepare('SELECT COUNT(*) n FROM ui_widget_runs WHERE user_id=?').get(userId).n,before=count();
  server.db.prepare('UPDATE account_preferences SET ui_widget_cost_cap_usd=0 WHERE user_id=?').run(userId);
  const capped=await request('POST',`${endpoint}/run`,{});assert.equal(capped.status,429);assert.equal(capped.body.code,'cost_cap');
  server.db.prepare('UPDATE account_preferences SET ui_agent_widgets=0 WHERE user_id=?').run(userId);
  assert.equal((await request('POST',`${endpoint}/run`,{})).status,404);assert.equal((await request('GET',`${endpoint}/result`)).status,404);assert.equal(count(),before);
});
