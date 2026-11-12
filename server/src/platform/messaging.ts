import { Hono, type Context } from 'hono';
import type { PoolClient } from 'pg';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { getConnInfo } from '@hono/node-server/conninfo';
import { randomInt, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import QRCode from 'qrcode';
import { Directory, hashToken, opaqueToken } from './directory.js';
import type { RuntimeIdentity } from './runtime-identity.js';
import type { TenantEnvelopes } from './envelopes.js';
import { platformSecrets } from './crypto.js';
import { issuePlatformSession } from './cookies.js';
import { parseEvent, type Parsed } from '../messaging/inkbox/events.js';
import * as ib from '../messaging/inkbox/client.js';
import { env } from '../env.js';
import { MessagingOwnership, MessagingNotFound, MessagingAdmissionError, MessagingDestinationChanged, type MessagingDeliveryTarget } from './messaging-store.js';
import { noteVerifiedWaiter, signupPolicy } from './signup.js';

type Channel = 'imessage' | 'whatsapp' | 'sms';
interface OutboundMessage { text?: string; quote?: string; audio?: { data: Buffer; mime: string; filename: string } }
async function providerJson(response:Response){
  if(!response.ok){await response.body?.cancel();throw new Error('Message outcome requires reconciliation.');}
  const reader=response.body?.getReader();if(!reader)throw new Error('Empty provider response.');
  const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>262144)throw new Error('Provider response limit exceeded.');chunks.push(r.value);}}finally{await reader.cancel();}
  return JSON.parse(Buffer.concat(chunks).toString());
}
export interface PlatformMessenger {
  ready(): boolean;
  verify(raw:string,headers:Record<string,string|undefined>):boolean;
  line():Promise<unknown>;
  send(channel:Channel,destination:{phone:string;conversation?:string},message:OutboundMessage,dispatch:string,beforeDispatch?:()=>Promise<unknown>):Promise<string|null>;
  typing?(conversation:string):Promise<void>;
}
export const inkboxMessenger:PlatformMessenger={
  ready:()=>!!(env.inkboxIdentityKey&&env.inkboxSigningKey&&env.inkboxIdentityId),
  verify:(raw,h)=>ib.verifySignature(raw,{requestId:h['x-inkbox-request-id'],timestamp:h['x-inkbox-timestamp'],signature:h['x-inkbox-signature']},env.inkboxSigningKey),
  async line(){
    if(!this.ready())return null;
    const r=await ib.routerInfo(env.inkboxAdminKey),command=`connect @${env.inkboxHandle.replace(/^@/,'')}`;
    const whatsapp=await ib.getWhatsAppOnboarding(env.inkboxIdentityKey,env.inkboxIdentityId).catch(()=>null);
    return {number:r.number,connectCommand:command,smsLink:`sms:${r.number}?&body=${encodeURIComponent(command)}`,whatsapp:whatsapp?.ready?{number:whatsapp.number,messageText:whatsapp.messageText,messageLink:whatsapp.messageLink,qr:whatsapp.messageQrPngDataUrl}:null};
  },
  async typing(conversation){
    const response=await fetch(`${env.inkboxBaseUrl}/api/v1/imessage/typing`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{'X-API-Key':env.inkboxIdentityKey,'Content-Type':'application/json'},body:JSON.stringify({conversation_id:conversation})});
    await response.body?.cancel();if(!response.ok)throw new Error('Typing unavailable.');
  },
  async send(channel,destination,message,dispatch,beforeDispatch){
    const route=channel==='whatsapp'?'/whatsapp/messages':channel==='sms'?`/phone/numbers/${encodeURIComponent(env.inkboxPhoneNumberId)}/texts`:'/imessage/messages';
    if(channel==='sms'&&!env.inkboxPhoneNumberId)throw new Error('SMS unavailable.');
    let mediaUrl:string|undefined;
    if(message.audio){
      if(channel!=='imessage')throw new Error('Audio is unavailable on this channel.');
      const form=new FormData();form.append('file',new Blob([new Uint8Array(message.audio.data)],{type:message.audio.mime}),message.audio.filename);
      await beforeDispatch?.();
      const uploaded=await providerJson(await fetch(`${env.inkboxBaseUrl}/api/v1/imessage/media`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{'X-API-Key':env.inkboxIdentityKey,'Idempotency-Key':`${dispatch}-media`},body:form}));
      if(typeof uploaded.media_url!=='string'||uploaded.media_url.length>8192||new URL(uploaded.media_url).protocol!=='https:')throw new Error('Invalid provider media response.');
      mediaUrl=uploaded.media_url;
    }
    // Upload may take time. A disconnect during it must prevent the later send.
    await beforeDispatch?.();
    const response=await fetch(`${env.inkboxBaseUrl}/api/v1${route}`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{'X-API-Key':env.inkboxIdentityKey,'Content-Type':'application/json','Idempotency-Key':dispatch},body:JSON.stringify({...(mediaUrl?{media_urls:[mediaUrl]}:{text:message.text}),...(destination.conversation?{conversation_id:destination.conversation}:{to:`+${destination.phone}`}),...(message.quote?{reply_to_message_id:message.quote,plain_reply_fallback:true}:{})})});
    const result=await providerJson(response),m=result.message??result;
    if(channel==='imessage'&&(m.was_downgraded===true||m.service==='sms'))throw new Error('Carrier downgrade refused.');
    return typeof m.id==='string'?m.id:null;
  },
};
export function platformMessaging(directory:Directory,envelopes:TenantEnvelopes,runtime:RuntimeIdentity,revoke:(tenant:string,hash?:string)=>void,messenger=inkboxMessenger){
  const app=new Hono(),secrets=platformSecrets(),ownership=new MessagingOwnership(directory,envelopes);
  app.onError((error,c)=>error instanceof MessagingNotFound?c.json({error:'Messaging connection not found.'},404):error instanceof MessagingAdmissionError?c.json({error:error.message,needInvite:error.needInvite},403):['identity_already_linked','account_revoked','reauth_required'].includes(error.message)?c.json({error:'Identity authorization changed.'},409):c.json({error:'Messaging operation unavailable.'},503));
  const digits=(v:unknown)=>String(v??'').replace(/\D/g,'');
  const recent=(s:any)=>s&&new Date(s.authenticated_at).getTime()>Date.now()-600000;
  const session=(c:Context)=>directory.session(getCookie(c,'swarm_session'));
  const codeHash=(id:string,code:string)=>createHmac('sha256',process.env.SESSION_SECRET!).update(`${id}:${code}`).digest('hex');
  const ip=(c:Context)=>{try{return getConnInfo(c).remote.address??'unknown';}catch{return 'unknown';}};
  async function rate(key:string,limit:number){
    const window=Math.floor(Date.now()/600000);
    const row=(await directory.pool.query(`INSERT INTO platform_rate_windows(key,window_id,hits) VALUES($1,$2,1)
      ON CONFLICT(key,window_id) DO UPDATE SET hits=platform_rate_windows.hits+1 RETURNING hits`,[hashToken(key),window])).rows[0];
    await directory.pool.query('DELETE FROM platform_rate_windows WHERE window_id<$1',[window-2]);
    return row.hits<=limit;
  }
  async function linkRoute(tenant:string,e:{phone:string;channel:Channel;conversationId?:string},requiredSession?:string){
    await ownership.link(tenant,e.phone,e.channel,e.conversationId,requiredSession);
  }
  app.get('/api/join/:code',async c=>{
    const invite=await ownership.invite(c.req.param('code')),line=invite?await messenger.line() as any:null;
    return c.json({valid:!!invite&&!!line,inviter:invite?.display_name??null,line:line?{...line,qr:line.smsLink?await QRCode.toDataURL(line.smsLink,{margin:1,width:220}):null}:null,reason:!invite?'This invite has expired or has been used up.':!line?'Texting is unavailable.':null});
  });
  app.post('/api/join/:code/claim',async c=>{
    const b=await c.req.json(),phone=digits(b.phone);
    if(phone.length<8||phone.length>15)return c.json({error:'Enter your full number with country code.'},400);
    if(!await rate(`claim-ip:${ip(c)}`,20)||!await rate(`claim-phone:${phone}`,5))return c.json({error:'Too many attempts.'},429);
    if(!await ownership.invite(c.req.param('code')))return c.json({error:'This invitation is no longer valid.'},404);
    await directory.pool.query("INSERT INTO messaging_claims(phone,invite_code,expires_at) VALUES($1,$2,now()+interval '30 minutes') ON CONFLICT(phone) DO UPDATE SET invite_code=excluded.invite_code,expires_at=excluded.expires_at",[phone,c.req.param('code').toUpperCase()]);
    return c.json({ok:true});
  });
  app.post('/api/messaging/my-invite',async c=>{
    const s=await session(c);if(!s)return c.json({error:'Unauthenticated.'},401);
    return c.json(await ownership.memberInvite(s.tenant_id,async client=>{
      if(!(await client!.query("SELECT 1 FROM sessions WHERE hash=$1 AND tenant_id=$2 AND expires_at>clock_timestamp() AND last_seen_at>clock_timestamp()-interval '24 hours' FOR SHARE",[s.hash,s.tenant_id])).rowCount)throw new MessagingNotFound();
    }));
  });
  app.post('/api/messaging/code',async c=>{
    const s=await session(c);if(!recent(s))return c.json({error:'Sign in again to link your phone.',code:'reauth_required'},401);
    const line=await messenger.line() as any;if(!line)return c.json({error:'Messaging is unavailable.'},503);
    const code=randomBytes(8).toString('hex').toUpperCase(),expiresAt=Date.now()+600000;
    await directory.transaction(async client=>{
      const current=await client.query("SELECT 1 FROM sessions s JOIN tenants t ON t.id=s.tenant_id WHERE s.hash=$1 AND s.authenticated_at>now()-interval '10 minutes' AND s.expires_at>now() AND t.state NOT IN ('deleting','deleted') FOR UPDATE OF s,t",[s.hash]);
      if(!current.rowCount)throw new MessagingNotFound();
      await client.query("DELETE FROM messaging_tokens WHERE tenant_id=$1 AND purpose='link'",[s.tenant_id]);
      await client.query("INSERT INTO messaging_tokens(hash,tenant_id,purpose,session_hash,expires_at) VALUES($1,$2,'link',$3,$4)",[hashToken(code),s.tenant_id,s.hash,new Date(expiresAt)]);
    });
    return c.json({code,expiresAt,...line,qr:line.smsLink?await QRCode.toDataURL(line.smsLink,{margin:1,width:200}):null});
  });
  async function sendLogin(tenant:string,channel:Channel,id=opaqueToken(),authorize?:(client?:PoolClient)=>Promise<unknown>){
    const route=await ownership.begin(tenant,channel,id,undefined,authorize);if(!route)return;
    try{
      const token=await ownership.loginToken(tenant,channel,authorize),url=new URL('/api/auth/text',process.env.PLATFORM_URL!);url.searchParams.set('t',token);
      await ownership.validate(tenant,channel,String(route.revision));
      await authorize?.();
      const receipt=await messenger.send(channel,{phone:route.phone,conversation:route.conversation_id??undefined},{text:`Sign in to Swarm (works once, for 10 minutes):\n${url.href}\nIf you did not request this, ignore it.`},`login-${hashToken(token)}`,async()=>{await authorize?.();await ownership.validate(tenant,channel,String(route.revision));});
      await ownership.finish(tenant,id,'completed',receipt);
    }catch(error){await ownership.finish(tenant,id,'uncertain');throw error;}
  }
  app.post('/api/auth/text/request',async c=>{
    const phone=digits((await c.req.json()).phone);
    if(phone.length<8||phone.length>15)return c.json({error:'Enter your full number with country code.'},400);
    if(!await rate(`text-phone:${phone}`,3)||!await rate(`text-ip:${ip(c)}`,20))return c.json({error:'Too many attempts.'},429);
    const route=(await directory.pool.query("SELECT r.* FROM messaging_routes r JOIN tenants t ON t.id=r.tenant_id WHERE r.phone=$1 AND r.state='active' AND t.state NOT IN ('deleting','deleted','failed') ORDER BY channel LIMIT 1",[phone])).rows[0];
    if(route)await sendLogin(route.tenant_id,route.channel).catch(()=>{});
    return c.json({ok:true});
  });
  app.get('/api/auth/text',async c=>{
    const previous=getCookie(c,'swarm_session'),old=await directory.session(previous);
    const result=await ownership.consumeLogin(c.req.query('t')??'',previous,c.req.header('user-agent')??'Unknown device');
    if(!result)return c.redirect(`${process.env.PLATFORM_URL}/?login=expired`,303);
    if(old)revoke(old.tenant_id,old.hash);
    setCookie(c,'swarm_session',result.raw,{secure:true,httpOnly:true,sameSite:'Lax',path:'/',maxAge:604800});
    return c.redirect(process.env.PLATFORM_URL!,303);
  });
  for(const linking of [false,true]){
    const route=linking?'/api/messaging/phone':'/api/auth/phone';
    app.post(`${route}/start`,async c=>{
      if(!messenger.ready())return c.json({error:'Messaging is not configured.'},503);
      const s=await session(c);if(linking&&!recent(s))return c.json({error:'Sign in again to link this phone.',code:'reauth_required'},401);
      const b=await c.req.json(),phone=digits(b.phone);
      if(phone.length<8||phone.length>15)return c.json({error:'Enter your full number with country code.'},400);
      if(!await rate(`phone:${phone}`,5)||!await rate(`phone-ip:${ip(c)}`,30))return c.json({error:'Too many tries. Wait a few minutes.'},429);
      const id=opaqueToken(),code=String(randomInt(1000000)).padStart(6,'0');
      await directory.pool.query('DELETE FROM phone_attempts WHERE phone=$1 OR expires_at<=now()',[phone]);
      await directory.pool.query('INSERT INTO phone_attempts(hash,phone,ciphertext,code_hash,link_session) VALUES($1,$2,$3,$4,$5)',[hashToken(id),phone,secrets.seal(`phone:${hashToken(id)}`,{code,id}),codeHash(id,code),linking?s.hash:null]);
      setCookie(c,'swarm_phone_attempt',id,{httpOnly:true,secure:true,sameSite:'Lax',path:'/api',maxAge:600});
      // Sending never proves ownership. Only the session-bound code verification does.
      const known=(await directory.pool.query("SELECT * FROM messaging_routes WHERE phone=$1 AND state='active' AND channel IN ('imessage','whatsapp') ORDER BY channel LIMIT 1",[phone])).rows[0];
      await messenger.send(known?.channel??'imessage',{phone,conversation:known?.conversation_id},{text:`Your Swarm sign-in code is ${code}. It expires in 10 minutes. If you did not request it, ignore it.`},`phone-${id}`).catch(()=>{});
      return c.json({id,line:await messenger.line()});
    });
    app.post(`${route}/verify`,async c=>{
      const b=await c.req.json(),s=await session(c);
      if(typeof b.id!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(b.id)||getCookie(c,'swarm_phone_attempt')!==b.id)return c.json({error:'This code expired. Start again.'},401);
      if(linking&&!recent(s))return c.json({error:'Sign in again to link this phone.',code:'reauth_required'},401);
      let waiting:string|undefined,verified;
      try{verified=await directory.transaction(async client=>{
        const row=(await client.query('SELECT * FROM phone_attempts WHERE hash=$1 AND expires_at>now() FOR UPDATE',[hashToken(b.id)])).rows[0];
        if(!row||row.attempts>=5||(row.link_session??null)!==(linking?s.hash:null))return null;
        await client.query('UPDATE phone_attempts SET attempts=attempts+1 WHERE hash=$1',[row.hash]);
        const expected=Buffer.from(row.code_hash),actual=Buffer.from(codeHash(b.id,String(b.code??'')));
        if(expected.length!==actual.length||!timingSafeEqual(expected,actual))return null;
        if(!linking)waiting=row.phone;
        const before=(await client.query("SELECT tenant_id FROM identities WHERE provider='phone' AND subject=$1",[row.phone])).rows[0];
        if(!linking)await ownership.admitPhone(client,row.phone,typeof b.inviteCode==='string'?b.inviteCode:undefined);
        const tenant=await directory.identityInTransaction(client,'phone',row.phone,{name:'Swarm member'},linking?s.hash:undefined);
        await client.query('DELETE FROM phone_attempts WHERE hash=$1',[row.hash]);return {...row,tenant,created:!before&&!linking};
      });}catch(error){if(error instanceof MessagingAdmissionError&&waiting)await noteVerifiedWaiter(directory,waiting,'imessage');throw error;}
      if(!verified)return c.json({error:'The code is invalid or expired.'},401);
      try{
        const tenant=verified.tenant;
        await envelopes.create(tenant);
        const metadata=secrets.open<any>(`phone:${hashToken(b.id)}`,verified.ciphertext);
        await linkRoute(tenant,{phone:verified.phone,channel:metadata.channel??'imessage',conversationId:metadata.conversationId},verified.link_session??undefined);
        deleteCookie(c,'swarm_phone_attempt',{path:'/api'});
        if(!linking)await issuePlatformSession(c,directory,tenant,revoke);
        return c.json({ok:true,created:verified.created,phone:verified.phone});
      }catch{return c.json({error:'This phone is linked to another account or authorization changed.'},409);}
    });
  }
  app.post('/api/messaging/inkbox/webhook',async c=>{
    if(!messenger.ready())return c.json({error:'Messaging unavailable.'},503);
    const raw=await c.req.text();
    if(raw.length>1024*1024||!messenger.verify(raw,Object.fromEntries(['x-inkbox-request-id','x-inkbox-timestamp','x-inkbox-signature'].map(k=>[k,c.req.header(k)]))))return c.json({error:'Invalid webhook.'},401);
    let e:Parsed|null;try{e=parseEvent(JSON.parse(raw));}catch{return c.json({error:'Invalid event.'},400);}
    if(!e)return c.body(null,204);
    // The signed provider payload alone determines the sender. Browser/model fields never route an event.
    let identity=(await directory.pool.query("SELECT i.tenant_id FROM identities i JOIN tenants t ON t.id=i.tenant_id WHERE i.provider='phone' AND i.subject=$1 AND t.state NOT IN ('deleting','deleted')",[e.phone])).rows[0];
    if(e.channel!=='sms'){
      const pending=(await directory.pool.query('SELECT * FROM phone_attempts WHERE phone=$1 AND expires_at>now() ORDER BY created_at DESC LIMIT 1',[e.phone])).rows[0];
      if(pending){
        const challenge=secrets.open<any>(`phone:${pending.hash}`,pending.ciphertext);
        const updated={...challenge,channel:e.channel,conversationId:e.conversationId};
        await directory.pool.query('UPDATE phone_attempts SET ciphertext=$2 WHERE hash=$1',[pending.hash,secrets.seal(`phone:${pending.hash}`,updated)]);
        await messenger.send(e.channel,{phone:e.phone,conversation:e.conversationId},{text:`Your Swarm sign-in code is ${challenge.code}. It expires in 10 minutes. If you did not request it, ignore it.`},`phone-reply-${hashToken(e.messageId)}`);
        return c.body(null,204);
      }
    }
    const link=e.text.trim().match(/^LINK\s+([A-Z0-9]{16})$/i);
    if(link&&!e.reaction){
      if(!await rate(`link-phone:${e.phone}`,5))return c.body(null,204);
      const tenant=await directory.transaction(async client=>{
        const attempt=(await client.query("SELECT * FROM messaging_tokens WHERE hash=$1 AND purpose='link' AND expires_at>now() FOR UPDATE",[hashToken(link[1].toUpperCase())])).rows[0];
        if(!attempt)return null;
        const owner=await directory.identityInTransaction(client,'phone',e.phone,{name:e.name??'Swarm member'},attempt.session_hash);
        if(owner!==attempt.tenant_id)throw new MessagingNotFound();
        await client.query('DELETE FROM messaging_tokens WHERE hash=$1',[attempt.hash]);return {owner,session:attempt.session_hash};
      });
      if(tenant){await envelopes.create(tenant.owner);await linkRoute(tenant.owner,e,tenant.session);}
      return c.body(null,204);
    }
    if(!identity&&!e.reaction){
      const invite=e.text.trim().match(/^(?:JOIN\s+)?([A-Z0-9]{8,16})$/i)?.[1];
      try{
        const tenant=await directory.transaction(async client=>{
          await ownership.admitPhone(client,e!.phone,invite);
          return directory.identityInTransaction(client,'phone',e!.phone,{name:e!.name??'Swarm member'});
        });
        await envelopes.create(tenant);await linkRoute(tenant,e);identity={tenant_id:tenant};
        if(invite)return c.body(null,204);
      }catch(error){if(error instanceof MessagingAdmissionError){await noteVerifiedWaiter(directory,e.phone,e.channel);return c.body(null,204);}throw error;}
    }
    if(!identity)return c.body(null,204);
    const route=await ownership.route(identity.tenant_id,e.channel);
    if(!route)return c.body(null,204);
    if(/^\/(web|login)\s*$/i.test(e.text)){
      await sendLogin(identity.tenant_id,e.channel,`login-${hashToken(e.messageId)}`);return c.body(null,204);
    }
    if(/^\/delete(?:\s+confirm)?\s*$/i.test(e.text)){
      const tenant=identity.tenant_id,key=hashToken(`delete:${tenant}:${e.channel}`);
      if(/^\/delete\s+confirm\s*$/i.test(e.text)){
        try{await directory.revokeTenant(tenant,{phone:{tokenHash:key,channel:e.channel,revision:String(route.revision)}});revoke(tenant);}
        catch(error){if(!(error instanceof Error)||error.message!=='reauth_required')throw error;}
      }else{
        // A signed message from the verified phone is recent authentication via the phone login method.
        const admitted=await ownership.begin(tenant,e.channel,`delete-${hashToken(e.messageId)}`);
        if(admitted){
          await directory.pool.query("INSERT INTO messaging_tokens(hash,tenant_id,purpose,channel,revision,expires_at) VALUES($1,$2,'delete',$3,$4,now()+interval '5 minutes') ON CONFLICT(hash) DO UPDATE SET revision=excluded.revision,expires_at=excluded.expires_at",[key,tenant,e.channel,route.revision]);
          await ownership.validate(tenant,e.channel,String(route.revision));
          try{await messenger.send(e.channel,{phone:route.phone,conversation:route.conversation_id??undefined},{text:'This deletes your Swarm account, Bots, files and connections. Send /delete confirm within 5 minutes to continue.'},`delete-${hashToken(e.messageId)}`);await ownership.finish(tenant,`delete-${hashToken(e.messageId)}`,'completed');}
          catch{await ownership.finish(tenant,`delete-${hashToken(e.messageId)}`,'uncertain');}
        }
      }
      return c.body(null,204);
    }
    await ownership.accept(identity.tenant_id,e);
    return c.body(null,204);
  });
  app.post('/internal/runtime/messaging',async c=>{
    const token=(c.req.header('authorization')??'').replace(/^Bearer /,'');
    const authorize=async(client?:PoolClient)=>{try{return await runtime.verify(token,'swarm-runtime',client);}catch{throw new MessagingNotFound();}};
    let owner;try{owner=await authorize();}catch{return c.json({error:'Unauthenticated runtime.'},401);}
    const b=await c.req.json();
    if(!b||!['imessage','whatsapp','sms'].includes(b.channel)||!['send','audio','typing','disconnect','status','validate','login-link','invite','delivery-target','deliver'].includes(b.operation))return c.json({error:'Invalid messaging operation.'},400);
    const allowed=b.operation==='deliver'?['operation','channel','text','id','expected']:b.operation==='send'?['operation','channel','text','quote','id']:b.operation==='audio'?['operation','channel','audio','id']:b.operation==='validate'?['operation','channel','revision','receipt']:['operation','channel'];
    if(Object.keys(b).some(k=>!allowed.includes(k)))return c.json({error:'Invalid messaging operation.'},400);
    await authorize();
    if(b.operation==='status'){const line=await messenger.line(),policy=await signupPolicy(directory.pool);await authorize();return c.json({line,memberInvites:policy.memberInvites});}
    if(b.operation==='disconnect'){await ownership.disconnect(owner.tenant,b.channel,authorize);return c.json({ok:true});}
    if(b.operation==='validate'){await ownership.validate(owner.tenant,b.channel,b.revision,b.receipt);await authorize();return c.json({ok:true});}
    if(b.operation==='login-link'){await sendLogin(owner.tenant,b.channel,undefined,authorize);return c.json({ok:true});}
    if(b.operation==='invite')return c.json(await ownership.memberInvite(owner.tenant,authorize));
    if (b.operation === 'delivery-target') {
      const route = await ownership.route(owner.tenant, b.channel);
      if (!route) throw new MessagingNotFound();
      await authorize();
      return c.json({ target: { channel: b.channel, transport: 'platform', phone: route.phone, chatRef: route.conversation_id, revision: String(route.revision) } });
    }
    if (b.operation === 'deliver') {
      const expected = b.expected as MessagingDeliveryTarget | undefined;
      if (typeof b.id !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(b.id) || typeof b.text !== 'string' || !b.text || b.text.length > 4000
        || !expected || Array.isArray(expected) || typeof expected !== 'object' || Object.keys(expected).some(k => !['phone','conversation','revision'].includes(k))
        || typeof expected.phone !== 'string' || !/^\d{8,15}$/.test(expected.phone) || typeof expected.revision !== 'string' || !/^\d{1,30}$/.test(expected.revision)
        || !(expected.conversation === null || typeof expected.conversation === 'string' && expected.conversation.length <= 1000)) return c.json({ error: 'Invalid controlled delivery.' }, 400);
      const notSent = () => c.json({ outcome: 'not_sent', error: 'Approved destination is unavailable or changed. No message was sent.' });
      const unknown = () => c.json({ outcome: 'unknown', error: 'Message outcome is unknown. Do not automatically resend.' });
      // A duplicate dispatch is never proof that nothing was sent. Only a persisted
      // not_sent outcome can authorize a fresh *attempt* at the tenant boundary.
      const previous = await ownership.dispatchState(owner.tenant, b.id);
      if (previous) return previous === 'not_sent' ? notSent() : unknown();
      if (!messenger.ready()) return notSent();
      let route;
      try {
        route = await ownership.begin(owner.tenant, b.channel, b.id, undefined, authorize, expected);
      } catch (error) {
        if (error instanceof MessagingDestinationChanged || error instanceof MessagingNotFound) return notSent();
        throw error;
      }
      if (!route) return unknown();
      try {
        await authorize();
        await ownership.validateDeliveryTarget(owner.tenant, b.channel, expected);
      } catch {
        await ownership.finish(owner.tenant, b.id, 'not_sent');
        return notSent();
      }
      let dispatchAllowed = false;
      try {
        const id = await messenger.send(b.channel, { phone: route.phone, conversation: route.conversation_id ?? undefined }, { text: b.text }, b.id, async () => {
          try { await authorize(); await ownership.validateDeliveryTarget(owner.tenant, b.channel, expected); }
          catch { throw new MessagingDestinationChanged('Approved route changed before provider dispatch.'); }
          dispatchAllowed = true;
        });
        if (!id) throw new Error('Provider did not acknowledge delivery.');
        await ownership.finish(owner.tenant, b.id, 'completed', id);
        return c.json({ outcome: 'delivered', id });
      } catch (error) {
        const state = error instanceof MessagingDestinationChanged && !dispatchAllowed ? 'not_sent' : 'uncertain';
        await ownership.finish(owner.tenant, b.id, state);
        return state === 'not_sent' ? notSent() : unknown();
      }
    }
    if(b.operation==='typing'){
      const route=await ownership.route(owner.tenant,b.channel);if(!route)throw new MessagingNotFound();
      if(!await rate(`typing:${owner.tenant}`,3000))return c.json({error:'Typing rate exceeded.'},429);
      await ownership.validate(owner.tenant,b.channel,String(route.revision));
      await authorize();
      if(b.channel==='imessage'&&route.conversation_id)await messenger.typing?.(route.conversation_id);
      return c.json({ok:true});
    }
    let message:OutboundMessage;
    if(b.operation==='audio'){
      if(b.channel!=='imessage'||!b.audio||Object.keys(b.audio).some(k=>!['data','mime','filename'].includes(k))||typeof b.audio.data!=='string'||b.audio.data.length>5592408||!/^audio\/(mpeg|mp3|wav|x-wav|ogg|flac|mp4|aac|webm)$/.test(b.audio.mime)||typeof b.audio.filename!=='string'||! /^[A-Za-z0-9_.-]{1,80}$/.test(b.audio.filename))return c.json({error:'Invalid audio.'},400);
      const data=Buffer.from(b.audio.data,'base64');if(!data.length||data.length>4*1024*1024||data.toString('base64')!==b.audio.data)return c.json({error:'Invalid audio.'},400);
      message={audio:{data,mime:b.audio.mime,filename:b.audio.filename}};
    }else{
      if(typeof b.text!=='string'||b.text.length>4000||(b.quote!==undefined&&(typeof b.quote!=='string'||b.quote.length>500)))return c.json({error:'Invalid message.'},400);
      message={text:b.text,quote:b.quote};
    }
    if(typeof b.id!=='string'||!/^[A-Za-z0-9_-]{16,100}$/.test(b.id))return c.json({error:'Invalid message.'},400);
    const route=await ownership.begin(owner.tenant,b.channel,b.id,b.quote,authorize);
    if(!route)return c.json({error:'Authorization changed or message already dispatched.'},409);
    try{
      await ownership.validate(owner.tenant,b.channel,String(route.revision));
      await authorize();
      const id=await messenger.send(b.channel,{phone:route.phone,conversation:route.conversation_id??undefined},message,b.id,async()=>{await authorize();await ownership.validate(owner.tenant,b.channel,String(route.revision));});
      await ownership.finish(owner.tenant,b.id,'completed',id);
      return c.json({id});
    }catch{await ownership.finish(owner.tenant,b.id,'uncertain');return c.json({error:'Message outcome is uncertain. Do not automatically resend.'},502);}
  });
  return app;
}
