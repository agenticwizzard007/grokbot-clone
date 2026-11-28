import { ApprovalLevelSettings } from './ApprovalLevelSettings';
import { Page, Section, Card, Row, ButtonGroup } from '../layout';
import { Modal } from '../modals/Modal';
import { InfoTip, SettingsMenu } from './SettingsControls';
import { ProviderMark } from '../ProviderMark';
import { OpenRouterSettings } from './OpenRouterSettings';
import { CredentialReauthPrompt } from './ReauthPrompt';
import { useModels } from '../../lib/models';
import { useEffect, useRef, useState } from 'react';
import { cliApi, getCachedCliStatus, type CliProvider, type CliProviderStatus, type CliStatus, type CliRun } from '../../lib/cliApi';
import { modelAccessStatus } from '../../lib/modelAccessStatus';
import { refreshModels } from './ModelPicker';
import { CliLoginTerminal } from './CliLoginTerminal';
import { ApiError } from '../../lib/api';
import { usePlanUsage } from '../../lib/planUsage';
import { PlanUsageContent } from '../PlanUsageContent';
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

type Action = 'load' | 'pair' | 'refresh' | 'codex' | 'claude' | 'api' | 'revoke' | 'reset';

export function SubscriptionSettings() {
  const user = useStore((state) => state.user);
  // Never retain a previous account's status, terminal or secret pairing command.
  return user ? <AccountSubscriptionSettings key={user.id} accountId={user.id} accountEmail={user.email} /> : null;
}

