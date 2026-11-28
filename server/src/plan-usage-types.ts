/** Read-only GET /api/usage/summary contract. All money is integer USD cents. */
export interface UsageAmounts {
  usedCents: number;
  requests: number;
  estimatedCents: number;
  unpricedRequests: number;
  label: string;
}
export interface PlanUsageSummary {
  plan: {
    softLimit?: boolean;
    softLimitExceeded?: boolean;
    source?: 'tenant';
    reportedAt?: string | null;
    name: string;
    billing: 'api' | 'plan';
    provider: string | null;
    periodStart: number;
    periodEnd: number;
    usedCents: number;
    limitCents: number | null;
    percentUsed: number | null;
    unit: 'usd' | 'percent';
    resetsAt: number | null;
    estimatedCents: number;
    unpricedRequests: number;
  };
  ownKeys: UsageAmounts;
  uncategorized: UsageAmounts;
  week: {
    start: number;
    end: number;
    planUsedCents: number;
    ownKeysUsedCents: number;
    uncategorizedCents: number;
    days: { day: string; planUsedCents: number; ownKeysUsedCents: number; uncategorizedCents: number }[];
  };
  computedAt: number;
}
