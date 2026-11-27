import type { PlanUsageSummary } from '@shared/plan-usage-types';
import { planUsageDisplay, usageDollars } from '../lib/planUsageDisplay';
import { useStore } from '../store';
import { ProviderLabel } from './ProviderMark';
import '../styles/plan-usage.css';

export function PlanUsageContent({ summary, error = false, sidebar = false }: { summary: Pick<PlanUsageSummary, 'plan' | 'ownKeys'> | null; error?: boolean; sidebar?: boolean }) {
  const timezone = useStore(s => (s.user as { timezone?: string | null } | null)?.timezone);
  const view = summary && planUsageDisplay(summary.plan, timezone);
  return <span className="plan-usage" data-level={view?.level ?? 'normal'}>
    <strong className="plan-usage__name">{summary?.plan.provider ? <ProviderLabel provider={summary.plan.provider}>{summary.plan.name}</ProviderLabel> : summary?.plan.name ?? (error ? 'Usage unavailable' : 'Loading usage...')}</strong>
    <span className="plan-usage__amount">{view?.amount ?? (error ? 'Try again' : 'Loading amount')}</span>
    <span className="plan-usage__quota">
      {view?.percent != null && <progress max={100} value={view.percent} aria-label={`${summary!.plan.name} usage`} />}
      <span className="plan-usage__status">{view ? <>{summary!.plan.unit === 'usd' && <span>{view.status}</span>}{view.warning && <span>{view.warning}</span>}</> : ' '}</span>
    </span>
    <span className="plan-usage__reset">{error && summary ? 'Update unavailable' : view?.reset ?? ' '}</span>
    {(summary && (summary.ownKeys.usedCents > 0 || summary.ownKeys.requests > 0)) && <span className="plan-usage__own">{usageDollars(summary.ownKeys.usedCents)} {summary.ownKeys.label}</span>}
    {!sidebar && summary && (summary.plan.estimatedCents > 0 || summary.plan.unpricedRequests > 0) && <span className="plan-usage__note">{[
      summary.plan.estimatedCents > 0 ? `${usageDollars(summary.plan.estimatedCents)} estimated` : '',
      summary.plan.unpricedRequests > 0 ? `${summary.plan.unpricedRequests} unpriced requests` : '',
    ].filter(Boolean).join(' · ')}</span>}
  </span>;
}
