import { useEffect, useState } from 'react';
import type { PlanUsage } from './models';

const quotaFreshness = 30_000;

export function reportedPlanUsage(usage: PlanUsage | null, now = Date.now()) {
  const checkedAt = usage && Number.isFinite(usage.checkedAt) && usage.checkedAt > 0 && usage.checkedAt <= now + quotaFreshness ? usage.checkedAt : null;
  const valid = usage?.available ? usage.windows.filter(window => Number.isFinite(window.usedPercent) && window.usedPercent >= 0 && window.usedPercent <= 100) : [];
  const stale = valid.length > 0 && (checkedAt === null || now - checkedAt >= quotaFreshness);
  const windows = stale ? [] : valid.map(window => ({ ...window, resetsAt: Number.isFinite(window.resetsAt) ? window.resetsAt : null }))
    .filter(window => window.resetsAt === null || window.resetsAt > now);
  return { state: windows.length ? 'reported' : stale || valid.length ? 'stale' : 'unavailable', checkedAt, windows } as const;
}

export function useReportedPlanUsage(usage: PlanUsage | null) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!usage?.available) return;
    const update = () => tick(value => value + 1);
    const now = Date.now();
    const boundary = [usage.checkedAt + quotaFreshness, ...usage.windows.map(window => window.resetsAt ?? 0)];
    const timers = boundary.filter(time => Number.isFinite(time) && time > now && time - now < quotaFreshness + 1000)
      .map(time => window.setTimeout(update, time - now + 1));
    window.addEventListener('focus', update);
    return () => { timers.forEach(window.clearTimeout); window.removeEventListener('focus', update); };
  }, [usage]);
  return reportedPlanUsage(usage);
}
