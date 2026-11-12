import { Hono } from 'hono';
import { z } from 'zod';
import { requireUser, type AuthVars } from './lib/auth.js';
import { DeliverableError, getRoutineRun, listArtifacts, listDeliveries, listRoutineRuns,
  readArtifact, requestDelivery, retryDelivery, sendDelivery } from './deliverables/index.js';

/** Mounted by the app at /api/deliverables. All downloads and mutations require the owning user. */
export const deliverablesApi = new Hono<AuthVars>();
deliverablesApi.use('*', requireUser);
deliverablesApi.onError((e, c) => {
  if (e instanceof DeliverableError) return c.json({ error: e.message }, e.status);
  if (e instanceof z.ZodError || e instanceof SyntaxError) return c.json({ error: 'Invalid deliverable request.' }, 400);
  console.warn('[deliverables] operation failed', e.name);
  return c.json({ error: 'Deliverable operation failed.' }, 500);
});

deliverablesApi.get('/bots/:botId', (c) => {
  const userId = c.get('user').id;
  const artifacts = listArtifacts(userId, c.req.param('botId')).map((a) => ({ ...a, deliveries: listDeliveries(userId, a.id) }));
  return c.json({ artifacts });
});
deliverablesApi.get('/bots/:botId/runs', (c) => c.json({ runs: listRoutineRuns(c.get('user').id, c.req.param('botId'), c.req.query('routineId')) }));
deliverablesApi.get('/runs/:runId', (c) => {
  const userId = c.get('user').id, run = getRoutineRun(userId, c.req.param('runId'));
  return c.json({ run, artifacts: listArtifacts(userId, run.botId, run.id) });
});
deliverablesApi.get('/artifacts/:artifactId/download', (c) => {
  const { artifact, content } = readArtifact(c.get('user').id, c.req.param('artifactId'));
  const asciiName = artifact.filename.replace(/[^A-Za-z0-9._-]/g, '_');
  return c.body(content, 200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(artifact.filename).replace(/['()*]/g, (s) => `%${s.charCodeAt(0).toString(16)}`)}`,
    'Content-Length': String(content.length),
    'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  });
});
deliverablesApi.post('/artifacts/:artifactId/deliveries', async (c) => {
  const { channel } = z.object({ channel: z.enum(['library', 'imessage', 'sms', 'whatsapp']) }).strict().parse(await c.req.json());
  const delivery = await requestDelivery({ userId: c.get('user').id, artifactId: c.req.param('artifactId'), channel, idempotencyKey: c.req.header('Idempotency-Key') });
  return c.json({ delivery: await sendDelivery(c.get('user').id, delivery.id) });
});
deliverablesApi.post('/deliveries/:deliveryId/retry', async (c) => {
  const d = retryDelivery(c.get('user').id, c.req.param('deliveryId'));
  return c.json({ delivery: await sendDelivery(c.get('user').id, d.id) });
});
