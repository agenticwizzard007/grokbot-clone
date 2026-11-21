import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
    <div className="app-row" title={app.description}>
      <ToolkitLogo slug={app.slug} name={app.name} logo={app.logo} />
      <span className="app-row__text">
        <span className="app-row__name">{app.name}</span>
        {app.description && <span className="app-row__desc">{app.description}</span>}
        {app.connected && <span className="app-row__desc">Connected</span>}
        {state === 'waiting' && <span className="app-row__desc" role="status">Finish authorizing in the provider window, then refresh.</span>}
        {error && <span className="app-row__error" role="alert">{error}</span>}
      </span>
      {app.connected ? (
        <div className="access-app-row__actions">
          <button type="button" className={`app-row__connected${state === 'confirm' ? ' is-confirm' : ''}`} onClick={disconnect} disabled={state === 'busy'}>{state === 'confirm' ? 'Confirm disconnect' : state === 'busy' ? 'Disconnecting…' : `Disconnect ${app.name}`}</button>
          {state === 'confirm' && <button type="button" className="app-row__connect" onClick={() => setState('idle')}>Cancel</button>}
        </div>
      ) : app.noAuth ? (
        <span className="app-row__connected is-static"><Icon name="check" size={12} opacity={0.56} />Built in</span>
      ) : (
        <div className="access-app-row__actions">
          <button type="button" className="app-row__connect" onClick={connect} disabled={state === 'busy'}>{state === 'busy' ? 'Opening…' : state === 'waiting' ? 'Try again' : `Connect ${app.name}`}</button>
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
  const [connectedApps, setConnectedApps] = useState<Toolkit[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const queryVersion = useRef(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [bump, setBump] = useState(0);
  const refresh = useCallback(() => setBump((n) => n + 1), []);

  useEffect(() => { const t = setTimeout(() => setDebounced(search.trim()), 200); return () => clearTimeout(t); }, [search]);
  useEffect(() => { bodyRef.current?.scrollTo({ top: 0 }); }, [debounced, view]);

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

  // Connected list (for the header chip and the Connected view): resolve the connected slugs to full entries.
  useEffect(() => {
    if (!data) return;
    if (data.connectedApps) { setConnectedApps(data.connectedApps); return; }
    const missing = data.connected.filter((s) => !data.apps.some((a) => a.slug === s));
    if (!missing.length) { setConnectedApps(data.apps.filter((a) => a.connected)); return; }
    let alive = true;
    Promise.all(data.connected.map((s) => api.apps(s).then((r) => r.apps.find((a) => a.slug === s)).catch(() => undefined)))
      .then((list) => { if (alive) setConnectedApps(list.filter((a): a is Toolkit => !!a)); });
    return () => { alive = false; };
  }, [data]);

  const apps = data?.apps ?? [];
  const searching = debounced.length > 0;
  const moreCategories = useMemo(() => [...new Set([...APP_CATEGORIES.map((group) => group.id), ...(data?.categories ?? [])])]
    .filter((c) => !PILLS.some((p) => p.category === c)), [data?.categories]);
  const popularGroups = APP_CATEGORIES.map((group) => ({ ...group, apps: apps.filter((app) => group.slugs.includes(app.slug)) }))
    .filter((group) => group.apps.length > 0);
  const popularCount = popularGroups.reduce((count, group) => count + group.apps.length, 0);
  const activeCategory = view.kind === 'category' ? view.category : null;
  const requestLoading = loading || search.trim() !== debounced;

  let body: React.ReactNode;
  if (requestLoading) body = <div className="apps-empty" role="status">Loading apps…</div>;
  else if (error) body = <div className="apps-empty" role="alert">Couldn’t load apps. {error} <button type="button" className="cfg-btn cfg-btn--secondary" onClick={refresh}>Retry catalog</button></div>;
  else if (data?.notConfigured) body = <div className="apps-empty">The server owner needs to add a Composio project key in <button type="button" className="link-btn" onClick={() => { close(); useConfigUI.getState().openAppSettings('keys'); }}>Settings → API keys</button>. This enables connected apps for everyone. Then connect your own accounts here.</div>;
  else if (view.kind === 'connected') body = connectedApps.length ? <Section title="Connected" apps={connectedApps} onChanged={refresh} /> : <div className="apps-empty">No apps connected yet.</div>;
  else if (searching || view.kind === 'category' || view.kind === 'all') {
    body = apps.length ? (
      <Section title={searching ? `Results${activeCategory ? ` in ${pillLabel(activeCategory)}` : ''}` : activeCategory ? pillLabel(activeCategory) : 'All apps'} apps={apps} onChanged={refresh} />
    ) : <div className="apps-empty">{debounced ? `No apps match “${debounced}”.` : 'No apps available in this view.'}</div>;
  } else if (view.kind === 'categories') {
    body = <div className="access-apps__categories">{[...PILLS.map(pill => pill.category), ...moreCategories].map(category => <button type="button" key={category} className="cfg-btn cfg-btn--secondary" onClick={() => setView({ kind: 'category', category })}>{pillLabel(category)}</button>)}</div>;
  } else {
    body = (
      <>
        {popularCount > 0 && (
          <section className="apps-popular" aria-labelledby="popular-apps-title">
            <div className="apps-popular__head">
              <h2 id="popular-apps-title" className="apps-popular__title">Popular apps <span className="apps-popular__count">{popularCount}</span></h2>
              <p className="apps-popular__description">Everyday essentials, grouped by what you do.</p>
            </div>
            {popularGroups.map((group) => (
              <Section key={group.id} title={group.label} apps={group.apps} onViewAll={() => setView({ kind: 'category', category: group.id })} onChanged={refresh} />
            ))}
          </section>
        )}
        {!popularCount && <div className="apps-empty">No popular apps available. Select View all to browse the catalog.</div>}
      </>
    );
  }

  const connectedCount = data?.connected.length ?? 0;

  return (
    <div className={`access-apps-catalog${inline ? ' access-apps-catalog--inline' : ''}`}>
      <div className="apps-modal__head">
        <div className="app-settings__head access-apps__title">
          <h1>Connect an app</h1>
          <p>Connect the tools you already use.</p>
          {inline && <button type="button" className="link-btn" onClick={close}>Back to connected accounts</button>}
        </div>
        <div className="apps-modal__controls">
          <div className="apps-modal__searchrow">
            <label className="cfg-field">
              <span className="cfg-field__label">Search apps</span>
              <input className="text-input" value={search} onChange={(e) => { setSearch(e.target.value); if (e.target.value.trim() && (view.kind === 'connected' || view.kind === 'categories' || view.kind === 'popular')) setView({ kind: 'all' }); }} placeholder="Search apps and skills" />
            </label>
          </div>
          <div className="cat-pills">
            {([{ kind: 'popular', label: 'Popular' }, { kind: 'categories', label: 'Browse categories' }, { kind: 'all', label: 'View all' }, { kind: 'connected', label: data ? `${connectedCount} connected` : 'Connected' }] as const).map(option => {
              const selected = view.kind === option.kind || (option.kind === 'categories' && view.kind === 'category');
              return <button key={option.kind} type="button" aria-pressed={selected} className={`cat-pill${selected ? ' is-active' : ''}`} onClick={() => { if (option.kind !== 'all') setSearch(''); setView({ kind: option.kind }); }}>{option.label}</button>;
            })}
          </div>
        </div>
      </div>
      <div ref={bodyRef} className="apps-modal__body">
        {body}
        {!requestLoading && !error && !data?.notConfigured && (view.kind === 'all' || view.kind === 'category') && data && (
          <div className="apps-pagination">
            <span>{apps.length} of {data.total} apps</span>
            {data.nextOffset != null && <button type="button" className="cfg-btn cfg-btn--secondary" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? 'Loading…' : 'Load more'}</button>}
            {pageError && <span role="alert">{pageError}</span>}
          </div>
        )}
        <div className="apps-pagination access-apps__mcp"><span><strong>Using your own MCP server?</strong><small>Manage custom tools separately.</small></span><button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => { close(); useConfigUI.getState().openAppSettings('mcp'); }}>Custom MCP</button></div>
      </div>
    </div>
  );
}
