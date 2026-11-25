import { api, type AppsResponse } from './api';
import { verifyAccessAccount } from './accessApi';
import { useStore } from '../store';
import { createSettingsCache, settingsRead } from './settingsReads';
import { suggestionCache as suggestions } from './suggestionCache';

const cache = createSettingsCache<AppsResponse>();
useStore.subscribe((state, previous) => {
  if (state.user?.id !== previous.user?.id) cache.scope(state.user?.id);
});
const key = (search = '', category = '', offset = 0) => JSON.stringify([search, category, offset]);
export function cachedApps(accountId: string, search = '', category = '', offset = 0) {
  cache.scope(accountId);
  return cache.peek(key(search, category, offset));
}
export function refreshApps(accountId: string, search = '', category = '', offset = 0) {
  cache.scope(accountId);
  return cache.refresh(key(search, category, offset), () => settingsRead(async signal => {
    await verifyAccessAccount(accountId, signal);
    const result = await api.apps(search, category, offset, signal);
    await verifyAccessAccount(accountId, signal);
    return result;
  }, undefined, 4500));
}
export function prefetchApps(accountId: string | undefined) {
  if (accountId) void refreshApps(accountId).catch(() => {});
}

// Recommendation responses use the same account-scoped cache primitive as catalog pages.
// The server ranker reuses catalog() and its TTL; this does not fetch a second catalog.
export function cachedSuggestions(accountId: string, key: string) {
  suggestions.scope(accountId);
  return suggestions.peek(key);
}
export function lastSuggestions(accountId: string, botId: string) {
  suggestions.scope(accountId);
  return suggestions.last(botId);
}
export function refreshSuggestions(accountId: string, key: string, botId: string, draft: { description: string; instructions: string }) {
  suggestions.scope(accountId);
  return suggestions.refresh(key, () => settingsRead(signal => api.suggestedApps(botId, draft, signal), undefined, 4500), botId);
}
