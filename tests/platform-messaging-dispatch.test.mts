import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { Directory } from '../server/src/platform/directory.js';
import { MessagingOwnership } from '../server/src/platform/messaging-store.js';

const url=process.env.TEST_DATABASE_URL;
test('controlled report delivery pins authoritative recipient/revision and never replays uncertain sends', { skip: !url }, async t => {
  process.env.SESSION_SECRET = 'controlled-delivery-test-private-secret-123456';
  process.env.PLATFORM_URL = 'https://swarm.test';
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'controlled-runtime-'));
  Object.assign(process.env, { DB_PATH: path.join(local, 'swarm.db'), FILES_DIR: path.join(local, 'files'), COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '' });
  const { platformMessaging } = await import('../server/src/platform/messaging.js');
  const { controlledMessagingMethods } = await import('../server/src/runtime/messaging.js');
  const { DeliveryNotSentError } = await import('../server/src/deliverables/types.js');
  t.after(async () => { const { db } = await import('../server/src/db.js'); db.close(); fs.rmSync(local, { recursive: true, force: true }); });
  const schema = `test_${randomBytes(8).toString('hex')}`, admin = new Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const connection = new URL(url!); connection.searchParams.set('options', `-c search_path=${schema},public`);
  const directory = new Directory(connection.href); await directory.migrate();
  t.after(async () => { await directory.pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  const owner = await directory.identity('phone', '15550003333', { name: 'Reports' }), foreign = await directory.identity('phone', '15550004444', { name: 'Foreign' });
  await directory.pool.query("UPDATE tenants SET state='active'");
  const envelopes = { encrypt: async () => 'encrypted-fixture' }, ownership = new MessagingOwnership(directory, envelopes as any);
  await ownership.link(owner, '15550003333', 'imessage', 'approved-conversation');
  await ownership.link(foreign, '15550004444', 'imessage', 'foreign-conversation');
  let runtimeRevoked = false, ready = true, loseReply = false, beforeProvider: (() => Promise<void>) | undefined;
  const sends: { phone: string; conversation?: string; text?: string }[] = [];
  const runtime = { verify: async (token: string) => { if (runtimeRevoked || ![owner, foreign].includes(token)) throw new Error(); return { tenant: token }; } };
  const messenger = { ready: () => ready, verify: () => true, line: async () => null,
    async send(_channel: string, target: { phone: string; conversation?: string }, message: { text?: string }, _id: string, beforeDispatch?: () => Promise<unknown>) {
      await beforeProvider?.(); await beforeDispatch?.(); sends.push({ ...target, text: message.text });
      if (loseReply) throw new Error('Provider response was lost after send');
      return 'controlled-provider-receipt';
    } };
  const app = platformMessaging(directory, envelopes as any, runtime as any, () => {}, messenger);
  const post = (body: unknown, who = owner) => app.request('/internal/runtime/messaging', { method: 'POST', headers: { authorization: `Bearer ${who}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const snapshot = async (who = owner) => (await (await post({ operation: 'delivery-target', channel: 'imessage' }, who)).json() as any).target;
  const body = (target: any) => ({ operation: 'deliver', channel: 'imessage', id: randomBytes(16).toString('hex'), text: 'Saved report: https://swarm.test/api/deliverables/artifacts/a/download', expected: { phone: target.phone, conversation: target.chatRef, revision: target.revision } });
  const outcome = async (value: unknown, who = owner) => { const response = await post(value, who); assert.equal(response.status, 200); return (await response.json() as any).outcome; };

  await t.test('snapshot is owner-scoped; explicit foreign overrides and recipients cannot send', async () => {
    const target = await snapshot(); assert.equal(target.phone, '15550003333'); assert.equal(target.chatRef, 'approved-conversation'); assert.ok(target.revision);
    assert.equal((await post({ operation: 'delivery-target', channel: 'imessage', tenant: foreign })).status, 400);
    assert.equal(await outcome(body(target), foreign), 'not_sent'); assert.equal(sends.length, 0);
  });
  await t.test('runtime adapter obtains platform snapshot and sends only its authenticated download link', async () => {
    const methods = controlledMessagingMethods(async (operation, input = {}) => {
      const response = await post({ operation, ...input }); if (!response.ok) throw new Error(`Platform refused ${response.status}`); return response.json();
    });
    const link = { userId: owner, channel: 'imessage', transport: 'inkbox', status: 'connected' } as any;
    const target = await methods.prepareControlledDelivery!(link);
    assert.equal(target.transport, 'platform'); assert.equal(target.chatRef, 'approved-conversation');
    const dispatchId = randomBytes(16).toString('hex');
    assert.equal(await methods.sendControlledDelivery!(link, { dispatchId, target, text: 'https://swarm.test/api/deliverables/artifacts/a/download' }), 'controlled-provider-receipt');
    assert.equal(sends.at(-1)!.conversation, target.chatRef);
    loseReply = true;
    try { await assert.rejects(methods.sendControlledDelivery!(link, { dispatchId: randomBytes(16).toString('hex'), target, text: 'saved report' }), /unknown/); } finally { loseReply = false; }
    await ownership.link(owner, '15550003333', 'imessage', 'approved-conversation');
    await assert.rejects(methods.sendControlledDelivery!(link, { dispatchId: randomBytes(16).toString('hex'), target, text: 'stale revision' }), DeliveryNotSentError);
  });
  await t.test('conversation changes without a revision bump invalidate an approval', async () => {
    const target = await snapshot(), before = sends.length;
    await ownership.accept(owner, { channel: 'imessage', phone: '15550003333', conversationId: 'ingest-changed-conversation', messageId: randomBytes(16).toString('hex') } as any);
    assert.equal((await snapshot()).revision, target.revision);
    assert.equal(await outcome(body(target)), 'not_sent'); assert.equal(sends.length, before);
  });
  await t.test('a destination change between admission and provider dispatch is definitely not sent', async () => {
    const target = await snapshot(), request = body(target), before = sends.length;
    beforeProvider = async () => { await ownership.accept(owner, { channel: 'imessage', phone: target.phone, conversationId: 'raced-conversation', messageId: randomBytes(16).toString('hex') } as any); };
    try { assert.equal(await outcome(request), 'not_sent'); } finally { beforeProvider = undefined; }
    assert.equal(sends.length, before);
    assert.equal(await ownership.dispatchState(owner, request.id), 'not_sent');
    assert.equal(await outcome(request), 'not_sent', 'same failed attempt is not redispatched');
    assert.equal(await outcome(body(await snapshot())), 'delivered', 'fresh approved attempt can send');
  });
  await t.test('provider response loss and duplicate dispatch IDs are unknown, with one provider call', async () => {
    const request = body(await snapshot()), before = sends.length;
    loseReply = true; try { assert.equal(await outcome(request), 'unknown'); } finally { loseReply = false; }
    assert.equal(await ownership.dispatchState(owner, request.id), 'uncertain');
    assert.equal(await outcome(request), 'unknown'); assert.equal(sends.length, before + 1);
    const concurrent = body(await snapshot()), count = sends.length;
    const results = await Promise.all([outcome(concurrent), outcome(concurrent)]);
    assert.ok(results.includes('delivered')); assert.equal(sends.length, count + 1);
  });
  await t.test('disconnect/revocation at dispatch and unready transport do not send', async () => {
    const target = await snapshot(), before = sends.length;
    beforeProvider = async () => { runtimeRevoked = true; };
    try { assert.equal(await outcome(body(target)), 'not_sent'); } finally { beforeProvider = undefined; runtimeRevoked = false; }
    ready = false; try { assert.equal(await outcome(body(await snapshot())), 'not_sent'); } finally { ready = true; }
    await ownership.disconnect(owner, 'imessage');
    assert.equal(await outcome(body(target)), 'not_sent'); assert.equal(sends.length, before);
  });
});
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
