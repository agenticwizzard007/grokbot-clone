import assert from 'node:assert/strict';
import { after, test, mock } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { Hono } from 'hono';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'swarm-google-'));
Object.assign(process.env,{DB_PATH:path.join(root,'test.db'),FILES_DIR:path.join(root,'files'),SESSION_SECRET:'test-google-identity',COMPUTER_PROVIDER:'local',COMPOSIO_API_KEY:'',GOOGLE_CLIENT_ID:'client',GOOGLE_CLIENT_SECRET:'secret',SERVER_URL:'https://swarm.test',APP_URL:'https://swarm.test'});
const {privateKey,publicKey}=await generateKeyPair('RS256',{extractable:true});const jwk=await exportJWK(publicKey);Object.assign(jwk,{kid:'google-fixture',alg:'RS256',use:'sig'});
let subject='google-person',email='person@example.test',verified=true,nonce='';
const calls:string[]=[];
mock.method(globalThis,'fetch',async(input:any,init:any)=>{
  const url=String(input);calls.push(url);
  if(url==='https://www.googleapis.com/oauth2/v3/certs')return Response.json({keys:[jwk]});
  if(url==='https://oauth2.googleapis.com/token'){
    assert.equal(init.redirect,'error');assert.ok(new URLSearchParams(init.body).get('code_verifier'));
    return Response.json({id_token:await new SignJWT({sub:subject,email,email_verified:verified,nonce}).setProtectedHeader({alg:'RS256',kid:'google-fixture'}).setIssuer('https://accounts.google.com').setAudience('client').setIssuedAt().setExpirationTime('5m').sign(privateKey)});
  }
  throw new Error('Unexpected provider request');
});
const {db,now}=await import('../server/src/db.js');
const {api}=await import('../server/src/routes.js');const app=new Hono().route('/api',api);
const proof=()=>randomBytes(32).toString('base64url');
async function begin(extra=''){
  const r=await app.request('/api/auth/google/start',{headers:{cookie:extra}}),url=new URL(r.headers.get('location')!);assert.equal(url.hostname,'accounts.google.com');
  assert.equal(url.searchParams.get('scope'),'openid email profile');assert.equal(url.searchParams.get('code_challenge_method'),'S256');
  nonce=url.searchParams.get('nonce')!;
  const cookie=r.headers.getSetCookie().find(v=>v.startsWith('swarm_google_attempt='))!.split(';')[0];
  return {cookie:extra?`${extra}; ${cookie}`:cookie,path:`/api/auth/google/callback?state=${url.searchParams.get('state')}&code=fixture`,state:url.searchParams.get('state')!};
}
const finish=(a:{path:string;cookie:string})=>app.request(a.path,{headers:{cookie:a.cookie}});
after(()=>{mock.restoreAll();db.close();fs.rmSync(root,{recursive:true,force:true});});
test('Google OIDC binds browser state, verifies identity, rotates and rejects replay',async()=>{
  const a=await begin();const before=calls.length;
  assert.match((await app.request(a.path)).headers.get('location')!,/google_session/);assert.equal(calls.length,before);
  const r=await finish(a);assert.equal(r.headers.get('location'),'https://swarm.test/');
  const cookie=r.headers.getSetCookie().find(v=>v.startsWith('swarm_session='))!.split(';')[0];
  const me=await (await app.request('/api/auth/me',{headers:{cookie}})).json() as any;assert.equal(me.user.email,email);
  assert.match((await finish(a)).headers.get('location')!,/google_session/);
  const again=await finish(await begin(cookie));assert.equal(again.headers.get('location'),'https://swarm.test/');
  assert.equal((await (await app.request('/api/auth/me',{headers:{cookie}})).json() as any).user,null);
  assert.equal((db.prepare('SELECT count(*) n FROM google_identities').get() as any).n,1);
});
test('unverified email, expired attempt, denial and substituted nonce fail',async()=>{
  verified=false;assert.match((await finish(await begin())).headers.get('location')!,/google_invalid/);verified=true;
  const expired=await begin();db.prepare('UPDATE google_oidc_attempts SET expires_at=? WHERE id=?').run(now()-1,expired.state);assert.match((await finish(expired)).headers.get('location')!,/google_session/);
  const denied=await begin();denied.path+='&error=access_denied';assert.match((await finish(denied)).headers.get('location')!,/google_denied/);
  const changed=await begin();nonce=proof();assert.match((await finish(changed)).headers.get('location')!,/google_invalid/);
});
test('native handoff carries only a single-use PKCE authorization code',async()=>{
  subject='native-google';email='native@example.test';const verifier=proof(),state=proof(),challenge=createHash('sha256').update(verifier).digest('base64url');
  const start=await app.request(`/api/auth/native/start?challenge=${challenge}&state=${state}`),cookie=start.headers.getSetCookie()[0].split(';')[0];
  const r=await finish(await begin(cookie)),link=new URL(r.headers.get('location')!);assert.equal(link.protocol,'so.swarms.app:');assert.equal(link.searchParams.get('state'),state);assert.equal(link.searchParams.has('token'),false);
  const exchange=(v:string)=>app.request('/api/auth/native/exchange',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:link.searchParams.get('code'),verifier:v})});
  assert.equal((await exchange(proof())).status,401);assert.equal((await exchange(verifier)).status,200);assert.equal((await exchange(verifier)).status,401);
});
