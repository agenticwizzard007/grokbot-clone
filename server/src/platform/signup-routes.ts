import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import QRCode from 'qrcode';
import type { Directory } from './directory.js';
import { SignupAdministration, SignupError } from './signup.js';
import { requestBoundary } from '../security/request.js';

export function signupAdminRoutes(directory: Directory) {
  const app = new Hono(), admin = new SignupAdministration(directory);
  for (const path of ['/api/platform/signup', '/api/messaging/invites', '/api/messaging/invites/*', '/api/messaging/waitlist', '/api/messaging/waitlist/*']) app.use(path, requestBoundary, bodyLimit({ maxSize:4096 }));
  app.onError((error,c) => error instanceof SignupError ? c.json({ error:error.message },error.status) : error instanceof SyntaxError ? c.json({ error:'Invalid JSON request.' },400) : c.json({ error:'Signup administration is unavailable.' },503));
  app.get('/api/platform/signup',async c => {
    try { return c.json({ admin:true, settings:await admin.settings(getCookie(c,'swarm_session')) }); }
    catch (e) { if (e instanceof SignupError && e.status===403) return c.json({ admin:false }); throw e; }
  });
  app.put('/api/platform/signup',async c => c.json({ admin:true, settings:await admin.update(getCookie(c,'swarm_session'),await c.req.json()) }));
  app.get('/api/messaging/invites',async c => c.json(await admin.invites(getCookie(c,'swarm_session'),c.req.query('cursor'))));
  app.post('/api/messaging/invites',async c => {
    const raw = getCookie(c,'swarm_session'), result = await admin.createInvite(raw,await c.req.json());
    const qr = await QRCode.toDataURL(result.invite.url,{margin:1,width:200});
    await admin.authorized(raw,true,async()=>{});
    return c.json({invite:{...result.invite,qr}});
  });
  app.delete('/api/messaging/invites/:code',async c => c.json(await admin.revokeInvite(getCookie(c,'swarm_session'),c.req.param('code'))));
  app.get('/api/messaging/waitlist',async c => c.json(await admin.waitlist(getCookie(c,'swarm_session'),c.req.query('cursor'))));
  for (const [verb,state] of [['approve','approved'],['decline','declined']] as const) app.post(`/api/messaging/waitlist/:phone/${verb}`,async c => {
    const body = await c.req.json();
    if (!body || typeof body!=='object' || Object.keys(body).some(k=>k!=='revision')) return c.json({error:'Invalid waitlist decision.'},400);
    return c.json(await admin.decide(getCookie(c,'swarm_session'),c.req.param('phone'),body.revision,state));
  });
  return app;
}
