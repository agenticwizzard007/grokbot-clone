import { useComponentVisible, useUiConfig } from '../customization';
import { useSidebarItems } from '../customization/layout/useSidebarItems';
import { dashboardScreen } from '../customization/layout/usePhoneTabs';
import { Fragment } from 'react';
import { RosterFeedback } from './LoadFeedback';
import { userFacingLive } from '../lib/audience';
import { memo, useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Blocks, ChevronDown, ChevronRight, Folder, Gauge, GitBranch, House, LayoutDashboard, LogOut, Settings, Terminal, X, Repeat } from 'lucide-react';
import { navigation, openConversation, useConfigUI } from '../configStore';
import { TasksIsland } from './config/TasksIsland';
import type { Bot } from '@shared/types';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { displayName, useStore } from '../store';
import { api } from '../lib/api';
import { Icon } from './Icon';
import { Menu } from './Menu';
import { SidebarUsage } from './SidebarUsage';
import { shortcutLabel } from '../lib/shortcuts';
import { toast } from '../lib/toast';
import './sidebar-labels.css';
import { useDashboardDisclosure } from '../lib/sidebarDisclosure';
import { useSidebarRows } from '../lib/useSidebarRows';
import { routeDashboard } from '../lib/navigation';

/** MF-027: a Bot is highlighted only while its chat is the visible page. */
export function sidebarHighlightsBot(ui: { view: string; appSettings: unknown; botSettings: unknown }, modal: string | null): boolean {
  return ui.view === 'chat' && !ui.appSettings && !ui.botSettings && modal === null;
}

function initials(name: string) {
  // Letters (any script) and digits only, so names like "Alex (owner)" don't yield "A(".
  const words = name.split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean);
  return ((words[0]?.[0] ?? '') + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase() || '?';
}

export function TrafficLights() {
  return (
    <div className="traffic-lights" aria-hidden>
      <span style={{ background: '#FF5F57' }} />
      <span style={{ background: '#FEBC2E' }} />
      <span style={{ background: '#28C840' }} />
    </div>
  );
}

function previewFor(bot: Bot, running: boolean, awaiting: string | null) {
  if (awaiting) return 'Needs you';
  if (running) return 'Working';
  return bot.kind === 'room' ? 'Room' : 'Ready';
}

const BotRow = memo(function BotRow({ bot, selected, running, awaiting, onSelect }: { bot: Bot; selected: boolean; running: boolean; awaiting: string | null; onSelect: (id: string) => void }) {
  return (
    <button type="button" className={`bot-row${selected ? ' is-selected' : ''}`} onClick={() => onSelect(bot.id)} aria-current={selected || undefined}>
      <span className="bot-row__avatar">
        <BotAvatarFor bot={bot} size={36} working={running} />
        {(running || awaiting || bot.unread > 0) && (
          <span className={`status-dot ${awaiting ? 'is-attention' : running ? 'is-working' : 'is-unread'}`} role="img" aria-label={awaiting ? 'Needs attention' : running ? 'Working' : 'Unread activity'} />
        )}
      </span>
      <span className="bot-row__text">
        <span className="bot-row__name">{bot.name}</span>
        <span className="bot-row__preview sidebar-status">{previewFor(bot, running, awaiting)}</span>
      </span>
    </button>
  );
});

