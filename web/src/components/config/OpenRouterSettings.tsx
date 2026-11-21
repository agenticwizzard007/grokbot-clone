import { useEffect, useRef, useState } from 'react';
import { openrouterApi, OPENROUTER_ERRORS, type OpenRouterStatus } from '../../lib/openrouterApi';
import { verifyAccessAccount } from '../../lib/accessApi';
import { useStore } from '../../store';
import { needsReauth } from '../../lib/api';
import { ModelPicker, refreshModels } from './ModelPicker';
import { AccessRow } from './AccessRow';
import { ConfirmButton } from './ui';
import { useAccessPanel } from './useAccessPanel';
import '../../styles/openrouter.css';

export function OpenRouterSettings({ onReauth }: { onReauth: (error: Error) => void }) {
  const accountId = useStore(s => s.user?.id);
  return accountId ? <AccountOpenRouterSettings key={accountId} accountId={accountId} onReauth={onReauth} /> : null;
}

function AccountOpenRouterSettings({ accountId, onReauth }: { accountId: string; onReauth: (error: Error) => void }) {
  const [status, setStatus] = useState<OpenRouterStatus | null>(null);
  const [callback] = useState(() => new URLSearchParams(location.search).get('openrouter'));
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(() => OPENROUTER_ERRORS[new URLSearchParams(location.search).get('openrouter') ?? ''] ?? null);
  const [note, setNote] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const running = useRef(false);
  const current = useAccessPanel(accountId);

  useEffect(() => {
    const controller = new AbortController();
    const url = new URL(location.href);
    if (url.searchParams.has('openrouter')) { url.searchParams.delete('openrouter'); history.replaceState(history.state, '', url); }
    void verifyAccessAccount(accountId, controller.signal).then(async () => {
      if (!current() || controller.signal.aborted) return;
      const result = await openrouterApi.status(controller.signal);
      if (!current() || controller.signal.aborted) return;
      setStatus(result);
      if (callback === 'connected' && result.connected) setNote('OpenRouter connected to your Swarm account.');
    }).catch(e => { if (current() && !controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [accountId, attempt, callback, current]);

  const run = async (action: () => Promise<OpenRouterStatus>, success: (result: OpenRouterStatus) => string) => {
    if (running.current || !current()) return;
    running.current = true;
    setBusy(true); setError(null); setNote(null);
    try {
      await verifyAccessAccount(accountId);
      if (!current()) return;
      const result = await action();
      if (useStore.getState().user?.id === accountId) refreshModels();
      if (!current()) return;
      setStatus(result); setNote(success(result));
    } catch (e) { if (current()) { if (needsReauth(e)) onReauth(e); else setError((e as Error).message); } }
    finally { running.current = false; if (current()) setBusy(false); }
  };
  const oauth = '/api/auth/openrouter/start?intent=link';
  const active = status?.active;
  return <section className="cfg-section openrouter-settings" aria-labelledby="personal-openrouter-title">
    <div className="app-settings__head">
      <h1 id="personal-openrouter-title">Your OpenRouter connection</h1>
      <p>Use your own credits or return to this server’s API defaults.</p>
    </div>
    {!status ? (error ? <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => { setError(null); setAttempt(n => n + 1); }}>Retry OpenRouter status</button> : <p role="status">Loading OpenRouter…</p>) : <>
      <AccessRow title="Personal key" description={status.hint ? `${status.source === 'oauth' ? 'Authorized key' : 'Manual key'} · ${status.hint}` : 'No personal key connected.'}
        status={active ? status.connected ? 'OpenRouter · Active' : 'OpenRouter · Reconnect to continue' : status.connected ? 'OpenRouter · Connected' : 'Not connected'} />
      <AccessRow title="OpenRouter sign-in" description={status.linked ? 'Linked to this Swarm account.' : 'A manual key does not enable sign-in.'}>
        {!(status.connected && status.linked) && <a className="cfg-btn cfg-btn--secondary openrouter-settings__oauth" href={oauth} aria-disabled={busy} onClick={e => {
          e.preventDefault();
          if (running.current || !current()) return;
          running.current = true; setBusy(true); setError(null);
          void verifyAccessAccount(accountId).then(() => { if (current()) window.location.assign(oauth); }).catch(e => { if (current()) setError(e.message); }).finally(() => { running.current = false; if (current()) setBusy(false); });
        }}>{status.linked ? 'Reconnect OpenRouter' : status.connected ? 'Enable OpenRouter sign-in' : 'Connect OpenRouter'}</a>}
      </AccessRow>
      <form className="openrouter-settings__key" onSubmit={e => {
        e.preventDefault();
        const value = key.trim();
        if (!value || running.current) return;
        setKey('');
        void run(() => openrouterApi.saveKey(value), () => 'Key verified and saved.');
      }}>
        <label htmlFor="personal-openrouter-key">{status.connected ? 'Replace your API key' : 'Or paste your API key'}</label>
        <input id="personal-openrouter-key" type="password" className="text-input" value={key} onChange={e => setKey(e.target.value)} autoComplete="off" spellCheck={false} disabled={busy} />
        <p className="cfg-field__hint">Your saved key is never shown. Pasting a key does not change your sign-in method.</p>
        <AccessRow title="Save and verify" description="Keep your previous key if verification fails.">
          <button type="submit" className="cfg-btn cfg-btn--secondary" disabled={busy || !key.trim()}>Save &amp; verify key</button>
        </AccessRow>
      </form>
      {status.connected && <AccessRow title="Your default model" description="Set the model used with your personal credits.">
        <ModelPicker provider="openrouter" label="Your OpenRouter default model" value={status.model} disabled={busy} onChange={model => { if (model) void run(() => openrouterApi.update({ model }), () => 'Default model saved for your Bots.'); }} />
      </AccessRow>}
      <AccessRow title="Server API defaults" description="Use server settings instead when personal credits are active.">
        <button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy || !status.selected} onClick={() => void run(() => openrouterApi.update({ enabled: false }), () => 'Personal OpenRouter billing is off.')}>Use server API defaults</button>
      </AccessRow>
      <AccessRow title="Credits and spending" description="Manage keys and budgets at OpenRouter.">
        <a className="cfg-btn cfg-btn--secondary" href={status.settingsUrl} target="_blank" rel="noreferrer">Open OpenRouter</a>
      </AccessRow>
      {status.connected && <AccessRow title="Remove personal key" description="Stop using this key in Swarm. Revoke it on OpenRouter to invalidate it there.">
        <ConfirmButton className="cfg-btn cfg-btn--secondary" disabled={busy} confirmLabel="Remove my key" onConfirm={() => run(openrouterApi.disconnect, () => 'Key removed from Swarm.')}>Disconnect key</ConfirmButton>
      </AccessRow>}
      {status.connected && !active && <button type="button" className="cfg-btn cfg-btn--primary openrouter-settings__use" disabled={busy} onClick={() => void run(() => openrouterApi.update({ enabled: true }), result => result.active ? 'Your Bots now use your OpenRouter credits.' : 'Your personal key is enabled but is not the active billing route.')}>Use my OpenRouter credits</button>}
      {active && <p className="cfg-field__hint">If your key is unavailable, model requests stop. Platform voice has separate billing.</p>}
    </>}
    {error && <div className="cfg-error" role="alert">{error}</div>}
    {note && <div className="cfg-key__ok" role="status">{note}</div>}
  </section>;
}
