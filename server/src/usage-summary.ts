/** Billing comes from each recorded request, never the account's current connection. */
export interface BillingSource {
  source: 'api' | 'subscription';
  provider: string;
  requests: number;
  costUsd: number;
  estimatedUsd: number;
  unpricedRequests: number;
}

export function billingNote(sources: BillingSource[]): string {
  const api = sources.some(source => source.source === 'api' && source.requests > 0);
  const plan = sources.some(source => source.source === 'subscription' && source.requests > 0);
  const parts: string[] = [];
  if (plan) parts.push("CLI requests use each account's own provider subscription, with no Swarm API charge");
  if (api) parts.push('API requests are billed per request by the provider at the recorded cost');
  if (!api && !plan) parts.push('No API or CLI plan requests were recorded in this period');
  parts.push('computer time is estimated');
  return `${parts.join('; ')}.`;
}
