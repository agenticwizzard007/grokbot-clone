import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import type { Toolkit } from '@shared/types';
import { APP_CATEGORIES } from '@shared/app-catalog';
import { api, openPopup, type AppsResponse } from '../../lib/api';
import { verifyAccessAccount } from '../../lib/accessApi';
import { useStore } from '../../store';
import { Icon } from '../Icon';
import { useAccessPanel } from '../config/useAccessPanel';
import { ToolkitLogo } from '../ToolkitLogo';
import { Modal } from './Modal';
import { useConfigUI } from '../../configStore';
import '../../styles/access-apps.css';
import './connect-apps.css';

const PILLS = APP_CATEGORIES.filter((group) => ['communication', 'productivity', 'project management', 'developer tools', 'images & design'].includes(group.id))
  .map((group) => ({ label: group.shortLabel, category: group.id }));
const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bAi\b/g, 'AI').replace(/\bCrm\b/g, 'CRM').replace(/\bSeo\b/g, 'SEO').replace(/\bIt\b/g, 'IT').replace(/\bHr\b/g, 'HR').replace(/\bSms\b/g, 'SMS').replace(/\bUrl\b/g, 'URL').replace(/\bOcr\b/g, 'OCR');
const pillLabel = (cat: string) => APP_CATEGORIES.find((group) => group.id === cat)?.label ?? titleCase(cat);

type View = { kind: 'all' | 'popular' | 'categories' | 'connected' } | { kind: 'category'; category: string };

function AppRow({ app, onChanged }: { app: Toolkit; onChanged: () => void }) {
  const accountId = useStore(s => s.user?.id);
  const current = useAccessPanel(accountId);
  const [state, setState] = useState<'idle' | 'busy' | 'waiting' | 'confirm'>('idle');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setState('idle'); }, [app.connected]);

  const connect = async () => {
    if (!accountId || state === 'busy' || !current()) return;
    setState('busy'); setError(null);
    const popup = openPopup('about:blank');
    try {
      await verifyAccessAccount(accountId);
      if (!current()) { popup?.close(); return; }
      const { redirectUrl } = await api.connect(app.slug);
      if (!current()) { popup?.close(); return; }
      if (popup) popup.location.href = redirectUrl; else window.open(redirectUrl, '_blank');
      setState('waiting');
    } catch (e) {
      popup?.close();
      if (current()) { setError((e as Error).message || 'Couldn’t start the connection'); setState('idle'); }
    }
  };
  const disconnect = async () => {
    if (!accountId || state === 'busy' || !current()) return;
    if (state !== 'confirm') { setState('confirm'); return; }
    setState('busy');
    try {
      await verifyAccessAccount(accountId);
      if (!current()) return;
      await api.disconnect(app.slug);
      if (current()) onChanged();
    } catch (e) { if (current()) { setError((e as Error).message); setState('idle'); } }
  };

  return (
    <div className={`app-row${state === 'waiting' || state === 'confirm' ? ' app-row--expanded' : ''}`}>
      <ToolkitLogo slug={app.slug} name={app.name} logo={app.logo} />
      <span className="app-row__text">
        <span className="app-row__name">{app.name}</span>
        {app.description && <span className="app-row__desc">{app.description}</span>}
        {app.connected && <span className="app-row__status">Connected</span>}
        {state === 'waiting' && <span className="app-row__desc" role="status">Finish authorizing in the provider window, then refresh.</span>}
        {error && <span className="app-row__error" role="alert">{error}</span>}
      </span>
      {app.connected ? (
        <div className="access-app-row__actions">
          <button type="button" className={`app-row__connected${state === 'confirm' ? ' is-confirm' : ''}`} onClick={disconnect} disabled={state === 'busy'} aria-label={state === 'idle' ? `Disconnect ${app.name}` : undefined}>{state === 'confirm' ? 'Confirm disconnect' : state === 'busy' ? 'Disconnecting…' : 'Disconnect'}</button>
          {state === 'confirm' && <button type="button" className="app-row__connect" onClick={() => setState('idle')}>Cancel</button>}
        </div>
      ) : app.noAuth ? (
        <span className="app-row__connected is-static"><Icon name="check" size={12} opacity={0.56} />Built in</span>
      ) : (
        <div className="access-app-row__actions">
          <button type="button" className="app-row__connect" onClick={connect} disabled={state === 'busy'} aria-label={state === 'idle' ? `Connect ${app.name}` : undefined}>{state === 'busy' ? 'Opening…' : state === 'waiting' ? 'Try again' : 'Connect'}</button>
          {state === 'waiting' && <button type="button" className="app-row__connect" onClick={onChanged}>Refresh status</button>}
        </div>
      )}
    </div>
  );
}

