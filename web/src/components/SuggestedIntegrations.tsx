import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, openPopup, type SuggestedToolkit } from '../lib/api';
import { verifyAccessAccount } from '../lib/accessApi';
import { useStore } from '../store';
import { ToolkitLogo } from './ToolkitLogo';
import { useAccessPanel } from './config/useAccessPanel';
import { cachedSuggestions, lastSuggestions, refreshSuggestions } from '../lib/appsCatalogCache';
import { useVersion } from '../configStore';
import { SUGGESTION_FILTER_VERSION } from '../../../server/src/suggestion-policy';
import { reconcileSuggestionDisplay } from '../lib/suggestionDisplay';
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
  const setupVersion = useVersion(`setup:${botId}`);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{ displayKey: string; apps: SuggestedToolkit[]; hasContext?: boolean; error?: string }>();
  const [loadingKey, setLoadingKey] = useState('');
  const key = JSON.stringify([SUGGESTION_FILTER_VERSION, userId, botId, description, instructions, connectionsVersion, setupVersion, retry]);
  // Passive connection/setup notifications can refetch without a user action.
  const displayKey = JSON.stringify([userId, botId, description, instructions, retry]);
  const previousRequest = useRef(displayKey);
  const section = useRef<HTMLElement>(null);
  const [reservedHeight, setReservedHeight] = useState(0);
  // Keep all refresh and sizing state here, below the page header. Reserve the
  // largest displayed block so a shorter response cannot trigger scroll anchoring.
  useLayoutEffect(() => {
    const element = section.current;
    if (!element) return;
    const reserve = () => setReservedHeight(height => Math.max(height, element.getBoundingClientRect().height));
    reserve();
    const observer = new ResizeObserver(reserve);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const windowKey = JSON.stringify([placement, botId]);
  const cacheKey = JSON.stringify([botId, description, instructions, connectionsVersion, setupVersion]);
  // Read during render so both panel mounts and reloads show the last Bot result
  // on their first frame, even after the draft or connection revision changes.
  const cached = useMemo(() => userId ? cachedSuggestions(userId, cacheKey) ?? lastSuggestions(userId, botId) : undefined, [userId, cacheKey, botId, retry]);
  useEffect(() => {
    const timer = setTimeout(() => setLoadingKey(key), 500);
    return () => clearTimeout(timer);
  }, [key]);
  useEffect(() => {
    if (!userId) return;
    const quiet = previousRequest.current === displayKey;
    previousRequest.current = displayKey;
    const controller = new AbortController();
    const isCurrent = () => !controller.signal.aborted && useStore.getState().user?.id === userId;
    if (cachedSuggestions(userId, cacheKey)) {
      // A completed, current result ends any abandoned loading window for this panel.
      // Details can fill the shared cache while General is unmounted. Give its fresh
      // refresh the full request budget instead of rejecting it before it even starts.
      loadingDeadlines.delete(windowKey);
    }
    const timeout = () => {
      if (isCurrent()) setResult(previous => ({ displayKey, apps: previous?.displayKey === displayKey ? previous.apps : cached?.suggestions ?? [], hasContext: cached?.hasContext, error: 'Suggestions unavailable. Please retry.' }));
      controller.abort();
    };
    const expires = loadingDeadline(windowKey);
    const remaining = expires - Date.now();
    if (remaining <= 0) { timeout(); return; }
    const deadline = setTimeout(timeout, remaining);
    const timer = setTimeout(() => {
      if (!isCurrent()) return;
      void refreshSuggestions(userId, cacheKey, botId, { description, instructions }).then(response => {
        if (isCurrent()) {
          // The cache still receives fresh reasons for a later visit. Only an
          // explicit action or a changed app set replaces wording on this page.
          setResult(previous => ({ displayKey, apps: reconcileSuggestionDisplay(previous?.displayKey === displayKey ? previous.apps : cached?.suggestions, response.suggestions, quiet), hasContext: response.hasContext }));
        }
      }).catch(error => {
        if (isCurrent()) setResult(previous => ({ displayKey, apps: previous?.displayKey === displayKey ? previous.apps : cached?.suggestions ?? [], hasContext: cached?.hasContext, error: (error instanceof ApiError && error.message.trim()) || 'Suggestions unavailable. Please retry.' }));
      }).finally(() => {
        clearTimeout(deadline);
        // Settling an abandoned request still completes its loading window, but
        // must not clear a newer retry's deadline.
        if (loadingDeadlines.get(windowKey) === expires) loadingDeadlines.delete(windowKey);
      });
    }, SUGGESTIONS_DEBOUNCE_MS);
    return () => { clearTimeout(timer); clearTimeout(deadline); controller.abort(); };
  }, [key, displayKey, cacheKey, windowKey, botId, description, instructions, userId, cached]);
  if (!userId) return null;
  const current = result?.displayKey === displayKey ? result : cached ? { apps: cached.suggestions, hasContext: cached.hasContext, error: undefined } : undefined;
  const refresh = () => { loadingDeadlines.delete(windowKey); setRetry(value => value + 1); };
  return <section ref={section} className="suggested-integrations bot-detail-section" style={reservedHeight ? { minBlockSize: reservedHeight } : undefined} aria-label="Suggested integrations" aria-busy={!current}>
    <h2>Suggested integrations</h2>
    {!current ? loadingKey === key && <p className="suggested-integrations__note" role="status">Finding relevant apps…</p>
      : <>
      {current.error && !current.apps.length && <p className="suggested-integrations__note" role="status">{current.error} <button type="button" className="link-btn" onClick={refresh}>Retry</button></p>}
      {current.apps.length ? <><ul className="suggested-integrations__list">{current.apps.map(app => <SuggestionCard key={JSON.stringify([userId, botId, app.slug])} app={app} refresh={refresh} />)}</ul>
        {current.error && <p className="suggested-integrations__note">Couldn't refresh. <button type="button" className="link-btn" onClick={refresh}>Retry</button></p>}</>
      : !current.error && <p className="suggested-integrations__note">{current.hasContext || description.trim() || instructions.trim()
        ? 'No matching additional apps for this Bot right now.'
        : "Describe this Bot's work in Bot settings > General to find relevant integrations."}</p>}
      </>}
  </section>;
}
