import { PreviewBanner, AppearanceUndo } from './customization/PreviewBanner';
import { SafeModeBanner } from './customization/SafeModeBanner';
import { lazy, Suspense, useEffect, useState } from 'react';
import { installOverlayScrollbars } from './lib/overlayScrollbars';
import { useStore } from './store';
import { SignIn } from './components/SignIn';
import { installVoiceEntry } from './voice/entry';
import { consumeSignedInRedirect } from './lib/signedIn';
import { navigation, useConfigUI } from './configStore';
import { parentScreen, parseScreen, type Screen } from './lib/navigation';
// Load the Flow bridge before the roster so its cold-link bootstrap runs once.
import { notifyFlow } from './flow/api';
import type { RunOutput } from './handoffs/api';
import type { LoopDraft } from './handoffs/loops/LoopSheet';

const AuthenticatedShell = lazy(() => import('./AuthenticatedShell').then(m => ({ default: m.AuthenticatedShell })));
const ArtifactPage = lazy(() => import('./artifacts/ArtifactViewer').then(m => ({ default: m.ArtifactPage })));
const JoinPage = lazy(() => import('./components/JoinPage').then(m => ({ default: m.JoinPage })));
const LoopsPage = lazy(() => import('./handoffs/loops/LoopsPage'));
const LoopRun = lazy(() => import('./handoffs/loops/LoopRun'));
const HandoffDetail = lazy(() => import('./handoffs/HandoffDetail').then(m => ({ default: m.HandoffDetail })));
const OutputViewer = lazy(() => import('./handoffs/OutputViewer').then(m => ({ default: m.OutputViewer })));
const SendSheet = lazy(() => import('./handoffs/SendSheet').then(m => ({ default: m.SendSheet })));
const LoopSheet = lazy(() => import('./handoffs/loops/LoopSheet'));
export type HandoffScreen = Extract<Screen, { kind: 'loops' | 'loop' | 'handoff' | 'output' }>;

/** The shell owns navigation, authentication and the single Back control. */
export function HandoffRoutes({ screen }: { screen: HandoffScreen }) {
  const bots = useStore(state => state.bots);
  const [send, setSend] = useState<RunOutput | null>(null);
  const [loop, setLoop] = useState<LoopDraft | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setSend(null); setLoop(null); setError('');
    if (screen.kind !== 'output' || !screen.send) return;
    const controller = new AbortController();
    void import('./handoffs/api').then(({ handoffApi }) => handoffApi.output(screen.id, controller.signal)).then(value => {
      if (!controller.signal.aborted) setSend(value.output);
    }).catch(() => { if (!controller.signal.aborted) setError('Could not open Send to agent. Try again.'); });
    return () => controller.abort();
  }, [screen.kind, 'id' in screen ? screen.id : '', screen.kind === 'output' && screen.send]);
  const back = () => navigation.back(parentScreen(screen) ?? { kind: 'bots' });
  const startLoop = async (output: RunOutput) => {
    const { newLoopSpec } = await import('./handoffs/loops/LoopSheet');
    setLoop(newLoopSpec(output.botId, '', `swarm://output/${output.id}`));
  };
  return <main className="ho-route" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
    <style>{'.ho-route .ho-back { display: none; }'}</style>
    {error && <p role="alert">{error}</p>}
    <Suspense fallback={<div className="boot" role="status">Loading...</div>}>
      {screen.kind === 'loops' && <LoopsPage showBack={false} onBack={back} onOpen={id => navigation.navigate({ kind: 'loop', id })} usageTracked={false} />}
      {screen.kind === 'loop' && <LoopRun id={screen.id} showBack={false} onBack={back} />}
      {screen.kind === 'handoff' && <HandoffDetail handoffId={screen.id} onBack={back} onSend={setSend} />}
      {screen.kind === 'output' && <OutputViewer outputId={screen.id} partId={screen.part} onBack={back} onSend={setSend} onStartLoop={output => void startLoop(output)} />}
      {send && <SendSheet open senderId={send.botId} output={send} onClose={() => setSend(null)} onSent={handoff => navigation.navigate({ kind: 'handoff', id: handoff.id })} onLoopStarted={id => navigation.navigate({ kind: 'loop', id })} />}
      {loop && <LoopSheet bots={bots} initial={loop} usageTracked={false} onClose={() => setLoop(null)} onCreated={id => navigation.navigate({ kind: 'loop', id })} />}
    </Suspense>
  </main>;
}

