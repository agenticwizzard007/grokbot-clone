import { ProviderLabel, ProviderMark } from './ProviderMark';
import { providerBrand } from '../lib/providerBrand';
import { planLabel } from '../lib/planLabel';
import { useEffect, useState } from 'react';
import { ChevronRight, Gauge } from 'lucide-react';
import { useConfigUI } from '../configStore';
import { useReportedPlanUsage } from '../lib/accessPlanUsage';
import { useSidebarUsageSummary } from '../lib/sidebarUsageCache';

/** Passive summary of the same catalog used by the composer. Rendering never probes a provider. */
export function SidebarUsage({ collapsed }: { collapsed: boolean }) {
  const { catalog, summary, stale } = useSidebarUsageSummary();
  const plan = summary?.billing === 'plan';
  const known = !!summary;
  const reported = useReportedPlanUsage(known && plan ? summary?.usage ?? null : null);
  const window = reported.windows[0];
  const pending = !known && (catalog.status === 'idle' || catalog.status === 'loading');
  const failed = catalog.status === 'error' || !!catalog.error;
  const refreshing = stale && !failed && (catalog.status === 'idle' || catalog.status === 'loading');
  const [slowRefresh, setSlowRefresh] = useState(false);
  useEffect(() => {
    setSlowRefresh(false);
    if (!refreshing) return;
    const timer = setTimeout(() => setSlowRefresh(true), 2000);
    return () => clearTimeout(timer);
  }, [refreshing]);
  const label = pending ? 'Loading usage...' : !known ? 'Unavailable'
    : plan ? planLabel(summary?.provider, summary?.plan) : 'API credits';
  const detail = pending ? 'Loading provider details...' : !known ? 'Retry provider details' : !plan ? 'Pay per use · View recorded spending'
    : window ? `${window.label} · ${Number(window.usedPercent.toFixed(1))}% used` : reported.state === 'stale' ? 'Usage needs a refresh' : 'Usage limits not reported';
  return <button type="button" className="sidebar-usage" aria-label={`Usage: ${label}. ${detail}`}
    title={collapsed ? `${label} · ${detail}` : undefined}
    onClick={() => { if (failed) void catalog.load(true); else useConfigUI.getState().openAppSettings(known && !plan ? 'usage' : 'subscriptions'); }}>
    {collapsed ? providerBrand(summary?.provider) ? <ProviderMark provider={summary?.provider} /> : <Gauge size={20} aria-hidden /> : <>
      <span className="sidebar-usage__row"><span><small>Usage</small><strong><ProviderLabel provider={summary?.provider}>{label}</ProviderLabel></strong></span><ChevronRight size={16} aria-hidden /></span>
      {window && <progress max={100} value={window.usedPercent} aria-label={`${window.label} usage`} />}
      <span className="sidebar-usage__detail">{detail}</span>
      {stale && (failed || (refreshing && slowRefresh)) && <span className="sidebar-usage__detail">Previously loaded{failed ? ' · Retry' : ' · Refreshing…'}</span>}
      {window?.resetsAt != null && Number.isFinite(window.resetsAt) && <span className="sidebar-usage__detail">Resets {new Date(window.resetsAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>}
    </>}
  </button>;
}
