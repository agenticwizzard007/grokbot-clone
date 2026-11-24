import { api, type AppsResponse } from './api';
import { verifyAccessAccount } from './accessApi';
import { useStore } from '../store';
import { createSettingsCache, settingsRead } from './settingsReads';

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
  }, undefined, 8000));
}
export function prefetchApps(accountId: string | undefined) {
  if (accountId) void refreshApps(accountId).catch(() => {});
}
