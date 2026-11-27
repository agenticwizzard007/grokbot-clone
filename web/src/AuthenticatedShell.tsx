import { openConversation } from './configStore';
import { lazy, Suspense, useEffect, useState } from 'react';
import { TasksLoader, preloadTasks } from './components/TasksLoader';
import { startEvents } from './lib/events';
import { PHONE_QUERY, useStore } from './store';
import { RosterFeedback } from './components/LoadFeedback';
import { ChatSkeleton } from './components/ChatSkeleton';
import { Sidebar } from './components/Sidebar';
import { SignedInAuthFeedback } from './components/SignedInAuthFeedback';
import { navigation, useConfigUI } from './configStore';
import { AppSettings } from './components/config/SettingsFrame';
import { installVoiceShortcut } from './voice/shortcut';
import { hasOpenModal } from './components/modals/Modal';
import { ToastPortal } from './lib/toast';
import { ConfirmPortal } from './lib/confirmDialog';
import { isNewBotShortcut } from './lib/shortcuts';
import { ChevronLeft, House, ListTodo, Menu, Search, Settings } from 'lucide-react';
import { backLabel, parentScreen, parseScreen, screenTitle, type Screen } from './lib/navigation';
import { Modal } from './components/modals/Modal';
import { BotAvatarFor } from './avatar/BotAvatar';
import { routeBot } from './lib/userRoutes';

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
import './components/sidebar-labels.css';

const FirstRun = lazy(() => import('./components/FirstRun').then(m => ({ default: m.FirstRun })));
const ChatView = lazy(() => import('./components/ChatView').then(m => ({ default: m.ChatView })));
const BotsView = lazy(() => import('./components/BotsView').then(m => ({ default: m.BotsView })));
const DetailsPanel = lazy(() => import('./components/DetailsPanel').then(m => ({ default: m.DetailsPanel })));

const ComputerViewer = lazy(() => import('./components/ComputerViewer').then(m => ({ default: m.ComputerViewer })));
const ConnectAppsModal = lazy(() => import('./components/modals/ConnectAppsModal').then(m => ({ default: m.ConnectAppsModal })));
const CreateBotModal = lazy(() => import('./components/modals/CreateBotModal').then(m => ({ default: m.CreateBotModal })));
const CreateGroupModal = lazy(() => import('./components/modals/CreateGroupModal').then(m => ({ default: m.CreateGroupModal })));
const SearchModal = lazy(() => import('./components/modals/SearchModal').then(m => ({ default: m.SearchModal })));
const BotSettingsModal = lazy(() => import('./components/config/BotSettingsModal').then(m => ({ default: m.BotSettingsModal })));

