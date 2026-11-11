import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Directory, hashToken, opaqueToken } from './directory.js';
import type { TenantEnvelopes } from './envelopes.js';
import { googleAvailable, googleAuthorization, exchangeGoogleCode, challengeFor } from '../auth/google-provider.js';
import { appleAvailability, appleConfiguration, exchangeAppleCode, type AppleClient } from '../auth/apple-verifier.js';
import { exchangeOpenRouterCode } from '../auth/openrouter-provider.js';

const proof = (s: unknown): s is string => typeof s==='string'&&/^[A-Za-z0-9_-]{43}$/.test(s);
export function platformAuth(directory: Directory, envelopes: TenantEnvelopes, revoked: (tenant:string,session?:string)=>void) {
  const app=new Hono(), origin=process.env.PLATFORM_URL!;
  if(!origin?.startsWith('https://'))throw new Error('Platform login requires HTTPS.');
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) throw new Error('Platform authorization encryption requires a strong SESSION_SECRET.');
  const cryptoKey=createHash('sha256').update(`platform-attempts:${process.env.SESSION_SECRET}`).digest();
  const seal=(value:unknown)=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',cryptoKey,iv);c.setAAD(Buffer.from('oauth-attempt-v1'));const data=Buffer.concat([c.update(JSON.stringify(value)),c.final()]);return Buffer.concat([iv,c.getAuthTag(),data]).toString('base64url');};
  const open=(value:string)=>{const b=Buffer.from(value,'base64url'),d=createDecipheriv('aes-256-gcm',cryptoKey,b.subarray(0,12));d.setAAD(Buffer.from('oauth-attempt-v1'));d.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([d.update(b.subarray(28)),d.final()]).toString());};
  const session=(c:Context)=>directory.session(getCookie(c,'swarm_session'));
  const recent=(s:any)=>s&&new Date(s.authenticated_at).getTime()>Date.now()-600_000;
  async function login(c:Context,tenant:string,requiredSession?:string){
    const old=await session(c),raw=await directory.createSession(tenant,getCookie(c,'swarm_session'),c.req.header('user-agent')??'Unknown device',requiredSession);
    if(old)revoked(old.tenant_id,old.hash);
    setCookie(c,'swarm_session',raw,{secure:true,httpOnly:true,sameSite:'Lax',path:'/',maxAge:604800});
  }
  async function attempt(provider:string,browser:string,payload:unknown,link?:string){
    const id=opaqueToken();
    await directory.pool.query('DELETE FROM auth_attempts WHERE expires_at<=now()');
    await directory.pool.query("INSERT INTO auth_attempts(hash,provider,browser_hash,payload,link_session,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '10 minutes')",[hashToken(id),provider,hashToken(browser),{encrypted:seal(payload)},link??null]);
    return id;
  }
  async function consume(id:string,provider:string,browser:string){
    if(!proof(id))throw new Error('Invalid attempt.');
    const row=(await directory.pool.query('DELETE FROM auth_attempts WHERE hash=$1 AND provider=$2 AND browser_hash=$3 AND expires_at>now() RETURNING *',[hashToken(id),provider,hashToken(browser)])).rows[0];
    if(!row)throw new Error('Attempt expired.');return {...row,data:open(row.payload.encrypted)};
  }
  app.get('/me',async c=>{
    const s=await session(c),apple=appleAvailability();
    return c.json({user:s?{id:s.tenant_id,name:s.display_name,email:s.verified_email??'',avatarUrl:null}:null,devLogin:false,googleLogin:googleAvailable(),appleLogin:apple.web,appleLinked:s?!!(await directory.pool.query("SELECT 1 FROM identities WHERE tenant_id=$1 AND provider='apple'",[s.tenant_id])).rowCount:false});
  });
  app.post('/logout',async c=>{const s=await session(c);if(s){await directory.pool.query('DELETE FROM sessions WHERE hash=$1',[s.hash]);revoked(s.tenant_id,s.hash);}deleteCookie(c,'swarm_session',{path:'/'});return c.json({ok:true});});
  app.get('/sessions',async c=>{const s=await session(c);if(!s)return c.json({error:'Unauthenticated.'},401);return c.json({sessions:(await directory.pool.query('SELECT hash AS id,device,created_at,last_seen_at,expires_at FROM sessions WHERE tenant_id=$1 AND expires_at>now()',[s.tenant_id])).rows.map(r=>({...r,current:r.id===s.hash}))});});
  app.delete('/sessions/:id',async c=>{const s=await session(c);if(!s)return c.json({error:'Unauthenticated.'},401);const r=await directory.pool.query('DELETE FROM sessions WHERE tenant_id=$1 AND hash=$2',[s.tenant_id,c.req.param('id')]);if(!r.rowCount)return c.json({error:'Session not found.'},404);revoked(s.tenant_id,c.req.param('id'));return c.json({ok:true});});

  for(const provider of ['google','openrouter','apple'] as const){
    app.get(`/${provider}/start`,async c=>{
      const s=await session(c),link=c.req.query('intent')==='link';
      if(link&&!recent(s))return c.json({error:'Sign in again to link this identity.'},401);
      const nativeId=getCookie(c,'swarm_native_attempt');
      const native=nativeId?(await directory.pool.query("SELECT link_session FROM auth_attempts WHERE hash=$1 AND provider='native' AND expires_at>now()",[hashToken(nativeId)])).rows[0]:null;
      const browser=opaqueToken(),nonce=opaqueToken(),verifier=opaqueToken();
      const id=await attempt(provider,browser,{nonce,verifier,native:native?nativeId:undefined,nativeLink:!!native?.link_session},native?.link_session??(link?s.hash:undefined));
      setCookie(c,`swarm_${provider}_attempt`,browser,{secure:true,httpOnly:true,path:`/api/auth/${provider}`,sameSite:provider==='apple'?'None':'Lax',maxAge:600});
      const callback=new URL(`/api/auth/${provider}/callback`,origin).href;
      if(provider==='google')return c.redirect(googleAuthorization(callback,id,nonce,verifier));
      const url=new URL(provider==='apple'?'https://appleid.apple.com/auth/authorize':'https://openrouter.ai/auth');
      url.search=new URLSearchParams(provider==='apple'?{client_id:appleConfiguration().clients.web,redirect_uri:callback,response_type:'code',response_mode:'form_post',scope:'name email',state:id,nonce}:{callback_url:callback,state:id,code_challenge:challengeFor(verifier),code_challenge_method:'S256',key_label:'Swarm'}).toString();
      return c.redirect(url.href);
    });
    app.on(provider==='apple'?'POST':'GET',`/${provider}/callback`,async c=>{
      try{
        const data=provider==='apple'?await c.req.parseBody():c.req.query();
        if(typeof data.state!=='string'||typeof data.code!=='string'||data.error)throw new Error('Authorization failed.');
        const a=await consume(data.state,provider,getCookie(c,`swarm_${provider}_attempt`)??'');
        deleteCookie(c,`swarm_${provider}_attempt`,{path:`/api/auth/${provider}`});
        if(a.link_session&&!a.data.nativeLink&&hashToken(getCookie(c,'swarm_session')??'')!==a.link_session)throw new Error('Link session changed.');
        const callback=new URL(`/api/auth/${provider}/callback`,origin).href;
        const identity=provider==='google'?await exchangeGoogleCode(data.code,a.data.verifier,a.data.nonce,callback):provider==='apple'?await exchangeAppleCode(data.code,appleConfiguration().clients.web,a.data.nonce,true):await exchangeOpenRouterCode(data.code,a.data.verifier);
        const tenant=await directory.identity(provider,identity.subject,{name:'name' in identity?identity.name??'Swarm member':'Swarm member',email:'email' in identity?identity.email??undefined:undefined},a.link_session??undefined);
        await envelopes.create(tenant);
        if('key' in identity)await envelopes.event(tenant,`openrouter-${opaqueToken()}`,{type:'provider-key',provider:'openrouter',key:identity.key},a.link_session??undefined);
        if('refreshToken' in identity)await envelopes.event(tenant,`apple-${opaqueToken()}`,{type:'apple-revocation',clientId:appleConfiguration().clients.web,refreshToken:identity.refreshToken},a.link_session??undefined);
        if(a.data.native){
          const code=opaqueToken();
          const changed=await directory.pool.query("UPDATE auth_attempts SET payload=payload||$2::jsonb,expires_at=now()+interval '60 seconds' WHERE hash=$1 AND provider='native' AND expires_at>now()",[hashToken(a.data.native),JSON.stringify({tenant,codeHash:hashToken(code)})]);
          if(!changed.rowCount)throw new Error('Native attempt expired.');
          const native=(await directory.pool.query('SELECT payload FROM auth_attempts WHERE hash=$1',[hashToken(a.data.native)])).rows[0];
          const callback=new URL('so.swarms.app://auth');callback.searchParams.set('code',code);callback.searchParams.set('state',open(native.payload.encrypted).state);return c.redirect(callback.href,303);
        }
        await login(c,tenant,a.link_session??undefined);return c.redirect(origin,303);
      }catch{return c.redirect(`${origin}/?login=${provider}_invalid`,303);}
    });
  }
  app.get('/native/start',async c=>{
    const ticket=c.req.query('ticket');
    if(ticket){
      if(!proof(ticket))return c.json({error:'Invalid native sign-in.'},400);
      const row=(await directory.pool.query("UPDATE auth_attempts SET payload=payload-'ticketHash' WHERE provider='native' AND payload->>'ticketHash'=$1 AND expires_at>now() RETURNING payload",[hashToken(ticket)])).rows[0];
      if(!row)return c.json({error:'Native authorization expired.'},401);
      const id=open(row.payload.encrypted).id;
      setCookie(c,'swarm_native_attempt',id,{secure:true,httpOnly:true,path:'/api/auth',sameSite:'Lax',maxAge:600});
      return c.redirect('/api/auth/openrouter/start');
    }
    const challenge=c.req.query('challenge'),state=c.req.query('state'),provider=c.req.query('provider')??'google';
    if(!proof(challenge)||!proof(state)||!['google','openrouter'].includes(provider))return c.json({error:'Invalid native sign-in.'},400);
    const id=await attempt('native',challenge,{challenge,state});
    setCookie(c,'swarm_native_attempt',id,{secure:true,httpOnly:true,path:'/api/auth',sameSite:'Lax',maxAge:600});
    return c.redirect(`/api/auth/${provider}/start`);
  });
  app.post('/native/openrouter/prepare',async c=>{
    const s=await session(c);if(!recent(s))return c.json({error:'Sign in again to connect OpenRouter.',code:'reauth_required'},401);
    const b=await c.req.json();if(!proof(b.challenge)||!proof(b.state))return c.json({error:'Invalid native sign-in.'},400);
    const ticket=opaqueToken(),id=opaqueToken();
    await directory.pool.query("INSERT INTO auth_attempts(hash,provider,browser_hash,payload,link_session,expires_at) VALUES($1,'native',$2,$3,$4,now()+interval '10 minutes')",[hashToken(id),hashToken(b.challenge),{encrypted:seal({id,challenge:b.challenge,state:b.state}),ticketHash:hashToken(ticket)},s.hash]);
    return c.json({ticket});
  });
  app.post('/native/exchange',async c=>{
    const b=await c.req.json();if(!proof(b.code)||!proof(b.verifier))return c.json({error:'Invalid proof.'},400);
    const row=(await directory.pool.query("DELETE FROM auth_attempts WHERE provider='native' AND payload->>'codeHash'=$1 AND browser_hash=$2 AND expires_at>now() RETURNING payload,link_session",[hashToken(b.code),hashToken(challengeFor(b.verifier))])).rows[0];
    if(!row?.payload?.tenant)return c.json({error:'Native authorization expired.'},401);
    if(row.link_session&&hashToken(getCookie(c,'swarm_session')??'')!==row.link_session)return c.json({error:'The initiating session changed.'},401);
    try{await login(c,row.payload.tenant,row.link_session??undefined);}catch{return c.json({error:'Native authorization expired.'},401);}return c.json({ok:true});
  });
  app.post('/apple/native/start',async c=>{
    const b=await c.req.json(),s=await session(c);
    if(!['ios','macos'].includes(b.client)||!proof(b.challenge)||!appleAvailability()[b.client as AppleClient])return c.json({error:'apple_unavailable'},400);
    if(b.intent==='link'&&!recent(s))return c.json({error:'reauth_required'},401);
    const nonce=opaqueToken(),id=await attempt('apple-native',b.challenge,{nonce,client:b.client},b.intent==='link'?s.hash:undefined);
    return c.json({attempt:id,nonce});
  });
  app.post('/apple/native/complete',async c=>{
    try{
      const b=await c.req.json();if(!proof(b.attempt)||!proof(b.verifier)||typeof b.code!=='string'||b.code.length>4096)throw new Error();
      const a=await consume(b.attempt,'apple-native',challengeFor(b.verifier));
      if(a.link_session&&hashToken(getCookie(c,'swarm_session')??'')!==a.link_session)throw new Error();
      const client=appleConfiguration().clients[a.data.client as AppleClient],identity=await exchangeAppleCode(b.code,client,a.data.nonce,false);
      const tenant=await directory.identity('apple',identity.subject,{name:typeof b.name==='string'?b.name.slice(0,80):'Swarm member',email:identity.email??undefined},a.link_session??undefined);
      await envelopes.create(tenant);await envelopes.event(tenant,`apple-${opaqueToken()}`,{type:'apple-revocation',clientId:client,refreshToken:identity.refreshToken},a.link_session??undefined);
      await login(c,tenant,a.link_session??undefined);return c.json({ok:true,linked:!!a.link_session});
    }catch{return c.json({error:'apple_invalid'},401);}
  });
  return app;
}
