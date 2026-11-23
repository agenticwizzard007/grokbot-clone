import { RosterFeedback } from './LoadFeedback';
import { userFacingLive } from '../lib/audience';
import { memo, useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Blocks, ChevronDown, Gauge, KeyRound, LogOut, Monitor, Settings } from 'lucide-react';
import { openConversation, useConfigUI } from '../configStore';
import { TasksIsland } from './config/TasksView';
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

/** MF-027: a Bot is highlighted only while its chat is the visible page. */
export function sidebarHighlightsBot(ui: { view: string; appSettings: unknown; botSettings: unknown }, modal: string | null): boolean {
  return ui.view === 'chat' && !ui.appSettings && !ui.botSettings && modal !== 'create' && modal !== 'group';
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
  if (awaiting) return `Waiting for you: ${awaiting}`;
  if (running && !bot.lastPreview) return 'Working…';
  return bot.lastPreview ?? 'No messages yet';
}

const BotRow = memo(function BotRow({ bot, selected, running, awaiting, onSelect }: { bot: Bot; selected: boolean; running: boolean; awaiting: string | null; onSelect: (id: string) => void }) {
  return (
    <button type="button" className={`bot-row${selected ? ' is-selected' : ''}`} onClick={() => onSelect(bot.id)} aria-label={`${displayName(bot)}. ${previewFor(bot, running, awaiting)}`} aria-current={selected || undefined}>
      <span className="bot-row__avatar">
        <BotAvatarFor bot={bot} size={36} working={running} />
        {(running || awaiting || bot.unread > 0) && (
          <span className={`status-dot ${awaiting ? 'is-attention' : running ? 'is-working' : 'is-unread'}`} aria-label={awaiting ? 'Needs attention' : running ? 'Working' : 'Unread activity'} />
        )}
      </span>
      <span className="bot-row__text">
        <span className="bot-row__name">{bot.name}</span>
        <span className="bot-row__preview">{previewFor(bot, running, awaiting)}</span>
      </span>
    </button>
  );
});

