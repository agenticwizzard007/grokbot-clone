import { ChevronRight, Gauge } from 'lucide-react';
import { useConfigUI } from '../configStore';
import { useReportedPlanUsage } from '../lib/accessPlanUsage';
import { useModels } from '../lib/models';

/** Passive summary of the same catalog used by the composer. Rendering never probes a provider. */
export function SidebarUsage({ collapsed }: { collapsed: boolean }) {
  const catalog = useModels();
  const plan = catalog.billing === 'plan';
  const known = catalog.status === 'ready' && !!catalog.provider && !!catalog.billing && !catalog.error;
  const reported = useReportedPlanUsage(known && plan ? catalog.usage : null);
  const window = reported.windows[0];
  const label = catalog.status === 'loading' ? 'Checking connection…' : !known ? 'Check connection'
    : plan ? catalog.plan || (catalog.provider === 'claude-cli' ? 'Claude subscription' : 'Codex subscription') : 'API credits';
  const detail = !known ? 'Choose how your Bots run' : !plan ? 'Pay per use · View recorded spending'
    : window ? `${window.label} · ${Number(window.usedPercent.toFixed(1))}% used` : reported.state === 'stale' ? 'Usage needs a refresh' : 'Provider usage unavailable';
  return <button type="button" className="sidebar-usage" aria-label={`Usage: ${label}. ${detail}`}
    title={collapsed ? `${label} · ${detail}` : undefined}
    onClick={() => useConfigUI.getState().openAppSettings(known && !plan ? 'usage' : 'subscriptions')}>
    {collapsed ? <Gauge size={20} aria-hidden /> : <>
      <span className="sidebar-usage__row"><span><small>Usage</small><strong>{label}</strong></span><ChevronRight size={16} aria-hidden /></span>
      {window && <progress max={100} value={window.usedPercent} aria-label={`${window.label} usage`} />}
      <span className="sidebar-usage__detail">{detail}</span>
      {window?.resetsAt != null && Number.isFinite(window.resetsAt) && <span className="sidebar-usage__detail">Resets {new Date(window.resetsAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>}
    </>}
  </button>;
}
