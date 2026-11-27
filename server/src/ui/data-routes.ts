import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db.js';
import { requireUser, type AuthVars } from '../lib/auth.js';
import { DataExecutor } from './sources/executor.js';
import { uiEnabled } from './flags.js';
import { uiMetric } from './metrics.js';

const batchSchema = z.object({ requests: z.array(z.object({
  key: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/),
  source: z.string().min(1).max(80), params: z.unknown().default({}),
}).strict()).min(1).max(24) }).strict().superRefine((batch, ctx) => {
  if (new Set(batch.requests.map(request => request.key)).size !== batch.requests.length) {
    ctx.addIssue({ code: 'custom', message: 'Request keys must be unique.' });
  }
});

const enabled = (userId: string) => uiEnabled(db, userId);

export function createDataApi(options: { executor?: DataExecutor; clock?: () => number; enabled?: (userId: string) => boolean } = {}) {
  const executor = options.executor ?? new DataExecutor(), clock = options.clock ?? Date.now;
  const batches = new Map<string, number[]>();
  const api = new Hono<AuthVars>();
  api.use('*', async (c, next) => {
    const response = await requireUser(c, next);
    if (response instanceof Response && response.status === 401) return c.json({ code: 'not_found', message: 'Sign in to continue.' }, 401);
    return response;
  });
  api.use('*', async (c, next) => {
    if (!(options.enabled ?? enabled)(c.get('user').id)) return c.json({ code: 'disabled', message: 'Customization is disabled.' }, 404);
    c.header('Cache-Control', 'no-store');
    return next();
  });
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
    const tooLarge = () => c.json({ code: 'limit_exceeded', message: 'Request body is too large.' }, 413);
    if (Number(c.req.header('content-length')) > 256 * 1024) return tooLarge();
    const reader = c.req.raw.body?.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
    try {
      while (reader) {
        const chunk = await reader.read(); if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 256 * 1024) { await reader.cancel(); return tooLarge(); }
        chunks.push(chunk.value);
      }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { return c.json({ code: 'invalid_value', message: 'Invalid JSON request body.' }, 400); }
    finally { reader?.releaseLock(); }
    const parsed = batchSchema.safeParse(body);
    if (!parsed.success) return c.json({ code: 'invalid_value', message: 'Use 1 to 24 requests with unique keys.' }, 422);
    const start = performance.now();
    const entries = await Promise.all(parsed.data.requests.map(async request => [request.key, await executor.execute(userId, request)] as const));
    uiMetric('ui_data_request_ms', performance.now() - start);
    return c.json({ results: Object.fromEntries(entries) });
  });
  return api;
}

export const dataApi = createDataApi();
