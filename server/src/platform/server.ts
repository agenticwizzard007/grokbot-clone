import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie } from 'hono/cookie';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Server } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Directory } from './directory.js';
import { RuntimeIdentity } from './runtime-identity.js';
import { TenantEnvelopes } from './envelopes.js';
import { TunnelBroker } from './tunnel.js';
import { platformAuth } from './auth.js';
import { requestBoundary } from '../security/request.js';
import { platformMessaging } from './messaging.js';
import { BackupCatalog, backupRoutes } from './backups.js';
import {HostCheckpoints,hostCheckpointRoutes} from './host-checkpoints.js';
import { S3BackupStorage } from './backup-storage.js';
import { HostControl,hostControlRoutes } from './host-control.js';
import {HostInstallations,hostInstallationRoutes} from './host-installations.js';
import { runtimeOperations } from './runtime-operations.js';
import { signupAdminRoutes } from './signup-routes.js';
import { SessionNotifications } from './session-notifications.js';
import { startOperationsMetrics } from './operations-metrics.js';

export async function startPlatform() {
  const directory=new Directory(),origin=process.env.PLATFORM_URL!;
  const identity=new RuntimeIdentity(directory,fs.readFileSync(process.env.PLATFORM_PRIVATE_KEY_FILE!,'utf8'),fs.readFileSync(process.env.PLATFORM_PUBLIC_KEY_FILE!,'utf8'));
  const envelopes=new TenantEnvelopes(directory),broker=new TunnelBroker(directory,identity,[new URL(origin).origin],process.env.SESSION_SECRET!);
  const notifications=new SessionNotifications(directory,event=>event.scope ? broker.revokeCompanions(event.tenant,event.scope) : broker.revoke(event.tenant,event.session),ready=>broker.setDirectoryReady(ready));
  await notifications.start();
  const app=new Hono();
  const ordinaryBodyLimit=bodyLimit({maxSize:10*1024*1024});
  app.use('*',(c,next)=>c.req.method==='PUT'&&/^\/internal\/host\/backups\/[a-f0-9]{32}\/(?:manifest|\d{1,6})\.bin$/.test(c.req.path)?next():ordinaryBodyLimit(c,next));
  app.use('*',async(c,next)=>{
    c.header('Cache-Control','no-store');c.header('X-Content-Type-Options','nosniff');c.header('Referrer-Policy','no-referrer');
    if(c.req.path==='/api/auth/apple/callback')return next();
    return requestBoundary(c,next);
  });
  app.onError((_e,c)=>c.json({error:'The platform could not complete this request.'},503));
  app.get('/api/health',c=>c.json({ok:broker.ready,role:'platform'},broker.ready?200:503));
  for (const [route, file] of [['companion','swarm-companion.mjs'],['cli','cli-bridge.mjs']]) {
    app.get(`/api/${route}/script`, c => c.body(fs.readFileSync(new URL(`../../../companion/${file}`,import.meta.url),'utf8'),200,{'content-type':'text/javascript; charset=utf-8'}));
  }
  app.route('/api/auth',platformAuth(directory,envelopes,(tenant,session)=>broker.revoke(tenant,session)));
  app.route('/',platformMessaging(directory,envelopes,identity,(tenant,session)=>broker.revoke(tenant,session)));
  app.route('/',signupAdminRoutes(directory));
  const backupStorage=new S3BackupStorage();
  app.route('/internal/host/backups',backupRoutes(new BackupCatalog(directory,backupStorage),identity));
  app.route('/internal/host/checkpoints',hostCheckpointRoutes(new HostCheckpoints(directory),identity));
  app.route('/internal/host/installations',hostInstallationRoutes(new HostInstallations(directory,backupStorage),identity));
  app.route('/internal/host',hostControlRoutes(new HostControl(directory),identity));
  app.post('/internal/runtime/exchange',async c=>{
    const b=await c.req.json();
    if(typeof b.credential!=='string'||b.credential.length>256||typeof b.tenant!=='string'||typeof b.machine!=='string')return c.json({error:'Invalid runtime.'},401);
    try{
      const result=await identity.exchange(b.credential,b.tenant,b.machine,b.nextRefresh);
      const tenant=(await directory.pool.query('SELECT id,display_name,verified_email,volume_id,generation FROM tenants WHERE id=$1',[b.tenant])).rows[0];
      const key=await envelopes.key(tenant.id);
      try{await identity.verify(result.hostToken,'swarm-host');return c.json({...result,tenant,dataKey:key.toString('base64')});}finally{key.fill(0);}
    }catch{return c.json({error:'Runtime authentication failed.'},401);}
  });
  app.route('/internal/runtime',runtimeOperations(identity,(tenant,scope)=>broker.revokeCompanions(tenant,scope)));
  app.get('/api/apps/callback',async c=>{
    const target=new URL('/api/apps/callback',process.env.COMPOSIO_GATEWAY_URL!);target.search=new URL(c.req.url).search;
    const result=await fetch(target,{headers:{cookie:c.req.header('cookie')??''},redirect:'error',signal:AbortSignal.timeout(30_000)});
    return new Response(result.body,{status:result.status,headers:{'content-type':result.headers.get('content-type')??'text/plain','cache-control':'no-store','referrer-policy':'no-referrer'}});
  });
  app.delete('/api/account',async c=>{
    const session=await directory.session(getCookie(c,'swarm_session'));
    if(!session||new Date(session.authenticated_at).getTime()<Date.now()-600_000)return c.json({error:'Sign in again to delete your account.',code:'reauth_required'},401);
    const b=await c.req.json();if(b.confirmation!=='DELETE')return c.json({error:'Confirm account deletion.'},400);
    try{await directory.revokeTenant(session.tenant_id,{sessionHash:session.hash});}
    catch(error){if(error instanceof Error&&error.message==='reauth_required')return c.json({error:'Sign in again to delete your account.',code:'reauth_required'},401);throw error;}
    broker.revoke(session.tenant_id);return c.json({ok:true,state:'deleting'},202);
  });
  app.all('/api/*',async c=>{
    const session=await directory.session(getCookie(c,'swarm_session'));
    if(!session)return c.json({error:'Unauthenticated.'},401);
    if(session.state==='suspended')await directory.pool.query("INSERT INTO lifecycle_jobs(id,tenant_id,operation) VALUES(gen_random_uuid()::text,$1,'wake') ON CONFLICT(tenant_id,operation) DO UPDATE SET state='queued',retry_at=now() WHERE lifecycle_jobs.state='completed'",[session.tenant_id]);
    return broker.forward(c.req.raw,session);
  });
  const webDist=path.resolve(new URL('.',import.meta.url).pathname,'../../../web/dist');
  if(fs.existsSync(webDist)){app.use('/*',serveStatic({root:path.relative(process.cwd(),webDist)}));app.get('*',c=>c.html(fs.readFileSync(path.join(webDist,'index.html'),'utf8')));}
  const metrics=await startOperationsMetrics(directory,'platform',{state:()=>({ready:broker.ready})})
    .catch(async error=>{notifications.stop();await directory.pool.end();throw error;});
  const server=serve({fetch:app.fetch,port:Number(process.env.PORT??8787)});
  broker.attach(server as unknown as Server);
  server.on('close',()=>{notifications.stop();void metrics?.close().catch(()=>{});});
  return {server,directory};
}
