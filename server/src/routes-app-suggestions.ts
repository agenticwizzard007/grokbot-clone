import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthVars } from './lib/auth.js';
import { readJson } from './lib/json.js';
import { catalog, connectionsDetail } from './composio.js';
import { getBotRow } from './store.js';
import { getSetup } from './bot-setup.js';
import { llmClient, defaultModel } from './lib/llm.js';
import { recordModelUsage, withUsage } from './usage.js';
import { availableSuggestions, createSuggestionRanker, fallbackSuggestions, SUGGESTION_PROMPT, withSuggestionTimeout } from './app-suggestions.js';
import { toolkitIcon } from './toolkit-icons.js';
import { env } from './env.js';

// Mounted under the main API's session and Bot body-limit middleware.
export const appSuggestionsApi = new Hono<AuthVars>();
const rank = createSuggestionRanker(async (input, signal) => {
  const model = defaultModel();
  const response: any = await llmClient(30_000).responses.create({
    model, store: false, tools: [], max_output_tokens: 1200,
    input: [{ role: 'system', content: SUGGESTION_PROMPT }, { role: 'user', content: input }],
  }, { signal });
  await recordModelUsage({ model, kind: 'other', response });
  const text = String(response.output_text ?? '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  return JSON.parse(text);
});
const draftSchema = z.object({ description: z.string().max(300).optional(), instructions: z.string().max(8000).optional() }).strict();

appSuggestionsApi.post('/bots/:id/suggested-apps', async c => {
  const userId = c.get('user').id;
  const bot = getBotRow(c.req.param('id'));
  if (!bot || bot.user_id !== userId || bot.kind === 'room') return c.json({ error: 'Bot not found.' }, 404);
  const body = await readJson(c, draftSchema); if (!body.ok) return body.response;
  const dependency: { stage: 'setup' | 'catalog' | 'connections' } = { stage: 'setup' };
  try {
    const context = {
      description: body.data.description ?? bot.description,
      instructions: body.data.instructions ?? bot.instructions,
      purpose: getSetup(bot.id)?.brief.purpose ?? '',
    };
    const started = performance.now();
    const suggestions = await withSuggestionTimeout(async signal => {
      dependency.stage = 'catalog';
      if (!env.composioEnabled) throw new Error('catalog_not_configured');
      const available = await catalog();
      signal.throwIfAborted();
      if (!available.length) return [];
      let result: unknown;
      let fallback = false;
      try {
        result = await withSuggestionTimeout(rankSignal => withUsage({ userId, botId: bot.id, kind: 'other' }, async () => {
          const model = defaultModel();
          rankSignal.throwIfAborted();
          // The ranker's conservative default budget fits without a separate model discovery call.
          return rank(userId, model, context, available);
        }), Math.max(1, Math.min(1500, 2500 - (performance.now() - started))));
      } catch {
        // Model credentials, provider errors, invalid JSON and ranker timeouts
        // do not prevent a safe ranking of real catalog entries.
        fallback = true;
      }
      signal.throwIfAborted();
      // Recheck membership and connection state even on a cached ranking.
      const current = await catalog();
      if (!env.composioEnabled) throw new Error('catalog_not_configured');
      dependency.stage = 'connections';
      const accounts = await connectionsDetail(userId, { signal });
      signal.throwIfAborted();
      const connected = new Set(accounts.filter(account => account.status === 'ACTIVE' && !account.isDisabled).map(account => account.toolkit));
      return availableSuggestions(fallback ? { suggestions: fallbackSuggestions(context, current) } : result, current, connected, context);
    }, 4_000);
    c.header('Server-Timing', `suggestions;dur=${(performance.now() - started).toFixed(1)}`);
    return c.json({ suggestions, hasContext: Object.values(context).some(text => text.trim()) });
  } catch (error) {
    // Report the failed dependency without exposing provider bodies or credentials.
    const detail = error instanceof Error ? error.message : '';
    const code = detail === 'catalog_not_configured' ? 'catalog_not_configured'
      : dependency.stage === 'catalog' && /(?:401|403)/.test(detail) ? 'catalog_authorization'
      : `${dependency.stage}_unavailable`;
    const messages: Record<string, string> = {
      catalog_not_configured: 'App suggestions need the app catalog service to be configured by the server administrator.',
      catalog_authorization: 'The app catalog service rejected the server credentials. The server administrator needs to check them.',
      catalog_unavailable: 'The app catalog could not be loaded. Retry to check available apps.',
      connections_unavailable: 'Connected app status could not be checked. Retry to avoid suggesting apps you already connected.',
      setup_unavailable: 'This Bot\'s saved setup could not be read. Retry after reloading its Setup tab.',
    };
    return c.json({ error: messages[code], code }, 503);
  }
});

appSuggestionsApi.get('/toolkits/icon/:slug', async c => {
  const slug = c.req.param('slug');
  if (!/^[a-z0-9_-]{1,100}$/i.test(slug)) return c.body(null, 404);
  try {
    const item = (await catalog()).find(toolkit => toolkit.slug === slug);
    if (!item) return c.body(null, 404);
    const icon = await toolkitIcon(item.logo || `https://logos.composio.dev/api/${encodeURIComponent(slug)}`);
    if (!icon) return c.body(null, 404);
    return c.body(icon.body, 200, {
      'Content-Type': icon.type, 'Cache-Control': 'private, max-age=3600',
      'Content-Security-Policy': "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
      'X-Content-Type-Options': 'nosniff',
    });
  } catch { return c.body(null, 404); }
});
