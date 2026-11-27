import { PreviewBanner, AppearanceUndo } from './customization/PreviewBanner';
import { SafeModeBanner } from './customization/SafeModeBanner';
import { lazy, Suspense, useEffect } from 'react';
import { installOverlayScrollbars } from './lib/overlayScrollbars';
import { useStore } from './store';
import { SignIn } from './components/SignIn';
import { installVoiceEntry } from './voice/entry';
import { consumeSignedInRedirect } from './lib/signedIn';

const AuthenticatedShell = lazy(() => import('./AuthenticatedShell').then(m => ({ default: m.AuthenticatedShell })));
const JoinPage = lazy(() => import('./components/JoinPage').then(m => ({ default: m.JoinPage })));

export function App() {
  const authChecked = useStore((s) => s.authChecked);
  const authChecking = useStore((s) => s.authChecking);
  const authError = useStore((s) => s.authError);
  const user = useStore((s) => s.user);
  useEffect(installVoiceEntry, []);
  useEffect(installOverlayScrollbars, []);
  useEffect(() => { consumeSignedInRedirect(); useStore.getState().checkAuth(); }, []);
  useEffect(() => {
    // A revoked session may traverse old app entries, but cannot restore a
    // private route. Leave untagged entry links and auth callback hashes intact.
    const clearExpiredRoute = () => {
      const state = useStore.getState();
      if (!state.authChecked || state.user || !history.state?.swarmNavigation) return;
      const { swarmNavigation: _expired, ...rest } = history.state;
      history.replaceState(rest, '', location.pathname + location.search);
    };
    window.addEventListener('popstate', clearExpiredRoute);
    return () => window.removeEventListener('popstate', clearExpiredRoute);
  }, []);
  useEffect(() => {
    if (!user) return;
    // Start while the shell/Bot list loads, before a chat or Settings is opened.
    void import('./lib/models').then(({ useModels }) => {
      if (useStore.getState().user?.id === user.id) void useModels.getState().load();
    }).catch(() => {});
    void import('./lib/cliApi').then(({ cliApi }) => {
      if (useStore.getState().user?.id === user.id) void cliApi.status().catch(() => {});
    }).catch(() => {});
  }, [user?.id]);
  // Public invite page: /join/<code> works signed in or out.
  const join = window.location.pathname.match(/^\/join\/([^/]+)/);
  if (join) {
    let code: string | null = null;
    try { code = decodeURIComponent(join[1]); }
    catch { /* Malformed URL encoding is an unusable invite. */ }
    return <Suspense fallback={<div className="boot" role="status">Loading…</div>}><JoinPage code={code} /></Suspense>;
  }
  if (authError) return (
    <main className="boot boot--error">
      <div className="boot__message">
        <div role="alert">
          <h1>Unable to load your session</h1>
          <p>{authError}</p>
        </div>
        <button className="btn btn--primary" disabled={authChecking} onClick={() => useStore.getState().checkAuth()}>
          {authChecking ? 'Checking session...' : 'Try again'}
        </button>
        {authChecking && <p role="status">Checking your session...</p>}
      </div>
    </main>
  );
  if (!authChecked) return <div className="boot" />;
  return user ? <><SafeModeBanner /><PreviewBanner /><AppearanceUndo /><Suspense fallback={<div className="boot" role="status">Loading...</div>}><AuthenticatedShell key={user.id} /></Suspense></> : <SignIn />;
}
