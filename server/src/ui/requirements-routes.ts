import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { requireUser, type AuthVars } from '../lib/auth.js';
import { patchSchema } from '../ui-config/patch.js';
import { RequirementsStore } from './requirements-store.js';

const writeSchema = z.union([z.object({ patch: patchSchema }).strict(), z.object({ undoReset: z.string().uuid() }).strict()]);
const empty = z.object({}).strict();
export function createRequirementsApi(store: RequirementsStore) {
  const api = new Hono<AuthVars>();
  const user = (c: Context<AuthVars>) => c.get('user').id;
  api.use('*', requireUser);
  api.use('*', bodyLimit({ maxSize: 8192, onError: c => c.json({ code: 'limit_exceeded', message: 'Requirements must fit in 8 KB.' }, 413) }));
  api.use('*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store');
    if (!store.enabled(user(c))) return c.json({ code: 'disabled', message: 'Dashboard suggestions are unavailable.' }, 404);
    if (!['GET', 'HEAD'].includes(c.req.method) && !/^application\/(?:json|json-patch\+json)(?:;|$)/i.test(c.req.header('content-type') ?? ''))
      return c.json({ code: 'invalid_value', message: 'Send a JSON request.' }, 415);
    await next();
  });
  const expected = (c: Context<AuthVars>): number | null => {
    const value = /^"(0|[1-9]\d*)"$/.exec(c.req.header('If-Match') ?? '');
    return value && Number.isSafeInteger(Number(value[1])) ? Number(value[1]) : null;
  };
  const respond = (c: Context<AuthVars>, result: any) => {
    if (!result.ok) {
      const first = result.errors[0];
      return c.json({ code: first.code, message: first.message, details: result.errors,
        ...(first.code === 'stale_revision' ? { current: store.get(user(c)) } : {}) },
        first.code === 'stale_revision' ? 409 : first.code === 'disabled' || first.code === 'not_found' ? 404 : 422);
    }
    if (typeof result.revision === 'number') c.header('ETag', `"${result.revision}"`);
    return c.json(result);
  };
  const write = async (c: Context<AuthVars>, schema: z.ZodType, action: (input: any, revision: number) => unknown) => {
    const revision = expected(c);
    if (revision === null) return c.json({ code: 'stale_revision', message: 'Send the requirements revision in If-Match.', current: store.get(user(c)) }, 409);
    let raw: unknown; try { raw = await c.req.json(); } catch { return c.json({ code: 'invalid_value', message: 'Send valid JSON.' }, 400); }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return c.json({ code: 'invalid_value', message: 'Check the request values.', details: parsed.error.issues.map(i => ({ path: `/${i.path.join('/')}`, code: 'invalid_value', message: i.message })) }, 422);
    return respond(c, action(parsed.data, revision));
  };
  api.get('/', c => {
    const result = store.get(user(c)); c.header('ETag', `"${result.revision}"`);
    if (c.req.header('If-None-Match') === `"${result.revision}"`) return c.body(null, 304);
    return c.json(result);
  });
  api.put('/', c => write(c, writeSchema, (input, revision) => 'patch' in input ? store.update(user(c), input.patch, revision) : store.undoReset(user(c), revision, input.undoReset)));
  api.delete('/', c => write(c, empty, (_input, revision) => store.reset(user(c), revision)));
  api.post('/suggest', c => write(c, empty, (_input, revision) => store.preview(user(c), revision)));
  // Existing clients can still ask explicitly, but only receive a dashboard addition.
  api.post('/adapt', c => write(c, empty, (_input, revision) => store.preview(user(c), revision)));
  api.onError((_error, c) => c.json({ code: 'invalid_value', message: 'Could not update requirements.' }, 500));
  return api;
}