function AccountSubscriptionSettings({ accountId, accountEmail }: { accountId: string; accountEmail: string }) {
  const modelCatalog = useModels();
  const requestedProvider = useConfigUI(s => s.subscriptionProvider);
  const planUsage = usePlanUsage();
  // A sign-in round trip (OAuth redirect or phone verification) returns here with the tab it left from.
  const resume = useConfigUI.getState().resume?.section === 'subscriptions' ? useConfigUI.getState().resume : null;
  const resumed = resume?.accountId === accountId && resume.expiresAt > Date.now() ? resume : null;
  const [providerTab, setProviderTab] = useState<CliProvider>(resumed?.provider ?? requestedProvider ?? 'claude');
  const [recovery, setRecovery] = useState<{ reason: string; action: ResumeAction } | null>(null);
  const [verifyingResume, setVerifyingResume] = useState(!!resumed);
  const [resumeLogin, setResumeLogin] = useState(false);
  const [credentialReauth, setCredentialReauth] = useState<string | null>(null);
  const [sheet, setSheet] = useState(resumed?.action === 'login' || !!requestedProvider);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [, setAuthMethod] = useState<'cli' | 'api'>('cli');
  const [loginProvider, setLoginProvider] = useState<CliProvider | null>(null);
  const [loginAttempt, setLoginAttempt] = useState(0);
  const [loginRunning, setLoginRunning] = useState(false);
  const loginActive = useRef(false);
  const tabPicked = useRef(!!resumed?.provider || !!requestedProvider);
  const methodChosen = useRef(false);
  const [status, setStatus] = useState<CliStatus | null>(getCachedCliStatus);
  const [busy, setBusy] = useState<Action | null>(() => getCachedCliStatus() ? null : 'load');
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
  const retryLabel = (action: ResumeAction) => ({ login: 'Login', reset: 'Reset connection', pair: 'Generate connect command', revoke: 'Revoke bridge', credentials: 'Save and verify or remove your key' })[action];
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
      tabPicked.current = true; setProviderTab(requestedProvider); setAuthMethod('cli'); setSheet(true);
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
      if (resumed.action === 'credentials') setCredentialReauth('Sign-in did not complete. Sign in again before changing your key.');
      else requestSession(resumed.action, 'Sign-in did not complete. Try again to continue.');
      setVerifyingResume(false);
      return;
    }
    void cliApi.verifyAuth(accountId, controller.signal).then(() => {
      if (controller.signal.aborted) return;
      if (resumed.action === 'login') setResumeLogin(true);
      else setNotice(`Your session is ready. Review the connection status before choosing ${retryLabel(resumed.action)}.`);
    }).catch((err: unknown) => {
      if (controller.signal.aborted) return;
      if (resumed.action === 'credentials') setCredentialReauth('Sign in again before changing your key.');
      else if (needsSession(err)) requestSession(resumed.action, err.message);
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
      cliApi.status(controller.signal).then((result) => {
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
    let lastPoll = Date.now();
    const interval = setInterval(() => {
      if (getCachedCliStatus()?.statusChecking || Date.now() - lastPoll >= 5000) { lastPoll = Date.now(); load(); }
    }, 1000);
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
      const message = err instanceof Error ? err.message : 'Subscription request failed. Try again.';
      if (action === 'refresh') setReadError(message);
      else setError(message);
      setStale(true);
    } finally {
      working.current = false;
      if (mounted.current) setBusy(null);
    }
  };

  const update = (result: CliStatus, epoch: number) => {
    if (!current(epoch)) return;
    setStatus(result);
    setStale(!!result.statusUnavailable);
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
        setNotice('Connections reset. Sign in to reconnect.');
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
  const provider = PROVIDERS.find((item) => item.id === providerTab)!;
  const health = status?.providers[providerTab];
  const reportedPlan = modelCatalog.provider === `${providerTab}-cli` && modelCatalog.status === 'ready' && !modelCatalog.error ? modelCatalog.plan : null;
  const tabStatus = modelAccessStatus(status, providerTab, stale, reportedPlan);
  const planReady = tabStatus.connected;
  const disabled = !!busy || loginRunning || !status || stale || authLocked;
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
    setSheet(true); startLogin();
  }, [resumeLogin, disabled]);

  return <div className="subscription-settings settings-stack">
    <Row className="settings-billing-row" title={<span className="settings-inline">Bots use <InfoTip label="About billing">Plan uses your subscription. API key pays per use.</InfoTip></span>}
      trailing={<ButtonGroup className="settings-billing cfg-seg" role="group" aria-label="Bots use">
        <button type="button" className={selected ? 'is-active' : ''} aria-pressed={!!selected} disabled={disabled} onClick={() => {
          const available = (['claude', 'codex'] as const).find(id => modelAccessStatus(status, id, stale).connected);
          if (available) void select(available); else setSheet(true);
        }}>Plan</button>
        <button type="button" className={!selected ? 'is-active' : ''} aria-pressed={!!status && !selected} disabled={disabled} onClick={() => void select(null)}>API key</button>
      </ButtonGroup>} />
    <Section title="Plan usage"><Card><PlanUsageContent summary={planUsage.summary} error={planUsage.error} /></Card></Section>
    <Section title="Plans"><Card variant="list">
      {(['claude', 'codex'] as const).map(id => {
        const connection = modelAccessStatus(status, id, stale);
        const name = id === 'claude' ? 'Claude' : 'ChatGPT';
        return <Row key={id} data-provider={id} leading={<ProviderMark provider={id} />} title={<span className="settings-provider">{name}<span className={`cfg-chip ${connection.connected ? 'is-connected' : ''}`} role="status">{connection.connection}</span></span>}
          trailing={connection.connected ? <SettingsMenu label="Manage" ariaLabel={`Manage ${name}`} disabled={!!busy || authLocked || loginRunning} items={[
            ...(connection.connected && selected !== id ? [{ label: `Use ${name}`, onSelect: () => void select(id) }] : []),
            { label: 'Refresh status', onSelect: () => { setProviderTab(id); void refresh(); } },
            { label: 'Reset connection', onSelect: () => { setProviderTab(id); setConfirmReset(true); } },
            { label: 'Disconnect', disabled: selected !== id, onSelect: () => void select(null) },
            { label: 'Connection details', onSelect: () => { setProviderTab(id); setSheet(true); } },
          ]} /> : <button type="button" className="cfg-btn cfg-btn--primary" disabled={!!busy || authLocked || loginRunning} onClick={() => { tabPicked.current = true; setProviderTab(id); setSheet(true); }}>Connect</button>} />;
      })}
    </Card></Section>
    {confirmReset && <Card><p>Reset both saved plan logins and the computer bridge?</p><ButtonGroup>
      <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setConfirmReset(false)}>Cancel</button>
      <button type="button" className="cfg-btn cfg-btn--danger" disabled={authLocked || !!busy} onClick={reset}>Confirm reset</button>
    </ButtonGroup></Card>}
    <Section title="Pay per use"><Card variant="list"><OpenRouterSettings compact disabled={!!busy || loginRunning || authLocked || !!credentialReauth} refreshToken={status?.selected} onReauth={error => setCredentialReauth(error.message)} onChanged={() => { void readStatus().catch(() => {}); }} /></Card></Section>
    {credentialReauth && <CredentialReauthPrompt accountEmail={accountEmail} reason={credentialReauth} resume={{ section: 'subscriptions', accountId, action: 'credentials' }} retryLabel="Save or remove your key" terminalActive={loginRunning} onCancel={() => setCredentialReauth(null)} />}
    {recovery && <Card className="subscription-reauth"><p role="alert">{recovery.reason}</p><ButtonGroup>
      <button type="button" className="cfg-btn cfg-btn--primary" onClick={() => {
        planResume({ section: 'subscriptions', provider: providerTab, accountId, action: recovery.action });
        const url = new URL(window.location.href); url.searchParams.delete('login'); url.searchParams.delete('openrouter');
        history.replaceState(history.state, '', url.pathname + url.search + '#settings/subscriptions'); window.location.reload();
      }}>Continue connection</button>
      <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => { invalidateStatus(); cancelResume(); setRecovery(null); }}>Not now</button>
    </ButtonGroup></Card>}
    {error && !sheet && <p className="cfg-error" role="alert">{error}</p>}
    {readError && <Row title="Status unavailable" trailing={<button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => void refresh()}>Retry</button>} />}
    {verifyingResume && <p role="status">Checking sign-in</p>}
    {notice && !recovery && !sheet && <p role="status">{notice}</p>}
    <details className="settings-disclosure subscription-settings__context"><summary>Learn more</summary><div className="settings-stack">
      <a href="https://docs.swarms.so" target="_blank" rel="noreferrer">Documentation</a>
      <ApprovalLevelSettings selectedCli={selected} />
      <Section title="API diagnostics"><Card><dl><RunDetails title="Last model run" run={status?.apiRuns?.latest ?? null} /><RunDetails title="Last tool run" run={status?.apiRuns?.lastToolRun ?? null} /></dl></Card></Section>
      <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => useConfigUI.getState().openAppSettings('computer')}>Computer settings</button>
    </div></details>
    {sheet && <Modal label={`Connect ${providerTab === 'claude' ? 'Claude' : 'ChatGPT'}`} className="settings-connect-sheet" onClose={() => { setSheet(false); closeLogin(); dismiss(); }}>
      <Page type="form" title={`Connect ${providerTab === 'claude' ? 'Claude' : 'ChatGPT'}`}>
        <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => { setSheet(false); closeLogin(); dismiss(); }}>Close</button>
        <Card><Row leading={<ProviderMark provider={providerTab} />} title={providerTab === 'claude' ? 'Claude' : 'ChatGPT'} subtitle={tabStatus.connection} trailing={<button className="cfg-btn cfg-btn--primary" disabled={disabled} onClick={startLogin}>{loginRunning ? 'Connecting' : 'Sign in'}</button>} /></Card>
        {error && <p role="alert" className="cfg-error">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        {loginProvider && <CliLoginTerminal key={loginAttempt} provider={loginProvider} onClose={closeLogin} onSessionRequired={() => { closeLogin(); requestSession('login', 'Sign in to Swarm to continue.'); }} onStateChange={next => {
          const running = next === 'running' || next === 'verifying'; loginActive.current = running; setLoginRunning(running);
          if ((next === 'failed' || next === 'cancelled') && !working.current) void readStatus().catch(() => {});
        }} onConnected={() => { refreshModels(); void refresh(); }} />}
        {selected === providerTab && <button type="button" className="cfg-btn cfg-btn--secondary" disabled={disabled} onClick={() => void select(null)}>Disconnect</button>}
        {planReady && selected !== providerTab && <button type="button" className="cfg-btn cfg-btn--primary" disabled={disabled} onClick={() => void select(providerTab)}>Use {providerTab === 'claude' ? 'Claude' : 'ChatGPT'}</button>}
        <details className="settings-disclosure"><summary>Learn more</summary><div className="settings-stack">
          <p>{tabStatus.details}</p><p>{tabStatus.currentRoute}</p>
          {!tabStatus.connected && tabStatus.hasSavedState && <SettingsMenu ariaLabel="Manage saved connection" disabled={disabled} items={[
            { label: 'Refresh status', onSelect: () => void refresh() },
            { label: 'Reset connection', onSelect: () => { setSheet(false); setConfirmReset(true); } },
            { label: 'Disconnect', disabled: selected !== providerTab, onSelect: () => void select(null) },
          ]} />}
          <p>Sign in through the official {providerTab === 'claude' ? 'Claude Code' : 'Codex'} app.</p>
          <a href={provider.docs} target="_blank" rel="noreferrer">Sign-in instructions</a>
          <Section title="Computer bridge"><Card>
            <Row title={status?.device || 'Your computer'} subtitle={runtime === 'bridge' && status?.connected ? 'Connected' : 'Not connected'} />
            <p>Model requests run here while it stays online.</p>
            <ButtonGroup stack><button type="button" className="cfg-btn cfg-btn--primary" disabled={authLocked || !!busy || loginRunning || !!command} onClick={() => void generate()}>Generate connect command</button><button type="button" className="cfg-btn cfg-btn--secondary" disabled={authLocked || !!busy || loginRunning} onClick={() => void refresh()}>Refresh status</button></ButtonGroup>
            {command && <><pre aria-label="Connect command, secret hidden"><CommandText command="node swarm-cli-bridge.mjs --server [server] --token [hidden]" /></pre><ButtonGroup><button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy command'}</button><button type="button" className="cfg-btn cfg-btn--secondary" onClick={dismiss}>Dismiss</button></ButtonGroup>{copyError && <p role="alert">Allow clipboard access and try again.</p>}</>}
            {runtime === 'bridge' && <button type="button" className="cfg-btn cfg-btn--secondary" disabled={authLocked || !!busy || loginRunning} onClick={() => confirmRevoke ? void revoke() : setConfirmRevoke(true)}>{confirmRevoke ? 'Confirm revoke bridge' : 'Revoke bridge'}</button>}
          </Card></Section>
          <Section title="Install"><Card><CommandText command={provider.install} /><CommandText command={provider.login} /></Card></Section>
          <Section title="Diagnostics"><Card><dl><RunDetails title="Last model run" run={status?.runsByProvider?.[providerTab]?.latest ?? null} /><RunDetails title="Last tool run" run={status?.runsByProvider?.[providerTab]?.lastToolRun ?? null} /></dl></Card></Section>

          {blocked && <p>Reconnect the selected plan or choose API key.</p>}
          {health?.error && <p role="note">{health.error}</p>}
        </div></details>
      </Page>
    </Modal>}
  </div>;
}

