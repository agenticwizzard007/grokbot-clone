import { ProviderLabel, ProviderText } from '../ProviderMark';
import { Blocks, Check, Gauge, KeyRound, LogIn, Server, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useModels } from '../../lib/models';
import { openrouterApi, OPENROUTER_ERRORS, type OpenRouterStatus } from '../../lib/openrouterApi';
import { verifyAccessAccount } from '../../lib/accessApi';
import { useStore } from '../../store';
import { needsReauth } from '../../lib/api';
import { ModelPicker, refreshModels } from './ModelPicker';
import { AccessRow } from './AccessRow';
import { SettingIcon } from './SettingRow';
import { ConfirmButton } from './ui';
import { useAccessPanel } from './useAccessPanel';
import '../../styles/openrouter.css';

type Props = { onReauth: (error: Error) => void; onChanged?: () => void; refreshToken?: 'codex' | 'claude' | null; disabled?: boolean };

export function OpenRouterSettings(props: Props) {
  const accountId = useStore(s => s.user?.id);
  return accountId ? <AccountOpenRouterSettings key={accountId} accountId={accountId} {...props} /> : null;
}

function AccountOpenRouterSettings({ accountId, onReauth, onChanged, refreshToken, disabled = false }: Props & { accountId: string }) {
  const provider = useModels(s => s.provider);
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
  const active = status?.active;
  const plan = status?.provider === 'codex-cli' ? 'ChatGPT' : status?.provider === 'claude-cli' ? 'Claude' : null;
  const route = plan
    ? `In use now: ${plan} plan. Bot turns are billed to that plan. Your personal OpenRouter key is not used for plan turns.`
    : active
      ? status?.connected
        ? 'In use now: your OpenRouter key. You pay OpenRouter for Bot turns.'
        : 'Personal OpenRouter billing is selected, but your key is missing. Add a key to continue. Bots will not use a shared server key.'
      : 'In use now: server API defaults. Usage is billed to the account that supplies those credentials.';
  return <section className="cfg-section openrouter-settings" aria-labelledby="personal-openrouter-title">
    <div className="app-settings__head">
      <h1 id="personal-openrouter-title"><ProviderLabel provider="openrouter">Your OpenRouter connection</ProviderLabel></h1>
      <p>Add your own OpenRouter key here. Your ChatGPT or Claude plan stays signed in when you add, replace or remove a key.</p>
    </div>
    {!status ? (error ? <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => { setError(null); setAttempt(n => n + 1); }}>Retry OpenRouter status</button> : <p role="status">Loading OpenRouter…</p>) : <>
      <AccessRow icon={KeyRound} title="Personal key" description={status.hint ? `${status.source === 'oauth' ? 'Authorized key' : 'Manual key'} · ${status.hint}` : 'No personal key saved. Add one to pay OpenRouter directly for API turns.'}
        status={<ProviderLabel provider={active || status.connected ? 'openrouter' : null}>{active ? status.connected ? 'OpenRouter · Active' : 'OpenRouter · Reconnect to continue' : status.connected ? 'OpenRouter · Connected' : 'Not connected'}</ProviderLabel>} />
      <p className="openrouter-settings__route" role="status"><ProviderText>{route}</ProviderText></p>
      <p className="cfg-field__hint">Choose Use API providers to use your saved OpenRouter key, even if personal credits are off. You pay OpenRouter for those turns. Connected plans stay signed in.</p>
      <AccessRow icon={LogIn} title={<ProviderLabel provider="openrouter">OpenRouter sign-in</ProviderLabel>} description={status.linked ? 'Linked to this Swarm account.' : 'A manual key does not enable sign-in.'}>
        {!(status.connected && status.linked) && <a className="cfg-btn cfg-btn--secondary openrouter-settings__oauth" href={oauth} aria-disabled={disabled || busy} onClick={e => {
          e.preventDefault();
          if (disabled || running.current || !current()) return;
          running.current = true; setBusy(true); setError(null);
          void verifyAccessAccount(accountId).then(() => { if (current()) window.location.assign(oauth); }).catch(e => { if (current()) setError(e.message); }).finally(() => { running.current = false; if (current()) setBusy(false); });
        }}>{status.linked ? 'Reconnect OpenRouter' : status.connected ? 'Enable OpenRouter sign-in' : 'Connect OpenRouter'}</a>}
      </AccessRow>
      <form className="openrouter-settings__key" onSubmit={e => {
        e.preventDefault();
        const value = key.trim();
        if (!value || disabled || running.current) return;
        setKey('');
        void run(() => openrouterApi.saveKey(value), () => 'Key verified and saved.');
      }}>
        <div className="openrouter-settings__key-fields">
          <SettingIcon icon={KeyRound} />
          <label htmlFor="personal-openrouter-key">{status.connected ? 'Replace your API key' : 'Or paste your API key'}</label>
          <input id="personal-openrouter-key" type="password" className="text-input" value={key} onChange={e => setKey(e.target.value)} autoComplete="off" spellCheck={false} disabled={disabled || busy} />
          <p className="cfg-field__hint">Your saved key is never shown again. Only its last four characters are shown. Pasting a key does not change your sign-in method or selected plan.</p>
        </div>
        <AccessRow icon={Check} title="Save and verify" description="Check the key with OpenRouter before saving. If verification fails, your previous key stays saved.">
          <button type="submit" className="cfg-btn cfg-btn--secondary" disabled={disabled || busy || !key.trim()}>Save &amp; verify key</button>
        </AccessRow>
      </form>
      {status.connected && <AccessRow icon={Blocks} title="Your default model" description="Set the model used with your personal credits.">
        <ModelPicker provider="openrouter" label="Your OpenRouter default model" value={status.model} disabled={disabled || busy} onChange={model => { if (model) void run(() => openrouterApi.update({ model }), () => 'Default model saved for your Bots.'); }} />
      </AccessRow>}
      <AccessRow icon={Server} title="Server API defaults" description="Explicitly use the credentials configured for this server. Their account pays for API turns. This leaves any selected plan in use.">
        <button type="button" className="cfg-btn cfg-btn--secondary" disabled={disabled || busy || !status.selected} onClick={() => void run(() => openrouterApi.update({ enabled: false }), () => 'Personal OpenRouter billing is off. Any selected plan stays in use.')}>Use server API defaults</button>
      </AccessRow>
      <AccessRow icon={Gauge} title="Credits and spending" description="Manage keys and budgets at OpenRouter.">
        <a className="cfg-btn cfg-btn--secondary" href={status.settingsUrl} target="_blank" rel="noreferrer">Open OpenRouter</a>
      </AccessRow>
      {status.connected && <AccessRow icon={ShieldCheck} title="Remove personal key" description="Remove this key from Swarm and keep any selected plan in use. If personal API billing is active, Bots stop until you add a key or choose another route. Revoke the key on OpenRouter to invalidate it there.">
        <ConfirmButton className="cfg-btn cfg-btn--secondary" disabled={disabled || busy} confirmLabel="Remove my key" onConfirm={() => run(openrouterApi.disconnect, () => 'Key removed from Swarm.')}>Disconnect key</ConfirmButton>
      </AccessRow>}
      {status.connected && !active && <button type="button" className="cfg-btn cfg-btn--primary openrouter-settings__use" disabled={disabled || busy} onClick={() => void run(() => openrouterApi.update({ enabled: true }), result => result.active ? 'Your Bots now use your OpenRouter key. You pay OpenRouter. Connected plans stay signed in.' : 'Your personal key is enabled but is not the active billing route.')}>Use my OpenRouter credits</button>}
      {active && <p className="cfg-field__hint">If your key is unavailable, model requests stop. Platform voice has separate billing.</p>}
    </>}
    {error && <div className="cfg-error" role="alert">{error}</div>}
    {note && <div className="cfg-key__ok" role="status">{note}</div>}
  </section>;
}
