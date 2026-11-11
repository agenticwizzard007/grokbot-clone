import { useEffect, useState } from 'react';
import { openrouterApi, OPENROUTER_ERRORS, type OpenRouterStatus } from '../../lib/openrouterApi';
import { OpenRouterSignIn, OpenRouterMark } from '../OpenRouterSignIn';
import { ModelPicker, refreshModels } from './ModelPicker';
import { ConfirmButton } from './ui';
import '../../styles/openrouter.css';

export function OpenRouterSettings() {
  const [status, setStatus] = useState<OpenRouterStatus | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(() => OPENROUTER_ERRORS[new URLSearchParams(location.search).get('openrouter') ?? ''] ?? null);
  const [note, setNote] = useState<string | null>(() => new URLSearchParams(location.search).get('openrouter') === 'connected' ? 'OpenRouter connected to your Swarm account.' : null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    openrouterApi.status(controller.signal).then(setStatus).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    const url = new URL(location.href);
    if (url.searchParams.has('openrouter')) { url.searchParams.delete('openrouter'); history.replaceState(null, '', url); }
    return () => controller.abort();
  }, [attempt]);
  const run = async (action: () => Promise<OpenRouterStatus>, message: string) => {
    setBusy(true); setError(null); setNote(null);
    try { setStatus(await action()); refreshModels(); setNote(message); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <section className="cfg-section openrouter-settings" aria-labelledby="personal-openrouter-title">
    <h2 className="cfg-section__label" id="personal-openrouter-title">Your OpenRouter account</h2>
    <div className="cfg-card cfg-key">
      <div className="cfg-row">
        <OpenRouterMark />
        <div className="cfg-row__text">
          <div className="cfg-row__title">{!status ? 'Loading OpenRouter…' : status.active ? status.connected ? 'OpenRouter · Active' : 'OpenRouter · Reconnect to continue' : status.connected ? 'OpenRouter · Connected' : 'Bring your own models'}</div>
          <div className="cfg-row__sub">Use Claude, GPT, Gemini and more with your own OpenRouter credits. This connection belongs only to your Swarm account.</div>
          {status?.hint && <div className="cfg-row__sub">Key {status.hint} · {status.source === 'oauth' ? 'Connected through OpenRouter' : 'Added manually'}</div>}
        </div>
      </div>
      <div className="openrouter-settings__body">
        {status && !(status.connected && status.linked) && <OpenRouterSignIn link label={status.linked ? 'Reconnect OpenRouter' : status.connected ? 'Enable OpenRouter sign-in' : undefined} />}
        {status && <p className="cfg-field__hint">{status.linked ? 'OpenRouter sign-in is linked to this Swarm account.' : status.connected ? 'Your API key is connected. Enable OpenRouter sign-in to sign into Swarm with this account.' : 'Connect to authorize a key and enable OpenRouter sign-in for this account.'}</p>}
        <form className="openrouter-settings__key" onSubmit={e => {
          e.preventDefault();
          const value = key.trim();
          if (!value) return;
          setKey('');
          void run(() => openrouterApi.saveKey(value), 'Key verified and saved.');
        }}>
          <label htmlFor="personal-openrouter-key">{status?.connected ? 'Replace your API key' : 'Or paste your API key'}</label>
          <input id="personal-openrouter-key" type="password" className="text-input" value={key} onChange={e => setKey(e.target.value)} autoComplete="off" spellCheck={false} placeholder="sk-or-v1-…" disabled={busy} />
          <button type="submit" className="cfg-btn cfg-btn--primary" disabled={busy || !key.trim()}>{busy ? 'Saving…' : 'Save & verify key'}</button>
        </form>
        <p className="cfg-field__hint">Keys are encrypted on this server. Pasting a key does not change your sign-in method.</p>
        {status && <>
          {status.connected && <div className="openrouter-settings__model"><label>Your default model</label><ModelPicker provider="openrouter" label="Your OpenRouter default model" value={status.model} disabled={busy} onChange={model => { if (model) void run(() => openrouterApi.update({ model }), 'Default model saved for your Bots.'); }} /></div>}
          <div className="openrouter-settings__actions">
            {status.connected && !status.active && <button type="button" className="cfg-btn cfg-btn--primary" disabled={busy} onClick={() => void run(() => openrouterApi.update({ enabled: true }), 'Your Bots now use your OpenRouter credits.')}>Use OpenRouter</button>}
            {status.active && <button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={() => void run(() => openrouterApi.update({ enabled: false }), 'Your Bots now use the server’s API defaults.')}>Use server defaults</button>}
            {status.connected && <ConfirmButton className="cfg-btn cfg-btn--secondary" disabled={busy} confirmLabel="Remove my key" onConfirm={() => run(openrouterApi.disconnect, 'Key removed from Swarm. You can still sign in with OpenRouter. Revoke the key on OpenRouter to invalidate it there.')}>Disconnect key</ConfirmButton>}
          </div>
          {status.connected && !status.active && <p className="cfg-field__hint">Current provider: {status.provider}. Choose Use OpenRouter to switch model billing to your credits.</p>}
          {status.active && <p className="cfg-field__hint">Chat and background tasks use your key. If it fails, model requests stop. Platform voice has separate billing.</p>}
          <a href={status.settingsUrl} target="_blank" rel="noreferrer">Manage keys and spending limits on OpenRouter ↗</a>
        </>}
        {!status && error && <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => { setError(null); setAttempt(n => n + 1); }}>Retry</button>}
        {error && <div className="cfg-error" role="alert">{error}</div>}
        {note && <div className="cfg-key__ok" role="status">{note}</div>}
      </div>
    </div>
  </section>;
}
