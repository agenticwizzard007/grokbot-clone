import { ProviderLabel, ProviderText } from './ProviderMark';
import { Terminal } from 'lucide-react';
import { SettingRow } from './config/SettingRow';
import { useEffect, useState } from 'react';
import { cliApi, getCachedCliStatus, type CliStatus } from '../lib/cliApi';
import { PLAN_PROVIDERS, planConnectionStatus, planState } from '../lib/planConnections';
import { useModels } from '../lib/models';
import { useConfigUI } from '../configStore';
import { useStore } from '../store';
import '../styles/plan-connections.css';

/** Provider entry points share the same account-bound CLI status as Models & access. */
export function PlanConnections({ onClose, settings = false }: { onClose?: (afterClose?: () => void) => void; settings?: boolean }) {
  const accountId = useStore(s => s.user?.id);
  return accountId ? <AccountPlanConnections key={accountId} onClose={onClose} settings={settings} /> : null;
}

function AccountPlanConnections({ onClose, settings }: { onClose?: (afterClose?: () => void) => void; settings: boolean }) {
  const catalog = useModels();
  const [status, setStatus] = useState<CliStatus | null>(getCachedCliStatus);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const load = async () => {
      if (pending || document.visibilityState !== 'visible') return;
      pending = true;
      try {
        const next = await (attempt ? cliApi.refresh(controller.signal) : cliApi.status(controller.signal));
        if (!next.providers?.claude || !next.providers.codex) throw new Error('Status unavailable');
        if (!controller.signal.aborted) { setStatus(next); setFailed(false); }
      } catch { if (!controller.signal.aborted) setFailed(true); }
      finally { pending = false; }
    };
    void load();
    const timer = setInterval(() => void load(), status?.statusChecking ? 1000 : 5000);
    document.addEventListener('visibilitychange', load);
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', load); };
  }, [attempt, !!status?.statusChecking]);
  return <section className="plan-connections" aria-label="Connect a plan">
    {settings && <p>Use a subscription through the official CLI. API keys remain available.</p>}
    {PLAN_PROVIDERS.some(provider => planState(status, provider.id, failed).unavailable) && <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setAttempt(value => value + 1)}>Retry status</button>}
    {PLAN_PROVIDERS.map(provider => {
      const active = status?.selected === provider.id;
      const state = planState(status, provider.id, failed);
      const available = state.connected;
      const plan = catalog.provider === `${provider.id}-cli` && catalog.status === 'ready' && !catalog.error ? catalog.plan : null;
      const connectionStatus = failed ? 'Status unavailable' : planConnectionStatus(status, provider.id, plan);
      const label = settings ? <span role="status"><span><ProviderText>{connectionStatus}</ProviderText></span><small className="plan-connections__hint" style={{ visibility: available && state.checking ? 'visible' : 'hidden' }} aria-hidden={!available || !state.checking}>Checking</small></span> : <span className="model-billing" role="status">{available ? active ? 'In use' : 'Connected' : state.checking ? 'Checking' : state.unavailable ? 'Unavailable' : 'Not connected'}</span>;
      const control = (available || state.canConnect) && <button type="button" className={settings ? 'cfg-btn cfg-btn--secondary' : undefined} aria-label={`${available ? active ? 'Manage' : 'Use' : 'Connect'} ${provider.name}`} onClick={() => {
        const navigate = () => useConfigUI.getState().openAppSettings('subscriptions', provider.id);
        if (onClose) onClose(navigate); else navigate();
      }}>{available ? active ? 'Manage' : settings ? 'Use subscription' : 'Use' : settings ? 'Connect plan' : 'Connect'}</button>;
      return settings
        ? <SettingRow key={provider.id} icon={Terminal} title={<ProviderLabel provider={provider.id}>{provider.name}</ProviderLabel>} sub={<>Via <ProviderLabel provider={provider.id}>{provider.cli}</ProviderLabel></>} status={label}>{control}</SettingRow>
        : <div className="plan-connections__provider" key={provider.id}>
          <div><strong><ProviderLabel provider={provider.id}>{provider.id === 'claude' ? 'Claude' : 'ChatGPT'}</ProviderLabel></strong>{label}</div>
          {control}
        </div>;
    })}
  </section>;
}