function RunDetails({ title, run }: { title: string; run: CliRun | null }) {
  return <>
    <div><dt>{title}</dt><dd>{run ? new Date(run.startedAt).toLocaleString() : 'No run recorded yet'}</dd></div>
    {run && <>
      <div><dt>Run type</dt><dd>{run.trigger === 'approval_decision' ? 'Reply after your decision' : run.lastTool || run.result === 'pending_approval' ? 'Request with tools' : run.result === 'running' ? 'Waiting for a reply' : 'Reply without a tool call'}</dd></div>
      <div><dt>Run location</dt><dd>{run.runtime === 'api' ? 'API provider' : run.runtime === 'server' ? 'Swarm server' : 'Your computer'}</dd></div>
      <div><dt>Tools offered</dt><dd>{run.toolsOffered}</dd></div>
      <div><dt>Last tool call</dt><dd>{run.lastTool ?? 'None reached Swarm'}</dd></div>
      <div><dt>Run result</dt><dd>{{ running: 'Running', completed: 'Completed', pending_approval: 'Approval requested', rejected_by_cli: 'Rejected by CLI', denied: 'Not allowed', allowed: 'Allowed', error: 'Error', cancelled: 'Stopped', no_tool_call: 'No tool call' }[run.result]}</dd></div>
      <div><dt>Error code</dt><dd>{run.result === 'denied' ? 'None' : run.errorCode ?? 'None'}</dd></div>
    </>}
  </>;
}

function CommandText({ command }: { command: string }) {
  return <code className="settings-command">{command.split(' ').map((word, index) => <span key={index}>{word}{index < command.split(' ').length - 1 ? ' ' : ''}</span>)}</code>;
}
