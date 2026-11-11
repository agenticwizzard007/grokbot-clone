import { Hono } from 'hono';
import type { RuntimeIdentity } from './runtime-identity.js';

/** Metadata mutations must retain current runtime authority across body reads and
 * directory lock waits. No caller-supplied tenant, machine or generation is used. */
export function runtimeOperations(identity: RuntimeIdentity, revokeCompanions: (tenant: string, scope: string) => void) {
  const app = new Hono();
  const token = (header?: string) => (header ?? '').replace(/^Bearer /, '');
  app.use('*', async (c, next) => {
    try { await identity.verify(token(c.req.header('authorization'))); }
    catch { return c.json({ error: 'Runtime authorization required.' }, 401); }
    return next();
  });
  app.onError((_error, c) => c.json({ error: 'Runtime authorization changed or operation requires retry.' }, 409));
  app.get('/events', async c => {
    const events = await identity.authorized(token(c.req.header('authorization')), async (owner, client) => {
      const result = await client.query('SELECT id,ciphertext FROM wake_events WHERE tenant_id=$1 ORDER BY created_at LIMIT 20', [owner.tenant]);
      return result.rows.map(event => ({ id: event.id, ciphertext: event.ciphertext.toString('utf8') }));
    });
    return c.json({ events });
  });
  app.post('/events/ack', async c => {
    const body = await c.req.json();
    if (!body || Object.keys(body).some(key => key !== 'ids') || !Array.isArray(body.ids) || body.ids.length > 20 || body.ids.some((id: unknown) => typeof id !== 'string' || id.length > 256)) return c.json({ error: 'Invalid event acknowledgement.' }, 400);
    await identity.authorized(token(c.req.header('authorization')), async (owner, client) => {
      await client.query('DELETE FROM wake_events WHERE tenant_id=$1 AND id=ANY($2::text[])', [owner.tenant, body.ids]);
    });
    return c.json({ ok: true });
  });
  app.post('/companions', async c => {
    const body = await c.req.json();
    if (!body || Object.keys(body).some(key => !['scope', 'hash'].includes(key)) || !['desktop', 'native-local', 'cli'].includes(body.scope) || (body.hash !== null && (typeof body.hash !== 'string' || !/^[a-f0-9]{64}$/.test(body.hash)))) return c.json({ error: 'Invalid computer registration.' }, 400);
    const tenant = await identity.authorized(token(c.req.header('authorization')), async (owner, client) => {
      await client.query('DELETE FROM companion_routes WHERE tenant_id=$1 AND scope=$2', [owner.tenant, body.scope]);
      if (body.hash) await client.query('INSERT INTO companion_routes(hash,tenant_id,scope,generation) VALUES($1,$2,$3,$4)', [body.hash, owner.tenant, body.scope, owner.generation]);
      return owner.tenant;
    });
    revokeCompanions(tenant, body.scope);
    return c.json({ ok: true });
  });
  return app;
}
