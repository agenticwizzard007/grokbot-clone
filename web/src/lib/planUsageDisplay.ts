import type { PlanUsageSummary } from '@shared/plan-usage-types';
import { displayUsagePercent } from '@shared/plan-usage-percent';

export const usageDollars = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export function planUsageDisplay(plan: PlanUsageSummary['plan']) {
  const percent = displayUsagePercent(plan.percentUsed);
  const amount = plan.unit === 'usd' ? plan.limitCents === null ? usageDollars(plan.usedCents) : `${usageDollars(plan.usedCents)} of ${usageDollars(plan.limitCents)}` : percent === null ? 'Quota unavailable' : `${Number(percent.toFixed(1))}% used`;
  const status = plan.unit === 'usd' && plan.limitCents === null ? 'No limit' : percent === null ? 'Quota unavailable' : `${Number(percent.toFixed(1))}% used`;
  const level = percent !== null && percent >= 100 ? 'critical' : percent !== null && percent >= 80 ? 'warning' : 'normal';
  const warning = level === 'critical' ? 'Limit reached' : level === 'warning' ? 'Near limit' : '';
  const reset = plan.resetsAt !== null && Number.isFinite(plan.resetsAt) ? `Resets ${new Date(plan.resetsAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : 'Reset unavailable';
  return { percent, amount, status, level, warning, reset };
}
