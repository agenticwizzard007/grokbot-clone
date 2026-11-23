import { Terminal } from 'lucide-react';
import { SettingRow } from './config/SettingRow';
import { useEffect, useState } from 'react';
import { cliApi, type CliStatus } from '../lib/cliApi';
import { PLAN_PROVIDERS, planConnectionStatus, subscriptionReady } from '../lib/planConnections';
import { useModels } from '../lib/models';
import { useConfigUI } from '../configStore';
import { useStore } from '../store';
import '../styles/plan-connections.css';

/** Provider entry points share the same account-bound CLI status as Models & access. */
export function PlanConnections({ onClose, settings = false }: { onClose?: () => void; settings?: boolean }) {
  const accountId = useStore(s => s.user?.id);
  return accountId ? <AccountPlanConnections key={accountId} onClose={onClose} settings={settings} /> : null;
}

function AccountPlanConnections({ onClose, settings }: { onClose?: () => void; settings: boolean }) {
  const catalog = useModels();
  const [status, setStatus] = useState<CliStatus | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const load = async () => {
      if (pending || document.visibilityState !== 'visible') return;
      pending = true;
      try {
        let next = await cliApi.status(controller.signal);
        if (!next.providers?.claude || !next.providers.codex) throw new Error('Status unavailable');
        if (!next.connected && next.runtime === 'server' && next.serverLoginAvailable) next = await cliApi.refresh();
        if (!controller.signal.aborted) { setStatus(next); setFailed(false); }
      } catch { if (!controller.signal.aborted) { setStatus(null); setFailed(true); } }
      finally { pending = false; }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    document.addEventListener('visibilitychange', load);
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', load); };
  }, []);
  return <section className="plan-connections" aria-label="Connect a plan">
    <p>Use a subscription through the official CLI. API keys remain available.</p>
    {PLAN_PROVIDERS.map(provider => {
      const active = status?.selected === provider.id;
      const available = !!status?.connected && subscriptionReady(status.providers[provider.id]);
      const plan = catalog.provider === `${provider.id}-cli` && catalog.status === 'ready' && !catalog.error ? catalog.plan : null;
      const connectionStatus = failed ? 'Status unavailable' : planConnectionStatus(status, provider.id, plan);
      const control = <button type="button" className={settings ? 'cfg-btn cfg-btn--secondary' : undefined} aria-label={`${active ? 'Manage' : 'Connect'} ${provider.name}`} onClick={() => {
        onClose?.(); useConfigUI.getState().openAppSettings('subscriptions', provider.id);
      }}>{active ? 'Manage' : available ? 'Use subscription' : 'Connect plan'}</button>;
      return settings
        ? <SettingRow key={provider.id} icon={Terminal} title={provider.name} sub={`Via ${provider.cli}`} status={<span role="status">{connectionStatus}</span>}>{control}</SettingRow>
        : <div className="plan-connections__provider" key={provider.id}>
          <div><strong>{provider.name}</strong><small>Via {provider.cli}</small><span role="status">{connectionStatus}</span></div>
          {control}
        </div>;
    })}
  </section>;
}