function AuthenticatedApp() {
  // Every applied route publishes ConfigUI state, including browser history restores.
  useConfigUI();
  const userId = useStore(state => state.user?.id);
  const routeHash = location.hash;
  // Keep HO-G's local Flow adapter on the shared history trail until its
  // standalone header and hash adapter can be removed by that workstream.
  useEffect(() => {
    const restore = (event: Event) => {
      const screen = parseScreen(location.hash);
      if (screen?.kind !== 'details' || !screen.flow) return;
      const entry = history.state?.swarmNavigation, previous = parseScreen(entry?.hash ?? '');
      if (event.type === 'swarm:flow-location' && previous?.kind === 'details' && previous.tab === 'activity' && !previous.flow) {
        history.replaceState({ ...history.state, swarmNavigation: { ...entry, hash: location.hash } }, '');
      }
      navigation.restore();
    };
    const back = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('.flow-header .shell-back')) return;
      const screen = navigation.screen;
      if (screen?.kind !== 'details' || !screen.flow) return;
      event.preventDefault(); event.stopPropagation();
      navigation.back(parentScreen(screen) ?? { kind: 'bots' });
    };
    window.addEventListener('popstate', restore, true);
    window.addEventListener('hashchange', restore, true);
    window.addEventListener('swarm:flow-location', restore);
    document.addEventListener('click', back, true);
    return () => {
      window.removeEventListener('popstate', restore, true);
      window.removeEventListener('hashchange', restore, true);
      window.removeEventListener('swarm:flow-location', restore);
      document.removeEventListener('click', back, true);
    };
  }, [userId]);
  useEffect(() => {
    const refresh = (message: Event) => {
      const event = (message as CustomEvent).detail;
      if (event?.type === 'flow') notifyFlow(event.botId);
      if (event?.type === 'reconnect') for (const bot of useStore.getState().bots) notifyFlow(bot.id);
    };
    window.addEventListener('swarm:event', refresh);
    return () => window.removeEventListener('swarm:event', refresh);
  }, [userId]);
  useEffect(() => {
    let cancel = () => {};
    const focus = async () => {
      cancel();
      const key = history.state?.flowFocus;
      if (typeof key !== 'string') return;
      const [kind, id] = key.split(':');
      const screen = navigation.screen, botId = useStore.getState().selectedBotId;
      if (!id || (kind === 'routine' || kind === 'skill' ? screen?.kind !== 'bot-settings' || screen.tab !== (kind === 'routine' ? 'routines' : 'skills')
        : kind === 'mcp' ? screen?.kind !== 'settings' || screen.section !== 'mcp' : screen?.kind !== 'apps' && (screen?.kind !== 'settings' || screen.section !== 'apps'))) return;
      let disposed = false, observer: MutationObserver | undefined, timer: ReturnType<typeof setTimeout> | undefined;
      let target: HTMLElement | undefined;
      cancel = () => { disposed = true; observer?.disconnect(); clearTimeout(timer); if (target) { target.style.removeProperty('outline'); target.style.removeProperty('outline-offset'); delete target.dataset.flowFocus; target.removeAttribute('tabindex'); } };
      try {
        const { configApi } = await import('./lib/configApi');
        let label: string | undefined;
        if ((kind === 'routine' || kind === 'skill') && botId) {
          const data = await configApi.settings(botId);
          label = (kind === 'routine' ? data.routines : data.skills).find(item => item.id === id)?.name;
        } else if (kind === 'mcp') label = (await configApi.mcpServers()).servers.find(item => item.id === id)?.name;
        else if (kind === 'app') {
          const { api } = await import('./lib/api');
          const data = await api.apps();
          label = [...data.apps, ...data.connectedApps ?? []].find(item => item.slug === id)?.name ?? id;
        }
        if (disposed || !label) return;
        const find = () => {
          if (disposed) return;
          const selector = { routine: '.cfg-item--routine', skill: '.knowledge-item__row', mcp: '.mcp-server', app: '[data-layout="row"]' }[kind];
          if (!selector) return;
          target = [...document.querySelectorAll<HTMLElement>(selector)].find(row => row.getClientRects().length && [...row.querySelectorAll('strong, .cfg-item__title, .settings-provider, .layout-row__title')].some(title => title.textContent?.trim() === label || title.firstChild?.textContent?.trim() === label));
          if (!target) return;
          observer?.disconnect(); clearTimeout(timer);
          target.tabIndex = -1; target.dataset.flowFocus = key;
          target.style.outline = '2px solid var(--accent)'; target.style.outlineOffset = '2px';
          target.scrollIntoView({ block: 'center', behavior: 'instant' }); target.focus({ preventScroll: true });
        };
        observer = new MutationObserver(find); observer.observe(document.body, { childList: true, subtree: true });
        timer = setTimeout(() => observer?.disconnect(), 5000); find();
      } catch { /* A missing or deleted focus target leaves the destination usable. */ }
    };
    void focus();
    window.addEventListener('swarm:flow-focus', focus);
    window.addEventListener('popstate', focus);
    window.addEventListener('hashchange', focus);
    return () => { cancel(); window.removeEventListener('swarm:flow-focus', focus); window.removeEventListener('popstate', focus); window.removeEventListener('hashchange', focus); };
  }, [userId, routeHash]);
  return <AuthenticatedShell />;
}

export function App() {
  const authChecked = useStore((s) => s.authChecked);
  const authChecking = useStore((s) => s.authChecking);
  const authError = useStore((s) => s.authError);
  const user = useStore((s) => s.user);
  useEffect(() => {
    if (!authChecked) return;
    try {
      const isArtifact = /^\/artifacts\/[A-Za-z0-9_-]+\/?$/.test(location.pathname);
      if (isArtifact) {
        if (user) sessionStorage.removeItem('swarm.artifactReturn');
        else sessionStorage.setItem('swarm.artifactReturn', location.pathname);
      } else if (user) {
        const returnTo = sessionStorage.getItem('swarm.artifactReturn');
        if (returnTo && /^\/artifacts\/[A-Za-z0-9_-]+\/?$/.test(returnTo)) {
          sessionStorage.removeItem('swarm.artifactReturn'); location.replace(returnTo);
        }
      }
    } catch { /* Normal navigation still works without session storage. */ }
  }, [authChecked, user?.id]);
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
  const artifactPath = window.location.pathname.match(/^\/artifacts\/([A-Za-z0-9_-]+)\/?$/);
  if (artifactPath) return user
    ? <Suspense fallback={<div className="boot" role="status">Loading artifact…</div>}><ArtifactPage key={`${user.id}:${artifactPath[1]}`} id={artifactPath[1]} /></Suspense>
    : <SignIn />;
  return user ? <><SafeModeBanner /><PreviewBanner /><AppearanceUndo /><Suspense fallback={<div className="boot" role="status">Loading...</div>}><AuthenticatedApp key={user.id} /></Suspense></> : <SignIn />;
}
