import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { db, now } from '../db.js';
import { env } from '../env.js';
import { requireUser, type AuthVars } from '../lib/auth.js';
import { selectCli, selectedCli } from '../cli/store.js';
import { defaultModel, llmProvider, openrouterModels } from '../lib/llm.js';
import { OpenRouterError, OPENROUTER_ERRORS, openrouterConnection, personalOpenRouterKey, saveOpenRouterKey, verifyPersonalOpenRouterKey } from './openrouter.js';

export function providerStatus(userId: string) {
  const row = openrouterConnection(userId);
  const linked = !!db.prepare('SELECT 1 FROM openrouter_identities WHERE user_id=?').get(userId);
  return {
    connected: !!row?.encrypted_key, linked, selected: !!row?.enabled, active: !!row?.enabled && !selectedCli(userId),
    hint: row?.key_hint ?? null, source: row?.source ?? null, model: row?.model || env.openrouterModel,
    provider: llmProvider(), defaultModel: defaultModel(),
    settingsUrl: row?.key_hash ? `https://openrouter.ai/keys/${row.key_hash}` : 'https://openrouter.ai/keys',
  };
}

export const providerApi = new Hono<AuthVars>();
providerApi.use('*', requireUser);
providerApi.use('*', bodyLimit({ maxSize: 4096 }));
providerApi.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  if (!['GET', 'HEAD'].includes(c.req.method)) {
    const origin = c.req.header('origin');
    if ((origin && ![new URL(env.appUrl).origin, new URL(env.serverUrl).origin].includes(origin)) || c.req.header('sec-fetch-site') === 'cross-site') return c.json({ error: 'Invalid request origin.' }, 403);
    if (!c.req.header('content-type')?.toLowerCase().startsWith('application/json')) return c.json({ error: 'Send a JSON request.' }, 415);
  }
  await next();
});
providerApi.get('/openrouter', (c) => c.json(providerStatus(c.get('user').id)));
providerApi.put('/openrouter/key', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (typeof body?.key !== 'string') return c.json({ error: 'Paste an OpenRouter API key.' }, 400);
  try {
    const key = body.key.trim();
    await verifyPersonalOpenRouterKey(key);
    saveOpenRouterKey(c.get('user').id, key, 'manual');
    return c.json(providerStatus(c.get('user').id));
  } catch (error) {
    const code = error instanceof OpenRouterError ? error.code : 'openrouter_unavailable';
    return c.json({ error: OPENROUTER_ERRORS[code] }, code === 'openrouter_unavailable' ? 502 : 400);
  }
});
providerApi.put('/openrouter', async (c) => {
  const body = await c.req.json().catch(() => null);
  const userId = c.get('user').id;
  if (!body || (body.enabled !== undefined && typeof body.enabled !== 'boolean') || (body.model !== undefined && (typeof body.model !== 'string' || body.model.length > 200)) || (body.enabled === undefined && body.model === undefined)) return c.json({ error: 'Choose a model or provider mode.' }, 400);
  if (!openrouterConnection(userId)) return c.json({ error: 'Connect OpenRouter first.' }, 409);
  if (body.enabled) {
    try { personalOpenRouterKey(userId); } catch { return c.json({ error: 'Reconnect OpenRouter before selecting it.' }, 409); }
  }
  if (body.model !== undefined) {
    let models;
    try { models = await openrouterModels(); } catch { return c.json({ error: 'Could not load models. Try again shortly.' }, 502); }
    if (!models.some(m => m.id === body.model)) return c.json({ error: 'Choose an available model that supports tools.' }, 400);
  }
  db.transaction(() => {
    if (body.model !== undefined) db.prepare("UPDATE provider_connections SET model=?,updated_at=? WHERE user_id=? AND provider='openrouter'").run(body.model, now(), userId);
    if (body.enabled !== undefined) {
      db.prepare("UPDATE provider_connections SET enabled=?,updated_at=? WHERE user_id=? AND provider='openrouter'").run(Number(body.enabled), now(), userId);
      // An explicit provider choice is required to leave subscription billing.
      selectCli(userId, null);
    }
  })();
  return c.json(providerStatus(userId));
});
providerApi.delete('/openrouter/key', (c) => {
  // Retain identity and selected mode. No implicit fallback to the server's paid key.
  db.prepare("UPDATE provider_connections SET encrypted_key=NULL,key_hint=NULL,key_hash=NULL,updated_at=? WHERE user_id=? AND provider='openrouter'").run(now(), c.get('user').id);
  return c.json(providerStatus(c.get('user').id));
});
