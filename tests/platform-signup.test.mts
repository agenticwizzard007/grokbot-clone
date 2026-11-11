import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, createHmac } from 'node:crypto';
import { Pool } from 'pg';
import { Hono } from 'hono';
import { Directory, hashToken } from '../server/src/platform/directory.js';

const url = process.env.TEST_DATABASE_URL;
test('platform signup administration preserves identity, role and fresh authorization boundaries', { skip: !url }, async t => {
  Object.assign(process.env, { SESSION_SECRET:'signup-tests-only-01234567890123456789', PLATFORM_URL:'https://swarm.test', MESSAGING_SIGNUP_MODE:'invite', MESSAGING_SIGNUPS_PER_DAY:'50', MESSAGING_MEMBER_INVITES:'5' });
  const { SignupAdministration, signupPolicy, pruneSignupMetadata } = await import('../server/src/platform/signup.js');
  const { signupAdminRoutes } = await import('../server/src/platform/signup-routes.js');
  const { platformMessaging } = await import('../server/src/platform/messaging.js');
  const { MessagingOwnership } = await import('../server/src/platform/messaging-store.js');
  const { verifySignature } = await import('../server/src/messaging/inkbox/client.js');
  const adminPool = new Pool({ connectionString:url }), schema = `test_${randomBytes(8).toString('hex')}`;
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  const target = new URL(url!); target.searchParams.set('options', `-c search_path=${schema},public`);
  const directory = new Directory(target.href); await directory.migrate(); await directory.migrate();
  t.after(async () => { await directory.pool.end(); await adminPool.query(`DROP SCHEMA ${schema} CASCADE`); await adminPool.end(); });
  const a = await directory.identity('google','admin',{name:'Administrator',email:'same@example.test'}), b = await directory.identity('google','other',{name:'Other',email:'same@example.test'});
  await directory.pool.query("INSERT INTO account_roles VALUES($1,'admin')",[a]);
  let token = await directory.createSession(a,undefined,'admin device');
  const other = await directory.createSession(b,undefined,'other device'), administration = new SignupAdministration(directory);
  const sent:any[]=[];
  const provider = {ready:()=>true,line:async()=>({number:'+15550000000'}),verify:(raw:string,h:any)=>verifySignature(raw,{requestId:h['x-inkbox-request-id'],timestamp:h['x-inkbox-timestamp'],signature:h['x-inkbox-signature']},'signup-signing'),send:async(_c:any,d:any,m:any)=>{sent.push({d,m});return 'receipt';}};
  const envelopes = {create:async()=>{},encrypt:async()=> 'encrypted'}, runtime = {verify:async()=>{throw new Error('No runtime admin permission.');}};
  const app = new Hono(); app.route('/',signupAdminRoutes(directory)); app.route('/',platformMessaging(directory,envelopes as any,runtime as any,()=>{},provider));
  const request = (route:string,method='GET',body?:unknown,raw=token,extra={})=>app.request(route,{method,headers:{cookie:`swarm_session=${raw}`,'content-type':'application/json',...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const save = async (patch:any) => administration.update(token,{...(await administration.settings(token)),...patch});
  async function signed(phone:string,text:string,id:string,valid=true) {
    const raw = JSON.stringify({event_type:'imessage.received',data:{message:{id,remote_number:`+${phone}`,conversation_id:`conversation-${phone}`,content:text}}});
    const ts=String(Math.floor(Date.now()/1000)),signature=`sha256=${createHmac('sha256','signup-signing').update(`${id}.${ts}.${raw}`).digest('hex')}`;
    return app.request('/api/messaging/inkbox/webhook',{method:'POST',body:raw,headers:{'content-type':'application/json','x-inkbox-request-id':id,'x-inkbox-timestamp':ts,'x-inkbox-signature':valid?signature:'invalid'}});
  }
  async function start(phone:string) {
    const response=await request('/api/auth/phone/start','POST',{phone}); assert.equal(response.status,200);
    return { id:(await response.json() as any).id, code:sent.at(-1).m.text.match(/\b\d{6}\b/)[0], cookie:response.headers.getSetCookie()[0].split(';')[0] };
  }
  const verify=(attempt:any,code=attempt.code)=>app.request('/api/auth/phone/verify',{method:'POST',headers:{cookie:attempt.cookie,'content-type':'application/json'},body:JSON.stringify({id:attempt.id,code})});

  await t.test('equal email, forged tenant headers and runtime tokens do not grant administration',async()=>{
    assert.deepEqual(await (await request('/api/platform/signup','GET',undefined,other,{'x-swarm-tenant':a,authorization:`Bearer ${a}`})).json(),{admin:false});
    for(const path of ['/api/messaging/invites','/api/messaging/waitlist'])assert.equal((await request(path,'GET',undefined,other)).status,403);
    assert.equal((await request('/api/platform/signup','PUT',{mode:'open',revision:'0'},other)).status,403);
    assert.equal((await request('/api/platform/signup','GET',undefined,'')).status,401);
    assert.equal((await directory.pool.query("SELECT count(*) n FROM account_roles WHERE role='admin'")).rows[0].n,'1');
  });
  await t.test('policy mutations are validated, recent, origin-checked and revision-bound',async()=>{
    assert.equal((await request('/api/platform/signup','PUT',{mode:'open',revision:'0'},token,{origin:'https://attacker.test'})).status,403);
    for(const patch of [{memberInvites:-1},{signupsPerDay:0.5},{mode:'public'},{tenant:b}])assert.equal((await request('/api/platform/signup','PUT',{revision:'0',...patch})).status,400);
    await directory.pool.query("UPDATE sessions SET authenticated_at=now()-interval '11 minutes' WHERE hash=$1",[hashToken(token)]);
    assert.equal((await request('/api/platform/signup','PUT',{revision:'0',mode:'open'})).status,401);
    token=await directory.createSession(a,token,'recent admin');
    const first=await save({mode:'invite',memberInvites:2,signupsPerDay:1}); assert.equal(first.revision,'1');
    assert.equal((await request('/api/platform/signup','PUT',{revision:'0',mode:'open'})).status,409);
    assert.equal((await signupPolicy(directory.pool)).mode,'invite');
  });
  await t.test('signed denied arrivals create contact-only waitlist records; unsigned requests do not',async()=>{
    assert.equal((await signed('15551110000','private task with secret marker','bad-signature',false)).status,401);
    assert.equal((await directory.pool.query('SELECT 1 FROM signup_waitlist')).rowCount,0);
    assert.equal((await signed('15551110001','private task with secret marker','waiter1')).status,204);
    const rows=(await directory.pool.query('SELECT * FROM signup_waitlist')).rows;
    assert.equal(rows.length,1); assert.equal(rows[0].phone,'15551110001'); assert.doesNotMatch(JSON.stringify(rows),/private task|secret marker/);
    assert.equal((await directory.pool.query("SELECT 1 FROM identities WHERE provider='phone'")).rowCount,0);
    assert.equal((await request('/api/messaging/waitlist','GET',undefined,other)).status,403);
    assert.equal((await request('/api/messaging/waitlist')).headers.get('cache-control'),'no-store');
  });
  await t.test('approval requires its current revision and fresh phone proof before identity creation',async()=>{
    const row=(await administration.waitlist(token)).waitlist[0];
    assert.equal((await request(`/api/messaging/waitlist/${row.phone}/approve`,'POST',{revision:row.revision},other)).status,403);
    assert.equal((await request(`/api/messaging/waitlist/${row.phone}/approve`,'POST',{revision:row.revision})).status,200);
    assert.equal((await request(`/api/messaging/waitlist/${row.phone}/decline`,'POST',{revision:row.revision})).status,409);
    assert.equal((await directory.pool.query("SELECT 1 FROM identities WHERE provider='phone' AND subject=$1",[row.phone])).rowCount,0);
    const attempt=await start(row.phone);
    assert.equal((await verify(attempt,'wrong')).status,401);
    assert.equal((await verify(attempt)).status,200);
    assert.equal((await directory.pool.query('SELECT 1 FROM signup_waitlist WHERE phone=$1',[row.phone])).rowCount,0);
    assert.equal((await verify(attempt)).status,401);
  });
  await t.test('waitlist approval does not bypass closed registration or the atomic daily limit',async()=>{
    await signed('15551110002','wait please','waiter2'); const row=(await administration.waitlist(token)).waitlist.find(r=>r.phone==='15551110002')!;
    await administration.decide(token,row.phone,row.revision,'approved');
    const attempt=await start(row.phone); assert.equal((await verify(attempt)).status,403,'one daily seat already used');
    await save({mode:'closed',signupsPerDay:0}); assert.equal((await verify(attempt)).status,403,'closed refuses even approval');
    await save({mode:'invite',signupsPerDay:0}); assert.equal((await verify(attempt)).status,200);
  });
  await t.test('unverified codes cannot populate the waitlist; verified denied codes can',async()=>{
    const attempt=await start('15551110003'); assert.equal((await verify(attempt,'wrong')).status,401);
    assert.equal((await directory.pool.query('SELECT 1 FROM signup_waitlist WHERE phone=$1',['15551110003'])).rowCount,0);
    assert.equal((await verify(attempt)).status,403);
    assert.equal((await directory.pool.query('SELECT 1 FROM signup_waitlist WHERE phone=$1',['15551110003'])).rowCount,1);
  });
  await t.test('admin and member invitations stay separate; expiry, revocation and lowered allowances apply immediately',async()=>{
    const owner=new MessagingOwnership(directory,envelopes as any);
    const member=await owner.memberInvite(b),code=new URL(member.url).pathname.split('/').at(-1)!;
    const first=await administration.createInvite(token,{maxUses:2,expiresInDays:7,note:'test invitation'});
    const second=await administration.createInvite(token,{maxUses:1,expiresInDays:7});
    assert.notEqual(first.invite.code,second.invite.code); assert.equal((await owner.memberInvite(b)).url,member.url);
    await save({memberInvites:0}); assert.equal(await owner.invite(code),undefined);
    await assert.rejects(directory.transaction(c=>owner.admitPhone(c,'15551110004',code)),/no longer valid/);
    assert.ok(await owner.invite(first.invite.code));
    await administration.revokeInvite(token,first.invite.code); assert.equal(await owner.invite(first.invite.code),undefined);
    await directory.pool.query("UPDATE messaging_invites SET expires_at=now()-interval '1 second' WHERE code=$1",[second.invite.code]);
    await assert.rejects(directory.transaction(c=>owner.admitPhone(c,'15551110004',second.invite.code)),/no longer valid/);
    assert.equal((await request('/api/messaging/invites','POST',{maxUses:3},other)).status,403);
  });
  async function blockedWrite(kind:'session'|'role'|'expiry') {
    const raw=await directory.createSession(a,undefined,`${kind} race`), revision=(await administration.settings(raw)).revision;
    const blocker=await directory.pool.connect();
    try {
      await blocker.query('BEGIN'); await blocker.query("SELECT pg_advisory_xact_lock(hashtext('swarm-phone-signups'))");
      if(kind==='expiry')await blocker.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '250 milliseconds' WHERE hash=$1",[hashToken(raw)]);
      const pending=request('/api/platform/signup','PUT',{revision,mode:'open'},raw);
      let waiting=false;
      for(let i=0;i<100;i++){if((await directory.pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query=$1",["SELECT pg_advisory_xact_lock(hashtext('swarm-phone-signups'))"])).rowCount){waiting=true;break;}await new Promise(r=>setTimeout(r,5));}
      assert.equal(waiting,true);
      if(kind==='session')await blocker.query('DELETE FROM sessions WHERE hash=$1',[hashToken(raw)]);
      if(kind==='role')await blocker.query("DELETE FROM account_roles WHERE tenant_id=$1 AND role='admin'",[a]);
      if(kind==='expiry')await blocker.query('SELECT pg_sleep(0.3)');
      await blocker.query('COMMIT');
      const result=await pending; assert.equal(result.status,kind==='role'?403:401,await result.clone().text());
      assert.equal((await signupPolicy(directory.pool)).revision,revision);
    }finally{await blocker.query('ROLLBACK');blocker.release();await directory.pool.query("INSERT INTO account_roles VALUES($1,'admin') ON CONFLICT DO NOTHING",[a]);}
  }
  for(const kind of ['session','role','expiry'] as const)await t.test(`queued policy mutation rechecks ${kind} after the lock`,()=>blockedWrite(kind));
  await t.test('body-read revocation prevents an administrator mutation',async()=>{
    const raw=await directory.createSession(a,undefined,'body race'), revision=(await administration.settings(raw)).revision;
    let release!:(value:unknown)=>void;
    const stream=new ReadableStream<Uint8Array>({start(c){release=value=>{c.enqueue(Buffer.from(JSON.stringify(value)));c.close();};}});
    const pending=app.request('/api/platform/signup',{method:'PUT',headers:{cookie:`swarm_session=${raw}`,'content-type':'application/json'},body:stream,duplex:'half'} as any);
    await directory.pool.query('DELETE FROM sessions WHERE hash=$1',[hashToken(raw)]); release({mode:'open',revision});
    assert.equal((await pending).status,401); assert.equal((await signupPolicy(directory.pool)).revision,revision);
  });
  await t.test('pagination is bounded, complete and contains no prompt fields',async()=>{
    await directory.pool.query("INSERT INTO signup_waitlist(phone,channel) SELECT '1666'||lpad(n::text,7,'0'),'sms' FROM generate_series(1,105) n");
    const first=await administration.waitlist(token),second=await administration.waitlist(token,first.next!);
    assert.equal(first.waitlist.length,100); assert.ok(first.next); assert.ok(second.waitlist.length>=6); assert.equal(second.next,null);
    assert.equal(new Set([...first.waitlist,...second.waitlist].map(r=>r.phone)).size,first.waitlist.length+second.waitlist.length);
    assert.ok(first.waitlist.every(r=>r.name===null&&r.firstMessage===null));
    await directory.pool.query("UPDATE signup_waitlist SET verified_at=now()-interval '31 days' WHERE phone LIKE '1666%'");
    await pruneSignupMetadata(directory);
    assert.equal((await directory.pool.query("SELECT 1 FROM signup_waitlist WHERE phone LIKE '1666%'")).rowCount,0);
  });
});
