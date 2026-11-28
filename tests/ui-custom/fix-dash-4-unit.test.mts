import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { SqliteUiConfigService } from '../../server/src/ui/service.ts';
import { WidgetService } from '../../server/src/ui/widget-service.ts';
import { runAgentWidget, parseWidgetAnswer } from '../../server/src/ui/widget-runner.ts';
import { previewMessageRows } from '../../web/src/lib/previewMessages.ts';
import type { Row } from '../../server/src/types.ts';

test('real service deadline aborts the runner, reports timeout, and rejects late provider output', async t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  db.exec("CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES('local-user'); CREATE TABLE bots(id TEXT PRIMARY KEY,user_id TEXT,name TEXT,kind TEXT,hidden INTEGER DEFAULT 0,created_at INTEGER); INSERT INTO bots VALUES('local-bot','local-user','Coordinator','agent',0,1)");
  const config = new SqliteUiConfigService(db, {flag:()=> 'on'});
  assert.ok(config.patch('local-user',[{op:'add',path:'/dashboards/-',value:{id:'d_00000001',name:'Daily summary',icon:'layout-dashboard',widgets:[{id:'w_00000001',type:'agent',span:12,rows:3,options:{prompt:'Say hello.',display:'text',schedule:'manual'}}]}}],0,'user').ok);
  let signal: AbortSignal, finish: (value: any) => void;
  const log=t.mock.method(console,'warn',()=>{});
  const service = new WidgetService(db,config,{timeoutMs:15,provider:()=> 'codex-cli',accountAllowed:()=>true,accountCost:()=>0,
    run:ctx=>runAgentWidget({...ctx,model:async(_input,_tools,s)=>{signal=s;return new Promise(resolve=>{finish=resolve;});},read:async()=>{throw Error('No data needed');},record:async()=>{throw Error('Late output must never be recorded');}})});
  assert.equal(service.run('local-user','d_00000001','w_00000001').state,'running');
  await service.idle('local-user');
  assert.equal(signal!.aborted,true);
  assert.equal(service.result('local-user','d_00000001','w_00000001').error,'The answer took too long. Try again.');
  finish!({output:[{type:'message',content:[{type:'output_text',text:'Late reply.'}]}]});
  await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(service.result('local-user','d_00000001','w_00000001').doc,null);
  const entry=JSON.parse(log.mock.calls[0].arguments[0]);
  assert.equal(entry.reason,'timeout');assert.equal(entry.provider,'codex-cli');assert.equal(entry.widgetId,'w_00000001');
  assert.match(entry.userIdHash,/^[a-f0-9]{16}$/);assert.doesNotMatch(JSON.stringify(entry),/local-user|Say hello/);
});

test('plain fallback preserves the same secret, markup and size validation as typed results',()=>{
  for(const text of ['<script>alert(1)</script>','x'.repeat(1201),'{"kind":"list","rows":[{"title":"Open","action":{"type":"delete"}}]}','```json\n{"kind":"text"}\n```']) assert.throws(()=>parseWidgetAnswer(text),/format was invalid/);
  assert.deepEqual(parseWidgetAnswer('Summary: {"kind":"text","text":"A brace } and a quote \\\" stay readable."} All set.'),{kind:'text',text:'A brace } and a quote " stay readable.'});
});

const row=(seq:number,body:any):Row=>({botId:'local-bot',generation:1,seq,updatedSeq:seq,createdAt:seq,kind:body.type,body});
for(const status of ['applied','discarded'] as const) test(`${status} preview rewrites only the associated assistant turn`,()=>{
  const rows=[row(1,{type:'card',card:'ui_preview',previewId:'preview',jobId:'turn',status:'pending'}),
    row(2,{type:'message',role:'assistant',jobId:'turn',text:'Here is your dashboard. Press Apply to save it.'}),
    row(3,{type:'message',role:'user',jobId:'turn',text:'Press Apply to save it.'}),
    row(4,{type:'message',role:'assistant',jobId:'other-turn',text:'Press Apply to save it.'})];
  const result=previewMessageRows(rows,{preview:status});
  assert.equal((result[1].body as any).text,'Here is your dashboard.');
  assert.equal(result[2],rows[2]);assert.equal(result[3],rows[3]);
  assert.equal((rows[1].body as any).text,'Here is your dashboard. Press Apply to save it.','stored history stays unchanged');
  assert.deepEqual(previewMessageRows(rows,{preview:'pending'}),rows);
  assert.deepEqual(previewMessageRows([...rows,row(5,{type:'card',card:'ui_preview',previewId:'pending',jobId:'turn',status:'pending'})],{preview:status}).slice(0,4),rows);
});

test('companion empty, malformed and cancellation errors retain specific reason codes',async()=>{
  const { widgetFailure }=await import('../../server/src/ui/widget-failure.ts');
  for(const [message,reason] of [
    ['Codex returned empty structured output.','empty'],
    ['Claude returned malformed structured output.','parse'],
    ['Codex did not return a readable structured output file.','parse'],
    ['CLI output exceeded the 8 MB limit.','parse'],
    ['CLI request cancelled.','cancelled'],
  ]) assert.equal(widgetFailure(new Error(message),'provider_unavailable'),reason);
});
