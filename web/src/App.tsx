import { lazy, Suspense, useEffect } from 'react';
import { startEvents } from './lib/events';
import { PHONE_QUERY, useStore } from './store';
import { ChatView } from './components/ChatView';
import { DetailsPanel } from './components/DetailsPanel';
import { Sidebar } from './components/Sidebar';
import { SignIn } from './components/SignIn';
import { TasksView } from './components/config/TasksView';
import { useConfigUI } from './configStore';
import { installVoiceShortcut } from './voice/shortcut';

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
  const mobile = useStore((s) => s.mobile);
  const pane = useStore((s) => s.mobilePane);
  // Settings dialogs load lazily; only mount them while one is open.
  const settingsOpen = useConfigUI((s) => !!s.appSettings || !!s.botSettings);

  // Phone layout: follow the breakpoint, and let the system back gesture leave a chat for the list.
  useEffect(() => {
    const mq = window.matchMedia(PHONE_QUERY);
    const onChange = () => useStore.getState().set({ mobile: mq.matches, ...(mq.matches ? {} : { mobilePane: 'list' as const }) });
    const onPop = () => {
      const st = useStore.getState();
      if (!st.mobile || st.mobilePane !== 'chat') return;
      st.set({ mobilePane: 'list', detailsOpen: false });
      useConfigUI.getState().setView('chat');
    };
    mq.addEventListener('change', onChange);
    window.addEventListener('popstate', onPop);
    return () => { mq.removeEventListener('change', onChange); window.removeEventListener('popstate', onPop); };
  }, []);
  // Leaving phone width closes nothing; reaching it closes the details column (it becomes a sheet).
  useEffect(() => {
    if (mobile) useStore.getState().set({ detailsOpen: false });
  }, [mobile]);

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
      else if (key === 'b') { e.preventDefault(); if (!st.mobile) st.set({ sidebarCollapsed: !st.sidebarCollapsed }); }
      else if (e.shiftKey && (key === ',' || key === '<')) { e.preventDefault(); st.set({ detailsOpen: !st.detailsOpen }); }
      else if (key === ',') { e.preventDefault(); useConfigUI.getState().openAppSettings(); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  return (
    <div className={`app${collapsed && !mobile ? ' is-sidebar-collapsed' : ''}${detailsOpen && hasBot && view === 'chat' ? ' has-details' : ''}${mobile ? ` is-mobile pane-${view === 'tasks' ? 'chat' : pane}` : ''}`}>
      <Sidebar />
      {view === 'tasks' ? <TasksView /> : <ChatView />}
      {detailsOpen && hasBot && view === 'chat' && (!mobile || pane === 'chat') && (
        <>
          {/* Tablets: the panel slides over the chat; tapping the dimmed chat closes it. Hidden on other widths (mobile.css). */}
          {!mobile && <div className="details-scrim" aria-hidden onClick={() => useStore.getState().set({ detailsOpen: false })} />}
          <DetailsPanel />
        </>
      )}
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
  useEffect(installVoiceShortcut, []);
  useEffect(() => { useStore.getState().checkAuth(); }, []);
  // Public invite page: /join/<code> works signed in or out.
  const join = window.location.pathname.match(/^\/join\/([^/]+)/);
  if (join) return <Suspense fallback={<div className="boot" role="status">Loading…</div>}><JoinPage code={decodeURIComponent(join[1])} /></Suspense>;
  if (!authChecked) return <div className="boot" />;
  return user ? <Shell /> : <SignIn />;
}
