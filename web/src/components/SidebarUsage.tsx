import { Gauge } from 'lucide-react';
import { ProviderMark } from './ProviderMark';
import { providerBrand } from '../lib/providerBrand';
import { useConfigUI } from '../configStore';
import { usePlanUsage } from '../lib/planUsage';
import { planUsageDisplay } from '../lib/planUsageDisplay';
import { PlanUsageContent } from './PlanUsageContent';

/** Account-scoped plan figures come only from GET /api/usage/summary. */
export function SidebarUsage({ collapsed }: { collapsed: boolean }) {
  const { summary, error, refresh } = usePlanUsage();
  const view = summary && planUsageDisplay(summary.plan);
  const label = summary ? `Usage: ${summary.plan.name}. ${view!.amount}. ${summary.plan.unit === 'usd' ? view!.status : ''} ${view!.warning}. ${view!.reset}` : error ? 'Usage unavailable. Try again' : 'Loading usage...';
  return <button type="button" className="sidebar-usage" aria-label={collapsed ? label : undefined}
    title={collapsed ? label : undefined}
    onClick={() => { if (error) void refresh(); useConfigUI.getState().openAppSettings(summary?.plan.billing === 'plan' ? 'subscriptions' : 'usage'); }}>
    {collapsed ? providerBrand(summary?.plan.provider) ? <ProviderMark provider={summary?.plan.provider} /> : <Gauge size={20} aria-hidden /> : <>
      <span className="sr-only">Usage</span><PlanUsageContent summary={summary} error={error} sidebar />
    </>}
  </button>;
}
