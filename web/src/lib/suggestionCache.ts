import { SUGGESTION_FILTER_VERSION } from '../../../server/src/suggestion-policy';
import type { SuggestedToolkit } from './api';
import { createSettingsCache } from './settingsReads';

export type Suggestions = { suggestions: SuggestedToolkit[]; hasContext?: boolean; filterVersion?: string };
export const suggestionCacheKey = (key: string) => JSON.stringify([SUGGESTION_FILTER_VERSION, key]);

/** Old snapshots and responses from an older server must never reach either mount. */
export function createSuggestionCache(storage = createSettingsCache<Suggestions>()) {
  return {
    scope: storage.scope,
    peek(key: string) {
      const value = storage.peek(suggestionCacheKey(key));
      return value?.filterVersion === SUGGESTION_FILTER_VERSION ? value : undefined;
    },
    refresh(key: string, read: () => Promise<Suggestions>) {
      return storage.refresh(suggestionCacheKey(key), async () => {
        const value = await read();
        if (value.filterVersion !== SUGGESTION_FILTER_VERSION) throw new Error('App suggestions have changed. Reload the page and try again.');
        return value;
      });
    },
  };
}
