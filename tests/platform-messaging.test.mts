import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, createHmac } from 'node:crypto';
import { Pool } from 'pg';
import { Directory } from '../server/src/platform/directory.js';
const url=process.env.TEST_DATABASE_URL;
test('platform phone verification and messaging stay bound to verified owners',{skip:!url},async t=>{
  process.env.SESSION_SECRET='platform-messaging-test-secret-0123456789';process.env.PLATFORM_URL='https://swarm.test';
  const { platformMessaging } = await import('../server/src/platform/messaging.js');
  const { verifySignature } = await import('../server/src/messaging/inkbox/client.js');
  const { setEnvOverride } = await import('../server/src/env.js');
  setEnvOverride('MESSAGING_SIGNUP_MODE','open');
  const schema=`test_${randomBytes(8).toString('hex')}`,admin=new Pool({connectionString:url});await admin.query(`CREATE SCHEMA ${schema}`);
  const target=new URL(url!);target.searchParams.set('options',`-c search_path=${schema},public`);const directory=new Directory(target.href);
  t.after(async()=>{await directory.pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
  await directory.migrate();
  const sent:any[]=[],events:any[]=[];
  const provider={ready:()=>true,line:async()=>({number:'+15550000000'}),verify:(raw:string,h:any)=>verifySignature(raw,{requestId:h['x-inkbox-request-id'],timestamp:h['x-inkbox-timestamp'],signature:h['x-inkbox-signature']},'test-signing'),send:async(channel:any,destination:any,message:any,id:any)=>{sent.push({channel,destination,message,id});return `sent-${sent.length}`;}};
  const envelopes={create:async()=>{},encrypt:async(tenant:string,purpose:string,payload:any)=>{events.push({tenant,id:purpose.slice(6),payload});return JSON.stringify(payload);}};
  const runtime={verify:async(token:string)=>{if(!token.startsWith('usr_'))throw new Error();return {tenant:token,generation:'1'};}};
  const app=platformMessaging(directory,envelopes as any,runtime as any,()=>{},provider);
  const post=(route:string,body:any,cookie?:string,token?:string)=>app.request(route,{method:'POST',headers:{'content-type':'application/json',...(cookie?{cookie}:{}),...(token?{authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});
  async function start(phone:string,cookie?:string,link=false){const r=await post(link?'/api/messaging/phone/start':'/api/auth/phone/start',{phone},cookie);assert.equal(r.status,200,await r.clone().text());return {id:(await r.json() as any).id,cookie:r.headers.getSetCookie()[0].split(';')[0],code:sent.at(-1).message.text.match(/\b\d{6}\b/)[0]};}
  async function finish(a:any,cookie=a.cookie,link=false){return post(link?'/api/messaging/phone/verify':'/api/auth/phone/verify',{id:a.id,code:a.code},cookie);}
  {
    const a=await start('15550001111');
    await t.test('the code alone cannot substitute the initiating browser and cannot be replayed',async()=>{
      assert.equal((await finish(a,'swarm_phone_attempt=foreign')).status,401);
      const r=await finish(a);assert.equal(r.status,200,await r.clone().text());assert.equal((await finish(a)).status,401);
    });
    const owner=(await directory.pool.query("SELECT tenant_id FROM identities WHERE provider='phone' AND subject='15550001111'")).rows[0].tenant_id;
    const other=await directory.identity('google','other',{name:'Other'}),session=await directory.createSession(other,undefined,'Other');
    await t.test('linking a phone already owned by another account is refused',async()=>{
      const a=await start('15550001111',`swarm_session=${session}`,true);assert.equal((await finish(a,`${a.cookie}; swarm_session=${session}`,true)).status,409);
      assert.equal((await directory.pool.query("SELECT tenant_id FROM identities WHERE provider='phone' AND subject='15550001111'")).rows[0].tenant_id,owner);
    });
    await t.test('wrong codes are durably limited and session revocation cancels linking',async()=>{
      const a=await start('15550002222');for(let i=0;i<5;i++)assert.equal((await post('/api/auth/phone/verify',{id:a.id,code:'bad'},a.cookie)).status,401);assert.equal((await finish(a)).status,401);
      const b=await start('15550003333',`swarm_session=${session}`,true);await directory.pool.query('DELETE FROM sessions WHERE tenant_id=$1',[other]);assert.equal((await finish(b,`${b.cookie}; swarm_session=${session}`,true)).status,401);
    });
    await directory.pool.query("UPDATE tenants SET state='active' WHERE id=ANY($1::text[])",[[owner,other]]);
    await t.test('outbound destinations come only from the owning routing record',async()=>{
      const body={operation:'send',channel:'imessage',text:'private reply',id:randomBytes(16).toString('hex')};
      const before=sent.length;
      assert.equal((await post('/internal/runtime/messaging',{...body,to:'15559999999'},undefined,owner)).status,400);
      assert.equal((await post('/internal/runtime/messaging',body,undefined,other)).status,404);assert.equal(sent.length,before);
      assert.equal((await post('/internal/runtime/messaging',body,undefined,owner)).status,200);assert.equal(sent.at(-1).destination.phone,'15550001111');
      assert.equal((await post('/internal/runtime/messaging',body,undefined,owner)).status,409);
    });
    await t.test('signed inbound events are routed by provider phone and disconnected routes stay blocked',async()=>{
      const raw=JSON.stringify({event_type:'imessage.received',data:{message:{id:'inbound1',remote_number:'+15550001111',conversation_id:'thread-a',content:'private task'}}});
      const timestamp=String(Math.floor(Date.now()/1000)),signature=`sha256=${createHmac('sha256','test-signing').update(`event1.${timestamp}.${raw}`).digest('hex')}`;
      const webhook=(sig:string)=>app.request('/api/messaging/inkbox/webhook',{method:'POST',body:raw,headers:{'content-type':'application/json','x-inkbox-request-id':'event1','x-inkbox-timestamp':timestamp,'x-inkbox-signature':sig}});
      assert.equal((await webhook('sha256=bad')).status,401);assert.equal((await webhook(signature)).status,204);
      assert.equal(events.at(-1).tenant,owner);assert.equal(events.at(-1).payload.type,'messaging-inbound');
      const inbound=events.at(-1),before=events.length;
      // Replaying after the wake event was acknowledged must not enqueue again.
      await directory.pool.query('DELETE FROM wake_events WHERE tenant_id=$1 AND id=$2',[owner,inbound.id]);
      await webhook(signature);assert.equal(events.length,before);
      assert.equal((await post('/internal/runtime/messaging',{operation:'validate',channel:'imessage',revision:inbound.payload.revision,receipt:'inbound1'},undefined,owner)).status,200);
      await post('/internal/runtime/messaging',{operation:'disconnect',channel:'imessage'},undefined,owner);await webhook(signature);assert.equal(events.length,before);
      assert.equal((await post('/internal/runtime/messaging',{operation:'validate',channel:'imessage',revision:inbound.payload.revision,receipt:'inbound1'},undefined,owner)).status,404);
      const reconnect=await start('15550001111');assert.equal((await finish(reconnect)).status,200);
      assert.equal((await post('/internal/runtime/messaging',{operation:'validate',channel:'imessage',revision:inbound.payload.revision,receipt:'inbound1'},undefined,owner)).status,404,'reconnecting cannot resurrect an old authorization');
    });
    await t.test('login links are single use, owner-routed and invalidated by disconnect',async()=>{
      assert.equal((await post('/internal/runtime/messaging',{operation:'login-link',channel:'imessage',tenant:other},undefined,owner)).status,400);
      assert.equal((await post('/internal/runtime/messaging',{operation:'login-link',channel:'imessage'},undefined,owner)).status,200);
      const link=sent.at(-1).message.text.match(/https:\/\/swarm\.test\/api\/auth\/text\?t=[A-Za-z0-9_-]+/)[0];
      const response=await app.request(link);assert.equal(response.status,303);
      assert.ok(response.headers.getSetCookie().some(v=>v.startsWith('swarm_session=')));
      assert.match((await app.request(link)).headers.get('location')!,/login=expired/);
      await post('/internal/runtime/messaging',{operation:'login-link',channel:'imessage'},undefined,owner);
      const revoked=sent.at(-1).message.text.match(/https:\/\/swarm\.test\/api\/auth\/text\?t=[A-Za-z0-9_-]+/)[0];
      await post('/internal/runtime/messaging',{operation:'disconnect',channel:'imessage'},undefined,owner);
      assert.match((await app.request(revoked)).headers.get('location')!,/login=expired/);
    });
    await t.test('invite seats and verified signup are consumed atomically',async()=>{
      setEnvOverride('MESSAGING_SIGNUP_MODE','invite');setEnvOverride('MESSAGING_MEMBER_INVITES','1');
      const aSession=await directory.createSession(owner,undefined,'Invite device');
      const invite=await post('/api/messaging/my-invite',{},`swarm_session=${aSession}`);assert.equal(invite.status,200);
      const code=new URL((await invite.json() as any).url).pathname.split('/').at(-1)!;
      const claim=await post(`/api/join/${code}/claim`,{phone:'15550004444'});assert.equal(claim.status,200);
      const one=await start('15550004444'),two=await start('15550005555');
      assert.equal((await finish(one)).status,200);
      assert.equal((await post('/api/auth/phone/verify',{id:two.id,code:two.code,inviteCode:code},two.cookie)).status,403);
      assert.equal((await directory.pool.query("SELECT 1 FROM identities WHERE provider='phone' AND subject='15550005555'")).rowCount,0);
      assert.equal((await directory.pool.query('SELECT uses FROM messaging_invites WHERE code=$1',[code])).rows[0].uses,1);
      setEnvOverride('MESSAGING_SIGNUP_MODE','open');
    });
    async function signed(text:string,phone:string,id:string){
      const raw=JSON.stringify({event_type:'imessage.received',data:{message:{id,remote_number:`+${phone}`,conversation_id:`conversation-${phone}`,content:text}}});
      const timestamp=String(Math.floor(Date.now()/1000)),signature=`sha256=${createHmac('sha256','test-signing').update(`${id}.${timestamp}.${raw}`).digest('hex')}`;
      return app.request('/api/messaging/inkbox/webhook',{method:'POST',body:raw,headers:{'content-type':'application/json','x-inkbox-request-id':id,'x-inkbox-timestamp':timestamp,'x-inkbox-signature':signature}});
    }
    await t.test('LINK codes require the initiating live session and cannot steal an existing phone',async()=>{
      let otherSession=await directory.createSession(other,undefined,'Link device');
      const code=await post('/api/messaging/code',{},`swarm_session=${otherSession}`);assert.equal(code.status,200);
      const token=(await code.json() as any).code;
      assert.equal((await signed(`LINK ${token}`,'15550001111','foreign-link')).status,409);
      await directory.pool.query('DELETE FROM sessions WHERE tenant_id=$1',[other]);
      assert.equal((await signed(`LINK ${token}`,'15550006666','revoked-link')).status,204);
      assert.equal((await directory.pool.query("SELECT 1 FROM identities WHERE provider='phone' AND subject='15550006666'")).rowCount,0);
      otherSession=await directory.createSession(other,undefined,'Link device');
      const valid=(await (await post('/api/messaging/code',{},`swarm_session=${otherSession}`)).json() as any).code;
      assert.equal((await signed(`LINK ${valid}`,'15550006666','valid-link')).status,204);
      assert.equal((await directory.pool.query("SELECT tenant_id FROM identities WHERE provider='phone' AND subject='15550006666'")).rows[0].tenant_id,other);
    });
    await t.test('verified phone deletion revokes the platform account rather than only its local database',async()=>{
      assert.equal((await signed('/delete','15550006666','delete-start')).status,204);
      assert.equal((await directory.pool.query('SELECT state FROM tenants WHERE id=$1',[other])).rows[0].state,'active');
      assert.equal((await signed('/delete confirm','15550006666','delete-confirm')).status,204);
      assert.equal((await directory.pool.query('SELECT state FROM tenants WHERE id=$1',[other])).rows[0].state,'deleting');
      assert.equal((await directory.pool.query('SELECT 1 FROM sessions WHERE tenant_id=$1',[other])).rowCount,0);
    });
  }
});
