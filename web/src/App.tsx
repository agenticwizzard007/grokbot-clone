import { lazy, Suspense, useEffect } from 'react';
import { startEvents } from './lib/events';
import { onReturnToList, PHONE_QUERY, restorePhoneSetup, showPhoneList, useStore } from './store';
import { ChatView } from './components/ChatView';
import { BotsView } from './components/BotsView';
import { DetailsPanel } from './components/DetailsPanel';
import { Sidebar } from './components/Sidebar';
import { SignIn } from './components/SignIn';
import { SignedInAuthFeedback } from './components/SignedInAuthFeedback';
import { TasksView } from './components/config/TasksView';
import { botSettingsHash, useConfigUI } from './configStore';
import { installVoiceShortcut } from './voice/shortcut';
import { hasOpenModal } from './components/modals/Modal';
import { ToastPortal } from './lib/toast';
import { ConfirmPortal } from './lib/confirmDialog';
import { isNewBotShortcut } from './lib/shortcuts';
import { consumeSignedInRedirect } from './lib/signedIn';
import { linkedWork } from './lib/userRoutes';

const ComputerViewer = lazy(() => import('./components/ComputerViewer').then(m => ({ default: m.ComputerViewer })));
const JoinPage = lazy(() => import('./components/JoinPage').then(m => ({ default: m.JoinPage })));
const ConnectAppsModal = lazy(() => import('./components/modals/ConnectAppsModal').then(m => ({ default: m.ConnectAppsModal })));
const CreateBotModal = lazy(() => import('./components/modals/CreateBotModal').then(m => ({ default: m.CreateBotModal })));
const CreateGroupModal = lazy(() => import('./components/modals/CreateGroupModal').then(m => ({ default: m.CreateGroupModal })));
const SearchModal = lazy(() => import('./components/modals/SearchModal').then(m => ({ default: m.SearchModal })));
const BotSettingsModal = lazy(() => import('./components/config/BotSettingsModal').then(m => ({ default: m.BotSettingsModal })));
const ConfigLayer = lazy(() => import('./components/config/ConfigLayer').then(m => ({ default: m.ConfigLayer })));