function Grid({ apps, onChanged }: { apps: Toolkit[]; onChanged: () => void }) {
  return (
    <div className="app-grid">
      {apps.map((a) => <AppRow key={a.slug} app={a} onChanged={onChanged} />)}
    </div>
  );
}

function Section({ title, apps, onViewAll, onChanged }: { title: string; apps: Toolkit[]; onViewAll?: () => void; onChanged: () => void }) {
  if (!apps.length) return null;
  return (
    <section className="apps-section">
      <div className="apps-section__head">
        <h3 className="apps-section__title">{title}</h3>
        {onViewAll && <button type="button" className="link-btn link-btn--small" onClick={onViewAll}>View all</button>}
      </div>
      <Grid apps={apps} onChanged={onChanged} />
    </section>
  );
}

export function ConnectAppsModal() {
  const setModal = useStore((s) => s.setModal);
  const close = useCallback(() => setModal(null), [setModal]);
  return <Modal onClose={close} className="apps-modal access-apps-dialog" label="Connect Apps">
    <button type="button" className="modal__close apps-modal__close" onClick={close} aria-label="Close"><Icon name="close" size={16} opacity={0.68} /></button>
    <ConnectAppsCatalog onClose={close} />
  </Modal>;
}

export function ConnectAppsCatalog({ onClose, inline = false }: { onClose: () => void; inline?: boolean }) {
  const accountId = useStore(s => s.user?.id);
  return accountId ? <AccountAppsCatalog key={accountId} accountId={accountId} close={onClose} inline={inline} /> : null;
}

