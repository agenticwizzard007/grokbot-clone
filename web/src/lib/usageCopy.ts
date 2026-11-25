import type { UsageCoverage } from './configApi';

export function requestHeadline(requests: number): string {
  return `${requests.toLocaleString('en-US')} ${requests === 1 ? 'request' : 'requests'}`;
}

export function tokenCoverageNote(coverage: UsageCoverage): string | null {
  const missing = (coverage.partialUsageRequests ?? 0) + (coverage.unavailableUsageRequests ?? 0);
  return missing > 0 ? `Token counts are incomplete for ${requestHeadline(missing)}; totals include only reported tokens.` : null;
}

export const computerTimeNote = 'Computer on time includes time without a Bot screen open.';

export function billingProviderName(provider: string): string {
  return ({ openrouter: 'OpenRouter', 'codex-cli': 'ChatGPT', 'claude-cli': 'Claude', direct: 'Direct API provider' } as Record<string, string>)[provider] ?? provider;
}


export function reportRangeLabel(days: { day: string }[], timezone = 'UTC'): string | null {
  if (!days.length) return null;
  const label = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const first = label(days[0].day), last = label(days[days.length - 1].day);
  return `${days.length > 1 ? `${first} to ${last}` : first} · ${(timezone || 'UTC').replace(/_/g, ' ')}`;
}
