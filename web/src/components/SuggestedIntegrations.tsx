import { useEffect, useRef, useState } from 'react';
import { api, openPopup, type SuggestedToolkit } from '../lib/api';
import { verifyAccessAccount } from '../lib/accessApi';
import { useStore } from '../store';
import { ToolkitLogo } from './ToolkitLogo';
import { useAccessPanel } from './config/useAccessPanel';
import '../styles/suggested-integrations.css';

export const SUGGESTIONS_DEBOUNCE_MS = 450;
export const SUGGESTIONS_TIMEOUT_MS = 12_000;

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

export function SuggestedIntegrations({ botId, description, instructions }: { botId: string; description: string; instructions: string }) {
  const userId = useStore(state => state.user?.id);
  const connectionsVersion = useStore(state => state.connectionsVersion);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{ key: string; apps: SuggestedToolkit[]; hasContext?: boolean; error?: string }>();
  const loadingWindow = useRef<{ contextKey: string; deadline: number }>();
  const contextKey = JSON.stringify([userId, botId, description, instructions, retry]);
  const key = JSON.stringify([userId, botId, description, instructions, connectionsVersion, retry]);
  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    const isCurrent = () => !controller.signal.aborted && useStore.getState().user?.id === userId;
    // Connection refreshes may invalidate a request, but cannot extend loading forever.
    if (loadingWindow.current?.contextKey !== contextKey) {
      loadingWindow.current = { contextKey, deadline: Date.now() + SUGGESTIONS_DEBOUNCE_MS + SUGGESTIONS_TIMEOUT_MS };
    }
    const timeout = () => {
      if (isCurrent()) setResult({ key, apps: [], error: 'Finding relevant apps took too long. Try again.' });
      controller.abort();
    };
    const remaining = loadingWindow.current.deadline - Date.now();
    if (remaining <= 0) { timeout(); return; }
    const deadline = setTimeout(timeout, remaining);
    const timer = setTimeout(() => {
      void api.suggestedApps(botId, { description, instructions }, controller.signal).then(response => {
        if (isCurrent()) {
          loadingWindow.current = undefined;
          setResult({ key, apps: response.suggestions, hasContext: response.hasContext });
        }
      }).catch(() => {
        if (isCurrent()) setResult({ key, apps: [], error: 'Suggestions are unavailable right now.' });
      }).finally(() => clearTimeout(deadline));
    }, SUGGESTIONS_DEBOUNCE_MS);
    return () => { clearTimeout(timer); clearTimeout(deadline); controller.abort(); };
  }, [key, contextKey, botId, description, instructions, userId]);
  if (!userId) return null;
  const current = result?.key === key ? result : undefined;
  const refresh = () => setRetry(value => value + 1);
  return <section className="suggested-integrations bot-detail-section" aria-label="Suggested integrations" aria-busy={!current}>
    <h2>Suggested integrations</h2>
    {!current ? <p className="suggested-integrations__note" role="status">Finding relevant apps…</p>
      : current.error ? <p className="suggested-integrations__note" role="status">{current.error} <button type="button" className="link-btn" onClick={refresh}>Retry</button></p>
      : current.apps.length ? <ul className="suggested-integrations__list">{current.apps.map(app => <SuggestionCard key={`${key}:${app.slug}`} app={app} refresh={refresh} />)}</ul>
      : <p className="suggested-integrations__note">{current.hasContext || description.trim() || instructions.trim()
        ? 'No matching additional apps for this Bot right now.'
        : "Describe this Bot's work in Bot settings > General to find relevant integrations."}</p>}
  </section>;
}
