import { cliCatalog } from './cli/catalog.js';
import { selectedCli } from './cli/store.js';
import { Hono } from 'hono';
import { db } from './db.js';
import { env } from './env.js';
import { requireUser, type AuthVars } from './lib/auth.js';
import { defaultModel, llmProvider, openrouterModels, type ModelInfo } from './lib/llm.js';
import { verifyDirectKey } from './settings.js';
import { getBotRow } from './store.js';
import { ANALYTICS_RANGES, botAnalytics, type AnalyticsRange } from './analytics.js';

/**
 * /api/models: the composer's model picker (every signed-in user, not just the owner): the models the
 * server's provider offers, with their effort levels, the user's favourites, and provider icons.
 * Also /api/bots/:id/analytics (a Bot's messages and estimated time saved).
 */
export const modelsApi = new Hono<AuthVars>();
modelsApi.use('*', requireUser);

/** "Anthropic: Claude Opus 5.5" → "Opus 5.5"; "OpenAI: GPT-5.5" → "GPT-5.5". */
export function shortName(m: Pick<ModelInfo, 'name' | 'author'>): string {
  let n = m.name.includes(': ') ? m.name.slice(m.name.indexOf(': ') + 2) : m.name;
  if (m.author === 'anthropic') n = n.replace(/^Claude /, '');
  return n;
}

/** Suggested favourites when the user hasn't chosen any: the first few of these the catalog has. */
const SUGGESTED = ['anthropic/claude-opus-5.5', 'openai/gpt-5.5', 'anthropic/claude-sonnet-5.5', 'google/gemini-4-argon', 'x-ai/grok-4.7'];

function favouritesOf(userId: string): string[] | null {
  const raw = (db.prepare('SELECT favorite_models FROM users WHERE id=?').get(userId) as any)?.favorite_models;
  if (!raw) return null;
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : null; } catch { return null; }
}

modelsApi.get('/models', async (c) => {
  const user = c.get('user');
  const provider = llmProvider();
  const cli = selectedCli(user.id);
  if (cli) {
    c.header('Cache-Control', 'no-store');
    try {
      const data = await cliCatalog(user.id, cli, true);
      const ids = new Set(data.models.map(m => m.id));
      const saved = favouritesOf(user.id)?.filter(id => ids.has(id));
      return c.json({ provider, billing: 'plan', canFast: false, ...data, favourites: saved?.length ? saved : data.models.slice(0, 12).map(m => m.id) });
    } catch (e) { return c.json({ provider, billing: 'plan', canFast: false, models: [], favourites: [], error: (e as Error).message }); }
  }
  let models: (ModelInfo & { short: string })[] = [];
  let error: string | undefined;
  if (provider === 'openrouter') {
    try { models = (await openrouterModels()).map((m) => ({ ...m, short: shortName(m) })); }
    catch (e: any) { error = String(e?.message ?? e); }
  } else if (env.directKey) {
    const r = await verifyDirectKey(env.directKey, env.directModel);
    if (r.ok) models = r.models.map((id) => ({ id, name: id, short: id, author: 'custom', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium', vision: true, reasoning: true, context: 0, price: { input: 0, output: 0 } }));
    else error = r.error;
  }
  const ids = new Set(models.map((m) => m.id));
  const saved = favouritesOf(user.id);
  const favourites = (saved ?? SUGGESTED).filter((id) => ids.has(id)).slice(0, 12);
  return c.json({ provider, billing: 'api', canFast: provider === 'openrouter', defaultModel: defaultModel(), models: models.map(m => ({ ...m, billing: 'api' })), favourites, suggested: saved === null, error });
});

modelsApi.put('/models/favourites', async (c) => {
  const p = await c.req.json().catch(() => ({}));
  const ids = Array.isArray(p.ids) ? [...new Set(p.ids.filter((x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 120))].slice(0, 12) : null;
  if (!ids) return c.json({ error: 'ids must be a list of model ids' }, 400);
  db.prepare('UPDATE users SET favorite_models=? WHERE id=?').run(JSON.stringify(ids), c.get('user').id);
  return c.json({ favourites: ids });
});

// ---------- provider icons: OpenRouter's, fetched once and served from here ----------

const ICON_FILES: Record<string, string> = {
  anthropic: 'Anthropic.svg', openai: 'OpenAI.svg', google: 'GoogleGemini.svg', meta: 'Meta.png', 'meta-llama': 'Meta.png',
  mistralai: 'Mistral.png', deepseek: 'DeepSeek.png', qwen: 'Qwen.png', moonshotai: 'MoonshotAI.png', cohere: 'Cohere.png',
};
const icons = new Map<string, { at: number; type: string; body: ArrayBuffer } | { at: number; missing: true }>();

modelsApi.get('/models/icon/:author', async (c) => {
  const author = c.req.param('author').toLowerCase();
  const file = ICON_FILES[author];
  if (!file) return c.body(null, 404);
  let hit = icons.get(author);
  const fresh = hit && Date.now() - hit.at < ('missing' in hit ? 3_600_000 : 86_400_000);
  if (!hit || !fresh) {
    try {
      const r = await fetch(`https://openrouter.ai/images/icons/${file}`, { signal: AbortSignal.timeout(8000) });
      const type = r.headers.get('content-type') ?? '';
      const body = await r.arrayBuffer();
      hit = r.ok && /^image\/(svg\+xml|png)/.test(type) && body.byteLength < 400_000 ? { at: Date.now(), type: type.split(';')[0], body } : { at: Date.now(), missing: true };
    } catch { hit = { at: Date.now(), missing: true }; }
    icons.set(author, hit);
  }
  if ('missing' in hit) return c.body(null, 404);
  return c.body(hit.body, 200, {
    'Content-Type': hit.type,
    'Cache-Control': 'private, max-age=86400',
    // A third party's SVG: never let it run script, even if opened directly.
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
    'X-Content-Type-Options': 'nosniff',
  });
});

// ---------- a Bot's analytics ----------

modelsApi.get('/bots/:id/analytics', (c) => {
  const b = getBotRow(c.req.param('id'));
  if (!b || b.user_id !== c.get('user').id) return c.json({ error: 'not found' }, 404);
  const range = ANALYTICS_RANGES.includes(c.req.query('range') as AnalyticsRange) ? (c.req.query('range') as AnalyticsRange) : '7d';
  return c.json(botAnalytics(b.id, range));
});
