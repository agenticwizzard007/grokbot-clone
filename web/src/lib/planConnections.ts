import { planLabel } from './planLabel';
import type { CliProvider, CliProviderStatus, CliStatus } from './cliApi';

export const PLAN_PROVIDERS = [
  { id: 'claude', name: 'Claude plan', cli: 'Claude Code', plans: 'Pro, Max and other supported Claude plans' },
  { id: 'codex', name: 'ChatGPT plan', cli: 'Codex', plans: 'Eligible ChatGPT plans' },
] as const;

export const subscriptionReady = (health: CliProviderStatus | undefined) => !!health?.installed && health.authenticated && health.subscription && !health.error;

/** Only a completed, successful check can offer a new connection. */
export function planState(status: CliStatus | null, provider: CliProvider, stale = false) {
  const health = status?.providers[provider];
  const missing = health?.installed === false && (!health.error || health.error === 'CLI executable is not installed.');
  const notSetUp = provider === 'claude' && !health?.authenticated && (missing || health?.hasSavedState === false);
  const probeFailed = !notSetUp && !!health?.error && (!health.authenticated || health.subscription);
  const checking = !status || !!status.statusChecking;
  const unavailable = stale || !!status?.statusUnavailable || probeFailed || !!status && !status.connected && !checking;
  const connected = !unavailable && !!status?.connected && subscriptionReady(health);
  return { connected, checking, unavailable, probeFailed, canConnect: !checking && !unavailable && !connected };
}

/** A disconnected bridge has no current installation evidence. Never call its CLI missing. */
export function planConnectionStatus(status: CliStatus | null, provider: CliProvider, plan: string | null = null) {
  const state = planState(status, provider);
  if (state.unavailable) return 'Status unavailable';
  if (state.connected) return plan ? `Connected with ${planLabel(provider, plan)}` : 'Connected';
  if (state.checking || !status) return 'Checking';
  const health = status.providers[provider];
  if (!status.connected) return 'Not connected';
  if (!health.installed) return 'CLI missing';
  return 'Not connected';
}

/** Connected plans use management wording; unknown status stays neutral. */
export function planMenuLabel(status: CliStatus | null) {
  if (!status || status.statusUnavailable || !status.connected) return 'Plans';
  const providers = PLAN_PROVIDERS.map(provider => status.providers[provider.id]);
  if (status.connected && providers.some(subscriptionReady)) return 'Manage plans';
  if (status.statusChecking || providers.some(health => !health || health.error && (!health.authenticated || health.subscription))) return 'Plans';
  return 'Connect plan';
}
