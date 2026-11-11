import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, createHash } from 'node:crypto';
import { Pool } from 'pg';
import { Hono } from 'hono';
import { Directory } from '../server/src/platform/directory.js';

const url=process.env.TEST_DATABASE_URL;
test('platform native account linking keeps the initiating session and PKCE boundary',{skip:!url},async t=>{
  Object.assign(process.env,{SESSION_SECRET:'platform-native-test-secret-0123456789',PLATFORM_URL:'https://swarm.test'});
  const {platformAuth}=await import('../server/src/platform/auth.js');
  const schema=`test_${randomBytes(8).toString('hex')}`,admin=new Pool({connectionString:url});
  await admin.query(`CREATE SCHEMA ${schema}`);
  const target=new URL(url!);target.searchParams.set('options',`-c search_path=${schema},public`);
  const directory=new Directory(target.href);
  t.after(async()=>{await directory.pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
  await directory.migrate();
  const owner=await directory.identity('google','native-owner',{name:'Owner'}),other=await directory.identity('google','native-other',{name:'Other'});
  let session=await directory.createSession(owner,undefined,'Native app');
  const otherSession=await directory.createSession(other,undefined,'Other app');
  const events:any[]=[],revocations:any[]=[];
  const envelopes={create:async()=>{},event:async(tenant:string,id:string,payload:any)=>events.push({tenant,id,payload})};
  const app=new Hono().route('/api/auth',platformAuth(directory,envelopes as any,(...args)=>revocations.push(args)));
  const originalFetch=globalThis.fetch;
  t.after(()=>{globalThis.fetch=originalFetch;});
  globalThis.fetch=async input=>{
    const u=String(input);
    if(u==='https://openrouter.ai/api/v1/auth/keys')return Response.json({key:'sk-or-v1-abcdefghijklmnopqrstuvwxyz123456',user_id:'native-openrouter-owner'});
    if(u==='https://openrouter.ai/api/v1/key')return Response.json({data:{label:'test key'}});
    throw new Error('Unexpected outbound request in native auth test.');
  };
  const post=(route:string,body:any,cookie?:string)=>app.request(route,{method:'POST',headers:{'content-type':'application/json',...(cookie?{cookie:`swarm_session=${cookie}`}:{})},body:JSON.stringify(body)});
  const proof=()=>randomBytes(32).toString('base64url'),challenge=(v:string)=>createHash('sha256').update(v).digest('base64url');
  async function prepare(){
    const verifier=proof(),state=proof(),response=await post('/api/auth/native/openrouter/prepare',{challenge:challenge(verifier),state},session);
    assert.equal(response.status,200,await response.clone().text());return {verifier,state,ticket:(await response.json() as any).ticket};
  }
  async function authorize(a:Awaited<ReturnType<typeof prepare>>){
    const start=await app.request(`/api/auth/native/start?ticket=${a.ticket}`);assert.equal(start.status,302);
    assert.equal((await app.request(`/api/auth/native/start?ticket=${a.ticket}`)).status,401,'ticket single use');
    const nativeCookie=start.headers.getSetCookie()[0].split(';')[0];
    // The browser cookie jar deliberately has no initiating app session.
    const redirect=await app.request(start.headers.get('location')!,{headers:{cookie:nativeCookie}});
    const auth=new URL(redirect.headers.get('location')!);assert.equal(auth.origin,'https://openrouter.ai');
    const browserCookie=redirect.headers.getSetCookie()[0].split(';')[0];
    const response=await app.request(`/api/auth/openrouter/callback?state=${auth.searchParams.get('state')}&code=code`,{headers:{cookie:`${nativeCookie}; ${browserCookie}`}});
    return {response,callback:new URL(response.headers.get('location')!),browserCookie,nativeCookie,state:auth.searchParams.get('state')};
  }
  await t.test('a separate browser completes a session-bound handoff with one-time proof',async()=>{
    const a=await prepare(),b=await authorize(a);
    assert.equal(b.callback.protocol,'so.swarms.app:');assert.equal(b.callback.searchParams.get('state'),a.state);
    const code=b.callback.searchParams.get('code');assert.ok(code);
    assert.equal((await post('/api/auth/native/exchange',{code,verifier:proof()},session)).status,401);
    const done=await post('/api/auth/native/exchange',{code,verifier:a.verifier},session);assert.equal(done.status,200,await done.clone().text());
    const old=session;session=done.headers.getSetCookie().find(c=>c.startsWith('swarm_session='))!.split(';')[0].slice('swarm_session='.length);
    assert.equal(await directory.session(old),null);assert.equal((await directory.session(session)).tenant_id,owner);
    assert.equal((await post('/api/auth/native/exchange',{code,verifier:a.verifier},session)).status,401);
    assert.equal(events.at(-1).tenant,owner);assert.ok(revocations.some(r=>r[0]===owner));
    assert.equal((await directory.pool.query("SELECT tenant_id FROM identities WHERE provider='openrouter'")).rows[0].tenant_id,owner);
  });
  await t.test('another native session cannot redeem the owner linking result',async()=>{
    const a=await prepare(),b=await authorize(a);
    assert.equal((await post('/api/auth/native/exchange',{code:b.callback.searchParams.get('code'),verifier:a.verifier},otherSession)).status,401);
    assert.equal((await directory.session(otherSession)).tenant_id,other);
  });
  await t.test('revocation during provider login prevents identity linking and key delivery',async()=>{
    const a=await prepare(),count=events.length;
    await directory.pool.query('DELETE FROM sessions WHERE tenant_id=$1',[owner]);
    const response=await app.request(`/api/auth/native/start?ticket=${a.ticket}`);
    assert.equal(response.status,401);assert.equal(events.length,count);
  });
  await t.test('stale sessions cannot prepare a new credential replacement',async()=>{
    session=await directory.createSession(owner,undefined,'Old app');
    await directory.pool.query("UPDATE sessions SET authenticated_at=now()-interval '11 minutes' WHERE tenant_id=$1",[owner]);
    assert.equal((await post('/api/auth/native/openrouter/prepare',{challenge:challenge(proof()),state:proof()},session)).status,401);
  });
  await t.test('native exchange cannot rotate a session revoked after its initial check',async()=>{
    session=await directory.createSession(owner,undefined,'Race app');
    const a=await prepare(),b=await authorize(a),create=directory.createSession.bind(directory);
    directory.createSession=async(...args)=>{
      await directory.pool.query('DELETE FROM sessions WHERE tenant_id=$1',[owner]);
      return create(...args);
    };
    try{
      const result=await post('/api/auth/native/exchange',{code:b.callback.searchParams.get('code'),verifier:a.verifier},session);
      assert.equal(result.status,401);assert.equal(result.headers.getSetCookie().length,0);
      assert.equal((await directory.pool.query('SELECT 1 FROM sessions WHERE tenant_id=$1',[owner])).rowCount,0);
    }finally{directory.createSession=create;}
  });
  await t.test('a delayed encrypted credential delivery cannot outlive its linking session',async()=>{
    const {TenantEnvelopes}=await import('../server/src/platform/envelopes.js');
    const {hashToken}=await import('../server/src/platform/directory.js');
    session=await directory.createSession(owner,undefined,'Credential app');
    const actual=new TenantEnvelopes(directory,'fixture-key-no-network');
    actual.encrypt=async()=>{await directory.pool.query('DELETE FROM sessions WHERE tenant_id=$1',[owner]);return 'encrypted-test-payload';};
    await assert.rejects(actual.event(owner,'late-credential',{key:'test'},hashToken(session)),/reauth_required/);
    assert.equal((await directory.pool.query("SELECT 1 FROM wake_events WHERE tenant_id=$1 AND id='late-credential'",[owner])).rowCount,0);
  });
});
