import { RefreshCw } from 'lucide-react';
import { useModels, type ModelProvider } from '../lib/models';
import { useConfigUI } from '../configStore';
import { useReportedPlanUsage } from '../lib/accessPlanUsage';
import { PlanConnections } from './PlanConnections';
import '../styles/model-usage.css';

function connectionName(provider: ModelProvider | null, plan: string | null) {
  const name = provider === 'claude-cli' ? 'Claude' : provider === 'codex-cli' ? 'ChatGPT' : provider === 'openrouter' ? 'OpenRouter' : 'Direct API';
  if (!plan || !provider?.endsWith('-cli')) return name;
  const label = plan.trim().replaceAll('_', ' ').replace(/\b[a-z]/g, c => c.toUpperCase());
  return label.toLowerCase().startsWith(name.toLowerCase()) ? label : `${name} ${label}`;
}

const dateLabel = (time: number) => new Date(time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** The model picker's details step uses the same reported connection and freshness as the sidebar. */
export function ModelUsageDetails({ onClose }: { onClose: () => void }) {
  const catalog = useModels();
  const loading = catalog.status === 'loading' || catalog.status === 'idle';
  const failed = !loading && (catalog.status === 'error' || !!catalog.error);
  const known = !loading && !failed && catalog.billing !== null && catalog.provider !== null;
  const planMode = known && catalog.billing === 'plan';
  const name = known ? connectionName(catalog.provider, catalog.plan) : '';
  const { windows, checkedAt, state: usageState } = useReportedPlanUsage(planMode ? catalog.usage : null);
  const manage = () => { onClose(); useConfigUI.getState().openAppSettings(planMode || !known ? 'subscriptions' : 'keys'); };
  return <section className={`usage-mode__panel${planMode ? ' is-plan' : ''}`} aria-label="Connection and usage">
    <header className="usage-mode__heading">
      <span className="usage-mode__eyebrow">{loading ? 'Connection' : failed ? 'Connection needs attention' : !known ? 'Connection' : planMode ? 'Plan' : 'API credits'}</span>
      <h2>{loading ? 'Checking your connection…' : failed ? 'Check your connection' : !known ? 'Choose how your Bots run' : planMode ? catalog.plan ? `Your ${name} plan` : `${name} subscription` : name}</h2>
      <p>{loading ? 'Getting the latest connection and usage information.' : failed ? 'We couldn’t verify this connection. Refresh or manage it to check its status.' : !known ? 'Connect a subscription or an API key in Settings.' : planMode ? 'Your Bots use this subscription connection. Provider limits and extra usage settings apply.' : 'Model requests use the connected API key and are billed by usage.'}</p>
    </header>
    {known && (planMode ? <div className="usage-mode__usage">
      {windows.length ? windows.map((w, i) => <div className="usage-mode__window" key={`${w.label}-${i}`}>
        <div className="usage-mode__window-title"><span>{w.label}</span><strong>{Number(w.usedPercent.toFixed(1))}% used</strong></div>
        <progress aria-label={w.label} max={100} value={w.usedPercent} />
        <span className="usage-mode__muted">{w.resetsAt !== null ? `Resets ${dateLabel(w.resetsAt)}` : 'Reset time unavailable'}</span>
      </div>) : <p className="usage-mode__empty">{usageState === 'stale' ? 'Usage needs a refresh. Previous limits may no longer be current.' : 'Usage isn’t available from your provider right now. Check your provider account for current limits.'}</p>}
      {checkedAt !== null && <p className="usage-mode__muted">Last checked {dateLabel(checkedAt)} · {catalog.provider === 'claude-cli' ? 'Claude' : 'Codex'}</p>}
    </div> : <div className="usage-mode__api-note"><strong>Pay per use</strong><p>View recorded spending in Usage. Your provider manages key balances and budgets.</p></div>)}
    <p className="usage-mode__scope">Model usage only. Voice and other services have separate billing.</p>
    <PlanConnections onClose={onClose} />
    <footer className="usage-mode__actions">
      <button type="button" onClick={() => void catalog.load(true)} disabled={loading}><RefreshCw size={14} aria-hidden />{loading ? 'Checking…' : 'Refresh'}</button>
      {known && !planMode && <button type="button" onClick={() => { onClose(); useConfigUI.getState().openAppSettings('usage'); }}>View usage</button>}
      <button type="button" className="usage-mode__manage" onClick={manage} disabled={loading}>Manage connection <span aria-hidden>→</span></button>
    </footer>
  </section>;
}
