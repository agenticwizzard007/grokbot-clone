import { useStore } from '../store';
import { applyAppearance } from './applier';
import { DEFAULT_CONFIG } from '../../../server/src/ui-config/schema';
import { CACHE_KEY, USER_KEY, clearPreview, readCachedConfig, refreshUiConfig, setUiPhone, setUiUser, useCustomization, patchUiConfig } from './store.js';
import { installSafeMode } from './safeMode';

export function legacyTheme(): 'system' | 'light' | 'dark' {
  try { const mode = localStorage.getItem('swarm.theme'); return mode === 'light' || mode === 'dark' ? mode : 'system'; } catch { return 'system'; }
}
export function renderAppearance() {
  const state = useCustomization.getState();
  applyAppearance(state.effective, state.safe ? 'system' : !state.userId || state.status === 'disabled' ? legacyTheme() : undefined);
}
export function applyLegacyTheme(mode = legacyTheme()) {
  const state = useCustomization.getState();
  if (!state.userId || state.status === 'disabled') applyAppearance(DEFAULT_CONFIG, mode); else renderAppearance();
}
export async function setTheme(mode: 'system' | 'light' | 'dark') {
  const state = useCustomization.getState();
  if (state.userId && state.status !== 'disabled') {
    const result = await patchUiConfig([{ op: 'replace', path: '/theme/mode', value: mode }]);
    if (!result.ok) return;
  }
  try { localStorage.setItem('swarm.theme', mode); } catch { /* Optional fallback. */ }
  renderAppearance();
}
let migrationPending = false;
async function migrateTheme() {
  const { userId, revision, status, invalidStored } = useCustomization.getState();
  if (!userId || status !== 'ready' || invalidStored || migrationPending) return;
  const key = `swarm.ui.migrated:${userId}`;
  try {
    if (localStorage.getItem(key)) return;
    const mode = legacyTheme();
    if (revision === 0 && mode !== 'system') {
      migrationPending = true;
      const result = await patchUiConfig([{ op: 'replace', path: '/theme/mode', value: mode }]);
      migrationPending = false;
      if (!result.ok || useCustomization.getState().userId !== userId) return;
    }
    localStorage.setItem(key, '1');
  } catch { migrationPending = false; }
}
export function startCustomization() {
  const stopSafe = installSafeMode();
  const phone = matchMedia('(max-width: 760px)');
  setUiPhone(phone.matches);
  // A cached account can paint offline. Auth confirmation always replaces it.
  try {
    const id = localStorage.getItem(USER_KEY), cached = id && readCachedConfig(id);
    if (id && cached) setUiUser(id);
  } catch { /* Defaults are ready without storage or network. */ }
  renderAppearance();
  const stopUi = useCustomization.subscribe((state, previous) => {
    if (state.effective !== previous.effective || state.status !== previous.status || state.userId !== previous.userId || state.safe !== previous.safe) renderAppearance();
    void migrateTheme();
  });
  const stopUser = useStore.subscribe((state, previous) => {
    if (state.authChecked && (state.user?.id !== previous.user?.id || state.authChecked !== previous.authChecked)) {
      setUiUser(state.user?.id ?? null);
      if (!state.user) { clearPreview(); applyAppearance(DEFAULT_CONFIG, legacyTheme()); }
    }
  });
  const onPhone = () => setUiPhone(phone.matches);
  phone.addEventListener('change', onPhone);
  const media = ['(prefers-color-scheme: dark)', '(prefers-reduced-motion: reduce)', '(forced-colors: active)'].map(query => matchMedia(query));
  media.forEach(query => query.addEventListener('change', renderAppearance));
  const sync = () => { if (document.visibilityState !== 'hidden') void refreshUiConfig(); };
  const stored = (event: StorageEvent) => { if (event.key === CACHE_KEY) sync(); };
  window.addEventListener('storage', stored); window.addEventListener('online', sync);
  document.addEventListener('visibilitychange', sync);
  return () => { stopSafe(); stopUi(); stopUser(); phone.removeEventListener('change', onPhone); media.forEach(query => query.removeEventListener('change', renderAppearance)); window.removeEventListener('storage', stored); window.removeEventListener('online', sync); document.removeEventListener('visibilitychange', sync); };
}
