import { useStore } from '../store';

let pending: Promise<boolean> | undefined;
let expired = false;

export const sessionExpired = () => expired;

export function requireActiveSession() {
  if (expired) throw new Error('Your session has ended. Sign in again.');
}

/** Terminal for this document, including the time spent waiting for sign-in navigation. */
export function expireSession(expectedAccountId: string) {
  if (expired || useStore.getState().user?.id !== expectedAccountId) return;
  expired = true;
  useStore.getState().set({
    user: null, authChecked: true, bots: [], botsLoaded: false, selectedBotId: null,
    transcripts: {}, live: {}, routines: {}, computer: null, sseConnected: false,
    modal: null, viewerOpen: false, viewerControl: false, detailsOpen: false,
  });
  try { localStorage.removeItem('swarm.selectedBot'); } catch { /* storage can be unavailable */ }
  // A fresh document also drops component drafts and settings caches.
  window.location.replace('/');
}

/** A stream failure or provider 401 alone does not prove the browser session expired. */
export function revalidateSession(): Promise<boolean> {
  const user = useStore.getState().user;
  if (expired || !user) return Promise.resolve(false);
  if (pending) return pending;
  pending = (async () => {
    try {
      // Use fetch directly so an auth failure cannot recursively trigger this check.
      const response = await fetch('/api/auth/me', {
        credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(5000),
      });
      const missing = response.status === 401 || (response.ok && (await response.json()).user === null);
      if (expired) return false;
      if (!missing || useStore.getState().user !== user) return true;
      expireSession(user.id);
      return false;
    } catch {
      // Offline, timeout and server failures keep the session available for recovery.
      return !expired;
    } finally {
      pending = undefined;
    }
  })();
  return pending;
}
