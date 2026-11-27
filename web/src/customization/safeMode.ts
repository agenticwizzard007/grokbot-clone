import { setUiSafe } from './store.js';
export function openSafeMode(): void {
  try { sessionStorage.setItem('swarm.ui.safe', '1'); } catch { /* Tab memory still works. */ }
  setUiSafe(true);
}
export function closeSafeMode(): void {
  try { sessionStorage.removeItem('swarm.ui.safe'); } catch { /* Tab memory still works. */ }
  const url = new URL(location.href); url.searchParams.delete('ui'); history.replaceState(history.state, '', url);
  setUiSafe(false);
}
export function installSafeMode() {
  let active = new URLSearchParams(location.search).get('ui') === 'safe';
  try { active ||= sessionStorage.getItem('swarm.ui.safe') === '1'; } catch { /* URL remains usable. */ }
  if (active) openSafeMode();
  const key = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.altKey && !event.shiftKey && (event.code === 'Digit0' || event.key === '0')) {
      event.preventDefault(); event.stopImmediatePropagation(); openSafeMode();
    }
  };
  window.addEventListener('keydown', key, true);
  return () => window.removeEventListener('keydown', key, true);
}
