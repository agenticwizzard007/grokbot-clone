import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ChevronLeft, PanelLeftOpen, Search, X } from 'lucide-react';
import { NAV, matches, SettingsNavButton } from './settingsNavigation';
import { backToParent, useReturnLabel, useConfigUI, type AppSection } from '../../configStore';
import { useStore } from '../../store';
import { useCompactLayout } from '../../lib/useCompactLayout';
import { SwarmMark } from '../SwarmMark';
import '../../styles/config.css';
import '../../styles/settings.css';
import '../../styles/access-settings.css';

// Only page contents wait for code or data. Navigation stays mounted and usable.
const ConfigLayer = lazy(() => import('./ConfigLayer').then(m => ({ default: m.ConfigLayer })));

let settingsCaller: HTMLElement | null = null;
const unsubscribeFocus = useConfigUI.subscribe((next, previous) => {
  if (next.appSettings && !previous.appSettings) {
    settingsCaller = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
});
import.meta.hot?.dispose(unsubscribeFocus);

function restoreSettingsFocus(caller: HTMLElement | null) {
  if (useConfigUI.getState().appSettings || (document.activeElement && document.activeElement !== document.body)) return;
  const account = document.querySelector<HTMLElement>('.account__btn');
  const pane = document.querySelector<HTMLElement>('.main-pane');
  for (const target of [caller, account, pane]) {
    if (!target?.isConnected || !target.getClientRects().length || target.closest('[hidden], [inert]')) continue;
    if (target === pane && !target.hasAttribute('tabindex')) target.tabIndex = -1;
    target.focus({ preventScroll: true });
    if (document.activeElement === target) return;
  }
}

/** Full-window settings, opened from the account menu or ⌘,. Phones get a section list that drills into each page. */
export function AppSettings() {
  const section = useConfigUI((s) => s.appSettings);
  const home = useConfigUI((s) => s.appSettingsHome);
  const close = useConfigUI((s) => s.closeAppSettings);
  const open = useConfigUI((s) => s.openAppSettings);
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const backTitle = useReturnLabel();
  const showListRoute = () => useConfigUI.getState().showSettingsList();
  const compact = useCompactLayout();
  const listView = home;
  const [query, setQuery] = useState('');
  const main = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLElement>(null);
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
  // The sidebar may mount in this same commit on a cold deep link. Resolve the
  // host before mounting any page, then keep it stable across viewport changes:
  // moving a portal remounts forms and can consume a one-time sign-in return.
  useLayoutEffect(() => {
    setPortalHost(document.querySelector<HTMLElement>('.app') ?? document.body);
  }, []);
  const desktopSlot = compact ? null : portalHost?.querySelector<HTMLElement>('#app-settings-sidebar-slot');
  const backSlot = desktopSlot && collapsed ? portalHost?.querySelector<HTMLElement>('#sidebar-back-slot') : null;
  const appRoot = !compact && portalHost?.matches('.app') ? portalHost : null;
  const state = useRef({ query, compact, listView });
  state.current = { query, compact, listView };

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('.modal-root')) return;
      e.preventDefault();
      const st = state.current;
      if (st.query && (e.target as HTMLElement | null)?.closest?.('.settings-search')) setQuery('');
      else if (st.compact && !st.listView) showListRoute();
      else close();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [close]);
  useEffect(() => { setQuery(''); }, [home, section]);
  useEffect(() => { main.current?.scrollTo({ top: 0 }); }, [section, listView]);
  useLayoutEffect(() => { heading.current?.focus({ preventScroll: true }); }, [portalHost, appRoot, compact, listView, section]);
  useLayoutEffect(() => {
    const caller = settingsCaller;
    return () => {
      if (!useConfigUI.getState().appSettings) requestAnimationFrame(() => restoreSettingsFocus(caller));
    };
  }, []);

  const sectionLabel = NAV.flatMap(group => group.items).find(item => item.id === section)?.label;
  if (!section || !portalHost) return null;
  const pick = (id: AppSection) => { open(id); setQuery(''); };
  const q = query.trim();
  const groups = q ? NAV.map((g) => ({ ...g, items: g.items.filter((it) => matches(it, q)) })).filter((g) => g.items.length) : NAV;
  // Up/Down move between sections, like a native sidebar.
  const arrows = (e: ReactKeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('.settings-nav__item')];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (at < 0 && !(document.activeElement as HTMLElement | null)?.closest('.settings-search')) return;
    e.preventDefault();
    items[at < 0 ? 0 : (at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  };

  const nav = collapsed && desktopSlot ? <nav className="access-nav access-nav--collapsed" aria-label="Settings sidebar">
    <button type="button" className="access-nav__expand" aria-label="Expand sidebar to browse settings" title="Expand sidebar to browse settings" onClick={() => useStore.getState().set({ sidebarCollapsed: false })}><PanelLeftOpen size={20} aria-hidden /></button>
  </nav> : (
    <nav className={`settings-nav access-nav${compact ? ' access-nav--phone' : ''}`} aria-label="Settings sections" onKeyDown={arrows}>
      {!compact && <div className="settings-nav__back-slot">{!home && <button type="button" className="access-settings__back settings-nav__back" onClick={backToParent}><ChevronLeft size={18} aria-hidden /><span>{backTitle}</span></button>}</div>}
      {compact ? <PageHead title={q ? 'Search settings' : 'Settings'} sub="Manage your Swarm workspace." /> : <h2 className="settings-nav__title">Settings</h2>}
      <label className="settings-search">
        <Search size={18} strokeWidth={1.75} aria-hidden />
        <input
          id="app-settings-search" type="search" value={query} placeholder="Search settings" aria-label="Search settings" autoComplete="off" spellCheck={false} enterKeyHint="go"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && groups[0]) { e.preventDefault(); pick(groups[0].items[0].id); } }}
        />
      </label>
      {groups.map((g) => (
        <div key={g.group} className="settings-nav__group" role="group" aria-label={g.group}>
          <h3 className="settings-nav__label">{g.group}</h3>
          <div className="settings-nav__items">
            {g.items.map(it => <SettingsNavButton key={it.id} item={it} compact={compact} active={section === it.id && !(compact && listView)} onSelect={pick} />)}
          </div>
        </div>
      ))}
      {!groups.length && <div className="settings-nav__empty" role="status">No settings match “{q}”.</div>}
    </nav>
  );

  const showList = compact && listView;
  return <>
    {backSlot && !home && createPortal(<button type="button" className="sidebar__back" aria-label={backTitle} title={backTitle} onClick={backToParent}><ArrowLeft size={20} aria-hidden /></button>, backSlot)}
    {desktopSlot && createPortal(nav, desktopSlot)}
    {createPortal(<div className={`app-settings access-settings${appRoot ? ' access-settings--in-shell' : ''}${showList ? ' is-list' : ''}`} role={appRoot ? 'region' : 'dialog'} aria-modal={appRoot ? undefined : true} aria-label="Settings">
      {!compact && !desktopSlot && <aside className="app-settings__nav">{nav}</aside>}
      <div className="app-settings__main" ref={main}>
        <header className="access-settings__bar" tabIndex={-1} ref={heading}>
          <div className="access-settings__back-slot">{!home && <button type="button" className="access-settings__back" onClick={backToParent} aria-label={backTitle}>
            <ChevronLeft size={18} strokeWidth={1.75} aria-hidden />{!compact && <span>{backTitle}</span>}
          </button>}</div>
          <span className="access-settings__bar-title">{compact && <SwarmMark size={24} />}{showList ? 'Settings' : sectionLabel}</span>
          {compact && <button type="button" className="access-settings__back access-settings__dismiss" onClick={close} aria-label="Close settings"><X size={18} strokeWidth={1.75} aria-hidden /></button>}
        </header>
        {showList ? nav : <>
          {/* Compact sidebar: the section list moves to a strip above the page so every section stays reachable. */}
          {collapsed && desktopSlot && <nav className="settings-strip" aria-label="Settings sections">
            {NAV.flatMap(g => g.items).map(it => <SettingsNavButton key={it.id} item={it} strip active={section === it.id} onSelect={pick} />)}
          </nav>}
          <div className="app-settings__page" key={section}>
            <Suspense fallback={<div className="settings-page-loading" role="status">Loading settings…</div>}>
              <ConfigLayer />
            </Suspense>
          </div>
        </>}
      </div>
    </div>, portalHost)}
  </>;
}

function PageHead({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="app-settings__head">
      <h1>{title}</h1>
      {sub && <p>{sub}</p>}
    </div>
  );
}
