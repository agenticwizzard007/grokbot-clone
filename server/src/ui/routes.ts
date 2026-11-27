import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { requireUser, type AuthVars } from '../lib/auth.js';
import { REGISTRY, uiConfigSchema, type ErrorCode, type PatchOp, type Violation } from '../ui-config/index.js';
import { dataApi } from './data-routes.js';
import { resultHash, type SqliteUiConfigService } from './service.js';

const empty = z.object({}).strict();
const operation = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), path: z.string(), value: z.unknown() }).strict(),
  z.object({ op: z.literal('replace'), path: z.string(), value: z.unknown() }).strict(),
  z.object({ op: z.literal('test'), path: z.string(), value: z.unknown() }).strict(),
  z.object({ op: z.literal('remove'), path: z.string() }).strict(),
  z.object({ op: z.literal('move'), path: z.string(), from: z.string() }).strict(),
]);
const patch = z.array(operation).max(100);
const patchBody = z.union([patch, z.object({ patch }).strict()]);
const previewBody = z.object({ patch, intent: z.string().min(1).max(200), autofix: z.boolean().optional() }).strict();
const resetBody = z.object({ scope: z.enum(['all', 'appearance', 'theme', 'layout', 'components', 'dashboards', 'dashboard']), dashboardId: z.string().optional() }).strict();
const statusFor = (code: ErrorCode) => code === 'disabled' || code === 'not_found' ? 404
  : code === 'stale_revision' || code === 'stale_preview' ? 409 : code === 'preview_expired' ? 410 : code === 'rate_limited' ? 429 : 422;
class RequestError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly status: 400 | 409 | 413 | 415 | 422 = 422, readonly details?: Violation[]) { super(message); }
}

/** Read the actual byte stream before parsing, even if Content-Length is missing or false. */
async function body<T>(c: Context<AuthVars>, schema: z.ZodType<T>): Promise<T> {
  if (!/^application\/(?:json|json-patch\+json)(?:\s*;|$)/i.test(c.req.header('content-type') ?? ''))
    throw new RequestError('invalid_value', 'Send a JSON request.', 415);
  const reader = c.req.raw.body?.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  if (Number(c.req.header('content-length')) > 256 * 1024) throw new RequestError('limit_exceeded', 'Requests must be 256 KB or smaller.', 413);
  try {
    while (reader) {
      const item = await reader.read(); if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > 256 * 1024) { await reader.cancel(); throw new RequestError('limit_exceeded', 'Requests must be 256 KB or smaller.', 413); }
      chunks.push(item.value);
    }
  } finally { reader?.releaseLock(); }
  let raw: unknown;
  try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new RequestError('invalid_value', 'Send valid JSON.', 400); }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new RequestError('invalid_value', 'Check the request values.', 422,
    parsed.error.issues.map(issue => ({ path: `/${issue.path.join('/')}`, code: 'invalid_value', message: issue.message })));
  return parsed.data;
}

