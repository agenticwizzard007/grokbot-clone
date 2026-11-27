import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { db } from '../db.js';
import { requireUser, type AuthVars } from '../lib/auth.js';
import { DataExecutor } from './sources/executor.js';

const batchSchema = z.object({ requests: z.array(z.object({
  key: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/),
  source: z.string().min(1).max(80), params: z.unknown().default({}),
}).strict()).min(1).max(24) }).strict().superRefine((batch, ctx) => {
  if (new Set(batch.requests.map(request => request.key)).size !== batch.requests.length) {
    ctx.addIssue({ code: 'custom', message: 'Request keys must be unique.' });
  }
});

function enabled(userId: string) {
  // UC-B owns the additive account flag migration and the parent route gate.
  const columns = db.prepare('PRAGMA table_info(account_preferences)').all() as { name: string }[];
  if (columns.some(column => column.name === 'ui_custom_enabled')) {
    const row = db.prepare('SELECT ui_custom_enabled FROM account_preferences WHERE user_id=?').get(userId) as { ui_custom_enabled: number | null } | undefined;
    if (row?.ui_custom_enabled != null) return row.ui_custom_enabled === 1;
  }
  return process.env.UI_CUSTOMIZATION === 'on';
}

export function createDataApi(options: { executor?: DataExecutor; clock?: () => number; enabled?: (userId: string) => boolean } = {}) {
  const executor = options.executor ?? new DataExecutor(), clock = options.clock ?? Date.now;
  const batches = new Map<string, number[]>();
  const api = new Hono<AuthVars>();
  api.use('*', requireUser);
  api.use('*', async (c, next) => {
    if (!(options.enabled ?? enabled)(c.get('user').id)) return c.json({ code: 'disabled', message: 'Customization is disabled.' }, 404);
    c.header('Cache-Control', 'no-store');
    return next();
  });
  api.use('*', bodyLimit({ maxSize: 256 * 1024, onError: c => c.json({ code: 'limit_exceeded', message: 'Request body is too large.' }, 413) }));
  api.post('/data', async c => {
    if (!/^application\/json(?:;|$)/i.test(c.req.header('content-type') ?? '')) return c.json({ code: 'invalid_value', message: 'Use a JSON request body.' }, 415);
    const userId = c.get('user').id, at = clock();
    for (const [id, times] of batches) {
      const active = times.filter(time => at - time < 60_000);
      if (active.length) batches.set(id, active); else batches.delete(id);
    }
    const times = batches.get(userId) ?? [];
    if (times.length >= 30) {
      c.header('Retry-After', String(Math.max(1, Math.ceil((times[0] + 60_000 - at) / 1000))));
      return c.json({ code: 'rate_limited', message: 'Too many data requests. Try again shortly.' }, 429);
    }
    batches.set(userId, [...times, at]);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ code: 'invalid_value', message: 'Invalid JSON request body.' }, 400); }
    const parsed = batchSchema.safeParse(body);
    if (!parsed.success) return c.json({ code: 'invalid_value', message: 'Use 1 to 24 requests with unique keys.' }, 422);
    const entries = await Promise.all(parsed.data.requests.map(async request => [request.key, await executor.execute(userId, request)] as const));
    return c.json({ results: Object.fromEntries(entries) });
  });
  return api;
}

export const dataApi = createDataApi();