export function Sidebar({ onClose }: { onClose?: () => void }) {
  const layout = useSidebarItems();
  const { status: dashboardStatus } = useUiConfig();
  const scrollRef = useSidebarRows();
  const searchVisibility = useComponentVisible('sidebar.search');
  const usageVisibility = useComponentVisible('sidebar.usage');
  const accountVisibility = useComponentVisible('sidebar.account');
  const mobile = useStore(s => s.mobile);
  const view = useConfigUI(s => s.view);
  const settingsOpen = useConfigUI(s => !!s.appSettings);
  const workTab = useConfigUI(s => s.workRoute.tab);
  const bots = useStore((s) => s.bots);
  const live = useStore((s) => s.live);
  const storeSelectedBotId = useStore((s) => s.selectedBotId);
  const modal = useStore((s) => s.modal);
  const chatVisible = useConfigUI((s) => sidebarHighlightsBot(s, modal));
  const selectedBotId = chatVisible ? storeSelectedBotId : null; // nothing highlighted on Tasks, Settings, Bot settings or create pages
  const user = useStore((s) => s.user);
  const dashboards = useDashboardDisclosure(user?.id);
  const screen = navigation.screen;
  const currentDashboard = !settingsOpen && !modal && screen?.kind === 'dash' ? routeDashboard(screen.dashboard, layout.dashboards)?.id : undefined;
  const managingDashboards = !settingsOpen && !modal && screen?.kind === 'dashboards';
  // The phone drawer always shows the full sidebar.
  const collapsed = useStore((s) => s.sidebarCollapsed && !s.mobile);
  const set = useStore((s) => s.set);
  // Picking a bot (even the one already selected) leaves the Tasks view.
  const selectBot = useCallback((id: string) => { openConversation(id); onClose?.(); }, [onClose]);
  const storeModal = useStore((s) => s.setModal);
  const setModal = (value: Parameters<typeof storeModal>[0]) => { storeModal(value); onClose?.(); };
  const [accountMenu, setAccountMenu] = useState(false);
  const accountTrigger = useRef<HTMLButtonElement>(null);
  const accountRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const account = accountRef.current;
    if (!accountMenu || !account) return;
    const measure = () => {
      // Allow for the menu's 6px trigger gap and an 8px viewport margin.
      const rect = account.getBoundingClientRect();
      const below = innerHeight - rect.bottom - 14;
      const above = rect.top - 14;
      if (layout.standardOrder) account.style.setProperty('--account-menu-height', `${Math.max(0, above)}px`);
      else {
        const height = Math.min(320, Math.max(above, below));
        account.style.setProperty('--account-menu-height', `${Math.max(0, height)}px`);
        account.style.setProperty('--ui-menu-top', `${below >= above ? rect.bottom + 6 : Math.max(8, rect.top - height - 6)}px`);
        account.style.setProperty('--ui-menu-left', `${Math.max(8, rect.left)}px`);
      }
    };
    measure();
    let frame = 0;
    const scheduleMeasure = () => {
      // Read after responsive layout has settled for the new viewport.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(account, { box: 'border-box' });
    const sidebar = account.closest('.sidebar');
    if (sidebar) {
      observer.observe(sidebar, { box: 'border-box' });
      // Sibling size changes can move the trigger without resizing it.
      for (const child of sidebar.children) observer.observe(child, { box: 'border-box' });
    }
    window.addEventListener('resize', scheduleMeasure);
    window.addEventListener('scroll', scheduleMeasure, true);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', scheduleMeasure);
      window.removeEventListener('scroll', scheduleMeasure, true);
    };
  }, [accountMenu, collapsed, layout.standardOrder]);
  // R2F-004: leaving Bot settings with unsaved edits asks first.
  const createBot = () => setModal('create');
  const showBots = () => { useConfigUI.getState().setView('bots'); onClose?.(); };
  const logout = async () => {
    try { await api.logout(); }
    catch { toast('Couldn\'t sign out. Check your connection and try again.', { tone: 'error' }); return; }
    useStore.getState().set({ user: null, bots: [], transcripts: {}, live: {}, routines: {} });
    location.reload();
  };

  const primary = bots.find((b) => b.isPrimary);
  const primaryLive = primary ? userFacingLive(live[primary.id]) : undefined;
  const primaryWorking = !!primaryLive?.isRunning && !primaryLive.awaiting;
  const others = bots.filter((b) => !b.isPrimary).sort((a, b) => b.lastActivityAt - a.lastActivityAt);

  const sections = {
    allBots: <>{!collapsed && <button type="button" className={`sidebar-island${view === 'bots' && !settingsOpen && !modal ? ' is-active' : ''}`} onClick={showBots} aria-label="All Bots"><House size={18} aria-hidden /><span>All Bots</span></button>}</>,
    tasks: <TasksIsland />,
    routines: <button type="button" className="sidebar-island" aria-label="Routines" title="Routines" onClick={() => { const bot = bots.find(b => b.isPrimary) ?? bots[0]; if (bot) navigation.navigate({ kind: 'bot-settings', bot: bot.id, tab: 'routines' }); onClose?.(); }}><Repeat size={18} aria-hidden />{!collapsed && <span>Routines</span>}</button>,
    files: <>        {!collapsed && <button type="button" className={`sidebar-island${view === 'tasks' && workTab === 'Reports' && !settingsOpen && !modal ? ' is-active' : ''}`} onClick={() => navigation.navigate({ kind: 'work', route: { tab: 'Reports' } })}><Folder size={18} aria-hidden /><span>Files</span></button>}</>,
    yourBots: <>        {!collapsed && bots.length > 0 && <button type="button" className="sidebar__section-label" onClick={showBots}>Your Bots</button>}
        {primary && (
          <div className="pinned">
            <button type="button" className={`pinned__tile${selectedBotId === primary.id ? ' is-selected' : ''}`} onClick={() => selectBot(primary.id)} aria-label={collapsed ? displayName(primary) : undefined} title={displayName(primary)}>
              <span className="pinned__avatar">
                <BotAvatarFor bot={primary} size={36} star working={primaryWorking} />
                {primaryWorking && <span className="status-dot is-working pinned__dot" />}
              </span>
              {!collapsed && <span className="pinned__text"><span className="pinned__label"><span className="pinned__name">{primary.name}</span><span className="pinned__tag">Primary</span></span><span className="bot-row__preview sidebar-status">{previewFor(primary, primaryWorking, primaryLive?.awaiting?.reason ?? null)}</span></span>}
            </button>
          </div>
        )}
        <div className="bot-list">
          {others.map((bot) => {
            const botLive = userFacingLive(live[bot.id]);
            const working = !!botLive?.isRunning && !botLive.awaiting;
            return collapsed ? (
              <button key={bot.id} type="button" className={`bot-rail-item${selectedBotId === bot.id ? ' is-selected' : ''}`} onClick={() => selectBot(bot.id)} title={displayName(bot)}>
                <BotAvatarFor bot={bot} size={36} working={working} />
              </button>
            ) : (
              <BotRow key={bot.id} bot={bot} selected={selectedBotId === bot.id} running={working} awaiting={botLive?.awaiting?.reason ?? null} onSelect={selectBot} />
            );
          })}
        </div>
</>,
    createBot: <>        <button type="button" className="sidebar__create" onClick={createBot} aria-label="Create a Bot" title={`Create a Bot (${shortcutLabel('new-bot')})`}>
          <Icon name="plus" size={20} opacity={0.66} />{!collapsed && <span>Create a Bot</span>}
        </button></>,
    usage: usageVisibility !== 'hide' ? <div data-ui-id="sidebar.usage" className="sidebar__usage"><SidebarUsage collapsed={collapsed} /></div> : null,
    settings: <>      <div className={`sidebar__footer${settingsOpen ? ' is-active' : ''}`}>
        <div className="account" ref={accountRef}>
            <button ref={accountTrigger} type="button" className="account__btn" aria-label={`${accountVisibility === 'hide' ? '' : `${initials(user?.name ?? user?.email ?? '')} `}Settings. Account & settings`} onClick={() => setAccountMenu(open => !open)} aria-haspopup="menu" aria-expanded={accountMenu} title={accountVisibility === 'hide' ? 'Settings' : user?.email.endsWith('@openrouter.invalid') ? 'OpenRouter account' : user?.email}>
              <span className="account__initials" data-ui-id="sidebar.account" aria-hidden="true" hidden={accountVisibility === 'hide'}>{initials(user?.name ?? user?.email ?? '')}</span>{' '}
              <span className="account__name">Settings</span>
              {(!collapsed || accountVisibility === 'hide') && <Settings size={18} aria-hidden />}
            </button>
            {accountMenu && (
              <Menu
                triggerRef={accountTrigger}
                placement="above"
                onClose={() => setAccountMenu(false)}
                items={[
                  { label: 'Settings', icon: Settings, hint: shortcutLabel('settings'), onSelect: () => { useConfigUI.getState().openAppSettings(); onClose?.(); } },
                  { label: 'Usage', icon: Gauge, onSelect: () => { useConfigUI.getState().openAppSettings('usage'); onClose?.(); } },
                  { label: 'Loops', icon: GitBranch, onSelect: () => { navigation.navigate({ kind: 'loops' }); onClose?.(); } },
                  { label: 'Models and access', icon: Terminal, onSelect: () => { useConfigUI.getState().openAppSettings('subscriptions'); onClose?.(); } },
                  { label: 'Connect apps', icon: Blocks, separatorBefore: true, onSelect: () => setModal('apps') },
                  { label: 'Log out', icon: LogOut, danger: true, separatorBefore: true, onSelect: logout },
                ]}
              />
            )}
          </div>

      </div></>,
    dashboards: dashboardStatus === 'ready' ? <section className="sidebar__dashboards" aria-label="Dashboards">
      {!collapsed && <button type="button" className="sidebar__section-label sidebar__disclosure" aria-expanded={dashboards.expanded} aria-label="Dashboards" onClick={() => dashboards.setExpanded(!dashboards.expanded)}><span>Dashboards</span>{dashboards.expanded ? <ChevronDown size={18} aria-hidden /> : <ChevronRight size={18} aria-hidden />}</button>}
      {(collapsed || dashboards.expanded) && <>
        {layout.dashboards.slice(0, mobile || dashboards.short ? 3 : 5).map(dashboard => <button type="button" key={dashboard.id} className={`sidebar-island${currentDashboard === dashboard.id ? ' is-active' : ''}`} aria-current={currentDashboard === dashboard.id ? 'page' : undefined} aria-label={dashboard.name} title={dashboard.name} onClick={() => { navigation.navigate(dashboardScreen(dashboard.id)); onClose?.(); }}><LayoutDashboard size={18} aria-hidden />{!collapsed && <span>{dashboard.name}</span>}</button>)}
        <button type="button" className={`sidebar-island${managingDashboards ? ' is-active' : ''}`} aria-current={managingDashboards ? 'page' : undefined} aria-label="All dashboards" onClick={() => { navigation.navigate({ kind: 'dashboards' }); onClose?.(); }}><LayoutDashboard size={18} aria-hidden />{!collapsed && <span>All dashboards</span>}</button>
      </>}
    </section> : null,
    search: null,
  };
  const section = (id: keyof typeof sections) => layout.items.includes(id) ? sections[id] : null;

  return (
    <aside className={`sidebar${layout.standardOrder ? '' : ' is-custom-order'}${collapsed ? ' is-collapsed' : ''}`} aria-label="Your Bots">

      <div className="sidebar__titlebar">
        <button type="button" className="sidebar__brand" aria-label="Your Bots" onClick={showBots}>
          {collapsed ? <>
            <img className="brand-image brand-image--light" src="/assets/swarms/flock.svg" alt="" />
            <img className="brand-image brand-image--night" src="/assets/swarms/flock-night.svg" alt="" />
          </> : <>
            <img className="brand-image brand-image--light" src="/assets/swarms/wordmark.svg" alt="swarms.so" />
            <img className="brand-image brand-image--night" src="/assets/swarms/wordmark-night.svg" alt="swarms.so" />
          </>}
        </button>
        <div className="sidebar__controls">
          {mobile ? <button type="button" className="icon-btn" aria-label="Close navigation" onClick={onClose}><X size={20} aria-hidden /></button> : <button type="button" className="icon-btn icon-btn--plain" onClick={() => set({ sidebarCollapsed: !collapsed })} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={`${collapsed ? 'Expand sidebar' : 'Collapse sidebar'} (${shortcutLabel('sidebar')})`}>
            <Icon name="sidebar" opacity={0.66} />
          </button>}
        </div>
      </div>
      {layout.search && searchVisibility !== 'hide' && <button type="button" data-ui-id="sidebar.search" className="sidebar__search" onClick={() => setModal('search')} aria-label={collapsed ? 'Search' : `Search ${shortcutLabel('search')}`} title={`Search (${shortcutLabel('search')})`}>
        <Icon name="search" size={18} opacity={0.66} />
        {!collapsed && <><span>Search</span>{' '}<kbd aria-hidden="true">{shortcutLabel('search')}</kbd></>}
      </button>}

      {layout.standardOrder ? <>
        <nav className="sidebar__nav" aria-label="Main navigation" onClick={onClose}>{section('allBots')}{section('tasks')}{section('files')}</nav>
        <div ref={scrollRef} className="sidebar__scroll"><div className="sidebar__scroll-content">{mobile && <RosterFeedback />}{section('dashboards')}{section('yourBots')}{section('createBot')}</div></div>
      </> : <div ref={scrollRef} className="sidebar__custom-scroll"><div className="sidebar__scroll-content">
        {mobile && <RosterFeedback />}
        {layout.pinned.length > 0 && <section aria-label="Pinned" className="sidebar__pins">
          {!collapsed && <div className="sidebar__section-label">Pinned</div>}
          {layout.pinned.map(pin => <button type="button" key={`${pin.type}:${pin.id}`} className="sidebar-island" aria-label={pin.name} title={pin.name} onClick={() => { if (pin.type === 'bot') selectBot(pin.id); else { navigation.navigate(dashboardScreen(pin.id)); onClose?.(); } }}>
            {pin.type === 'bot' ? <BotAvatarFor bot={bots.find(bot => bot.id === pin.id)!} size={24} /> : <LayoutDashboard size={18} aria-hidden />}{!collapsed && <span>{pin.name}</span>}
          </button>)}
        </section>}
        {layout.items.filter(id => id !== 'usage' && id !== 'settings').map(id => <Fragment key={id}>{section(id)}</Fragment>)}
      </div></div>}
      {section('usage')}{section('settings')}

    </aside>
  );
}
