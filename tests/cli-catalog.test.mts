// Account-scoped CLI discovery/control protocol and generation flags. No live inference.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readCatalog, runGeneration } from '../companion/cli-bridge.mjs';

async function fixture(t: any, provider: 'codex' | 'claude', extra: any = {}) {
  const root = await mkdtemp(join(tmpdir(), 'swarm-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'cli.mjs'), auditFile = join(root, 'audit');
  const name = `${provider}-account-special`;
  const config = { provider, name, ...extra };
  await writeFile(file, `#!${process.execPath}
import fs from 'node:fs';
import { createInterface } from 'node:readline';
const config = ${JSON.stringify(config)}, args = process.argv.slice(2);
const audit = data => fs.appendFileSync(${JSON.stringify(auditFile)}, JSON.stringify(data)+'\\n');
const send = value => console.log(JSON.stringify(value));
audit({args, cwd:process.cwd(), leakedKey:process.env.OPENAI_API_KEY});
if (args[0]==='login') { console.error(config.authBad ? 'Logged in using an API key' : 'Logged in using ChatGPT'); process.exit(0); }
if (args[0]==='auth') { send({loggedIn:true,authMethod:'claude.ai',subscriptionType:config.authBad?'console':'max'}); process.exit(0); }
if (args[0]==='exec') {
  let input='';for await(const chunk of process.stdin)input+=chunk;
  audit({generation:true,args,input}); fs.writeFileSync(args[args.indexOf('--output-last-message')+1],'{"text":"ok","tool_calls":[]}');
  send({type:'turn.completed',usage:{input_tokens:20,output_tokens:5}});
} else {
 const input=createInterface({input:process.stdin});let prompt='';
 input.on('line',line=>{
  const r=JSON.parse(line); audit({request:r});
  const method=r.method??r.request?.subtype;
  if(!method) { prompt+=line; return; }
  const reply = value => send(config.provider==='codex'?{id:r.id,result:value}:{type:'control_response',response:{subtype:'success',request_id:r.request_id,response:value}});
  const error = () => send(config.provider==='codex'?{id:r.id,error:{message:'private-sentinel'}}:{type:'control_response',response:{subtype:'error',request_id:r.request_id,error:'private-sentinel'}});
  if(config.hold) return;
  if(method==='initialized')return;
  if(method==='initialize')reply(config.provider==='codex'?{}:{account:{subscriptionType:config.accountBad?null:config.accountPlan??'max',apiProvider:config.apiProvider??'firstParty',tokenSource:config.tokenSource,email:'secret@example.test'},models:[{value:config.name,displayName:'Account Claude',supportsEffort:true,supportedEffortLevels:['low','high']},{value:'default',displayName:'Account default',supportsEffort:false}]});
  if(method==='account/read')reply({account:{type:config.accountBad?'apiKey':'chatgpt',planType:'pro',email:'secret@example.test'}});
  if(method==='model/list')reply({data:[{model:r.params.cursor?'account-text':config.name,displayName:r.params.cursor?'Text model':'Account Codex',isDefault:!r.params.cursor,hidden:false,supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}],defaultReasoningEffort:'high',inputModalities:r.params.cursor?['text']:['text','image']}],nextCursor:r.params.cursor?null:'second'});
  if(config.holdUsage && ['account/rateLimits/read','get_usage'].includes(method))return;
  if(method==='account/rateLimits/read')config.usageBad?error():reply({rateLimitsByLimitId:{main:{limitName:'Account window',primary:{usedPercent:37,windowDurationMins:300,resetsAt:1800000000}},secondary:{primary:{usedPercent:0,windowDurationMins:10080,resetsAt:1800000001}}}});
  if(method==='get_usage')config.usageBad?error():reply({subscription_type:'max',rate_limits_available:true,rate_limits:{limits:[{kind:'weekly_scoped',group:'weekly',percent:61,resets_at:'2027-01-01T00:00:00Z',scope:{model:{display_name:'Account model'}}}]}});
 });
 input.on('close',()=>{if(args.includes('--json-schema')){audit({generation:true,args,input:prompt});send({type:'result',structured_output:{text:'ok',tool_calls:[]},modelUsage:{[config.name]:{}},usage:{input_tokens:5,output_tokens:2}});}});
}
`, { mode: 0o700 });
  const options = { [`${provider}Path`]: file, env: { PATH: process.env.PATH, HOME: root, OPENAI_API_KEY: 'forbidden' }, fileCredentials: true };
  return { options, name, audit: async () => (await readFile(auditFile, 'utf8')).trim().split('\n').map(JSON.parse) };
}
for (const provider of ['codex','claude'] as const) {
  test(`${provider}: discover actual account models, efforts and quota without inference or auth leakage`, async t => {
    const f = await fixture(t, provider);
    const catalog = await readCatalog({provider},f.options);
    assert.equal(catalog.models[0].id,`${provider}/${f.name}`);
    assert.deepEqual(catalog.models[0].efforts,['low','high']);
    assert.equal(catalog.plan,provider==='codex'?'pro':'max');
    assert.equal(catalog.usage.available,true);
    assert.equal(catalog.usage.windows[0].usedPercent,provider==='codex'?37:61);
    assert.ok(catalog.usage.checkedAt <= Date.now());
    assert.doesNotMatch(JSON.stringify(catalog),/secret@example|private-sentinel/);
    const audit = await f.audit();
    assert.ok(audit.every(a=>!a.generation&&!a.leakedKey));
    assert.ok(audit.filter(a=>a.request).every(a=>!['turn/start','thread/start','user'].includes(a.request.method??a.request.type)));
    if(provider==='codex') {
      assert.equal(catalog.models.length,2);
      assert.equal(catalog.models[1].vision,false);
      assert.equal(catalog.usage.windows[1].usedPercent,0,'reported zero is distinct from unavailable');
      assert.equal(audit.filter(a=>a.request?.method==='model/list').length,2);
    }
  });
  test(`${provider}: usage failure preserves model catalog but never fabricates zero quota`, async t => {
    const f = await fixture(t,provider,{usageBad:true});
    const catalog = await readCatalog({provider},f.options);
    assert.ok(catalog.models.length);
    assert.equal(catalog.usage.available,false);
    assert.deepEqual(catalog.usage.windows,[]);
  });
  test(`${provider}: API login cannot discover subscription models`, async t => {
    const f=await fixture(t,provider,{authBad:true});
    await assert.rejects(readCatalog({provider},f.options),/subscription login/);
    assert.equal((await f.audit()).length,1);
  });
  test(`${provider}: selected model, effort and image reach isolated generation`, async t => {
    const f=await fixture(t,provider);
    const result=await runGeneration({provider,model:f.name,effort:'high',prompt:'Image test',schema:{type:'object'},images:[{mediaType:'image/png',data:'aGVsbG8='}],timeoutMs:4000},f.options);
    assert.equal(result.model,f.name);
    const call=(await f.audit()).find(a=>a.generation);
    assert.equal(call.args[call.args.indexOf('--model')+1],f.name);
    if(provider==='codex') { assert.ok(call.args.includes('model_reasoning_effort="high"')); assert.ok(call.args.includes('--image')); }
    else { assert.equal(call.args[call.args.indexOf('--effort')+1],'high'); assert.match(call.input,/"type":"image"/); }
  });
  test(`${provider}: cancellation stops catalog subprocess and cleans temporary cwd`, async t => {
    const f=await fixture(t,provider,{hold:true});const controller=new AbortController();
    const request=readCatalog({provider},{...f.options,signal:controller.signal});
    setTimeout(()=>controller.abort(),200);
    await assert.rejects(request,/cancelled/);
    for(const a of await f.audit()) if(a.cwd) await assert.rejects(readFile(join(a.cwd,'anything')),/ENOENT/);
  });
}
test('Codex independently checks account identity after its login status probe',async t=>{
  const f=await fixture(t,'codex',{accountBad:true});
  await assert.rejects(readCatalog({provider:'codex'},f.options),/ChatGPT plan login/);
});
test('runner rejects argument-injection models and invented effort modes before starting a CLI',async()=>{
  for(const extra of [{model:'--bad'},{model:'openai/model'},{model:'x\n--bad'},{effort:'ultracode'}]) await assert.rejects(runGeneration({provider:'codex',prompt:'x',schema:{},timeoutMs:1000,...extra}),/Invalid CLI/);
});

test('Claude independently rechecks subscription identity from initialize',async t=>{
 const f=await fixture(t,'claude',{accountBad:true});
 await assert.rejects(readCatalog({provider:'claude'},f.options),/authentication changed/);
});
test('Claude initialize accepts native display plan labels after verified subscription auth',async t=>{
 for(const accountPlan of ['Claude Ultra','Claude Max','Pro','Team','Enterprise']) {
  const f=await fixture(t,'claude',{accountPlan,usageBad:true});
  const result=await readCatalog({provider:'claude'},f.options);
  assert.equal(result.plan,accountPlan,'preserve the provider-reported display label');
  assert.equal(result.models[0].id,`claude/${f.name}`);
  assert.equal(result.usage.available,false);
  assert.ok((await f.audit()).every(a=>!a.generation));
 }
});
test('Claude display labels cannot admit API, missing-token or unknown billing',async t=>{
 for(const extra of [{accountPlan:'Claude Ultra',apiProvider:'thirdParty'},{accountPlan:'Claude Max',tokenSource:'none'},
  ...['Claude Console','Claude Free','Max API','ultra-preview','unknown'].map(accountPlan=>({accountPlan}))]) {
  const f=await fixture(t,'claude',extra);
  await assert.rejects(readCatalog({provider:'claude'},f.options),/authentication changed/);
  assert.ok((await f.audit()).every(a=>!a.generation));
 }
 const f=await fixture(t,'claude',{accountPlan:'Claude Ultra',authBad:true});
 await assert.rejects(readCatalog({provider:'claude'},f.options),/subscription login/);
 assert.equal((await f.audit()).length,1,'display plan cannot bypass the independent auth probe');
});
test('an unresponsive quota endpoint does not hide the discovered models',async t=>{
 const f=await fixture(t,'codex',{holdUsage:true});const start=Date.now();
 const result=await readCatalog({provider:'codex'},f.options);
 assert.ok(result.models.length);assert.equal(result.usage.available,false);assert.ok(Date.now()-start<8000);
});