function Shell() {
  useEffect(installVoiceShortcut, []);
  const detailsOpen = useStore((s) => s.detailsOpen);
  const modal = useStore((s) => s.modal);
  const viewerOpen = useStore((s) => s.viewerOpen);
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const selectedBotId = useStore(s => s.selectedBotId);
  const hasBot = !!selectedBotId;
  const rosterUnavailable = useStore(s => !s.botsLoaded && !s.bots.length);
  const config = useConfigUI();
  const view = config.view;
  const mobile = useStore((s) => s.mobile);
  const settingsOpen = useConfigUI((s) => !!s.appSettings);
  const bots = useStore(s => s.bots);
  const screen = navigation.screen ?? { kind: 'bots' };
  const [drawerOpen, setDrawerOpen] = useState(false);
  const routeModal = modal === 'search' || modal === 'apps';
  const chatHeader = screen.kind === 'chat';
  const topLevel = screen.kind === 'bots' || screen.kind === 'search' || (screen.kind === 'settings' && !screen.section) || (screen.kind === 'work' && !screen.route.botSlug);
  const hasBack = screen.kind !== 'bots' || navigation.trail.length > 0;
  const backTarget = parseScreen(navigation.trail.at(-1) ?? '') ?? parentScreen(screen) ?? { kind: 'bots' };
  const backText = mobile ? 'Back' : screen.kind === 'settings' ? 'Back to chat' : backTarget.kind === 'chat' ? 'Back to chat' : backLabel(backTarget, bots);
  const back = () => {
    if (!mobile && screen.kind === 'settings') {
      const bot = bots.find(bot => bot.id === selectedBotId) ?? bots.find(bot => bot.isPrimary);
      if (bot) openConversation(bot.id);
      else useConfigUI.getState().setView('bots');
      return;
    }
    navigation.back(parentScreen(screen) ?? { kind: 'bots' });
  };
  const headerTitle = !mobile && screen.kind === 'settings' ? 'Settings' : screenTitle(screen, bots).replace(/ · Swarm$/, '').replace(/^Settings · /, '');
  const headerBot = 'bot' in screen ? routeBot(screen.bot, bots) : undefined;
  const botSubtitle = headerBot ? headerTitle.replace(`${headerBot.name} · `, '') : '';
  useEffect(() => { setDrawerOpen(false); }, [headerTitle, mobile]);
  // Settings pages load lazily; navigation stays mounted.
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

  return (
    <div className={`app paper-shell${settingsOpen ? ' is-app-settings' : ''}${collapsed && !mobile ? ' is-sidebar-collapsed' : ''}${mobile ? ' is-mobile' : ''}${topLevel ? ' has-phone-tabs' : ''}${chatHeader ? ' is-chat-route' : ''}`}>
      {!mobile && <Sidebar />}
      <div className="shell-content">
        <header className="shell-header" tabIndex={-1}>
          {hasBack && <button type="button" className="shell-back" aria-label={mobile ? 'Back' : backText} onClick={back}><ChevronLeft size={mobile ? 20 : 16} aria-hidden /><span>{backText}</span></button>}
          <div id="shell-chat-header" hidden={!chatHeader} />
          {!chatHeader && (headerBot ? <><BotAvatarFor bot={headerBot} size={32} /><div className="shell-header__bot"><strong className="shell-header__title">{headerBot.name}</strong><span className="shell-header__subtitle">{botSubtitle}</span></div></> : <strong className="shell-header__title">{headerTitle}</strong>)}
          {mobile && <button type="button" className="shell-menu" aria-label="Open navigation" aria-expanded={drawerOpen} onClick={() => setDrawerOpen(true)}><Menu size={22} aria-hidden /></button>}
        </header>
      <div className={`main-pane${detailsOpen && hasBot && view === 'chat' && !botSettings && modal !== 'create' && modal !== 'group' ? ' has-bot-details' : ''}`} hidden={settingsOpen || routeModal}>
      <div className="chat-pane">
      <Suspense fallback={view === 'chat' && !botSettings && !modal ? <ChatSkeleton /> : <main className="chat chat--empty" role="status">Loading...</main>}>
        {rosterUnavailable && view !== 'tasks' ? <main className="boot boot--data"><RosterFeedback /></main>
          : screen.kind === 'first-run' ? <FirstRun />
          : modal === 'create' ? <CreateBotModal inline />
          : modal === 'group' ? <CreateGroupModal inline />
          : botSettings ? <BotSettingsModal inline />
          : view === 'tasks' ? <TasksLoader />
          : view === 'bots' ? <BotsView /> : <ChatView />}
      </Suspense>
      </div>
      {detailsOpen && hasBot && view === 'chat' && <div className="bot-details-pane" hidden={!!botSettings || modal === 'create' || modal === 'group'}><Suspense fallback={<div role="status">Loading...</div>}><DetailsPanel key={selectedBotId} /></Suspense></div>}
      </div>
      <Suspense fallback={<div className="toast" role="status">Loading</div>}>
      {modal === 'search' && <SearchModal inline />}
      {modal === 'apps' && <ConnectAppsModal inline />}
      {viewerOpen && <ComputerViewer />}
      </Suspense>
      {settingsOpen && <AppSettings />}
      {mobile && topLevel && <nav className="phone-tabs" aria-label="App navigation">
        {([
          ['Bots', House, { kind: 'bots' }, screen.kind === 'bots'],
          ['Tasks', ListTodo, { kind: 'work', route: { tab: 'Tasks' } }, screen.kind === 'work'],
          ['Search', Search, { kind: 'search' }, screen.kind === 'search'],
          ['Settings', Settings, { kind: 'settings' }, screen.kind === 'settings'],
        ] as const).map(([label, Icon, target, active]) => <button type="button" key={label} aria-current={active ? 'page' : undefined} onClick={() => navigation.navigate(target as Screen)}><Icon size={22} aria-hidden /><span>{label}</span></button>)}
      </nav>}
      </div>
      {mobile && drawerOpen && <Modal label="App navigation" className="phone-drawer paper-shell" onClose={() => setDrawerOpen(false)}><Sidebar onClose={() => setDrawerOpen(false)} /></Modal>}
    </div>
  );
}


export function AuthenticatedShell() {
  return <SignedInAuthFeedback><Shell /><ConfirmPortal /><ToastPortal /></SignedInAuthFeedback>;
}
