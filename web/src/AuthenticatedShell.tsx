import { usePhoneTabs, isPhoneRoot, isPhoneTab } from './customization/layout/usePhoneTabs';
import { useSidebarDefault } from './customization/layout/useSidebarItems';
import { useHome } from './customization/layout/useHome';
import { useKeybindings } from './customization/layout/useKeybindings';
import { useComponentVisible, useEffectiveConfig } from './customization';
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
import { ToastPortal } from './lib/toast';
import { ConfirmPortal } from './lib/confirmDialog';
import { ChevronLeft, Menu } from 'lucide-react';
import { backLabel, parentScreen, parseScreen, routeDashboard, screenTitle } from './lib/navigation';
import { Modal } from './components/modals/Modal';
import { BotAvatarFor } from './avatar/BotAvatar';
import { routeBot } from './lib/userRoutes';
import { HandoffRoutes, type HandoffScreen } from './App';

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

// Paper geometry is the same for every dashboard, independent of the profile.
const dashboardSurfaceStyles = `
.dashboard-surface { width: 100%; height: 100%; min-width: 0; min-height: 0; overflow-y: auto; }
.dashboard-surface :is(.btn, .cfg-btn) { gap: 8px; font-size: 14px; line-height: 20px; }
.dashboard-surface :is(.dashboard-muted, .dashboard-list-meta, .dashboard-chart-labels, .dashboard-chart-legend, .dashboard-schedule time, .dashboard-schedule li > span, .dashboard-bot-grid small) { font-size: 13px; line-height: 20px; color: var(--color-text-secondary); }
.dashboard-surface :is(.dashboard-widget--stat, .dashboard-status, .dashboard-bot-grid li > div, .dashboard-schedule li) { gap: 8px; }
.dashboard-surface .dashboard-actions .btn:first-child, .dashboard-surface .dashboard-empty-data .btn { background: var(--color-bg-tertiary); color: var(--color-text-primary); box-shadow: inset 0 0 0 1px var(--color-border); }
.dashboard-surface .dashboard-actions .btn:last-child { background: var(--color-primary); color: var(--color-on-primary); }
@media (max-width: 760px) {
  .dashboard-surface .dashboard-heading > div:first-child { display: none; }
  .dashboard-surface .dashboard-actions { max-width: none; flex: 1 1 0; width: 100%; }
}
@media (min-width: 761px) {
  .app:has(.dashboard-surface) .shell-header > .shell-header__title { display: none; }
}
`;

const DashboardView = lazy(() => import('./dashboards/DashboardView'));
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
  useHome();
  useSidebarDefault();
  useKeybindings();
  const phoneTabs = usePhoneTabs();
  const dashboards = useEffectiveConfig().dashboards;
  const tabLabels = useComponentVisible('phone.tabLabels');
  const taskFilters = useComponentVisible('tasks.filters');
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
  const topLevel = isPhoneRoot(screen, phoneTabs);
  const hasBack = mobile ? !topLevel : screen.kind !== 'bots' || navigation.trail.length > 0;
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
  const dashboard = screen.kind === 'dash' ? routeDashboard(screen.dashboard, dashboards) : undefined;
  const headerTitle = dashboard?.name ?? (!mobile && screen.kind === 'settings' ? 'Settings' : screenTitle(screen, bots).replace(/ · Swarm$/, '').replace(/^Settings · /, ''));
  const headerBot = 'bot' in screen ? routeBot(screen.bot, bots) : undefined;
  const titledInHeader = mobile && (screen.kind === 'dash' || (screen.kind === 'settings' && screen.use));
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

  return (
    <div className={`app paper-shell${settingsOpen ? ' is-app-settings' : ''}${collapsed && !mobile ? ' is-sidebar-collapsed' : ''}${mobile ? ' is-mobile' : ''}${topLevel ? ' has-phone-tabs' : ''}${chatHeader ? ' is-chat-route' : ''}`}>
      {!mobile && <Sidebar />}
      <div className="shell-content">
        <header className="shell-header" tabIndex={-1}>
          {hasBack && <button type="button" className="shell-back" aria-label={mobile ? 'Back' : backText} onClick={back}><ChevronLeft size={mobile ? 20 : 16} aria-hidden /><span>{backText}</span></button>}
          <div id="shell-chat-header" hidden={!chatHeader} />
          {!chatHeader && (headerBot ? <><BotAvatarFor bot={headerBot} size={32} /><div className="shell-header__bot"><strong className="shell-header__title">{headerBot.name}</strong><span className="shell-header__subtitle">{botSubtitle}</span></div></> : <strong className="shell-header__title" role={titledInHeader ? 'heading' : undefined} aria-level={titledInHeader ? 1 : undefined}>{headerTitle}</strong>)}
          {mobile && <button type="button" className="shell-menu" aria-label="Open navigation" aria-expanded={drawerOpen} onClick={() => setDrawerOpen(true)}><Menu size={22} aria-hidden /></button>}
        </header>
      <div className={`main-pane${detailsOpen && hasBot && view === 'chat' && !botSettings && modal !== 'create' && modal !== 'group' ? ' has-bot-details' : ''}`} hidden={settingsOpen || routeModal}>
      <div className="chat-pane" data-ui-id="tasks.filters" data-ui-visibility={taskFilters}>
      <Suspense fallback={view === 'chat' && !botSettings && !modal ? <ChatSkeleton /> : <main className="chat chat--empty" role="status">Loading...</main>}>
        {rosterUnavailable && view !== 'tasks' ? <main className="boot boot--data"><RosterFeedback /></main>
          : ['loops', 'loop', 'handoff', 'output'].includes(screen.kind) ? <HandoffRoutes screen={screen as HandoffScreen} />
          : screen.kind === 'dash' ? <div className="dashboard-surface"><style>{dashboardSurfaceStyles}</style><DashboardView dashboardId={dashboard?.id ?? screen.dashboard} /></div>
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
      {mobile && topLevel && <nav className="phone-tabs" aria-label="App navigation" data-ui-id="phone.tabLabels" data-ui-visibility={tabLabels}>
        {phoneTabs.map(tab => <button type="button" key={tab.id} aria-label={tab.label} aria-current={isPhoneTab(screen, [tab]) ? 'page' : undefined} onClick={() => navigation.navigate(tab.target)}><tab.Icon size={22} aria-hidden /><span hidden={tabLabels === 'hide'}>{tab.label}</span></button>)}
      </nav>}
      </div>
      {mobile && drawerOpen && <Modal label="App navigation" className="phone-drawer paper-shell" onClose={() => setDrawerOpen(false)}><Sidebar onClose={() => setDrawerOpen(false)} /></Modal>}
    </div>
  );
}


export function AuthenticatedShell() {
  return <SignedInAuthFeedback><Shell /><ConfirmPortal /><ToastPortal /></SignedInAuthFeedback>;
}
