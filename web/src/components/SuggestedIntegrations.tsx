import { useEffect, useState } from 'react';
import { api, ApiError, openPopup, type SuggestedToolkit } from '../lib/api';
import { verifyAccessAccount } from '../lib/accessApi';
import { useStore } from '../store';
import { ToolkitLogo } from './ToolkitLogo';
import { useAccessPanel } from './config/useAccessPanel';
import { cachedSuggestions, refreshSuggestions } from '../lib/appsCatalogCache';
import '../styles/suggested-integrations.css';

export const SUGGESTIONS_DEBOUNCE_MS = 450;
export const SUGGESTIONS_TIMEOUT_MS = 4_500;

// Only deadlines, never account data. Keep each panel's unfinished loading window across
// draft/account changes and remounts. Only a completed request or Retry renews it.
const loadingDeadlines = new Map<string, number>();
function loadingDeadline(windowKey: string) {
  if (!loadingDeadlines.has(windowKey)) {
    loadingDeadlines.set(windowKey, Date.now() + SUGGESTIONS_DEBOUNCE_MS + SUGGESTIONS_TIMEOUT_MS);
    if (loadingDeadlines.size > 80) loadingDeadlines.delete(loadingDeadlines.keys().next().value!);
  }
  return loadingDeadlines.get(windowKey)!;
}

function SuggestionCard({ app, refresh }: { app: SuggestedToolkit; refresh: () => void }) {
  const userId = useStore(state => state.user?.id);
  const current = useAccessPanel(userId);
  const [status, setStatus] = useState<'idle' | 'opening' | 'waiting'>('idle');
  const [error, setError] = useState('');
  const connect = async () => {
    if (!userId || !current() || status !== 'idle') return;
    setStatus('opening'); setError('');
    const popup = openPopup('about:blank');
    try {
      await verifyAccessAccount(userId);
      if (!current()) { popup?.close(); return; }
      const { redirectUrl } = await api.connect(app.slug);
      if (!current()) { popup?.close(); return; }
      if (popup && !popup.closed) popup.location.href = redirectUrl;
      else if (!window.open(redirectUrl, '_blank', 'noopener')) throw new Error('Allow pop-ups, then try again.');
      setStatus('waiting');
    } catch {
      popup?.close();
      if (current()) { setError('Could not open the connection. Allow pop-ups and try again.'); setStatus('idle'); }
    }
  };
  return <li className="suggested-integration">
    <ToolkitLogo slug={app.slug} name={app.name} logo={app.logo} size={36} />
    <div className="suggested-integration__text"><strong>{app.name}</strong><p>{app.reason}</p>
      {status === 'waiting' && <p role="status">Finish in the provider window, then refresh.</p>}
      {error && <p className="cfg-error" role="alert">{error}</p>}
    </div>
    {app.noAuth ? <span className="suggested-integration__status">Built in</span> : status === 'waiting'
      ? <div className="suggested-integration__actions"><button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => { setStatus('idle'); refresh(); }}>Refresh status</button><button type="button" className="link-btn" onClick={() => setStatus('idle')}>Try again</button></div>
      : <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => void connect()} disabled={status === 'opening'} aria-label={`Connect ${app.name}`}>{status === 'opening' ? 'Opening…' : 'Connect'}</button>}
  </li>;
}

export function SuggestedIntegrations({ botId, description, instructions, placement = 'default' }: { botId: string; description: string; instructions: string; placement?: 'details' | 'settings' | 'default' }) {
  const userId = useStore(state => state.user?.id);
  const connectionsVersion = useStore(state => state.connectionsVersion);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{ key: string; apps: SuggestedToolkit[]; hasContext?: boolean; error?: string; refreshing?: boolean }>();
  const key = JSON.stringify([userId, botId, description, instructions, connectionsVersion, retry]);
  const windowKey = JSON.stringify([placement, botId]);
  const cacheKey = JSON.stringify([botId, description, instructions, connectionsVersion]);
  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    const isCurrent = () => !controller.signal.aborted && useStore.getState().user?.id === userId;
    const cached = cachedSuggestions(userId, cacheKey);
    if (cached) setResult({ key, apps: cached.suggestions, hasContext: cached.hasContext });
    const timeout = () => {
      if (isCurrent()) setResult({ key, apps: cached?.suggestions ?? [], hasContext: cached?.hasContext, error: 'Suggestions unavailable. Please retry.' });
      controller.abort();
    };
    const remaining = loadingDeadline(windowKey) - Date.now();
    if (remaining <= 0) { timeout(); return; }
    const deadline = setTimeout(timeout, remaining);
    const timer = setTimeout(() => {
      if (cached && isCurrent()) setResult({ key, apps: cached.suggestions, hasContext: cached.hasContext, refreshing: true });
      void refreshSuggestions(userId, cacheKey, botId, { description, instructions }).then(response => {
        if (isCurrent()) {
          loadingDeadlines.delete(windowKey);
          setResult({ key, apps: response.suggestions, hasContext: response.hasContext });
        }
      }).catch(error => {
        if (isCurrent()) setResult({ key, apps: cached?.suggestions ?? [], hasContext: cached?.hasContext, error: error instanceof ApiError ? error.message : 'Suggestions unavailable. Please retry.' });
      }).finally(() => clearTimeout(deadline));
    }, SUGGESTIONS_DEBOUNCE_MS);
    return () => { clearTimeout(timer); clearTimeout(deadline); controller.abort(); };
  }, [key, cacheKey, windowKey, botId, description, instructions, userId]);
  if (!userId) return null;
  const current = result?.key === key ? result : undefined;
  const refresh = () => { loadingDeadlines.delete(windowKey); setRetry(value => value + 1); };
  return <section className="suggested-integrations bot-detail-section" aria-label="Suggested integrations" aria-busy={!current}>
    <h2>Suggested integrations</h2>
    {!current ? <p className="suggested-integrations__note" role="status">Finding relevant apps…</p>
      : <>
      {current.error && <p className="suggested-integrations__note" role="status">{current.error} <button type="button" className="link-btn" onClick={refresh}>Retry</button></p>}
      {current.apps.length ? <><ul className="suggested-integrations__list">{current.apps.map(app => <SuggestionCard key={`${key}:${app.slug}`} app={app} refresh={refresh} />)}</ul>
        {(current.refreshing || current.error) && <p className="suggested-integrations__note">{current.refreshing ? 'Updating saved suggestions...' : 'Showing saved suggestions.'}</p>}</>
      : !current.error && <p className="suggested-integrations__note">{current.hasContext || description.trim() || instructions.trim()
        ? 'No matching additional apps for this Bot right now.'
        : "Describe this Bot's work in Bot settings > General to find relevant integrations."}</p>}
      </>}
  </section>;
}
