import { useModels } from '../../lib/models';
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Copy, ExternalLink, RefreshCw, Terminal } from 'lucide-react';
import { cliApi, type CliProvider, type CliProviderStatus, type CliStatus } from '../../lib/cliApi';
import { PLAN_PROVIDERS, planConnectionStatus } from '../../lib/planConnections';
import { refreshModels } from './ModelPicker';
import { CliLoginTerminal } from './CliLoginTerminal';
import { ApiError } from '../../lib/api';
import { AccessRow } from './AccessRow';
import { useReportedPlanUsage } from '../../lib/accessPlanUsage';
import { useStore } from '../../store';
import { cancelResume, planResume, useConfigUI, type ResumeAction } from '../../configStore';
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
const needsSession = (err: unknown): err is ApiError => err instanceof ApiError && err.status === 401;
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

type Action = 'load' | 'pair' | 'refresh' | 'codex' | 'claude' | 'api' | 'revoke' | 'reset';

export function SubscriptionSettings() {
  const user = useStore((state) => state.user);
  // Never retain a previous account's status, terminal or secret pairing command.
  return user ? <AccountSubscriptionSettings key={user.id} accountId={user.id} accountEmail={user.email} /> : null;
}

function AccountSubscriptionSettings({ accountId, accountEmail }: { accountId: string; accountEmail: string }) {
  const modelCatalog = useModels();
  const requestedProvider = useConfigUI(s => s.subscriptionProvider);
  const planUsage = useReportedPlanUsage(modelCatalog.usage);
  // A sign-in round trip (OAuth redirect or phone verification) returns here with the tab it left from.
  const resume = useConfigUI.getState().resume?.section === 'subscriptions' ? useConfigUI.getState().resume : null;
  const resumed = resume?.accountId === accountId && resume.expiresAt > Date.now() ? resume : null;
  const [providerTab, setProviderTab] = useState<CliProvider>(resumed?.provider ?? requestedProvider ?? 'claude');
  const [recovery, setRecovery] = useState<{ reason: string; action: ResumeAction } | null>(null);
  const [verifyingResume, setVerifyingResume] = useState(!!resumed);
  const [resumeLogin, setResumeLogin] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [authMethod, setAuthMethod] = useState<'cli' | 'api'>('cli');
  const [loginProvider, setLoginProvider] = useState<CliProvider | null>(null);
  const [loginAttempt, setLoginAttempt] = useState(0);
  const [loginRunning, setLoginRunning] = useState(false);
  const loginActive = useRef(false);
  const tabPicked = useRef(!!resumed?.provider || !!requestedProvider);
  const methodChosen = useRef(false);
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
  const statusEpoch = useRef(0);
  const authLocked = !!recovery || verifyingResume;
  const authLockedRef = useRef(authLocked);
  authLockedRef.current = authLocked;
  const invalidateStatus = () => {
    polling.current?.abort(); polling.current = null;
    return ++statusEpoch.current;
  };
  const current = (epoch: number) => mounted.current && epoch === statusEpoch.current;
  const retryLabel = (action: ResumeAction) => ({ login: 'Login', reset: 'Reset connection', pair: 'Generate connect command', revoke: 'Revoke bridge' })[action];
  const requestSession = (action: ResumeAction, reason: string) => {
    invalidateStatus(); authLockedRef.current = true;
    setNotice(null); setStale(true); setRecovery({ action, reason });
    planResume({ section: 'subscriptions', provider: providerTab, accountId, action });
    // A late authorization check can follow partial reset effects. Reconcile
    // the current state without assuming that the failed request did nothing.
    void readStatus().catch(() => {});
  };

  useEffect(() => {
    if (requestedProvider && !authLocked && !loginRunning) {
      tabPicked.current = true; setProviderTab(requestedProvider); setAuthMethod('cli');
    }
  }, [requestedProvider]);

  useEffect(() => {
    if (status) refreshModels();
    if (status?.selected && !tabPicked.current) setProviderTab(status.selected);
    // Open on what is actually active: with no plan selected, Bots run on API providers.
    if (status && !methodChosen.current) { methodChosen.current = true; if (!status.selected && !tabPicked.current) setAuthMethod('api'); }
  }, [status?.selected, status?.runtime, status?.connected]);

  useEffect(() => {
    if (!resume) return;
    useConfigUI.getState().clearResume();
    cancelResume();
    if (!resumed) { setError('The previous sign-in request expired or belongs to another account. Choose your connection action again.'); return; }
    const controller = new AbortController();
    invalidateStatus();
    const callback = new URLSearchParams(window.location.search);
    if (callback.has('login') || (callback.has('openrouter') && callback.get('openrouter') !== 'connected')) {
      requestSession(resumed.action, 'Sign-in did not complete. Try again to continue.');
      setVerifyingResume(false);
      return;
    }
    void cliApi.verifyAuth(accountId, controller.signal).then(() => {
      if (controller.signal.aborted) return;
      if (resumed.action === 'login') setResumeLogin(true);
      else setNotice(`Your session is ready. Review the connection status before choosing ${retryLabel(resumed.action)}.`);
    }).catch((err: unknown) => {
      if (controller.signal.aborted) return;
      if (needsSession(err)) requestSession(resumed.action, err.message);
      else setError(err instanceof Error ? err.message : 'Could not verify your sign-in. Reload and try again.');
    }).finally(() => {
      if (!controller.signal.aborted) {
        setVerifyingResume(false);
        void readStatus().catch(() => {});
      }
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    mounted.current = true;
    let initial = true;
    const load = () => {
      if (document.visibilityState !== 'visible' || working.current || loginActive.current || polling.current || authLockedRef.current) return;
      const controller = new AbortController();
      const epoch = statusEpoch.current;
      polling.current = controller;
      cliApi.status(controller.signal).then(async (result) => {
        // The initial hosted snapshot has no installation evidence until the official CLIs are probed.
        if (initial && !result.connected && result.runtime === 'server' && result.serverLoginAvailable) result = await cliApi.refresh();
        if (!controller.signal.aborted) update(result, epoch);
      }).catch((err: unknown) => {
        if (!controller.signal.aborted && current(epoch)) {
          setReadError(err instanceof Error ? err.message : 'Could not load subscription status.');
          setStale(true);
        }
      }).finally(() => {
        if (polling.current === controller) polling.current = null;
        if (!controller.signal.aborted && current(epoch) && initial) { initial = false; setBusy(null); }
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
      invalidateStatus();
      clearInterval(interval);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timeout = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timeout);
  }, [copied]);

  const run = async (action: Action, task: (epoch: number) => Promise<void>) => {
    if (working.current || authLockedRef.current || (loginActive.current && action !== 'reset')) return;
    working.current = true;
    const epoch = invalidateStatus();
    setBusy(action);
    setError(null); setNotice(null);
    setConfirmRevoke(false);
    setConfirmReset(false);
    try { await task(epoch); }
    catch (err) {
      if (!mounted.current) return;
      if (needsSession(err)) { requestSession(action === 'reset' || action === 'pair' || action === 'revoke' ? action : 'login', err.message); return; }
      setError(err instanceof Error ? err.message : 'Subscription request failed. Try again.');
      setStale(true);
    } finally {
      working.current = false;
      if (mounted.current) setBusy(null);
    }
  };

  const update = (result: CliStatus, epoch: number) => {
    if (!current(epoch)) return;
    setStatus(result);
    setStale(false);
    setReadError(null);
  };
  const readStatus = async () => {
    const epoch = statusEpoch.current;
    try { update(await cliApi.status(), epoch); }
    catch (err) {
      if (current(epoch)) { setStale(true); setReadError(err instanceof Error ? err.message : 'Could not load subscription status.'); }
      throw err;
    } finally {
      if (current(epoch)) setBusy((value) => value === 'load' ? null : value);
    }
  };
  const refresh = () => run('refresh', async (epoch) => { update(await cliApi.refresh(), epoch); });
  const select = (provider: CliProvider | null) => run(provider ?? 'api', async (epoch) => {
    await cliApi.select(provider);
    closeLogin();
    refreshModels();
    // Selection responses need no body. Reflect the saved mode even if the subsequent GET fails.
    if (current(epoch)) {
      setAuthMethod(provider ? 'cli' : 'api');
      setStatus((current) => current ? { ...current, selected: provider } : current);
    }
    update(await cliApi.status(), epoch);
  });
  const generate = () => run('pair', async (epoch) => {
    setCommand(null); setCopied(false); setCopyError(false);
    const result = await cliApi.pair();
    if (current(epoch)) {
      setCommand(result.command);
      setStatus((current) => current ? { ...current, runtime: 'bridge', connected: false, device: null } : current);
    }
    update(await cliApi.status(), epoch);
  });
  const revoke = () => run('revoke', async (epoch) => {
    await cliApi.revoke();
    if (current(epoch)) {
      closeLogin();
      setCommand(null); setCopied(false); setCopyError(false);
      // Revocation deliberately keeps the selected subscription, including while offline.
      setStatus((current) => current ? { ...current, connected: false, device: null } : current);
    }
    update(await cliApi.status(), epoch);
  });
  // Start over for both providers: saved server logins, bridge pairing, pending sign-in and cached status.
  const reset = () => {
    void run('reset', async (epoch) => {
      const result = await cliApi.reset(accountId);
      if (current(epoch)) {
        closeLogin();
        setCommand(null); setCopied(false); setCopyError(false);
        setAuthMethod('cli');
        setNotice('Connection reset. Both CLIs are signed out on your Swarm server. Choose Login to connect Claude Code or Codex again.');
      }
      update(result, epoch);
      refreshModels();
    });
  };
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
  const planReady = !!status?.connected && !!health && ready(health) && !stale;
  const reportedPlan = modelCatalog.provider === `${providerTab}-cli` && modelCatalog.status === 'ready' && !modelCatalog.error ? modelCatalog.plan : null;
  const disabled = !!busy || loginRunning || !status || stale || authLocked;
  const loginLabel = runtime === 'bridge' ? 'Use server login' : health?.authenticated ? 'Log in again' : 'Login';
  const startLogin = () => {
    if (disabled || loginActive.current) return;
    tabPicked.current = true;
    invalidateStatus();
    setBusy(null); setError(null); setRecovery(null); setNotice(null); setConfirmReset(false); dismiss();
    loginActive.current = true; setLoginRunning(true);
    setAuthMethod('cli'); setLoginAttempt((current) => current + 1); setLoginProvider(providerTab);
  };
  const closeLogin = () => {
    loginActive.current = false; setLoginRunning(false); setLoginProvider(null);
  };

  useEffect(() => {
    if (!resumeLogin || disabled || loginActive.current) return;
    setResumeLogin(false);
    startLogin();
  }, [resumeLogin, disabled]);

  return (
    <div className="subscription-settings">
      <div className="app-settings__head">
        <h1>Choose how models are billed</h1>
        <p>Use an eligible plan through CLI authentication, or choose API billing.</p>
      </div>

      <div className="subscription-settings__tabs" role="tablist" aria-label="CLI provider">
        {(['codex', 'claude'] as const).map((id) => (
          <button key={id} id={`subscription-tab-${id}`} role="tab" type="button" aria-selected={providerTab === id} aria-controls="subscription-auth-panel" tabIndex={providerTab === id ? 0 : -1} disabled={authLocked || loginRunning} onClick={() => { tabPicked.current = true; setProviderTab(id); setAuthMethod('cli'); }} onKeyDown={(event) => {
            if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft' && event.key !== 'Home' && event.key !== 'End') return;
            event.preventDefault();
            const next = event.key === 'Home' ? 'codex' : event.key === 'End' ? 'claude' : id === 'claude' ? 'codex' : 'claude';
            tabPicked.current = true; setProviderTab(next); setAuthMethod('cli');
            document.getElementById(`subscription-tab-${next}`)?.focus();
          }}>
            {id === 'claude' ? 'Claude Code' : 'Codex'}
          </button>
        ))}
      </div>

      {recovery && <section className="cfg-card subscription-reauth" aria-label="Continue connection">
        <div className="subscription-reauth__body">
          <p role="alert">{recovery.reason}</p>
          <p>Continue to check your Swarm session and return to this connection.</p>
          {recovery.action === 'reset' && <p>Reset may already have stopped login sessions or removed saved connections. Review the refreshed status before retrying.</p>}
          <div className="subscription-settings__actions">
            <button type="button" className="cfg-btn cfg-btn--primary" onClick={() => {
              planResume({ section: 'subscriptions', provider: providerTab, accountId, action: recovery.action });
              const url = new URL(window.location.href);
              url.searchParams.delete('login'); url.searchParams.delete('openrouter');
              history.replaceState(history.state, '', url.pathname + url.search + '#settings/subscriptions');
              window.location.reload();
            }}>Continue connection</button>
            <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => { invalidateStatus(); cancelResume(); setRecovery(null); }}>Not now</button>
          </div>
        </div>
      </section>}

      <section className="cfg-section" aria-label="Plan connection">
        <AccessRow title={providerTab === 'claude' ? 'Claude plan' : 'ChatGPT plan'} description={`${PLAN_PROVIDERS.find(p => p.id === providerTab)!.plans} via the official ${providerTab === 'claude' ? 'Claude Code' : 'Codex'} CLI.`}
          status={<span role="status">{stale ? 'Status unavailable' : planConnectionStatus(status, providerTab, reportedPlan)}</span>}>
          {selected === providerTab
            ? <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!!busy || loginRunning || authLocked} onClick={() => void select(null)}>Disconnect</button>
            : planReady
              ? <button type="button" className="cfg-btn cfg-btn--primary" disabled={disabled} onClick={() => void select(providerTab)}>Use subscription</button>
              : <button type="button" className="cfg-btn cfg-btn--primary" disabled={disabled || runtime === 'bridge' || !status?.serverLoginAvailable || (status.connected && !health?.installed)} onClick={startLogin}>Connect plan</button>}
        </AccessRow>
        <p>Complete sign-in with the official CLI on the computer running your Bots. Credentials stay in that CLI's profile. Disconnect switches your Bots to API billing and leaves the CLI signed in.</p>
        {runtime === 'bridge' && !planReady && <p>Run <code>{provider.login}</code> on your computer, complete the official sign-in, then refresh status and choose Use subscription.</p>}
        {status?.connected && !health?.installed && <p>Install the official {providerTab === 'claude' ? 'Claude Code' : 'Codex'} CLI on {runtime === 'bridge' ? 'your computer' : "your Bot's computer"}, then refresh status. <a href={provider.docs} target="_blank" rel="noreferrer">Installation and sign-in instructions</a></p>}
      </section>

      {loginProvider && <CliLoginTerminal key={loginAttempt} provider={loginProvider} onClose={closeLogin} onSessionRequired={() => { closeLogin(); requestSession('login', 'Your Swarm session needs to be checked before connecting.'); }} onStateChange={(next) => {
        const running = next === 'running' || next === 'verifying';
        loginActive.current = running; setLoginRunning(running);
        if ((next === 'failed' || next === 'cancelled') && !working.current) void readStatus().catch(() => {});
      }} onConnected={() => { refreshModels(); void refresh(); }} />}

      <section className="cfg-section subscription-settings__auth" role="tabpanel" id="subscription-auth-panel" aria-labelledby={`subscription-tab-${providerTab}`}>
        <AccessRow title="CLI connection" description="Clear saved CLI sign-ins and start over.">
            <button type="button" className={`cfg-btn ${confirmReset ? 'cfg-btn--danger' : 'cfg-btn--secondary'}`} disabled={authLocked || !!busy} onClick={() => confirmReset ? reset() : setConfirmReset(true)}>{busy === 'reset' ? 'Resetting…' : confirmReset ? 'Confirm reset' : 'Reset connection'}</button>
            {confirmReset && <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setConfirmReset(false)}>Cancel</button>}
        </AccessRow>
        {confirmReset && <p role="note">Reset removes the saved Claude Code and Codex logins from your Swarm server, revokes any computer bridge, cancels a sign-in in progress and clears cached status, then checks both CLIs again. Your selected subscription stays selected and blocked until you log in again or choose API providers.</p>}
        <AccessRow title="CLI authentication" description="Use your subscription on the Swarm server or through an advanced bridge." status={selected ? undefined : authMethod === 'cli' ? 'Set up a plan below' : 'Not in use'}>
          {authMethod === 'api' && <button type="button" className="cfg-btn cfg-btn--secondary" disabled={disabled} onClick={() => setAuthMethod('cli')}>Set up CLI authentication</button>}
        </AccessRow>
        <AccessRow title="API providers" description="Pay per use through a connected API provider." status={status && !selected ? 'In use' : undefined}>
          <button type="button" className="cfg-btn cfg-btn--secondary" aria-pressed={authMethod === 'api'} disabled={disabled} onClick={() => void select(null)}>Use API providers</button>
          <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => useConfigUI.getState().openAppSettings('keys')}>Manage API keys</button>
        </AccessRow>
        <AccessRow title={providerTab === 'claude' ? 'Claude Code' : 'Codex'} description={modeTitle} status={<span role="status">{busy === 'load' ? 'Checking status…' : !status ? 'Status unavailable' : stale ? 'Status unverified' : runtime === 'bridge' ? status.connected ? 'Computer bridge connected' : 'Computer bridge offline' : serverReady ? 'Connected' : 'Login required'}</span>}>
          {serverReady && selected !== providerTab && <button type="button" className="cfg-btn cfg-btn--secondary" disabled={disabled} onClick={() => void select(providerTab)}>Use {providerTab === 'claude' ? 'Claude' : 'ChatGPT'}</button>}
        </AccessRow>
        <AccessRow title="Authorization status" description="Refresh after signing in or reconnecting.">
          <button type="button" className="cfg-btn cfg-btn--secondary" disabled={authLocked || !!busy || loginRunning} onClick={() => void refresh()}>{busy === 'refresh' ? 'Refreshing…' : 'Refresh status'}</button>
        </AccessRow>
        <AccessRow title="Provider instructions" description="Review eligibility and official authentication steps.">
          <a className="cfg-btn cfg-btn--secondary" href={provider.docs} target="_blank" rel="noreferrer">Official auth docs</a>
        </AccessRow>
        <details className="subscription-settings__context">
          <summary>Account and login details</summary>
          <dl className="subscription-settings__details">
          <div><dt>Swarm account</dt><dd>{accountEmail.endsWith('@openrouter.invalid') ? 'Your OpenRouter sign-in' : accountEmail}</dd></div>
          <div><dt>Provider</dt><dd>{provider.name}</dd></div>
          <div><dt>Eligible plan</dt><dd>{provider.plan}</dd></div>
          <div><dt>Login location</dt><dd>{runtime === 'bridge' ? 'Your computer · advanced bridge' : 'Swarm server · private account profile'}</dd></div>
          <div><dt>Current mode</dt><dd className={blocked ? 'subscription-settings__blocked' : ''}>{modeTitle}</dd></div>
          </dl>
        </details>
        {blocked && <p className="subscription-settings__blocked">The selected subscription is blocked until its login is ready. There is no automatic fallback to API providers.</p>}
        {(error || readError) && <div className="cfg-error" role="alert">{error || readError}</div>}
        {verifyingResume && <p role="status">Verifying your sign-in…</p>}
        {notice && !recovery && <p className="subscription-settings__notice" role="status">{notice}</p>}
        {status?.serverLoginAvailable === false && <p>Server login is currently unavailable. Try Login for the server’s instructions, or use the computer bridge under Advanced.</p>}
        {health?.error && <div className="cfg-error">{health.error}</div>}
      </section>

      <details className="subscription-settings__advanced">
        <summary><span>Connect your computer<small>Run the CLI on your computer only if you need the advanced bridge.</small></span><span className="cfg-btn cfg-btn--secondary">Advanced bridge <ChevronDown size={16} aria-hidden /></span></summary>
        <div className="subscription-settings__advanced-content">
      <section className="cfg-section" aria-labelledby="subscription-bridge-title">
        <h2 className="cfg-section__label" id="subscription-bridge-title">Computer bridge</h2>
        <div className="cfg-card">
          <p className="subscription-settings__inset">Generating a command switches model requests for this account to your computer. That computer must stay awake and online.</p>
          <div className="cfg-row">
            <Terminal size={20} strokeWidth={1.75} aria-hidden />
            <div className="cfg-row__text">
              <div className="cfg-row__title">{runtime === 'server' ? 'Optional computer bridge' : !status ? 'Bridge status unknown' : stale ? 'Bridge status unverified' : status.connected ? 'Connected' : 'Disconnected'}</div>
              <div className="cfg-row__sub">{status?.device ? `Computer: ${status.device}` : 'Run the bridge on the computer where your CLIs are installed.'}</div>
            </div>
          </div>
          <div className="subscription-settings__actions subscription-settings__inset">
            <button type="button" className="cfg-btn cfg-btn--primary" disabled={authLocked || !!busy || loginRunning || !!command} onClick={() => void generate()}>
              {busy === 'pair' ? 'Generating…' : 'Generate connect command'}
            </button>
            <button type="button" className="cfg-btn cfg-btn--secondary" disabled={authLocked || !!busy || loginRunning} onClick={() => void refresh()}>
              <RefreshCw size={14} aria-hidden />{busy === 'refresh' ? 'Refreshing…' : 'Refresh status'}
            </button>
          </div>
          {command && (
            <div className="subscription-settings__pair">
              <div className="cfg-row__title">Run this in a terminal on your computer</div>
              <p>This command contains a private pairing secret. Copy it directly to your terminal. The secret is hidden here and discarded when you leave this page.</p>
              <pre tabIndex={0} aria-label="Connect command, secret hidden"><code>node swarm-cli-bridge.mjs --server [your server] --token [hidden]</code></pre>
              <div className="subscription-settings__actions">
                <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => void copy()}>
                  {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}{copied ? 'Copied' : 'Copy connect command'}
                </button>
                <button type="button" className="cfg-btn cfg-btn--secondary" onClick={dismiss}>Dismiss command</button>
              </div>
              <p role="status">{copyError ? 'Clipboard access failed. Allow clipboard access, then try Copy connect command again.' : 'After starting the bridge, use Refresh status, then select a provider.'}</p>
            </div>
          )}
          {runtime === 'bridge' && <div className="subscription-settings__revoke">
            <p>Revoking disconnects the bridge and invalidates its pairing. A selected subscription stays selected and blocked until you reconnect or choose API providers.</p>
            <div className="subscription-settings__actions">
              <button type="button" className={`cfg-btn ${confirmRevoke ? 'cfg-btn--danger' : 'cfg-btn--ghost-danger'}`} disabled={authLocked || !!busy || loginRunning} onClick={() => confirmRevoke ? void revoke() : setConfirmRevoke(true)}>
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
                <div className="subscription-settings__health" role="status">{stale ? 'Status unverified · refresh required' : runtime === 'bridge' ? providerState(health, !!status?.connected) : 'Connect the bridge to check this computer.'}</div>
                {runtime === 'bridge' && health?.error && <div className="cfg-error">{health.error}</div>}
                <div className="subscription-settings__command-label">Install</div>
                <pre tabIndex={0}><code>{provider.install}</code></pre>
                <div className="subscription-settings__command-label">Sign in with your subscription</div>
                <pre tabIndex={0}><code>{provider.login}</code></pre>
                {provider.id === 'codex' && <p>For device sign-in, use <code>codex login --device-auth</code>.</p>}
                <div className="subscription-settings__actions">
                  <button type="button" className={`cfg-btn ${isSelected ? 'cfg-btn--secondary' : 'cfg-btn--primary'}`} disabled={authLocked || !!busy || loginRunning || isSelected || !available} aria-pressed={isSelected} onClick={() => void select(provider.id)}>
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

      <AccessRow title="Manage device access" description="Pair or manage the separate computer your Bots work on.">
        <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => useConfigUI.getState().openAppSettings('computer')}>Computer settings</button>
      </AccessRow>
      <div className="subscription-settings__actions">
        <button type="button" className="cfg-btn cfg-btn--primary" disabled={disabled} onClick={startLogin}>{loginRunning ? 'Login in progress…' : loginLabel}</button>
        {selected === providerTab && <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!!busy || loginRunning || authLocked} onClick={() => void select(null)}>Disconnect subscription</button>}
      </div>
      <section className="cfg-section subscription-settings__coverage" aria-labelledby="subscription-limits-title">
        <h2 className="cfg-section__label" id="subscription-limits-title">Usage and coverage</h2>
        {providerTab === 'codex' && <p>Codex chooses its default model. The model list, plan name and usage limits are unavailable through this CLI connection. Check your ChatGPT account for plan details.</p>}
        <p>All your Bots share your plan across desktop, phone and linked iMessage or WhatsApp. Your provider’s usage limits and extra usage charges still apply.</p>
        <p>Browser and computer tools use the computer selected in Settings. Choose a server-hosted computer there to use those tools while your personal computer is off.</p>
        {status?.selected && modelCatalog.billing === 'plan' && <div className="cfg-card" aria-label="Connected plan usage">
          <p>{modelCatalog.plan ? `Reported plan: ${modelCatalog.plan}` : 'Plan name unavailable from the CLI.'}</p>
          {modelCatalog.status === 'loading' ? <p>Checking plan usage…</p> : planUsage.state === 'reported' ? planUsage.windows.map(w => <p key={w.label}>{w.label}: {w.usedPercent}% used{w.resetsAt !== null ? ` · Resets ${new Date(w.resetsAt).toLocaleString()}` : ''}</p>) : <p>{planUsage.state === 'stale' ? 'Reported usage has expired. ' : 'Usage limits were not reported. '}Check your provider account for current limits.</p>}
          {modelCatalog.usage && <p>Checked {new Date(modelCatalog.usage.checkedAt).toLocaleString()}</p>}
        </div>}
        <p>Your subscription covers model usage. Platform-provided voice and external services are separate and have their own billing.</p>
      </section>
    </div>
  );
}
