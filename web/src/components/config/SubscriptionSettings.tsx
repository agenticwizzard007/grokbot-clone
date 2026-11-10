import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Copy, ExternalLink, KeyRound, RefreshCw, Sparkles, Terminal } from 'lucide-react';
import { cliApi, type CliProvider, type CliProviderStatus, type CliStatus } from '../../lib/cliApi';
import { refreshModels } from './ModelPicker';
import { CliLoginTerminal } from './CliLoginTerminal';
import '../../styles/subscriptions.css';

const PROVIDERS: { id: CliProvider; name: string; plan: string; install: string; login: string; docs: string }[] = [
  {
    id: 'codex', name: 'ChatGPT via Codex', plan: 'Eligible ChatGPT plan',
    install: 'npm install -g @openai/codex', login: 'codex login',
    docs: 'https://developers.openai.com/codex/auth/',
  },
  {
    id: 'claude', name: 'Claude via Claude Code', plan: 'Pro/Max eligible plan',
    install: 'npm install -g @anthropic-ai/claude-code', login: 'claude auth login',
    docs: 'https://code.claude.com/docs/en/authentication',
  },
];

const ready = (provider: CliProviderStatus) => provider.installed && provider.authenticated && provider.subscription && !provider.error;
const providerName = (id: CliProvider) => PROVIDERS.find((provider) => provider.id === id)!.name;

function providerState(provider: CliProviderStatus | undefined, connected: boolean) {
  if (!provider) return 'Not checked';
  if (!connected) return 'Bridge offline · status unverified';
  if (provider.error) return 'Needs attention';
  if (!provider.installed) return 'CLI not installed';
  if (!provider.authenticated) return 'Login required';
  if (!provider.subscription) return 'Eligible subscription required';
  return 'Ready';
}

type Action = 'load' | 'pair' | 'refresh' | 'codex' | 'claude' | 'api' | 'revoke';