function Shell() {
  const detailsOpen = useStore((s) => s.detailsOpen);
  const modal = useStore((s) => s.modal);
  const viewerOpen = useStore((s) => s.viewerOpen);
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const selectedBotId = useStore(s => s.selectedBotId);
  const hasBot = !!selectedBotId;
  const view = useConfigUI((s) => s.view);
  const mobile = useStore((s) => s.mobile);
  const pane = useStore((s) => s.mobilePane);
  // Settings dialogs load lazily; only mount them while one is open.
  const settingsOpen = useConfigUI((s) => !!s.appSettings);
  const botSettings = useConfigUI(s => s.botSettings);

  // Phone layout: follow the breakpoint, and let the system back gesture leave a chat for the list.
  useEffect(() => {
    const mq = window.matchMedia(PHONE_QUERY);
    const onChange = () => {
      const st = useStore.getState();
      // R2F-007: also called on resize (device emulation can skip the media query event); only act on a real change.
      if (st.mobile === mq.matches) return;
      st.set({ mobile: mq.matches, ...(mq.matches ? {} : { mobilePane: 'list' as const }) });
      if (mq.matches && (st.modal === 'create' || st.modal === 'group')) st.setModal(st.modal);
    };
    const onPop = () => {
      if (restorePhoneSetup()) return;
      const st = useStore.getState();
      if (!st.mobile || st.mobilePane !== 'chat') return;
      // Hash navigation already has a history entry. Let the route handler restore
      // that work page instead of treating every pop as a return to the Bot list.
      if (linkedWork(window.location.hash)) return;
      const config = useConfigUI.getState();
      if (config.botSettings && !config.appSettings) {
        if (config.botSettingsDirty) {
          // Keep editing must retain an in-app Back destination after the browser has popped it.
          history.pushState({ swarmPane: 'chat', swarmFrom: 'list', swarmDoc: performance.timeOrigin }, '', botSettingsHash(config.botSettings.botId, config.botSettings.tab));
          config.closeBotSettings();
        } else { config.discardBotSettings(); showPhoneList(); }
        return;
      }
      showPhoneList();
    };
    // Back to the list always lands on the chat view underneath, never on Tasks or Goals.
    const stopList = onReturnToList(() => { if (useConfigUI.getState().view !== 'chat') useConfigUI.getState().setView('chat'); });
    mq.addEventListener('change', onChange);
    window.addEventListener('resize', onChange);
    window.addEventListener('popstate', onPop);
    return () => { stopList(); mq.removeEventListener('change', onChange); window.removeEventListener('resize', onChange); window.removeEventListener('popstate', onPop); };
  }, []);
  // Entering phone width starts from the conversation; setup can be opened as its own page.
  useEffect(() => {
    if (mobile) useStore.getState().set({ detailsOpen: false });
  }, [mobile]);
  useEffect(() => {
    if (mobile && botSettings) useConfigUI.getState().openBotSettings(botSettings.botId, botSettings.tab);
  }, [mobile, botSettings?.botId, botSettings?.tab]);

  useEffect(() => {
    const st = useStore.getState();
    st.loadBots().catch(console.error);
    st.loadComputer().catch(console.error);
    const stop = startEvents();
    // OAuth popups post back here; refresh connection-dependent views and the open transcript.
    const onMsg = (e: MessageEvent) => {
      if ((e.data as { type?: string })?.type !== 'swarm-connected') return;
      const s = useStore.getState();
      s.set({ connectionsVersion: s.connectionsVersion + 1 });
      if (s.selectedBotId) s.loadRows(s.selectedBotId).catch(() => {});
    };
    window.addEventListener('message', onMsg);
    return () => { stop(); window.removeEventListener('message', onMsg); };
  }, []);

  // Global shortcuts (listed in lib/shortcuts.ts and Settings > General): Mod+K search, Mod+B sidebar,
  // Mod+Shift+, details, Mod+, settings, Alt+Shift+N new Bot (browsers reserve Mod+N).
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const st = useStore.getState();
      if (isNewBotShortcut(e)) {
        if (st.modal === 'search' || st.modal === 'apps' || hasOpenModal()) return;
        e.preventDefault(); useConfigUI.getState().requestLeaveBotSettings(() => { useConfigUI.getState().closeAppSettings(); useConfigUI.getState().discardBotSettings(); st.setModal('create'); });
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 'k') { e.preventDefault(); st.setModal(st.modal === 'search' ? null : 'search'); }
      else if (st.modal === 'search' || st.modal === 'apps' || hasOpenModal()) return;
      else if (key === 'b') { e.preventDefault(); if (!st.mobile) st.set({ sidebarCollapsed: !st.sidebarCollapsed }); }
      else if (e.shiftKey && (key === ',' || key === '<')) { e.preventDefault(); st.set({ detailsOpen: !st.detailsOpen }); }
      else if (key === ',') { e.preventDefault(); useConfigUI.getState().openAppSettings(); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  return (
    <div className={`app${settingsOpen ? ' is-app-settings' : ''}${collapsed && !mobile ? ' is-sidebar-collapsed' : ''}${mobile ? ` is-mobile pane-${view === 'tasks' || (modal === 'create' || modal === 'group') || botSettings || detailsOpen ? 'chat' : pane}` : ''}`}>
      <Sidebar />
      <div className={`main-pane${detailsOpen && hasBot && view === 'chat' && !botSettings && modal !== 'create' && modal !== 'group' ? ' has-bot-details' : ''}`} hidden={settingsOpen}>
      <div className="chat-pane">
      <Suspense fallback={<main className="chat chat--empty" role="status">Loading…</main>}>
        {modal === 'create' ? <CreateBotModal inline />
          : modal === 'group' ? <CreateGroupModal inline />
          : botSettings ? <BotSettingsModal inline />
          : view === 'tasks' ? <TasksView />
          : view === 'bots' && !mobile ? <BotsView /> : <ChatView />}
      </Suspense>
      </div>
      {detailsOpen && hasBot && view === 'chat' && <div className="bot-details-pane" hidden={!!botSettings || modal === 'create' || modal === 'group'}><DetailsPanel key={selectedBotId} /></div>}
      </div>
      <Suspense fallback={<div className="toast" role="status">Loading…</div>}>
      {modal === 'search' && <SearchModal />}
      {modal === 'apps' && <ConnectAppsModal />}
      {viewerOpen && <ComputerViewer />}
      {settingsOpen && <ConfigLayer />}
      </Suspense>
    </div>
  );
}

export function App() {
  return <><AppRoot /><ConfirmPortal /><ToastPortal /></>;
}

function AppRoot() {
  const authChecked = useStore((s) => s.authChecked);
  const authChecking = useStore((s) => s.authChecking);
  const authError = useStore((s) => s.authError);
  const user = useStore((s) => s.user);
  useEffect(installVoiceShortcut, []);
  useEffect(() => { consumeSignedInRedirect(); useStore.getState().checkAuth(); }, []);
  // Public invite page: /join/<code> works signed in or out.
  const join = window.location.pathname.match(/^\/join\/([^/]+)/);
  if (join) return <Suspense fallback={<div className="boot" role="status">Loading…</div>}><JoinPage code={decodeURIComponent(join[1])} /></Suspense>;
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
  return user ? <SignedInAuthFeedback><Shell /></SignedInAuthFeedback> : <SignIn />;
}
