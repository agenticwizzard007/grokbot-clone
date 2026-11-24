import { lazy, Suspense, useEffect } from 'react';
import { TasksLoader, preloadTasks } from './components/TasksLoader';
import { startEvents } from './lib/events';
import { PHONE_QUERY, useStore } from './store';
import { RosterFeedback } from './components/LoadFeedback';
import { ChatSkeleton } from './components/ChatSkeleton';
import { Sidebar } from './components/Sidebar';
import { SignedInAuthFeedback } from './components/SignedInAuthFeedback';
import { useConfigUI } from './configStore';
import { installVoiceShortcut } from './voice/shortcut';
import { hasOpenModal } from './components/modals/Modal';
import { ToastPortal } from './lib/toast';
import { ConfirmPortal } from './lib/confirmDialog';
import { isNewBotShortcut } from './lib/shortcuts';

import './styles/shell.css';
import './styles/chat.css';
import './styles/cards.css';
import './styles/details.css';
import './styles/modals.css';
import './styles/viewer.css';
import './styles/voice.css';
import './styles/composer-models.css';
import './styles/mobile.css';
import './styles/paper-core.css'; // accepted shared shell and core responsive geometry

const ChatView = lazy(() => import('./components/ChatView').then(m => ({ default: m.ChatView })));
const BotsView = lazy(() => import('./components/BotsView').then(m => ({ default: m.BotsView })));
const DetailsPanel = lazy(() => import('./components/DetailsPanel').then(m => ({ default: m.DetailsPanel })));

const ComputerViewer = lazy(() => import('./components/ComputerViewer').then(m => ({ default: m.ComputerViewer })));
const ConnectAppsModal = lazy(() => import('./components/modals/ConnectAppsModal').then(m => ({ default: m.ConnectAppsModal })));
const CreateBotModal = lazy(() => import('./components/modals/CreateBotModal').then(m => ({ default: m.CreateBotModal })));
const CreateGroupModal = lazy(() => import('./components/modals/CreateGroupModal').then(m => ({ default: m.CreateGroupModal })));
const SearchModal = lazy(() => import('./components/modals/SearchModal').then(m => ({ default: m.SearchModal })));
const BotSettingsModal = lazy(() => import('./components/config/BotSettingsModal').then(m => ({ default: m.BotSettingsModal })));
const ConfigLayer = lazy(() => import('./components/config/ConfigLayer').then(m => ({ default: m.ConfigLayer })));

function Shell() {
  useEffect(installVoiceShortcut, []);
  const detailsOpen = useStore((s) => s.detailsOpen);
  const modal = useStore((s) => s.modal);
  const viewerOpen = useStore((s) => s.viewerOpen);
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const selectedBotId = useStore(s => s.selectedBotId);
  const hasBot = !!selectedBotId;
  const rosterUnavailable = useStore(s => !s.botsLoaded && !s.bots.length);
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
      st.set({ mobile: mq.matches });
    };
    mq.addEventListener('change', onChange);
    window.addEventListener('resize', onChange);
    return () => { mq.removeEventListener('change', onChange); window.removeEventListener('resize', onChange); };
  }, []);
  useEffect(() => {
    const st = useStore.getState();
    st.loadBots().catch(console.error);
    st.loadComputer().catch(console.error);
    const stop = startEvents();
    // Keep speculative Tasks assets out of the initial chat's network budget.
    const preload = setTimeout(() => { void preloadTasks().catch(() => {}); }, 5000);
    // OAuth popups post back here; refresh connection-dependent views and the open transcript.
    const onMsg = (e: MessageEvent) => {
      if ((e.data as { type?: string })?.type !== 'swarm-connected') return;
      const s = useStore.getState();
      s.set({ connectionsVersion: s.connectionsVersion + 1 });
      if (s.selectedBotId) s.loadRows(s.selectedBotId).catch(() => {});
    };
    window.addEventListener('message', onMsg);
    return () => { clearTimeout(preload); stop(); window.removeEventListener('message', onMsg); };
  }, []);

  // Global shortcuts (listed in lib/shortcuts.ts and Settings > General): Mod+K search, Mod+B sidebar,
  // Mod+Shift+, details, Mod+, settings, Alt+Shift+N new Bot (browsers reserve Mod+N).
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const st = useStore.getState();
      if (isNewBotShortcut(e)) {
        if (st.modal === 'search' || st.modal === 'apps' || hasOpenModal()) return;
        e.preventDefault(); useConfigUI.getState().requestLeaveBotSettings(() => { st.setModal('create'); });
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

  // Work routes keep their heading and neutral title while their roster resolves.
  if (rosterUnavailable && view !== 'tasks') return <main className="boot boot--data"><RosterFeedback /></main>;

  return (
    <div className={`app${settingsOpen ? ' is-app-settings' : ''}${collapsed && !mobile ? ' is-sidebar-collapsed' : ''}${mobile ? ` is-mobile pane-${view === 'tasks' || (modal === 'create' || modal === 'group') || botSettings || detailsOpen ? 'chat' : pane}` : ''}`}>
      <Sidebar />
      <div className={`main-pane${detailsOpen && hasBot && view === 'chat' && !botSettings && modal !== 'create' && modal !== 'group' ? ' has-bot-details' : ''}`} hidden={settingsOpen}>
      <div className="chat-pane">
      <Suspense fallback={view === 'chat' && !botSettings && !modal ? <ChatSkeleton /> : <main className="chat chat--empty" role="status">Loading...</main>}>
        {modal === 'create' ? <CreateBotModal inline />
          : modal === 'group' ? <CreateGroupModal inline />
          : botSettings ? <BotSettingsModal inline />
          : view === 'tasks' ? <TasksLoader />
          : view === 'bots' && !mobile ? <BotsView /> : <ChatView />}
      </Suspense>
      </div>
      {detailsOpen && hasBot && view === 'chat' && <div className="bot-details-pane" hidden={!!botSettings || modal === 'create' || modal === 'group'}><Suspense fallback={<div role="status">Loading...</div>}><DetailsPanel key={selectedBotId} /></Suspense></div>}
      </div>
      <Suspense fallback={<div className="toast" role="status">Loading…</div>}>
      {modal === 'search' && <SearchModal />}
      {modal === 'apps' && <ConnectAppsModal />}
      {viewerOpen && <ComputerViewer />}
      </Suspense>
      {settingsOpen && <Suspense fallback={<section className="settings-loading" aria-label="Settings">
        <h1>Settings</h1>
        <p role="status">Loading settings…</p>
        <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => useConfigUI.getState().closeAppSettings()}>Close settings</button>
      </section>}><ConfigLayer /></Suspense>}
    </div>
  );
}


export function AuthenticatedShell() {
  return <SignedInAuthFeedback><Shell /><ConfirmPortal /><ToastPortal /></SignedInAuthFeedback>;
}
