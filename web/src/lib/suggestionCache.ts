import { SUGGESTION_FILTER_VERSION } from '../../../server/src/suggestion-policy';
import type { SuggestedToolkit } from './api';
import { createSettingsCache } from './settingsReads';

export type Suggestions = { suggestions: SuggestedToolkit[]; hasContext?: boolean; filterVersion?: string };
export const suggestionCacheKey = (key: string) => JSON.stringify([SUGGESTION_FILTER_VERSION, key]);
export const SUGGESTION_STORAGE_KEY = 'swarm.suggestions';
export const SUGGESTION_STORAGE_VERSION = 1;
const MAX_BOTS = 20;
const MAX_CHARS = 32_000;

// Persist catalog identity only. Drafts, message text, model-written reasons and
// provider URLs stay in memory. A cold snapshot gets neutral copy until refreshed.
function snapshot(value: Suggestions): Suggestions {
  return { filterVersion: SUGGESTION_FILTER_VERSION, hasContext: !!value.hasContext,
    suggestions: value.suggestions.slice(0, 4).map(app => ({
      slug: app.slug, name: app.name, noAuth: !!app.noAuth, managedAuth: !!app.managedAuth, categories: [],
      reason: `${app.name} was suggested for this Bot.`,
    })) };
}
function valid(value: Suggestions | undefined): value is Suggestions {
  return value?.filterVersion === SUGGESTION_FILTER_VERSION && Array.isArray(value.suggestions) && value.suggestions.length <= 4
    && value.suggestions.every(app => app && typeof app.slug === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(app.slug)
      && typeof app.name === 'string' && app.name.length > 0 && app.name.length <= 100 && typeof app.noAuth === 'boolean');
}

/** Old snapshots and responses from an older server must never reach either mount. */
export function createSuggestionCache(storage = createSettingsCache<Suggestions>()) {
  let owner: string | undefined;
  let scoped = false;
  let generation = 0;
  const latest = new Map<string, Suggestions>();
  const requests = new Map<string, number>();
  const persist = () => {
    try {
      if (!owner) return;
      const bots = [...latest].filter(([, value]) => valid(value)).slice(-MAX_BOTS).map(([bot, value]) => [bot, snapshot(value)]);
      let saved = '';
      while (bots.length) {
        saved = JSON.stringify({ version: SUGGESTION_STORAGE_VERSION, account: owner, filterVersion: SUGGESTION_FILTER_VERSION, bots });
        if (saved.length <= MAX_CHARS) break;
        bots.shift();
      }
      if (bots.length) localStorage.setItem(SUGGESTION_STORAGE_KEY, saved);
      else localStorage.removeItem(SUGGESTION_STORAGE_KEY);
    } catch { /* optional display cache */ }
  };
  return {
    scope(account: string | undefined) {
      if (scoped && owner === account) return;
      scoped = true;
      try { if (owner) localStorage.removeItem(SUGGESTION_STORAGE_KEY); } catch { /* optional display cache */ }
      owner = account; generation++; latest.clear(); requests.clear(); storage.scope(account);
      try {
        const raw = localStorage.getItem(SUGGESTION_STORAGE_KEY);
        const saved = raw && raw.length <= MAX_CHARS ? JSON.parse(raw) : null;
        if (!account || saved?.account !== account || saved?.version !== SUGGESTION_STORAGE_VERSION
          || saved?.filterVersion !== SUGGESTION_FILTER_VERSION || !Array.isArray(saved?.bots)) {
          localStorage.removeItem(SUGGESTION_STORAGE_KEY);
          return;
        }
        for (const entry of saved.bots.slice(-MAX_BOTS)) {
          if (!Array.isArray(entry)) continue;
          const [bot, value] = entry;
          if (typeof bot === 'string' && bot.length <= 256 && valid(value)) latest.set(bot, snapshot(value));
        }
      } catch { /* a cold cache is safe */ }
    },
    last(botId: string) { return latest.get(botId); },
    peek(key: string) {
      const value = storage.peek(suggestionCacheKey(key));
      return value?.filterVersion === SUGGESTION_FILTER_VERSION ? value : undefined;
    },
    async refresh(key: string, read: () => Promise<Suggestions>, botId?: string) {
      const epoch = generation;
      const request = botId ? (requests.get(botId) ?? 0) + 1 : 0;
      if (botId) requests.set(botId, request);
      const value = await storage.refresh(suggestionCacheKey(key), async () => {
        const value = await read();
        if (value.filterVersion !== SUGGESTION_FILTER_VERSION) throw new Error('App suggestions have changed. Reload the page and try again.');
        return value;
      });
      if (botId && epoch === generation && requests.get(botId) === request) {
        latest.delete(botId); latest.set(botId, value);
        if (latest.size > 80) { const oldest = latest.keys().next().value!; latest.delete(oldest); requests.delete(oldest); }
        persist();
      }
      return value;
    },
  };
}

// Owned by the account lifecycle, even before a suggestions panel is lazy-loaded.
export const suggestionCache = createSuggestionCache();