export function createUiApi(service: SqliteUiConfigService) {
  const api = new Hono<AuthVars>();
  const user = (c: Context<AuthVars>) => c.get('user').id;
  api.use('*', async (c, next) => {
    const response = await requireUser(c, next);
    if (response instanceof Response) {
      if (response.status === 401) return c.json({ code: 'not_found', message: 'Sign in to continue.' }, 401);
      if (response.status === 403) return c.json({ code: 'invalid_value', message: 'Invalid request origin.' }, 403);
      if (response.status === 415) return c.json({ code: 'invalid_value', message: 'Send a JSON request.' }, 415);
    }
    return response;
  });
  api.use('*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store');
    if (!service.enabled(user(c))) return c.json({ code: 'disabled', message: 'Appearance customization is disabled.' }, 404);
    await next();
  });
  api.onError((error, c) => {
    if (error instanceof RequestError) return c.json({ code: error.code, message: error.message,
      ...(error.details ? { details: error.details } : {}), ...(error.code === 'stale_revision' ? { current: service.get(user(c)) } : {}) }, error.status);
    console.error('[ui] request failed');
    return c.json({ code: 'invalid_value', message: 'Could not update appearance.' }, 500);
  });
  const expected = (c: Context<AuthVars>) => {
    const header = c.req.header('If-Match'), match = /^"(0|[1-9]\d*)"$/.exec(header ?? '');
    if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) !== service.get(user(c)).revision)
      throw new RequestError('stale_revision', 'Send the current revision in If-Match.', 409);
    return Number(match[1]);
  };
  const respond = (c: Context<AuthVars>, result: { ok: boolean; errors?: Violation[]; revision?: number; [key: string]: unknown }) => {
    if (!result.ok) {
      const first = result.errors?.[0] ?? { code: 'invalid_value' as const, message: 'Check the request values.' };
      return c.json({ code: first.code, message: first.message, details: result.errors,
        ...(first.code === 'stale_revision' ? { current: service.get(user(c)) } : {}) }, statusFor(first.code));
    }
    if (typeof result.revision === 'number') {
      c.header('ETag', `"${result.revision}"`);
      return c.json({ ...result, undoToken: result.revision - 1 });
    }
    return c.json(result);
  };
  api.get('/config', c => {
    const current = service.get(user(c)); c.header('ETag', `"${current.revision}"`);
    if ((c.req.header('If-None-Match') ?? '').split(',').map(tag => tag.trim().replace(/^W\//, '')).includes(`"${current.revision}"`)) return c.body(null, 304);
    return c.json({ ...current, status: current.status ?? 'ready', effective: { preset: current.doc.preset, dashboardCount: current.doc.dashboards.length },
      flags: { enabled: true, agentApplyMode: service.agentApplyMode(user(c)) } });
  });
  api.patch('/config', async c => {
    const input = await body(c, patchBody), revision = expected(c);
    return respond(c, service.patch(user(c), (Array.isArray(input) ? input : input.patch) as PatchOp[], revision, 'user'));
  });
  api.put('/config', async c => {
    const input = await body(c, z.unknown()), revision = expected(c);
    return respond(c, service.replace(user(c), input, revision));
  });
  api.post('/patches/preview', async c => {
    const input = await body(c, previewBody); expected(c);
    const result = service.preview(user(c), input.patch as PatchOp[], { intent: input.intent, actor: 'user', autofix: input.autofix });
    return respond(c, result.ok ? { ...result, violations: result.warnings, resultHash: resultHash(service.getPreview(user(c), result.previewId)!.result) } : result);
  });
  api.get('/previews/:id', c => {
    const preview = service.getPreview(user(c), c.req.param('id'));
    if (!preview) return c.json({ code: 'not_found', message: 'Preview not found.' }, 404);
    const { userId: _userId, ...publicPreview } = preview;
    return c.json({ ...publicPreview, violations: preview.warnings, resultHash: resultHash(preview.result) });
  });
  api.post('/previews/:id/apply', async c => {
    await body(c, empty);
    // Ownership and lifetime errors take precedence over revision errors.
    const preview = service.getPreview(user(c), c.req.param('id'));
    if (!preview) return c.json({ code: 'not_found', message: 'Preview not found.' }, 404);
    if (preview.status !== 'pending' || preview.baseRevision !== service.get(user(c)).revision)
      return respond(c, service.applyPreview(user(c), preview.id, 'user'));
    expected(c); return respond(c, service.applyPreview(user(c), preview.id, preview.actor === 'import' ? 'import' : 'user'));
  });
  api.post('/previews/:id/discard', async c => {
    await body(c, empty);
    if (!service.getPreview(user(c), c.req.param('id'))) return c.json({ code: 'not_found', message: 'Preview not found.' }, 404);
    expected(c); service.discardPreview(user(c), c.req.param('id')); return c.json({ ok: true });
  });
  api.post('/undo', async c => {
    const input = await body(c, z.object({ steps: z.number().int().min(1).max(10).default(1) }).strict()); const revision = expected(c);
    return respond(c, service.undo(user(c), input.steps, 'user', revision));
  });
  api.post('/reset', async c => {
    const input = await body(c, resetBody); const revision = expected(c);
    const preview = service.reset(user(c), input.scope, input.dashboardId, revision);
    return respond(c, preview.ok ? service.applyPreview(user(c), preview.previewId, 'reset') : preview);
  });
  api.get('/history', c => c.json({ history: service.history(user(c)) }));
  api.post('/history/:revision/restore', async c => {
    await body(c, empty); const revision = Number(c.req.param('revision'));
    if (!/^\d+$/.test(c.req.param('revision')) || !Number.isSafeInteger(revision) || !service.history(user(c)).some(row => row.revision === revision))
      return c.json({ code: 'not_found', message: 'Revision not found.' }, 404);
    return respond(c, service.restore(user(c), revision, expected(c)));
  });
  api.get('/presets', c => c.json({ builtin: REGISTRY.presets, user: service.presets(user(c)) }));
  api.post('/presets', async c => {
    const input = await body(c, z.object({ name: z.string(), includeDashboards: z.boolean().default(false) }).strict()); expected(c);
    return respond(c, service.savePreset(user(c), input.name, input.includeDashboards));
  });
  api.delete('/presets/:id', async c => {
    await body(c, empty);
    if (!service.presets(user(c)).some(preset => preset.id === c.req.param('id'))) return c.json({ code: 'not_found', message: 'Preset not found.' }, 404);
    expected(c); service.deletePreset(user(c), c.req.param('id')); return c.json({ ok: true });
  });
  api.get('/export', c => { c.header('Content-Disposition', 'attachment; filename="swarm-appearance.json"'); return c.json(service.export(user(c))); });
  api.post('/import/preview', async c => {
    const input = await body(c, z.unknown()); expected(c);
    const result = service.importPreview(user(c), input);
    return respond(c, result.ok ? { ...result, violations: result.warnings, resultHash: resultHash(service.getPreview(user(c), result.previewId)!.result) } : result);
  });
  api.get('/schema', c => {
    c.header('Cache-Control', 'private, max-age=3600');
    return c.json({ version: 1, schema: z.toJSONSchema(uiConfigSchema, { unrepresentable: 'any' }), registries: REGISTRY });
  });
  // UC-F owns the implementation. Shared authentication and flags cover it too.
  api.route('/', dataApi);
  api.all('*', c => c.json({ code: 'not_found', message: 'Route not found.' }, 404));
  return api;
}
