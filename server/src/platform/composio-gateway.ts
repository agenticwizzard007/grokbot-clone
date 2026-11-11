import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie } from 'hono/cookie';
import { serve } from '@hono/node-server';
import fs from 'node:fs';
import { Directory, hashToken, opaqueToken } from './directory.js';
import { RuntimeIdentity } from './runtime-identity.js';
import { createComposioService } from './composio-service.js';
import { ConnectionGateway, ConnectionNotFound, publicAppTools } from './composio-policy.js';
import { TenantEnvelopes } from './envelopes.js';
import { resolveTenantSession } from './tenant-sessions.js';

export function composioGatewayApp(directory: Directory, runtime: RuntimeIdentity) {
  const { provider, registry, gateway } = createComposioService(directory);
  const app = new Hono();
  app.use('*', bodyLimit({ maxSize: 512 * 1024 }));
  app.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); c.header('Referrer-Policy', 'no-referrer'); await next(); });
  app.onError((e, c) => c.json({ error: e instanceof ConnectionNotFound ? 'Connection not found.' : 'Connected app operation refused.' }, e instanceof ConnectionNotFound ? 404 : 400));
  app.get('/health', c => c.json({ ok: true }));
  app.post('/webhooks/composio', async c => {
    const secret=process.env.COMPOSIO_WEBHOOK_SECRET;
    if(!secret)return c.json({error:'Webhook unavailable.'},503);
    const event=await provider.sdk.triggers.verifyWebhook({id:c.req.header('webhook-id')??'',timestamp:c.req.header('webhook-timestamp')??'',signature:c.req.header('webhook-signature')??'',payload:await c.req.text(),secret,tolerance:300});
    const data=event.payload,account=data.metadata.connectedAccount;
    const row=(await directory.pool.query(`SELECT p.*,t.composio_user_id FROM provider_triggers p JOIN tenants t ON t.id=p.tenant_id
      WHERE p.id=$1 AND p.connection_id=$2 AND p.state='active' AND t.state IN ('active','suspended')`,[data.id,account.id])).rows[0];
    if(!row||row.composio_user_id!==data.userId||row.composio_user_id!==account.userId)return c.json({error:'Event owner not found.'},404);
    await gateway.own(row.tenant_id,account.id,Number(row.revision));
    const id=`composio-${hashToken(c.req.header('webhook-id')??'')}`;
    await new TenantEnvelopes(directory).event(row.tenant_id,id,{type:'provider-trigger',triggerId:row.id,connectionId:account.id,revision:Number(row.revision),data});
    await directory.pool.query("INSERT INTO lifecycle_jobs(id,tenant_id,operation) VALUES($1,$2,'wake') ON CONFLICT(tenant_id,operation) DO UPDATE SET state='queued',retry_at=now() WHERE lifecycle_jobs.state='completed'",[opaqueToken(),row.tenant_id]);
    return c.json({ok:true});
  });
  app.post('/rpc', async c => {
    let identity;
    const token=(c.req.header('authorization') ?? '').replace(/^Bearer /, '');
    const authorize=()=>runtime.verify(token);
    try { identity = await authorize(); }
    catch { return c.json({ error: 'Unauthenticated runtime.' }, 401); }
    const tenant = identity.tenant;
    const gateway=new ConnectionGateway(registry,provider,authorize);
    const request = await c.req.json();
    if (!request || !request.input || typeof request.input !== 'object' || Object.keys(request).some(k => !['operation','input','sessionHash'].includes(k))) return c.json({ error: 'Invalid request.' }, 400);
    const a = request.input;
    // Each switch arm extracts only its own fields. No caller-provided SDK option objects are forwarded.
    switch (request.operation) {
      case 'trigger-types': return c.json(await provider.sdk.triggers.listTypes({toolkits:[String(a.toolkit)],limit:40}));
      case 'trigger-create': {
        const type=await provider.sdk.triggers.getType(String(a.slug));
        const selected=await gateway.select(tenant,type.toolkit.slug,typeof a.connectionId==='string'?a.connectionId:undefined);
        const providerIdentity=await registry.identity(tenant);await authorize();
        const result=await provider.sdk.triggers.create(providerIdentity,type.slug,{connectedAccountId:selected.id,triggerConfig:a.config??{}});
        await directory.pool.query("INSERT INTO provider_triggers(id,tenant_id,connection_id,revision) VALUES($1,$2,$3,$4)",[result.triggerId,tenant,selected.id,selected.revision]);
        return c.json(result);
      }
      case 'trigger-check':
      case 'trigger-enable':
      case 'trigger-disable':
      case 'trigger-delete': {
        const row=(await directory.pool.query('SELECT * FROM provider_triggers WHERE id=$1 AND tenant_id=$2',[String(a.triggerId),tenant])).rows[0];
        if(!row)throw new ConnectionNotFound();
        await gateway.own(tenant,row.connection_id,Number(row.revision));
        if(request.operation==='trigger-check'){if(row.state!=='active')throw new ConnectionNotFound();return c.json({ok:true});}
        await directory.pool.query('UPDATE provider_triggers SET state=$3 WHERE id=$1 AND tenant_id=$2',[row.id,tenant,request.operation==='trigger-enable'?'active':request.operation==='trigger-delete'?'deleted':'disabled']);
        await authorize();
        if(request.operation==='trigger-enable')await provider.sdk.triggers.enable(row.id);
        else if(request.operation==='trigger-disable')await provider.sdk.triggers.disable(row.id);
        else await provider.sdk.triggers.delete(row.id);
        return c.json({ok:true});
      }
      case 'connections': return c.json((await gateway.list(tenant)).map(r => ({ id: r.id, toolkit: r.toolkit, revision: r.revision, status: 'ACTIVE', isDefault: r.isDefault })));
      case 'disconnect': await gateway.disconnect(tenant, String(a.connectionId)); return c.json({ ok: true });
      case 'refresh': return c.json(await gateway.refresh(tenant, String(a.connectionId)));
      case 'execute': return c.json(await gateway.execute(tenant, { connectionId: String(a.connectionId), revision: Number(a.revision), dispatchId: String(a.dispatchId), slug: String(a.slug), arguments: a.arguments ?? {}, readOnly: a.readOnly }) as any);
      case 'default': {
        const { row } = await gateway.own(tenant, String(a.connectionId));
        await directory.transaction(async client => {
          await client.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [tenant]);
          await client.query('UPDATE connected_accounts SET is_default=false WHERE tenant_id=$1 AND toolkit=$2', [tenant, row.toolkit]);
          await client.query("UPDATE connected_accounts SET is_default=true WHERE tenant_id=$1 AND id=$2 AND state='active'", [tenant, row.id]);
        }); return c.json({ ok: true });
      }
      case 'catalog': {
        const result = await provider.sdk.toolkits.get({ limit: 100, cursor: typeof a.cursor === 'string' ? a.cursor : undefined });
        return c.json(result);
      }
      case 'search': {
        const toolkit = String(a.toolkit ?? '').toLowerCase();
        const row = await gateway.select(tenant, toolkit, typeof a.connectionId === 'string' ? a.connectionId : undefined);
        const result = await provider.sdk.tools.getRawComposioTools({ toolkits: [toolkit], search: String(a.query ?? '').slice(0, 300), limit: 20 });
        await gateway.own(tenant, row.id, row.revision);
        return c.json({ connectionId: row.id, revision: row.revision, tools: publicAppTools(result, toolkit) });
      }
      case 'connect': {
        const session = await resolveTenantSession(directory, await authorize(), request.sessionHash);
        if (!session) return c.json({ error: 'Start authorization from your signed-in app.' }, 401);
        const toolkit = String(a.toolkit ?? '');
        if (!/^[a-z0-9_]{1,100}$/.test(toolkit)) return c.json({ error: 'Invalid app.' }, 400);
        const state = opaqueToken();
        const callback = new URL('/api/apps/callback', process.env.PLATFORM_URL!); callback.searchParams.set('state', state);
        await directory.pool.query(`INSERT INTO connection_attempts(hash,tenant_id,session_hash,toolkit,expires_at)
          VALUES($1,$2,$3,$4,now()+interval '10 minutes')`, [hashToken(state), tenant, session.hash, toolkit]);
        await directory.pool.query('UPDATE connection_attempts SET native=$2 WHERE hash=$1', [hashToken(state), a.native === true]);
        const sessionSdk = await provider.sdk.create(await registry.identity(tenant), { manageConnections: false });
        if (!await resolveTenantSession(directory, await authorize(), request.sessionHash)) throw new ConnectionNotFound();
        const result = await sessionSdk.authorize(toolkit, { callbackUrl: callback.href });
        if (!result.id || !result.redirectUrl || new URL(result.redirectUrl).protocol !== 'https:') throw new Error('Invalid authorization response.');
        await directory.pool.query('UPDATE connection_attempts SET connection_id=$2 WHERE hash=$1', [hashToken(state), result.id]);
        if (!await resolveTenantSession(directory, await authorize(), request.sessionHash)) throw new ConnectionNotFound();
        return c.json({ redirectUrl: result.redirectUrl });
      }
      default: return c.json({ error: 'Unsupported app operation.' }, 400);
    }
  });
  // Mount on the public platform origin (reverse proxy only this exact path to this service).
  app.get('/api/apps/callback', async c => {
    const state = c.req.query('state') ?? '', session = await directory.session(getCookie(c, 'swarm_session'));
    if (!/^[A-Za-z0-9_-]{43}$/.test(state)) return c.json({ error: 'Authorization expired.' }, 400);
    // Native browsers have a separate cookie jar. The single-use attempt still requires
    // the initiating app session to be live and the provider to attest exact ownership.
    const a = (await directory.pool.query(`UPDATE connection_attempts a SET consumed_at=now() FROM sessions s, tenants t
      WHERE a.hash=$1 AND s.hash=a.session_hash AND s.tenant_id=a.tenant_id AND t.id=a.tenant_id
      AND t.state NOT IN ('deleting','deleted') AND s.expires_at>now() AND s.last_seen_at>now()-interval '24 hours'
      AND (a.native OR (a.tenant_id=$2 AND a.session_hash=$3)) AND a.consumed_at IS NULL AND a.expires_at>now() RETURNING a.*`, [hashToken(state), session?.tenant_id ?? null, session?.hash ?? null])).rows[0];
    if (!a?.connection_id) return c.json({ error: 'Authorization expired.' }, 400);
    const own = await provider.owned(await registry.identity(a.tenant_id), a.connection_id);
    if (!own?.active || own.toolkit !== a.toolkit) return c.json({ error: 'Authorization could not be confirmed.' }, 400);
    await directory.transaction(async client=>{
      if(!(await client.query(`SELECT 1 FROM sessions s JOIN tenants t ON t.id=s.tenant_id WHERE s.hash=$1 AND s.tenant_id=$2
        AND s.expires_at>now() AND s.last_seen_at>now()-interval '24 hours' AND t.state NOT IN ('deleting','deleted','failed') FOR UPDATE OF s,t`,[a.session_hash,a.tenant_id])).rowCount)throw new ConnectionNotFound();
      const registered=await client.query(`INSERT INTO connected_accounts(id,tenant_id,toolkit,state) VALUES($1,$2,$3,'active')
        ON CONFLICT(id) DO UPDATE SET state='active',revision=connected_accounts.revision+1 WHERE connected_accounts.tenant_id=excluded.tenant_id RETURNING id`, [a.connection_id, a.tenant_id, a.toolkit]);
      if(!registered.rowCount)throw new ConnectionNotFound();
    });
    return c.html('<!doctype html><meta charset="utf-8"><title>App connected</title><p>Your app is connected. Return to Swarm.</p>' + (a.native ? '<a href="so.swarms.app://connected">Return to Swarm</a>' : ''));
  });
  return app;
}
export async function startComposioGateway() {
  const directory = new Directory();
  const publicKey = fs.readFileSync(process.env.PLATFORM_PUBLIC_KEY_FILE!, 'utf8');
  const runtime = new RuntimeIdentity(directory, '', publicKey);
  serve({ fetch: composioGatewayApp(directory, runtime).fetch, port: Number(process.env.PORT ?? 8787) });
  const {provider}=createComposioService(directory);
  let busy=false;
  setInterval(()=>{if(busy)return;busy=true;void(async()=>{
    const rows=(await directory.pool.query("SELECT a.id,t.composio_user_id FROM connected_accounts a JOIN tenants t ON t.id=a.tenant_id WHERE t.state='deleting' AND a.state!='deleted' LIMIT 20")).rows;
    for(const row of rows){
      const remote=await provider.owned(row.composio_user_id,row.id);
      if(remote)await provider.disconnect(row.id);
      await directory.pool.query("UPDATE connected_accounts SET state='deleted' WHERE id=$1 AND state='revoked'",[row.id]);
    }
  })().catch(()=>{}).finally(()=>{busy=false;});},10_000).unref();
}
