import { Row, ButtonGroup } from '../layout';
import { ProviderMark } from '../ProviderMark';
import { SettingsMenu } from './SettingsControls';
import { useEffect, useRef, useState } from 'react';
import { useModels } from '../../lib/models';
import { openrouterApi, OPENROUTER_ERRORS, type OpenRouterStatus } from '../../lib/openrouterApi';
import { verifyAccessAccount } from '../../lib/accessApi';
import { useStore } from '../../store';
import { needsReauth } from '../../lib/api';
import { refreshModels } from './ModelPicker';
import { useAccessPanel } from './useAccessPanel';
import '../../styles/openrouter.css';

type Props = { compact?: boolean; onReauth: (error: Error) => void; onChanged?: () => void; refreshToken?: 'codex' | 'claude' | null; disabled?: boolean };

export function OpenRouterSettings(props: Props) {
  const accountId = useStore(s => s.user?.id);
  return accountId ? <AccountOpenRouterSettings key={accountId} accountId={accountId} {...props} /> : null;
}

function AccountOpenRouterSettings({ accountId, onReauth, onChanged, refreshToken, disabled = false, compact = false }: Props & { accountId: string }) {
  const provider = useModels(s => s.provider);
  const [status, setStatus] = useState<OpenRouterStatus | null>(null);
  const [callback] = useState(() => new URLSearchParams(location.search).get('openrouter'));
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
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
      if (callback === 'connected' && result.connected) setNote('Connected.');
    }).catch(e => { if (current() && !controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [accountId, attempt, callback, current, refreshToken, provider]);

  const run = async (action: () => Promise<OpenRouterStatus>, success: (result: OpenRouterStatus) => string) => {
    if (disabled || running.current || !current()) return;
    running.current = true;
    setBusy(true); setError(null); setNote(null);
    try {
      await verifyAccessAccount(accountId);
      if (!current()) return;
      const result = await action();
      if (useStore.getState().user?.id === accountId) refreshModels();
      if (!current()) return;
      setStatus(result); setNote(success(result)); onChanged?.();
    } catch (e) { if (current()) { if (needsReauth(e)) onReauth(e); else setError((e as Error).message); } }
    finally { running.current = false; if (current()) setBusy(false); }
  };
  const oauth = '/api/auth/openrouter/start?intent=link';
  const connect = () => {
    if (disabled || running.current || !current()) return;
    running.current = true; setBusy(true); setError(null);
    void verifyAccessAccount(accountId).then(() => { if (current()) window.location.assign(oauth); }).catch(e => { if (current()) { if (needsReauth(e)) onReauth(e); else setError(e.message); } }).finally(() => { running.current = false; if (current()) setBusy(false); });
  };
  const keyOptions = [
    { label: 'Use my credits', onSelect: () => void run(() => openrouterApi.update({ enabled: true }), () => 'API key selected.') },
    { label: 'Use server defaults', onSelect: () => void run(() => openrouterApi.update({ enabled: false }), () => 'Server defaults selected.') },
    { label: status?.linked ? 'Reconnect sign-in' : 'Enable sign-in', onSelect: connect },
    { label: 'OpenRouter account', onSelect: () => window.open(status?.settingsUrl || 'https://openrouter.ai/settings/keys', '_blank', 'noopener') },
  ];
  return <div className="openrouter-settings settings-stack">
    <Row leading={<ProviderMark provider="openrouter" />} title={<span className="settings-provider">OpenRouter<span className={`cfg-chip ${status?.connected ? 'is-connected' : ''}`} role="status">{status?.connected ? 'Key saved' : 'Not connected'}</span></span>}
      trailing={<>
        {!status?.connected && compact && <button type="button" className="link-btn" disabled={disabled || busy} aria-expanded={editing} onClick={() => setEditing(v => !v)}>Paste key</button>}
        {!status?.connected && compact ? <a className="cfg-btn cfg-btn--primary openrouter-settings__oauth" href={oauth} aria-disabled={disabled || busy} onClick={e => {
          e.preventDefault(); connect();
        }}>Connect</a> : compact ? <SettingsMenu label="Manage" ariaLabel="Manage OpenRouter" disabled={disabled || busy} items={[
          { label: 'Replace', onSelect: () => setEditing(true) },
          { label: 'Remove', danger: true, onSelect: () => setRemoving(true) },
          ...keyOptions,
        ]} /> : <button type="button" className="cfg-btn cfg-btn--secondary" disabled={disabled || busy} aria-expanded={editing} onClick={() => setEditing(v => !v)}>{status?.connected ? 'Replace' : 'Add key'}</button>}
      </>} />
    {editing && <form className="settings-inline-form" onSubmit={e => {
      e.preventDefault(); const value = key.trim(); if (!value || disabled || running.current) return;
      setKey(''); void run(() => openrouterApi.saveKey(value), () => { setEditing(false); return 'Key saved.'; });
    }}>
      <label htmlFor="personal-openrouter-key">OpenRouter API key</label>
      <input id="personal-openrouter-key" type="password" className="text-input" value={key} onChange={e => setKey(e.target.value)} autoComplete="off" spellCheck={false} disabled={disabled || busy} autoFocus />
      <ButtonGroup><button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => { setEditing(false); setKey(''); }}>Cancel</button><button type="submit" className="cfg-btn cfg-btn--primary" disabled={disabled || busy || !key.trim()}>Save</button></ButtonGroup>
      <SettingsMenu label="Key options" disabled={disabled || busy} items={keyOptions} />
      {status?.connected && <button type="button" className="link-btn" disabled={disabled || busy} onClick={() => setRemoving(true)}>Remove key</button>}
    </form>}
    {removing && <div className="settings-stack"><p>Remove this key? Active API turns will stop.</p><ButtonGroup>
      <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setRemoving(false)}>Cancel</button>
      <button type="button" className="cfg-btn cfg-btn--danger" disabled={disabled || busy} onClick={() => void run(openrouterApi.disconnect, () => { setRemoving(false); return 'Key removed.'; })}>Remove key</button>
    </ButtonGroup></div>}
    {error && <div className="cfg-error" role="alert">{error}{!status && <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => { setError(null); setAttempt(n => n + 1); }}>Retry</button>}</div>}
    {note && <div className="cfg-key__ok" role="status">{note}</div>}
  </div>;
}
