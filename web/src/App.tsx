import { lazy, Suspense, useEffect } from 'react';
import { startEvents } from './lib/events';
import { useStore } from './store';
import { ChatView } from './components/ChatView';
import { DetailsPanel } from './components/DetailsPanel';
import { Sidebar } from './components/Sidebar';
import { SignIn } from './components/SignIn';
import { TasksView } from './components/config/TasksView';
import { useConfigUI } from './configStore';
import { Icon } from './components/Icon';
import { useCompactLayout } from './lib/useCompactLayout';

const ComputerViewer = lazy(() => import('./components/ComputerViewer').then(m => ({ default: m.ComputerViewer })));
const JoinPage = lazy(() => import('./components/JoinPage').then(m => ({ default: m.JoinPage })));
const ConnectAppsModal = lazy(() => import('./components/modals/ConnectAppsModal').then(m => ({ default: m.ConnectAppsModal })));
const CreateBotModal = lazy(() => import('./components/modals/CreateBotModal').then(m => ({ default: m.CreateBotModal })));
const CreateGroupModal = lazy(() => import('./components/modals/CreateGroupModal').then(m => ({ default: m.CreateGroupModal })));
const SearchModal = lazy(() => import('./components/modals/SearchModal').then(m => ({ default: m.SearchModal })));
const ConfigLayer = lazy(() => import('./components/config/ConfigLayer').then(m => ({ default: m.ConfigLayer })));

function Shell() {
  const detailsOpen = useStore((s) => s.detailsOpen);
  const modal = useStore((s) => s.modal);
  const viewerOpen = useStore((s) => s.viewerOpen);
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const hasBot = useStore((s) => !!s.selectedBotId);
  const view = useConfigUI((s) => s.view);
  const compact = useCompactLayout();
  const mobileSidebarOpen = useStore((s) => s.mobileSidebarOpen);
  const settingsOpen = useConfigUI((s) => !!s.appSettings || !!s.botSettings);

  useEffect(() => {
    if (modal || settingsOpen) useStore.getState().set({ mobileSidebarOpen: false });
  }, [modal, settingsOpen]);
  useEffect(() => {
    if (compact) useStore.getState().set({ detailsOpen: false });
  }, [compact]);

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

  // Global shortcuts: ⌘K search, ⌘B sidebar, ⇧⌘, details, ⌘N new bot.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const st = useStore.getState();
      const key = e.key.toLowerCase();
      if (key === 'k') { e.preventDefault(); st.setModal(st.modal === 'search' ? null : 'search'); }
      else if (key === 'b') { e.preventDefault(); st.set(window.matchMedia('(max-width: 760px)').matches ? { mobileSidebarOpen: !st.mobileSidebarOpen } : { sidebarCollapsed: !st.sidebarCollapsed }); }
      else if (e.shiftKey && (key === ',' || key === '<')) { e.preventDefault(); st.set({ detailsOpen: !st.detailsOpen }); }
      else if (key === ',') { e.preventDefault(); useConfigUI.getState().openAppSettings(); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  return (
    <div className={`app${collapsed ? ' is-sidebar-collapsed' : ''}${detailsOpen && hasBot && view === 'chat' ? ' has-details' : ''}`}>
      {compact && <button className="mobile-nav-toggle icon-btn" type="button" aria-label="Open bots" aria-expanded={mobileSidebarOpen} onClick={() => useStore.getState().set({ mobileSidebarOpen: true })}><Icon name="sidebar" /></button>}
      {compact && mobileSidebarOpen && <button type="button" className="mobile-nav-scrim" aria-label="Close bots" tabIndex={-1} onClick={() => useStore.getState().set({ mobileSidebarOpen: false })} />}
      {(!compact || mobileSidebarOpen) && <Sidebar />}
      {view === 'tasks' ? <TasksView /> : <ChatView />}
      {detailsOpen && hasBot && view === 'chat' && <DetailsPanel />}
      <Suspense fallback={<div className="toast" role="status">Loading…</div>}>
      {modal === 'create' && <CreateBotModal />}
      {modal === 'group' && <CreateGroupModal />}
      {modal === 'search' && <SearchModal />}
      {modal === 'apps' && <ConnectAppsModal />}
      {viewerOpen && <ComputerViewer />}
      {settingsOpen && <ConfigLayer />}
      </Suspense>
    </div>
  );
}

export function App() {
  const authChecked = useStore((s) => s.authChecked);
  const user = useStore((s) => s.user);
  useEffect(() => { useStore.getState().checkAuth(); }, []);
  // Public invite page: /join/<code> works signed in or out.
  const join = window.location.pathname.match(/^\/join\/([^/]+)/);
  if (join) return <Suspense fallback={<div className="boot" role="status">Loading…</div>}><JoinPage code={decodeURIComponent(join[1])} /></Suspense>;
  if (!authChecked) return <div className="boot" />;
  return user ? <Shell /> : <SignIn />;
}