export function Sidebar() {
  const mobile = useStore(s => s.mobile);
  const bots = useStore((s) => s.bots);
  const live = useStore((s) => s.live);
  const storeSelectedBotId = useStore((s) => s.selectedBotId);
  const modal = useStore((s) => s.modal);
  const chatVisible = useConfigUI((s) => sidebarHighlightsBot(s, modal));
  const selectedBotId = chatVisible ? storeSelectedBotId : null; // nothing highlighted on Tasks, Settings, Bot settings or create pages
  const user = useStore((s) => s.user);
  // Phones show the full list as the home screen, never the collapsed rail.
  const collapsed = useStore((s) => s.sidebarCollapsed && !s.mobile);
  const set = useStore((s) => s.set);
  // Picking a bot (even the one already selected) leaves the Tasks view.
  const selectBot = useCallback(openConversation, []);
  const setModal = useStore((s) => s.setModal);
  const [accountMenu, setAccountMenu] = useState(false);
  const accountTrigger = useRef<HTMLButtonElement>(null);
  const accountRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const account = accountRef.current;
    if (!accountMenu || !account) return;
    const measure = () => {
      // Allow for the menu's 6px trigger gap and an 8px viewport margin.
      account.style.setProperty('--account-menu-height', `${Math.max(0, account.getBoundingClientRect().top - 14)}px`);
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
  }, [accountMenu, collapsed]);
  // R2F-004: leaving Bot settings with unsaved edits asks first.
  const createBot = () => useConfigUI.getState().requestLeaveBotSettings(() => { useConfigUI.getState().closeAppSettings(); useConfigUI.getState().discardBotSettings(); setModal('create'); });
  const showBots = () => useConfigUI.getState().requestLeaveBotSettings(() => {
    const ui = useConfigUI.getState(); ui.closeAppSettings(); ui.discardBotSettings(); setModal(null);
    ui.setView(useStore.getState().mobile ? 'chat' : 'bots');
    set({ mobilePane: 'list', detailsOpen: false });
  });
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

  return (
    <aside className={`sidebar${collapsed ? ' is-collapsed' : ''}`} aria-label="Your Bots">
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
          <button type="button" className="icon-btn icon-btn--plain" onClick={() => set({ sidebarCollapsed: !collapsed })} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={`Toggle sidebar (${shortcutLabel('sidebar')})`}>
            <Icon name="sidebar" opacity={0.66} />
          </button>
        </div>
      </div>
      <button type="button" className="sidebar__search" onClick={() => setModal('search')} aria-label="Search" title={`Search (${shortcutLabel('search')})`}>
        <Icon name="search" size={18} opacity={0.66} />
        {!collapsed && <><span>Search</span><kbd>{shortcutLabel('search')}</kbd></>}
      </button>

      <div className="sidebar__scroll">
        {mobile && <RosterFeedback />}
        <TasksIsland />
        {!collapsed && bots.length > 0 && <p className="sidebar__section-label">Your Bots</p>}
        {primary && (
          <div className="pinned">
            <button type="button" className={`pinned__tile${selectedBotId === primary.id ? ' is-selected' : ''}`} onClick={() => selectBot(primary.id)} aria-label={displayName(primary)} title={displayName(primary)}>
              <span className="pinned__avatar">
                <BotAvatarFor bot={primary} size={40} star working={primaryWorking} />
                {primaryWorking && <span className="status-dot is-working pinned__dot" />}
              </span>
              {!collapsed && <span className="pinned__text"><span className="pinned__label"><span className="pinned__name">{primary.name}</span><span className="pinned__tag">Primary</span></span><span className="bot-row__preview">{primaryLive?.awaiting?.reason ?? (primaryWorking ? 'Working…' : primary.label || primary.lastPreview || 'No messages yet')}</span></span>}
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
        <button type="button" className="sidebar__create" onClick={createBot} aria-label="New Bot" title={`Create a Bot (${shortcutLabel('new-bot')})`}>
          <Icon name="plus" size={20} opacity={0.66} />{!collapsed && <span>Create a Bot</span>}
        </button>
      </div>
      <div id="app-settings-sidebar-slot" />
      <SidebarUsage collapsed={collapsed} />

      <div className="sidebar__footer">
        <div className="account" ref={accountRef}>
            <button ref={accountTrigger} type="button" className="account__btn" aria-label="Account & settings" onClick={() => setAccountMenu(!accountMenu)} aria-haspopup="menu" aria-expanded={accountMenu} title={user?.email.endsWith('@openrouter.invalid') ? 'OpenRouter account' : user?.email}>
              <span className="account__initials">{initials(user?.name ?? user?.email ?? '')}</span>
              <span className="account__name">Account &amp; settings</span>
              {!collapsed && <ChevronDown size={14} aria-hidden />}
            </button>
            {accountMenu && (
              <Menu
                triggerRef={accountTrigger}
                placement="above"
                onClose={() => setAccountMenu(false)}
                items={[
                  { label: 'Settings', icon: Settings, hint: shortcutLabel('settings'), onSelect: () => useConfigUI.getState().openAppSettings() },
                  { label: 'Usage', icon: Gauge, onSelect: () => useConfigUI.getState().openAppSettings('usage') },
                  { label: 'API keys', icon: KeyRound, onSelect: () => useConfigUI.getState().openAppSettings('keys') },
                  { label: 'Computer', icon: Monitor, onSelect: () => useConfigUI.getState().openAppSettings('computer') },
                  { label: 'Connect apps', icon: Blocks, separatorBefore: true, onSelect: () => setModal('apps') },
                  { label: 'Log out', icon: LogOut, danger: true, separatorBefore: true, onSelect: logout },
                ]}
              >
                <div className="menu__header">{user?.email.endsWith('@openrouter.invalid') ? 'OpenRouter account' : user?.email}</div>
              </Menu>
            )}
          </div>
        <button type="button" className="icon-btn icon-btn--bordered" onClick={() => setModal('apps')} aria-label="Connect apps" title="Connect apps">
          <Icon name="apps" />
        </button>
      </div>
    </aside>
  );
}
