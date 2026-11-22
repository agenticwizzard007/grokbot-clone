import { Hono } from 'hono';
import { z } from 'zod';
import { requireUser, type AuthVars } from './lib/auth.js';
import { readJson } from './lib/json.js';
import { accountPreferences, saveAccountPreferences } from './settings.js';

/** /api/account/preferences: per-account choices such as asking before Bots use their computer. */
export const preferencesApi = new Hono<AuthVars>();
preferencesApi.use('*', requireUser);

const patchSchema = z.object({ askBeforeComputer: z.boolean() }).strict();

preferencesApi.get('/preferences', (c) => c.json(accountPreferences(c.get('user').id)));

preferencesApi.patch('/preferences', async (c) => {
  const body = await readJson(c, patchSchema);
  if (!body.ok) return body.response;
  return c.json(saveAccountPreferences(c.get('user').id, body.data));
});
