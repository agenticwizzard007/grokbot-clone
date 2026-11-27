import { planUsageSummary } from '../../plan-usage.js';
import type { SourceData } from './catalog.js';

/** Backward-compatible window fields, with the same account summary as the sidebar.
 * A missing CLI observation is unknown; an API null limit is unlimited. No discovery. */
export function cachedWindows(userId: string): SourceData {
  const { plan, ownKeys } = planUsageSummary(userId);
  return { available: true, count: 1,
    rows: [{ label: plan.name, usedPercent: plan.percentUsed, resetsAt: plan.resetsAt }],
    value: { plan, ownKeys } };
}
