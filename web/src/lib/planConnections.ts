import type { CliProvider, CliProviderStatus, CliStatus } from './cliApi';

export const PLAN_PROVIDERS = [
  { id: 'claude', name: 'Claude plan', cli: 'Claude Code', plans: 'Pro, Max and other supported Claude plans' },
  { id: 'codex', name: 'ChatGPT plan', cli: 'Codex', plans: 'Eligible ChatGPT plans' },
] as const;

export const subscriptionReady = (health: CliProviderStatus | undefined) => !!health?.installed && health.authenticated && health.subscription && !health.error;

/** A disconnected bridge has no current installation evidence. Never call its CLI missing. */
export function planConnectionStatus(status: CliStatus | null, provider: CliProvider, plan: string | null = null) {
  if (!status) return 'Checking status…';
  const health = status.providers[provider];
  if (!status.connected) return 'Not connected';
  if (!health.installed) return 'CLI missing';
  if (status.selected !== provider || !subscriptionReady(health)) return 'Not connected';
  return plan ? `Connected as ${plan.replaceAll('_', ' ')}` : 'Connected';
}