export function SubscriptionSettings() {
  const [providerTab, setProviderTab] = useState<CliProvider>('claude');
  const [authMethod, setAuthMethod] = useState<'cli' | 'api'>('cli');
  const [loginProvider, setLoginProvider] = useState<CliProvider | null>(null);
  const [loginAttempt, setLoginAttempt] = useState(0);
  const [loginRunning, setLoginRunning] = useState(false);
  const loginActive = useRef(false);
  const tabPicked = useRef(false);
  const [status, setStatus] = useState<CliStatus | null>(null);
  const [busy, setBusy] = useState<Action | null>('load');
  const [error, setError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  // The pairing command contains a secret. Keep it only in this mounted view's memory.
  const [command, setCommand] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const working = useRef(false);
  const mounted = useRef(false);
  const polling = useRef<AbortController | null>(null);

  useEffect(() => {
    if (status) refreshModels();
    if (status?.selected && !tabPicked.current) setProviderTab(status.selected);
  }, [status?.selected]);

  useEffect(() => {
    mounted.current = true;
    let initial = true;
    const load = () => {
      if (document.visibilityState !== 'visible' || working.current || loginActive.current || polling.current) return;
      const controller = new AbortController();
      polling.current = controller;
      cliApi.status(controller.signal).then((result) => {
        if (!controller.signal.aborted) update(result);
      }).catch((err: unknown) => {
        if (!controller.signal.aborted) {
          setReadError(err instanceof Error ? err.message : 'Could not load subscription status.');
          setStale(true);
        }
      }).finally(() => {
        if (polling.current === controller) polling.current = null;
        if (!controller.signal.aborted && initial) { initial = false; setBusy(null); }
      });
    };
    const visibility = () => {
      if (document.visibilityState === 'visible') load();
      else { polling.current?.abort(); polling.current = null; }
    };
    load();
    const interval = setInterval(load, 5000);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      mounted.current = false;
      polling.current?.abort(); polling.current = null;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timeout = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timeout);
  }, [copied]);

  const run = async (action: Action, task: () => Promise<void>) => {
    if (working.current || loginActive.current) return;
    working.current = true;
    polling.current?.abort(); polling.current = null;
    setBusy(action);
    setError(null);
    setConfirmRevoke(false);
    try { await task(); }
    catch (err) {
      if (mounted.current) {
        setError(err instanceof Error ? err.message : 'Subscription request failed. Try again.');
        setStale(true);
      }
    } finally {
      working.current = false;
      if (mounted.current) setBusy(null);
    }
  };

  const update = (result: CliStatus) => {
    if (!mounted.current) return;
    setStatus(result);
    setStale(false);
    setReadError(null);
  };
  const refresh = () => run('refresh', async () => { update(await cliApi.refresh()); });
  const select = (provider: CliProvider | null) => run(provider ?? 'api', async () => {
    await cliApi.select(provider);
    refreshModels();
    // Selection responses need no body. Reflect the saved mode even if the subsequent GET fails.
    if (mounted.current) {
      setAuthMethod(provider ? 'cli' : 'api');
      setStatus((current) => current ? { ...current, selected: provider } : current);
    }
    update(await cliApi.status());
  });
  const generate = () => run('pair', async () => {
    setCommand(null); setCopied(false); setCopyError(false);
    const result = await cliApi.pair();
    if (mounted.current) {
      setCommand(result.command);
      setStatus((current) => current ? { ...current, connected: false, device: null } : current);
    }
    update(await cliApi.status());
  });
  const revoke = () => run('revoke', async () => {
    await cliApi.revoke();
    if (mounted.current) {
      closeLogin();
      setCommand(null); setCopied(false); setCopyError(false);
      // Revocation deliberately keeps the selected subscription, including while offline.
      setStatus((current) => current ? { ...current, connected: false, device: null } : current);
    }
    update(await cliApi.status());
  });
  const dismiss = () => { setCommand(null); setCopied(false); setCopyError(false); };
  const copy = async () => {
    if (!command) return;
    setCopyError(false);
    try { await navigator.clipboard.writeText(command); if (mounted.current) setCopied(true); }
    catch { if (mounted.current) setCopyError(true); }
  };

  const selected = status?.selected;
  const blocked = !!selected && (!status.connected || !ready(status.providers[selected]));
  const runtime = status?.runtime ?? 'server';
  const modeTitle = !status ? 'Status unavailable' : selected
    ? `${providerName(selected)} · ${blocked ? 'Blocked' : stale ? 'Status unverified' : 'Active'}`
    : 'API providers selected';
  const provider = PROVIDERS.find((item) => item.id === providerTab)!;
  const health = status?.providers[providerTab];
  const serverReady = runtime === 'server' && !!status?.connected && !!health && ready(health) && !stale;
  const mutationBusy = !!busy && busy !== 'load';
  const disabled = mutationBusy || loginRunning;
  const loginLabel = runtime === 'bridge' ? 'Use server login' : health?.authenticated ? 'Log in again' : 'Login';
  const startLogin = () => {
    if (mutationBusy || loginActive.current) return;
    tabPicked.current = true;
    polling.current?.abort(); polling.current = null;
    setBusy(null); setError(null); dismiss();
    loginActive.current = true; setLoginRunning(true);
    setAuthMethod('cli'); setLoginAttempt((current) => current + 1); setLoginProvider(providerTab);
  };
  const closeLogin = () => {
    loginActive.current = false; setLoginRunning(false); setLoginProvider(null);
  };

  return (
    <div className="subscription-settings">
      <div className="app-settings__head">
        <h1>Subscriptions</h1>
        <p>Sign in on the Swarm server in your private account profile. All your Bots share this login across desktop, phone, iMessage and WhatsApp.</p>
      </div>

      <div className="subscription-settings__tabs" role="tablist" aria-label="CLI provider">
        {(['claude', 'codex'] as const).map((id) => (
          <button key={id} id={`subscription-tab-${id}`} role="tab" type="button" aria-selected={providerTab === id} aria-controls="subscription-auth-panel" tabIndex={providerTab === id ? 0 : -1} disabled={loginRunning} onClick={() => { tabPicked.current = true; setProviderTab(id); setAuthMethod('cli'); }} onKeyDown={(event) => {
            if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft' && event.key !== 'Home' && event.key !== 'End') return;
            event.preventDefault();
            const next = event.key === 'Home' ? 'claude' : event.key === 'End' ? 'codex' : id === 'claude' ? 'codex' : 'claude';
            tabPicked.current = true; setProviderTab(next); setAuthMethod('cli');
            document.getElementById(`subscription-tab-${next}`)?.focus();
          }}>
            {id === 'claude' ? <Sparkles size={18} aria-hidden /> : <Terminal size={18} aria-hidden />}{id === 'claude' ? 'Claude Code' : 'Codex'}
          </button>
        ))}
      </div>

      <section className="cfg-section subscription-settings__auth" role="tabpanel" id="subscription-auth-panel" aria-labelledby={`subscription-tab-${providerTab}`}>
        <h2 className="cfg-section__label">Authentication</h2>
        <div className="subscription-settings__methods">
          <button type="button" className={`subscription-settings__method${authMethod === 'cli' ? ' is-selected' : ''}`} aria-pressed={authMethod === 'cli'} disabled={disabled} onClick={() => setAuthMethod('cli')}>
            {authMethod === 'cli' && <Check className="subscription-settings__method-check" size={16} aria-hidden />}
            <Terminal size={24} strokeWidth={1.5} aria-hidden /><span>CLI authentication</span><small>Use your subscription</small>
          </button>
          <button type="button" className={`subscription-settings__method${authMethod === 'api' ? ' is-selected' : ''}`} aria-label="Use API providers" aria-pressed={authMethod === 'api'} disabled={disabled} onClick={() => void select(null)}>
            {authMethod === 'api' && <Check className="subscription-settings__method-check" size={16} aria-hidden />}
            <KeyRound size={24} strokeWidth={1.5} aria-hidden /><span>API providers</span><small>Switch explicitly to API billing</small>
          </button>
        </div>
        <div className="subscription-settings__status-row">
          <span className="subscription-settings__status" role="status"><span className={`subscription-settings__status-dot${serverReady ? ' is-connected' : ''}`} aria-hidden />{busy === 'load' ? 'Checking status…' : runtime === 'bridge' ? 'Computer bridge active' : serverReady ? 'Connected' : stale ? 'Status unverified' : 'Login required'}</span>
          <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!!busy || loginRunning} onClick={() => void refresh()}><RefreshCw size={14} aria-hidden />{busy === 'refresh' ? 'Refreshing…' : 'Refresh status'}</button>
        </div>
        <dl className="subscription-settings__details">
          <div><dt>Provider</dt><dd>{provider.name}</dd></div>
          <div><dt>Eligible plan</dt><dd>{provider.plan}</dd></div>
          <div><dt>Login location</dt><dd>{runtime === 'bridge' ? 'Your computer · advanced bridge' : 'Swarm server · private account profile'}</dd></div>
          <div><dt>Current mode</dt><dd className={blocked ? 'subscription-settings__blocked' : ''}>{modeTitle}</dd></div>
        </dl>
        {blocked && <p className="subscription-settings__blocked">The selected subscription is blocked until its login is ready. There is no automatic fallback to API providers.</p>}
        {(error || readError) && <div className="cfg-error" role="alert">{error || readError}</div>}
        {authMethod === 'cli' && <div className="subscription-settings__login-row">
          <div>
            <div className="cfg-row__title">One login for all your Bots</div>
            <p>{runtime === 'bridge' ? 'Choose Use server login to move authentication from your computer to your private Swarm server profile.' : 'The official CLI runs on the Swarm server. Complete its sign-in here; no local terminal or bridge is required.'}</p>
          </div>
          <div className="subscription-settings__actions">
            {serverReady && selected !== providerTab && <button type="button" className="cfg-btn cfg-btn--secondary" disabled={disabled} onClick={() => void select(providerTab)}>Use {providerTab === 'claude' ? 'Claude' : 'ChatGPT'}</button>}
            <button type="button" className="cfg-btn cfg-btn--primary" disabled={disabled} onClick={startLogin}>{loginRunning ? 'Login in progress…' : loginLabel}</button>
            {runtime === 'server' && (health?.authenticated || selected) && <button type="button" className={`cfg-btn ${confirmRevoke ? 'cfg-btn--danger' : 'cfg-btn--ghost-danger'}`} disabled={disabled} onClick={() => confirmRevoke ? void revoke() : setConfirmRevoke(true)}>{busy === 'revoke' ? 'Disconnecting…' : confirmRevoke ? 'Confirm disconnect' : 'Disconnect subscription'}</button>}
            {confirmRevoke && runtime === 'server' && <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setConfirmRevoke(false)}>Cancel</button>}
          </div>
        </div>}
        {runtime === 'server' && confirmRevoke && <p>Disconnecting deletes saved CLI credentials and stops jobs for this account. Your selected provider stays selected and blocked until you log in again or explicitly choose API providers.</p>}
        {status?.serverLoginAvailable === false && <p>Server login is currently unavailable. Try Login for the server’s instructions, or use the computer bridge under Advanced.</p>}
        {health?.error && <div className="cfg-error">{health.error}</div>}
        <a href={provider.docs} target="_blank" rel="noreferrer">Official authentication docs <ExternalLink size={12} aria-hidden /></a>
      </section>

      {loginProvider && <CliLoginTerminal key={loginAttempt} provider={loginProvider} onClose={closeLogin} onStateChange={(next) => {
        const running = next === 'running' || next === 'verifying';
        loginActive.current = running; setLoginRunning(running);
        if (next === 'failed' || next === 'cancelled') void cliApi.status().then(update).catch(() => {});
      }} onConnected={() => { refreshModels(); void refresh(); }} />}

      <details className="subscription-settings__advanced">
        <summary>Advanced · connect your own computer <ChevronDown size={16} aria-hidden /></summary>
        <div className="subscription-settings__advanced-content">
      <section className="cfg-section" aria-labelledby="subscription-bridge-title">
        <h2 className="cfg-section__label" id="subscription-bridge-title">Computer bridge</h2>
        <div className="cfg-card">
          <div className="cfg-row">
            <Terminal size={20} strokeWidth={1.75} aria-hidden />
            <div className="cfg-row__text">
              <div className="cfg-row__title">{runtime === 'server' ? 'Optional computer bridge' : !status ? 'Bridge status unknown' : stale ? 'Bridge status unverified' : status.connected ? 'Connected' : 'Disconnected'}</div>
              <div className="cfg-row__sub">{status?.device ? `Computer: ${status.device}` : 'Run the bridge on the computer where your CLIs are installed.'}</div>
            </div>
          </div>
          <div className="subscription-settings__actions subscription-settings__inset">
            <button type="button" className="cfg-btn cfg-btn--primary" disabled={!!busy || loginRunning || !!command} onClick={() => void generate()}>
              {busy === 'pair' ? 'Generating…' : 'Generate connect command'}
            </button>
            <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!!busy || loginRunning} onClick={() => void refresh()}>
              <RefreshCw size={14} aria-hidden />{busy === 'refresh' ? 'Refreshing…' : 'Refresh status'}
            </button>
          </div>
          {command && (
            <div className="subscription-settings__pair">
              <div className="cfg-row__title">Run this in a terminal on your computer</div>
              <p>This command contains a secret for your account. Keep it private. It is only shown here until you dismiss it or leave this page.</p>
              <pre tabIndex={0} aria-label="Connect command"><code>{command}</code></pre>
              <div className="subscription-settings__actions">
                <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => void copy()}>
                  {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}{copied ? 'Copied' : 'Copy connect command'}
                </button>
                <button type="button" className="cfg-btn cfg-btn--secondary" onClick={dismiss}>Dismiss command</button>
              </div>
              <p role="status">{copyError ? 'Clipboard access failed. Select and copy the command above.' : 'After starting the bridge, use Refresh status, then select a provider.'}</p>
            </div>
          )}
          {runtime === 'bridge' && <div className="subscription-settings__revoke">
            <p>Revoking disconnects the bridge and invalidates its pairing. A selected subscription stays selected and blocked until you reconnect or choose API providers.</p>
            <div className="subscription-settings__actions">
              <button type="button" className={`cfg-btn ${confirmRevoke ? 'cfg-btn--danger' : 'cfg-btn--ghost-danger'}`} disabled={!!busy || loginRunning} onClick={() => confirmRevoke ? void revoke() : setConfirmRevoke(true)}>
                {busy === 'revoke' ? 'Revoking…' : confirmRevoke ? 'Confirm revoke bridge' : 'Revoke bridge'}
              </button>
              {confirmRevoke && <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setConfirmRevoke(false)}>Cancel</button>}
            </div>
          </div>}
        </div>
      </section>

      <section className="cfg-section" aria-labelledby="subscription-providers-title">
        <h2 className="cfg-section__label" id="subscription-providers-title">Install on your computer</h2>
        <p>Install Node.js 22.22 or newer and the official CLI on your computer, then sign in with your subscription account. Keep the bridge running while using a subscription.</p>
        {PROVIDERS.map((provider) => {
          const health = status?.providers[provider.id];
          const isSelected = selected === provider.id;
          const available = runtime === 'bridge' && !!status?.connected && !!health && ready(health) && !stale;
          return (
            <div className="cfg-card subscription-settings__provider" key={provider.id}>
              <div className="cfg-row">
                <div className="cfg-row__text">
                  <div className="cfg-row__title">{provider.name}</div>
                  <div className="cfg-row__sub">{provider.plan}</div>
                </div>
                {isSelected && <span className="cfg-chip">Selected{blocked ? ' · Blocked' : ''}</span>}
              </div>
              <div className="subscription-settings__provider-body">
                <div className="subscription-settings__health" role="status">{stale ? 'Status unverified · refresh required' : providerState(health, !!status?.connected)}</div>
                {health?.error && <div className="cfg-error">{health.error}</div>}
                <div className="subscription-settings__command-label">Install</div>
                <pre tabIndex={0}><code>{provider.install}</code></pre>
                <div className="subscription-settings__command-label">Sign in with your subscription</div>
                <pre tabIndex={0}><code>{provider.login}</code></pre>
                {provider.id === 'codex' && <p>For device sign-in, use <code>codex login --device-auth</code>.</p>}
                <div className="subscription-settings__actions">
                  <button type="button" className={`cfg-btn ${isSelected ? 'cfg-btn--secondary' : 'cfg-btn--primary'}`} disabled={!!busy || loginRunning || isSelected || !available} aria-pressed={isSelected} onClick={() => void select(provider.id)}>
                    {busy === provider.id ? 'Selecting…' : isSelected ? 'Selected' : `Use ${provider.id === 'codex' ? 'ChatGPT' : 'Claude'}`}
                  </button>
                  <a href={provider.docs} target="_blank" rel="noreferrer">Official auth docs <ExternalLink size={12} aria-hidden /></a>
                </div>
                {!available && !isSelected && <p>Connect the bridge, install and sign in to this CLI with an eligible plan, then refresh status to enable selection.</p>}
              </div>
            </div>
          );
        })}
      </section>

        </div>
      </details>

      <section className="cfg-section" aria-labelledby="subscription-limits-title">
        <h2 className="cfg-section__label" id="subscription-limits-title">Usage and coverage</h2>
        <p>All your Bots share your eligible subscription’s usage and rate limits across devices and messaging channels. Provider extra usage settings also apply and may result in additional charges. Check your provider account for plan eligibility, usage and billing.</p>
        <p>Your subscription covers model usage. Platform-provided voice and external services are separate and have their own billing.</p>
      </section>
    </div>
  );
}
