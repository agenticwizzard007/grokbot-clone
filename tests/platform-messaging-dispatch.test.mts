import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { Directory } from '../server/src/platform/directory.js';
import { MessagingOwnership } from '../server/src/platform/messaging-store.js';

const url=process.env.TEST_DATABASE_URL;
test('messaging media, typing and uncertain sends enforce current ownership',{skip:!url},async t=>{
  process.env.SESSION_SECRET='messaging-dispatch-private-test-secret-1234';process.env.PLATFORM_URL='https://swarm.test';
  const {platformMessaging,inkboxMessenger}=await import('../server/src/platform/messaging.js');
  const {setEnvOverride}=await import('../server/src/env.js');
  setEnvOverride('INKBOX_BASE_URL','https://provider.test');
  const schema=`test_${randomBytes(8).toString('hex')}`,admin=new Pool({connectionString:url});await admin.query(`CREATE SCHEMA ${schema}`);
  const connection=new URL(url!);connection.searchParams.set('options',`-c search_path=${schema},public`);
  const directory=new Directory(connection.href);await directory.migrate();
  const originalFetch=globalThis.fetch;
  t.after(async()=>{globalThis.fetch=originalFetch;await directory.pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
  const owner=await directory.identity('phone','15550001111',{name:'Owner'}),other=await directory.identity('phone','15550002222',{name:'Other'});
  await directory.pool.query("UPDATE tenants SET state='active'");
  const envelopes={encrypt:async()=> 'encrypted-fixture'},ownership=new MessagingOwnership(directory,envelopes as any);
  let runtimeRevoked=false,authenticated:(()=>void)|undefined;
  const runtime={verify:async(token:string)=>{if(runtimeRevoked||![owner,other].includes(token))throw new Error();authenticated?.();return {tenant:token};}};
  const app=platformMessaging(directory,envelopes as any,runtime as any,()=>{},{...inkboxMessenger,ready:()=>true});
  const calls:{url:string;options:RequestInit}[]=[];
  let duringUpload:(()=>Promise<void>)|undefined,failSend=false,oversize=false;
  globalThis.fetch=async(input,options={})=>{
    const url=String(input);calls.push({url,options});assert.equal(options.redirect,'error');
    if(url.endsWith('/media')){await duringUpload?.();return new Response(oversize?'x'.repeat(262145):JSON.stringify({media_url:'https://provider.test/media/test'}));}
    if(failSend)throw new Error('provider result lost');
    return new Response(JSON.stringify({message:{id:'provider-receipt'}}));
  };
  const post=(body:unknown,tenant=owner)=>app.request('/internal/runtime/messaging',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${tenant}`},body:JSON.stringify(body)});
  const audio=()=>({operation:'audio',channel:'imessage',id:randomBytes(16).toString('hex'),audio:{data:Buffer.from('audio').toString('base64'),mime:'audio/wav',filename:'message.wav'}});
  await ownership.link(owner,'15550001111','imessage','owner-thread');
  await t.test('audio uploads and sends only to the owners stored conversation',async()=>{
    assert.equal((await post(audio())).status,200);const request=JSON.parse(String(calls.at(-1)!.options.body));
    assert.equal(request.conversation_id,'owner-thread');assert.deepEqual(request.media_urls,['https://provider.test/media/test']);
    assert.equal((await post({...audio(),phone:'15550002222'})).status,400);
    assert.equal((await post(audio(),other)).status,404);
  });
  await t.test('caller-provided media URLs and oversized or noncanonical base64 are rejected',async()=>{
    const before=calls.length;
    for(const value of [{url:'http://169.254.169.254/'},{data:'!invalid!',mime:'audio/wav',filename:'x.wav'},{data:'YQ==',mime:'text/html',filename:'x.wav'},{data:'a'.repeat(5592409),mime:'audio/wav',filename:'x.wav'}])assert.equal((await post({...audio(),audio:value})).status,400);
    assert.equal(calls.length,before);
  });
  await t.test('disconnect during upload prevents send, including a later retry of that dispatch',async()=>{
    const body=audio(),before=calls.length;
    duringUpload=()=>ownership.disconnect(owner,'imessage');
    assert.equal((await post(body)).status,502);duringUpload=undefined;
    assert.equal(calls.length,before+1);assert.ok(calls.at(-1)!.url.endsWith('/media'));
    await ownership.link(owner,'15550001111','imessage','new-owner-thread');
    assert.equal((await post(body)).status,409);
    assert.equal((await directory.pool.query('SELECT state FROM messaging_dispatches WHERE tenant_id=$1 AND id=$2',[owner,body.id])).rows[0].state,'uncertain');
  });
  await t.test('oversized provider upload responses stop before any message is sent',async()=>{
    oversize=true;const before=calls.length;assert.equal((await post(audio())).status,502);oversize=false;
    assert.equal(calls.length,before+1);
  });
  await t.test('lost send result persists uncertainty and is never blindly replayed',async()=>{
    failSend=true;const body={operation:'send',channel:'imessage',text:'write once',id:randomBytes(16).toString('hex')};
    assert.equal((await post(body)).status,502);const before=calls.length;failSend=false;
    assert.equal((await post(body)).status,409);assert.equal(calls.length,before);
  });
  await t.test('typing rejects conversation overrides and disconnected owners',async()=>{
    assert.equal((await post({operation:'typing',channel:'imessage',conversation:'foreign-thread'})).status,400);
    assert.equal((await post({operation:'typing',channel:'imessage'},other)).status,404);
    assert.equal((await post({operation:'typing',channel:'imessage'})).status,200);
    assert.equal(JSON.parse(String(calls.at(-1)!.options.body)).conversation_id,'new-owner-thread');
    await ownership.disconnect(owner,'imessage');const before=calls.length;
    assert.equal((await post({operation:'typing',channel:'imessage'})).status,404);assert.equal(calls.length,before);
  });
  await t.test('runtime revocation during audio upload prevents provider send and preserves an uncertain outcome',async()=>{
    await ownership.link(owner,'15550001111','imessage','current-owner-thread');
    const body=audio(),before=calls.length;
    duringUpload=async()=>{runtimeRevoked=true;};
    try{assert.equal((await post(body)).status,502);assert.equal(calls.length,before+1);}
    finally{duringUpload=undefined;runtimeRevoked=false;}
    assert.equal((await directory.pool.query('SELECT state FROM messaging_dispatches WHERE tenant_id=$1 AND id=$2',[owner,body.id])).rows[0].state,'uncertain');
    assert.equal((await post(body)).status,409);assert.equal(calls.length,before+1);
  });
  await t.test('runtime revocation while reading a body blocks disconnect, grants, login links and outbound dispatch',async()=>{
    for(const operation of ['disconnect','invite','login-link','send','typing']){
      let release!:(body:unknown)=>void,entered!:()=>void;
      const checked=new Promise<void>(done=>{entered=done;});authenticated=entered;
      const stream=new ReadableStream<Uint8Array>({start(controller){release=body=>{controller.enqueue(Buffer.from(JSON.stringify(body)));controller.close();};}});
      const before=calls.length;
      const pending=app.request('/internal/runtime/messaging',{method:'POST',headers:{authorization:`Bearer ${owner}`,'content-type':'application/json'},body:stream,duplex:'half'} as any);
      try{
        await checked;runtimeRevoked=true;
        release({operation,channel:'imessage',...(operation==='send'?{text:'must not send',id:randomBytes(16).toString('hex')}:{})});
        assert.equal((await pending).status,404);assert.equal(calls.length,before);
        assert.equal((await ownership.route(owner,'imessage'))!.conversation_id,'current-owner-thread');
      }finally{authenticated=undefined;runtimeRevoked=false;}
    }
    assert.equal((await directory.pool.query('SELECT 1 FROM messaging_invites WHERE tenant_id=$1',[owner])).rowCount,0);
    assert.equal((await directory.pool.query('SELECT 1 FROM messaging_tokens WHERE tenant_id=$1',[owner])).rowCount,0);
  });
});
