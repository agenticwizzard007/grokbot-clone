import { Gauge } from 'lucide-react';
import { ProviderMark } from './ProviderMark';
import { providerBrand } from '../lib/providerBrand';
import { useStore } from '../store';
import { useConfigUI } from '../configStore';
import { usePlanUsage } from '../lib/planUsage';
import { planUsageDisplay } from '../lib/planUsageDisplay';
import { PlanUsageContent } from './PlanUsageContent';

/** Account-scoped plan figures come only from GET /api/usage/summary. */
export function SidebarUsage({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const { summary, error, refresh } = usePlanUsage();
  const timezone = useStore(s => (s.user as { timezone?: string | null } | null)?.timezone);
  const view = summary && planUsageDisplay(summary.plan, timezone);
  const unavailable = error || !!summary && summary.plan.unit === 'percent' && view?.percent === null;
  const label = unavailable ? 'Usage unavailable' : summary ? `Usage: ${summary.plan.name}. ${view!.amount}. ${summary.plan.unit === 'usd' ? view!.status : ''} ${view!.warning}. ${view!.reset}` : 'Loading usage...';
  return <button type="button" className={`sidebar-usage${unavailable ? ' is-unavailable' : ''}`} aria-label={collapsed ? label : undefined}
    title={collapsed ? label : undefined}
    onClick={() => { if (error) void refresh(); useConfigUI.getState().openAppSettings('usage'); onNavigate?.(); }}>
    {collapsed ? providerBrand(summary?.plan.provider) ? <ProviderMark provider={summary?.plan.provider} /> : <Gauge size={20} aria-hidden /> : <>
      {unavailable ? <span className="sidebar-usage__unavailable">Usage unavailable</span> : <><span className="sr-only">Usage</span><PlanUsageContent summary={summary} error={error} sidebar /></>}
    </>}
  </button>;
}