function AccountAppsCatalog({ accountId, close, inline }: { accountId: string; close: () => void; inline: boolean }) {
  const connectionsVersion = useStore((s) => s.connectionsVersion);
  const current = useAccessPanel(accountId);
  const [view, setView] = useState<View>({ kind: 'popular' });
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [data, setData] = useState<AppsResponse | null>(null);
  const [legacyConnectedApps, setLegacyConnectedApps] = useState<Toolkit[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const queryVersion = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const popularTitleId = useId();
  const [error, setError] = useState<string | null>(null);
  const [bump, setBump] = useState(0);
  const refresh = useCallback(() => setBump((n) => n + 1), []);

  useEffect(() => { const t = setTimeout(() => setDebounced(search.trim()), 200); return () => clearTimeout(t); }, [search]);
  useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }); }, [debounced, view]);

  useEffect(() => {
    let alive = true;
    queryVersion.current++;
    setLoading(true); setError(null); setLoadingMore(false); setPageError(null);
    const category = view.kind === 'category' ? view.category : '';
    void verifyAccessAccount(accountId).then(async () => {
      if (!alive || !current()) return;
      const result = await api.apps(debounced, category);
      if (alive && current()) setData(result);
    }).catch((e) => { if (alive && current()) setError(e.message); })
      .finally(() => { if (alive && current()) setLoading(false); });
    return () => { alive = false; queryVersion.current++; };
  }, [accountId, current, debounced, view, connectionsVersion, bump]);

  const loadMore = async () => {
    if (loading || loadingMore || data?.nextOffset == null || search.trim() !== debounced || !current()) return;
    const version = queryVersion.current;
    const previous = data;
    setLoadingMore(true); setPageError(null);
    try {
      await verifyAccessAccount(accountId);
      if (queryVersion.current !== version || !current()) return;
      const next = await api.apps(debounced, view.kind === 'category' ? view.category : '', previous.nextOffset!);
      if (queryVersion.current === version && current()) setData({ ...next, apps: [...new Map([...previous.apps, ...next.apps].map(app => [app.slug, app])).values()] });
    } catch (e) {
      if (queryVersion.current === version && current()) setPageError((e as Error).message);
    } finally {
      if (queryVersion.current === version && current()) setLoadingMore(false);
    }
  };

  useEffect(() => {
    if (!data || data.connectedApps) return;
    const missing = [...new Set(data.connected)].filter(slug => !data.apps.some(app => app.slug === slug));
    if (!missing.length) return;
    let alive = true;
    void verifyAccessAccount(accountId).then(async () => {
      if (!alive || !current()) return;
      const list = await Promise.all(missing.map(slug => api.apps(slug).then(result => result.apps.find(app => app.slug === slug)).catch(() => undefined)));
      if (alive && current()) setLegacyConnectedApps(list.filter((app): app is Toolkit => !!app));
    }).catch(() => {});
    return () => { alive = false; };
  }, [accountId, current, data]);

  const apps = data?.apps ?? [];
  const searching = debounced.length > 0;
  const moreCategories = useMemo(() => [...new Set([...APP_CATEGORIES.map((group) => group.id), ...(data?.categories ?? [])])]
    .filter((c) => !PILLS.some((p) => p.category === c)), [data?.categories]);
  const popularGroups = APP_CATEGORIES.map((group) => ({ ...group, apps: apps.filter((app) => group.slugs.includes(app.slug)) }))
    .filter((group) => group.apps.length > 0);
  const popularCount = popularGroups.reduce((count, group) => count + group.apps.length, 0);
  const activeCategory = view.kind === 'category' ? view.category : null;
  const requestLoading = loading || search.trim() !== debounced;
  const connectedSlugs = [...new Set(data?.connected)];
  const appDetails = new Map([...(data?.connectedApps ?? legacyConnectedApps), ...apps].map(app => [app.slug, app]));
  const connectedApps = connectedSlugs.flatMap(slug => {
    const app = appDetails.get(slug);
    return app ? [{ ...app, connected: true }] : [];
  });
  const selectView = (next: View) => {
    if (next.kind !== 'all' && next.kind !== 'category') setSearch('');
    setView(next);
  };

  let body: React.ReactNode;
  if (requestLoading) body = <div className="apps-empty" role="status">Loading apps…</div>;
  else if (error) body = <div className="apps-empty" role="alert">Couldn’t load apps. {error} <button type="button" className="cfg-btn cfg-btn--secondary" onClick={refresh}>Retry catalog</button></div>;
  else if (data?.notConfigured) body = <div className="apps-empty">The server owner needs to add a Composio project key in <button type="button" className="link-btn" onClick={() => { close(); useConfigUI.getState().openAppSettings('keys'); }}>Settings → API keys</button>. This enables connected apps for everyone. Then connect your own accounts here.</div>;
  else if (view.kind === 'connected') body = connectedSlugs.length ? (
    <>
      <Section title="Connected" apps={connectedApps} onChanged={refresh} />
      {connectedApps.length < connectedSlugs.length && <div className="apps-empty" role="status">Some connected app details are unavailable. <button type="button" className="cfg-btn cfg-btn--secondary" onClick={refresh}>Retry catalog</button></div>}
    </>
  ) : <div className="apps-empty">No apps connected yet.</div>;
  else if (searching || view.kind === 'category' || view.kind === 'all') {
    body = apps.length ? (
      <Section title={searching ? `Results${activeCategory ? ` in ${pillLabel(activeCategory)}` : ''}` : activeCategory ? pillLabel(activeCategory) : 'All apps'} apps={apps} onChanged={refresh} />
    ) : <div className="apps-empty">{debounced ? `No apps match “${debounced}”.` : 'No apps available in this view.'}</div>;
  } else if (view.kind === 'categories') {
    body = <section className="apps-section"><h2 className="apps-section__title">Categories</h2><div className="access-apps__categories">{[...PILLS.map(pill => pill.category), ...moreCategories].map(category => <button type="button" key={category} className="cfg-btn cfg-btn--secondary" onClick={() => selectView({ kind: 'category', category })}>{pillLabel(category)}</button>)}</div></section>;
  } else {
    body = (
      <>
        {popularCount > 0 && (
          <section className="apps-popular" aria-labelledby={popularTitleId}>
            <div className="apps-popular__head">
              <h2 id={popularTitleId} className="apps-popular__title">Popular apps <span className="apps-popular__count">{popularCount}</span></h2>
              <p className="apps-popular__description">Everyday essentials, grouped by what you do.</p>
            </div>
            {popularGroups.map((group) => (
              <Section key={group.id} title={group.label} apps={group.apps} onViewAll={() => setView({ kind: 'category', category: group.id })} onChanged={refresh} />
            ))}
          </section>
        )}
        {!popularCount && <div className="apps-empty">No popular apps available. Select All to browse the catalog.</div>}
      </>
    );
  }

  return (
    <div ref={inline ? undefined : scrollRef} className={`access-apps-catalog${inline ? ' access-apps-catalog--inline' : ''}`}>
      <div className="apps-modal__head">
        {inline && <button type="button" className="link-btn access-apps__back" onClick={close}>Back to connected accounts</button>}
        <div className="access-apps__heading">
          <div className="app-settings__head access-apps__title">
            <h1>Connect an app</h1>
            <p>Connect the tools you already use.</p>
          </div>
          <button type="button" aria-pressed={view.kind === 'connected'} className="access-apps__connected" onClick={() => selectView({ kind: 'connected' })}>
            {!!connectedApps.length && <span className="access-apps__connected-logos" aria-hidden="true">{connectedApps.slice(0, 4).map(app => <ToolkitLogo key={app.slug} slug={app.slug} name={app.name} logo={app.logo} size={22} />)}</span>}
            <span>{data && !data.notConfigured ? `${connectedSlugs.length} connected` : 'Connected'}</span>
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="apps-modal__controls">
          <label className="pill-input access-apps__search">
            <Search size={17} aria-hidden="true" />
            <input type="search" aria-label="Search apps" value={search} onChange={(e) => { setSearch(e.target.value); if (e.target.value.trim() && (view.kind === 'connected' || view.kind === 'categories' || view.kind === 'popular')) setView({ kind: 'all' }); }} placeholder="Search apps" />
          </label>
          <div className="cat-pills" role="group" aria-label="App catalog filters">
            <button type="button" className="cat-pill" aria-pressed={view.kind === 'all'} onClick={() => selectView({ kind: 'all' })}>All</button>
            <button type="button" className="cat-pill" aria-pressed={view.kind === 'popular'} onClick={() => selectView({ kind: 'popular' })}>Popular</button>
            {PILLS.map(pill => <button key={pill.category} type="button" className="cat-pill" aria-pressed={activeCategory === pill.category} onClick={() => selectView({ kind: 'category', category: pill.category })}>{pill.label}</button>)}
            {activeCategory && moreCategories.includes(activeCategory) && <button type="button" className="cat-pill" aria-pressed="true" onClick={() => selectView({ kind: 'category', category: activeCategory })}>{pillLabel(activeCategory)}</button>}
            <button type="button" className="cat-pill" aria-label="Browse categories" aria-pressed={view.kind === 'categories'} onClick={() => selectView({ kind: 'categories' })}>Categories <ChevronDown size={14} aria-hidden="true" /></button>
          </div>
        </div>
      </div>
      <div className="apps-modal__body">
        {body}
        {!requestLoading && !error && !data?.notConfigured && (view.kind === 'all' || view.kind === 'category') && data && (
          <div className="apps-pagination">
            <span>{apps.length} of {data.total} apps</span>
            {data.nextOffset != null && <button type="button" className="cfg-btn cfg-btn--secondary" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? 'Loading…' : 'Load more'}</button>}
            {pageError && <span role="alert">{pageError}</span>}
          </div>
        )}
        <div className="apps-pagination access-apps__mcp"><span><strong>Using your own MCP server?</strong><small>Manage custom tools separately.</small></span><button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => { close(); useConfigUI.getState().openAppSettings('mcp'); }}>MCP servers</button></div>
      </div>
    </div>
  );
}
