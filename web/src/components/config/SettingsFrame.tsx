import { SETTINGS_LABELS } from '../../lib/navigation';
import { useUiConfig } from '../../customization';
import { Page, Section, Card } from '../layout';
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ChevronRight, Search } from 'lucide-react';
import { NAV, matches, SettingsNavButton } from './settingsNavigation';
import { navigation, useConfigUI, type AppSection } from '../../configStore';
import { useStore } from '../../store';
import { useCompactLayout } from '../../lib/useCompactLayout';
import '../../styles/config.css';
import '../../styles/settings.css';
import '../../styles/access-settings.css';
import '../../styles/settings-v3.css';

// Only page contents wait for code or data. Navigation stays mounted and usable.
const AppearanceSettings = lazy(() => import('./AppearanceSettings').then(m => ({ default: m.AppearanceSettings })));
const Requirements = lazy(() => import('./appearance/Requirements').then(m => ({ default: m.Requirements })));
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

/** Settings keeps the app navigation alongside its section list. */
export function AppSettings() {
  const { status: appearanceStatus } = useUiConfig();
  const availableNav = appearanceStatus === 'disabled' ? NAV.map(group => ({ ...group, items: group.items.filter(item => item.id !== 'appearance') })) : NAV;
  const section = useConfigUI((s) => s.appSettings);
  const currentScreen = navigation.screen;
  const aboutUse = currentScreen?.kind === 'settings' && currentScreen.use;
  const home = useConfigUI((s) => s.appSettingsHome);
  const close = useConfigUI((s) => s.closeAppSettings);
  const open = useConfigUI((s) => s.openAppSettings);
  const user = useStore(s => s.user);
  const showListRoute = () => useConfigUI.getState().showSettingsList();
  const compact = useCompactLayout();
  const listView = home;
  const [query, setQuery] = useState('');
  const main = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLElement>(null);
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
  useEffect(() => { main.current?.scrollTo({ top: 0 }); }, [section, listView, aboutUse]);
  useLayoutEffect(() => { heading.current?.focus({ preventScroll: true }); }, [compact, listView, section, aboutUse]);
  useLayoutEffect(() => {
    const caller = settingsCaller;
    return () => {
      if (!useConfigUI.getState().appSettings) requestAnimationFrame(() => restoreSettingsFocus(caller));
    };
  }, []);

  const sectionLabel = aboutUse ? 'About you' : NAV.flatMap(group => group.items).find(item => item.id === section)?.label ?? (section ? SETTINGS_LABELS[section] : 'Settings');
  if (!section) return null;
  const pick = (id: AppSection) => { open(id); setQuery(''); };
  const q = query.trim();
  const groups = q ? availableNav.map((g) => ({ ...g, items: g.items.filter((it) => matches(it, q)) })).filter((g) => g.items.length) : availableNav;
  // Up/Down move between sections, like a native sidebar.
  const arrows = (e: ReactKeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('.settings-nav__item')];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (at < 0 && !(document.activeElement as HTMLElement | null)?.closest('.settings-search')) return;
    e.preventDefault();
    items[at < 0 ? 0 : (at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  };

  const nav = (
    <nav className={`settings-nav access-nav${compact ? ' access-nav--phone' : ''}`} aria-label="Settings sections" onKeyDown={arrows}>
      {compact && <button type="button" className="settings-account" onClick={() => pick('account')}>
        <span className="account__initials">{(user?.name || user?.email || '?').split(/\s+/).map(word => word[0]).slice(0, 2).join('').toUpperCase()}</span>
        <span><strong>{user?.name || 'Your account'}</strong></span>
        <ChevronRight size={18} aria-hidden />
      </button>}
      <label className="settings-search">
        <Search size={18} strokeWidth={1.75} aria-hidden />
        <input
          id="app-settings-search" type="search" value={query} placeholder="Search settings" aria-label="Search settings" autoComplete="off" spellCheck={false} enterKeyHint="go"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && groups[0]) { e.preventDefault(); pick(groups[0].items[0].id); } }}
        />
      </label>
      {groups.map((g) => (
        <Section key={g.group} className="settings-nav__group" title={g.group} aria-label={g.group}>
          <Card variant="list" className="settings-nav__items">
            {g.items.map(it => <SettingsNavButton key={it.id} item={it} compact={compact} active={section === it.id && !(compact && listView)} onSelect={pick} />)}
          </Card>
        </Section>
      ))}
      {!groups.length && <div className="settings-nav__empty" role="status">No settings match “{q}”.</div>}
    </nav>
  );

  const showList = compact && listView;
  return <div className={`app-settings paper-settings access-settings${showList ? ' is-list' : ''}`} role="region" aria-label="Settings">
    {!compact && <aside className="app-settings__nav">{nav}</aside>}
    <div className="app-settings__main" ref={main}>
      <span ref={heading} tabIndex={-1} className="sr-only">{showList ? 'Settings' : sectionLabel}</span>
      {showList ? <Page type="form">{nav}</Page> : <Page type="form" title={compact ? undefined : section === 'subscriptions' ? 'Models & access' : sectionLabel} className="app-settings__page" key={aboutUse ? 'appearance/use' : section}>
        <Suspense fallback={<div className="settings-page-loading" role="status">Loading settings</div>}>
          {aboutUse ? <Requirements /> : section === 'appearance' ? <AppearanceSettings /> : <ConfigLayer />}
        </Suspense>
      </Page>}
    </div>
  </div>;
}
