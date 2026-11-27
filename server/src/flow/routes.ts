import { Hono } from 'hono';
import { z } from 'zod';
import { requireUser, type AuthVars } from '../lib/auth.js';
import { apiBodyLimit } from '../security/body-limits.js';
import { db } from '../db.js';
import { getFlow, FlowError, hasTable } from './cache.js';
import { requestFlowRefresh } from './summary.js';

export const flowApi = new Hono<AuthVars>();
for (const path of ['/bots/:id/flow', '/bots/:id/flow/refresh']) {
  flowApi.use(path, requireUser, apiBodyLimit);
  flowApi.use(path, async (c, next) => { c.header('Cache-Control', 'private, no-cache'); await next(); });
}
flowApi.onError((error, c) => error instanceof FlowError ? c.json({ error: error.message, code: error.code }, error.status) : c.json({ error: 'Flow is unavailable.', code: 'flow_error' }, 500));
flowApi.get('/bots/:id/flow', c => {
  const model = getFlow(c.get('user').id, c.req.param('id'));
  const etag = `"${model.botId}:${model.version}"`;
  c.header('ETag', etag);
  c.header('X-Flow-Has-Runs', hasTable('agent_jobs') && db.prepare('SELECT 1 FROM agent_jobs WHERE bot_id=? LIMIT 1').get(model.botId) ? '1' : '0');
  if (c.req.header('If-None-Match') === etag) return c.body(null, 304);
  return c.json(model);
});
flowApi.post('/bots/:id/flow/refresh', async c => {
  const body = await c.req.json().catch(() => null);
  if (!z.object({}).strict().safeParse(body).success) return c.json({ error: 'Invalid refresh request.', code: 'invalid_request' }, 400);
  return c.json(requestFlowRefresh(c.get('user').id, c.req.param('id')));
});
