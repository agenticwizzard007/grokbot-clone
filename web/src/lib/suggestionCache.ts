import { SUGGESTION_FILTER_VERSION } from '../../../server/src/suggestion-policy';
import type { SuggestedToolkit } from './api';
import { createSettingsCache } from './settingsReads';

export type Suggestions = { suggestions: SuggestedToolkit[]; hasContext?: boolean; filterVersion?: string };
export const suggestionCacheKey = (key: string) => JSON.stringify([SUGGESTION_FILTER_VERSION, key]);

/** Old snapshots and responses from an older server must never reach either mount. */
export function createSuggestionCache(storage = createSettingsCache<Suggestions>()) {
  let owner: string | undefined;
  let generation = 0;
  const latest = new Map<string, Suggestions>();
  const requests = new Map<string, number>();
  const savedKey = (account: string) => `swarm.suggestions:${SUGGESTION_FILTER_VERSION}:${account}`;
  const valid = (value: Suggestions | undefined) => value?.filterVersion === SUGGESTION_FILTER_VERSION && Array.isArray(value.suggestions)
    && value.suggestions.every(app => app && typeof app.slug === 'string' && typeof app.name === 'string' && typeof app.reason === 'string');
  const persist = () => {
    try { if (owner) sessionStorage.setItem(savedKey(owner), JSON.stringify([...latest])); } catch { /* optional display cache */ }
  };
  return {
    scope(account: string | undefined) {
      if (owner === account) return;
      try { if (owner) sessionStorage.removeItem(savedKey(owner)); } catch { /* optional display cache */ }
      owner = account; generation++; latest.clear(); requests.clear(); storage.scope(account);
      try {
        const entries = account && JSON.parse(sessionStorage.getItem(savedKey(account)) || '[]');
        if (Array.isArray(entries)) for (const [bot, value] of entries.slice(-80)) {
          if (typeof bot === 'string' && valid(value)) latest.set(bot, value);
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
