import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthVars } from './lib/auth.js';
import { readJson } from './lib/json.js';
import { catalog, connectionsDetail } from './composio.js';
import { getBotRow } from './store.js';
import { getSetup } from './bot-setup.js';
import { llmClient, defaultModel, modelInfo } from './lib/llm.js';
import { recordModelUsage, withUsage } from './usage.js';
import { availableSuggestions, createSuggestionRanker, SUGGESTION_PROMPT } from './app-suggestions.js';
import { toolkitIcon } from './toolkit-icons.js';

// Mounted under the main API's session and Bot body-limit middleware.
export const appSuggestionsApi = new Hono<AuthVars>();
const rank = createSuggestionRanker(async input => {
  const model = defaultModel();
  const response: any = await llmClient(30_000).responses.create({
    model, store: false, tools: [], max_output_tokens: 1200,
    input: [{ role: 'system', content: SUGGESTION_PROMPT }, { role: 'user', content: input }],
  }, { signal: AbortSignal.timeout(30_000) });
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
  try {
    const context = {
      description: body.data.description ?? bot.description,
      instructions: body.data.instructions ?? bot.instructions,
      purpose: getSetup(bot.id)?.brief.purpose ?? '',
    };
    const available = await catalog();
    const result = await withUsage({ userId, botId: bot.id, kind: 'other' }, async () => {
      const model = defaultModel();
      const info = available.length ? await modelInfo(model) : undefined;
      return rank(userId, model, context, available, info?.context || undefined);
    });
    // Recheck membership and connection state even on a cached ranking.
    const [current, accounts] = await Promise.all([catalog(), connectionsDetail(userId)]);
    const connected = new Set(accounts.filter(account => account.status === 'ACTIVE' && !account.isDisabled).map(account => account.toolkit));
    return c.json({ suggestions: availableSuggestions(result, current, connected) });
  } catch {
    return c.json({ error: 'Suggestions are unavailable right now. Try again shortly.' }, 503);
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
