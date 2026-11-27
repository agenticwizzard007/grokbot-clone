import type { PlanUsageSummary } from './plan-usage-types.js';
import { db } from './db.js';
import { env } from './env.js';
import { rangeBounds, usageTimezone, type UsageRange } from './usage.js';
import { reportDay, reportDayStart, shiftDay } from './report-days.js';
import { selectedCli } from './cli/store.js';
import { cachedCliCatalog } from './cli/catalog.js';
export { displayUsagePercent } from './plan-usage-percent.js';

export const OWN_KEYS_LABEL = 'On your own keys (does not count toward the plan)';

/** Round every event before summing, using precisely the same rule as the ledger fixtures. */
db.function('plan_event_cents', { deterministic: true }, value => typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) : 0);

interface Amounts { usedCents: number; requests: number; estimatedCents: number; unpricedRequests: number }
const empty = (): Amounts => ({ usedCents: 0, requests: 0, estimatedCents: 0, unpricedRequests: 0 });
interface UsageDay { day: string; planUsedCents: number; ownKeysUsedCents: number; uncategorizedCents: number }

/** All intervals are [start, end). The observation includes rows recorded at computedAt. */
function ledgerPeriod(userId: string, start: number, end: number, at: number, timezone: string) {
  const days: UsageDay[] = [];
  for (let day = reportDay(start, timezone); reportDayStart(day, timezone) < end; day = shiftDay(day, 1)) {
    days.push({ day, planUsedCents: 0, ownKeysUsedCents: 0, uncategorizedCents: 0 });
  }
  const plan = empty(), ownKeys = empty(), uncategorized = empty();
  // A small set of calendar boundaries avoids formatting every event in a large ledger.
  const dayCase = `CASE ${days.map(() => 'WHEN created_at>=? THEN ?').join(' ')} END`;
  const boundaries = [...days].reverse().flatMap(({ day }) => [reportDayStart(day, timezone), day]);
  const rows = db.prepare(`SELECT ${dayCase} day, key_kind,
    COALESCE(SUM(plan_event_cents(cost_usd)),0) usedCents, COUNT(*) requests,
    COALESCE(SUM(CASE WHEN cost_source='estimate' THEN plan_event_cents(cost_usd) ELSE 0 END),0) estimatedCents,
    SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) unpricedRequests
    FROM usage_events WHERE user_id=? AND created_at>=? AND created_at<? AND created_at<=?
    GROUP BY day,key_kind`).all(...boundaries, userId, start, end, at) as (Amounts & { day: string; key_kind: string })[];
  for (const row of rows) {
    if (row.key_kind === 'subscription') continue;
    const target = row.key_kind === 'native' ? plan : row.key_kind === 'personal' ? ownKeys : uncategorized;
    for (const key of ['usedCents', 'requests', 'estimatedCents', 'unpricedRequests'] as const) target[key] += row[key];
    const day = days.find(day => day.day === row.day)!;
    day[row.key_kind === 'native' ? 'planUsedCents' : row.key_kind === 'personal' ? 'ownKeysUsedCents' : 'uncategorizedCents'] += row.usedCents;
  }
  return { start, end, plan, ownKeys, uncategorized, days };
}

/** Dashboard costUsd means plan-counted USD, excluding own keys and computer estimates. */
export function planUsageRange(userId: string, range: UsageRange, at = Date.now()) {
  const timezone = usageTimezone(userId);
  const { from } = rangeBounds(range, at, timezone);
  const end = reportDayStart(shiftDay(reportDay(at, timezone), 1), timezone);
  const result = ledgerPeriod(userId, from, end, at, timezone);
  return { ...result, planUsedCents: result.plan.usedCents, ownKeysUsedCents: result.ownKeys.usedCents };
}

function configuredLimit(): number | null {
  const raw = env.planLimitUsd.trim();
  if (!raw) return null;
  const cents = Math.round(Number(raw) * 100);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

function subscriptionName(provider: 'claude' | 'codex', plan?: string | null) {
  if (provider === 'codex') return 'Codex plan';
  const code = plan?.trim().toLowerCase().replace(/^claude[ _]+/, '').replace(/[ _]+plan$/, '').replace(/^max[ _](?:5x|20x)$/, 'max') ?? '';
  const tiers: Record<string, string> = { pro: 'Pro', max: 'Max', team: 'Team', ultra: 'Ultra', enterprise: 'Enterprise' };
  return Object.hasOwn(tiers, code) ? `Claude ${tiers[code]} plan` : 'Claude plan';
}

/** Read-only account summary. No provider discovery or key-wide billing requests. */
export function planUsageSummary(userId: string, at = Date.now()): PlanUsageSummary {
  const timezone = usageTimezone(userId);
  const month = `${reportDay(at, timezone).slice(0, 7)}-01`;
  const nextMonth = new Date(`${month}T00:00:00Z`);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  const periodStart = reportDayStart(month, timezone);
  const periodEnd = reportDayStart(nextMonth.toISOString().slice(0, 10), timezone);
  const period = ledgerPeriod(userId, periodStart, periodEnd, at, timezone);
  const week = planUsageRange(userId, '7d', at);
  const cli = selectedCli(userId);
  const catalog = cli ? cachedCliCatalog(userId, cli) : null;
  // A subscription never inherits the configured API dollar allowance.
  const limitCents = cli ? null : configuredLimit();
  const observed = catalog?.usage;
  const windows = observed?.available && observed.checkedAt <= at && at - observed.checkedAt < 30_000
    ? observed.windows.filter(window => Number.isFinite(window.usedPercent) && (window.resetsAt === null || window.resetsAt > at)) : [];
  const window = windows.reduce<(typeof windows)[number] | null>((best, item) => !best || item.usedPercent > best.usedPercent ? item : best, null);
  const rawPercent = limitCents === null ? null : period.plan.usedCents / limitCents * 100;
  return {
    plan: {
      name: env.planName.trim() || (cli ? subscriptionName(cli, catalog?.plan) : 'API credits'),
      billing: cli ? 'plan' as const : 'api' as const,
      provider: cli ? `${cli}-cli` : null,
      periodStart, periodEnd,
      usedCents: period.plan.usedCents, limitCents,
      percentUsed: cli ? window?.usedPercent ?? null : rawPercent !== null && Number.isFinite(rawPercent) ? rawPercent : null,
      unit: cli ? 'percent' as const : 'usd' as const,
      resetsAt: cli ? window?.resetsAt ?? null : periodEnd,
      estimatedCents: period.plan.estimatedCents, unpricedRequests: period.plan.unpricedRequests,
    },
    ownKeys: { ...period.ownKeys, label: OWN_KEYS_LABEL },
    uncategorized: { ...period.uncategorized, label: 'Historical usage with unknown key source' },
    week: { start: week.start, end: week.end, planUsedCents: week.planUsedCents, ownKeysUsedCents: week.ownKeysUsedCents,
      uncategorizedCents: week.uncategorized.usedCents, days: week.days },
    computedAt: at,
  };
}

export type PlanUsageSummary = ReturnType<typeof planUsageSummary>;
