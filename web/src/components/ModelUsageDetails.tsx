import { ProviderMark } from './ProviderMark';
import { planLabel } from '../lib/planLabel';
import { RefreshCw } from 'lucide-react';
import { useModels } from '../lib/models';
import { useConfigUI } from '../configStore';
import { useReportedPlanUsage } from '../lib/accessPlanUsage';
import '../styles/model-usage.css';

const dateLabel = (time: number) => new Date(time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** The model picker's details step uses the same reported connection and freshness as the sidebar. */
export function ModelUsageDetails({ onClose }: { onClose: (afterClose?: () => void) => void }) {
  const catalog = useModels();
  const loading = catalog.status === 'loading' || catalog.status === 'idle';
  const failed = !loading && (catalog.status === 'error' || !!catalog.error);
  const known = !loading && !failed && catalog.billing !== null && catalog.provider !== null;
  const planMode = known && catalog.billing === 'plan';
  const name = known ? catalog.provider === 'openrouter' ? 'OpenRouter' : 'Direct API' : '';
  const { windows, checkedAt, state: usageState } = useReportedPlanUsage(planMode ? catalog.usage : null);
  const manage = () => onClose(() => useConfigUI.getState().openAppSettings(planMode || !known ? 'subscriptions' : 'keys'));
  return <section className={`usage-mode__panel${planMode ? ' is-plan' : ''}`} aria-label="Connection and usage">
    <header className="usage-mode__heading">
      <h2>{known && <><ProviderMark provider={catalog.provider} /> </>}{known ? planMode ? planLabel(catalog.provider, catalog.plan) : name : 'Connection'}</h2>
      {!known && <span className="model-billing" role="status">{loading ? 'Checking' : failed ? 'Unavailable' : 'Not connected'}</span>}
    </header>
    {known && (planMode ? <div className="usage-mode__usage">
      {windows.length ? windows.map((w, i) => <div className="usage-mode__window" key={`${w.label}-${i}`}>
        <div className="usage-mode__window-title"><span>{w.label}</span><strong>{Number(w.usedPercent.toFixed(1))}% used</strong></div>
        <progress aria-label={w.label} max={100} value={w.usedPercent} />
        <span className="usage-mode__muted">{w.resetsAt !== null ? `Resets ${dateLabel(w.resetsAt)}` : 'Reset time unavailable'}</span>
      </div>) : <span className="model-billing" role="status">{usageState === 'stale' ? 'Refresh needed' : 'Usage unavailable'}</span>}
      {checkedAt !== null && <p className="usage-mode__muted">Checked {dateLabel(checkedAt)}</p>}
    </div> : <span className="model-billing">Pay per use</span>)}
    <p className="usage-mode__scope">Voice has separate billing.</p>
    <footer className="usage-mode__actions">
      <button type="button" onClick={() => void catalog.load(true)} disabled={loading}><RefreshCw size={14} aria-hidden />{loading ? 'Checking' : 'Refresh'}</button>
      {known && !planMode && <button type="button" onClick={() => onClose(() => useConfigUI.getState().openAppSettings('usage'))}>View usage</button>}
      <button type="button" className="usage-mode__manage" onClick={manage} disabled={loading}>Manage connection <span aria-hidden>→</span></button>
    </footer>
  </section>;
}
