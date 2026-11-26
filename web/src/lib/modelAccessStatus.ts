import { planLabel } from './planLabel';
import type { CliProvider, CliStatus } from './cliApi';
import { PLAN_PROVIDERS, planState, subscriptionReady } from './planConnections';

/** Runtime availability, CLI authentication and the selected route are separate facts. */
export function modelAccessStatus(status: CliStatus | null, provider: CliProvider, stale = false, plan: string | null = null) {
  const info = PLAN_PROVIDERS.find(item => item.id === provider)!;
  const health = status?.providers[provider];
  const { unavailable, checking, connected, canConnect, probeFailed } = planState(status, provider, stale);
  const currentlyInUse = connected && status?.selected === provider;
  const connection = unavailable ? 'Status unavailable' : connected ? 'Connected' : checking ? 'Checking' : 'Not connected';
  const action = connected ? `Use ${info.name}` : canConnect ? `Connect ${info.name}` : null;
  let details = `${info.cli} status has not been checked.`;
  if (!checking && status && !status.connected) details = `${info.cli} status cannot be verified while ${status.runtime === 'bridge' ? 'your computer bridge is offline' : 'the CLI runtime is unavailable'}.`;
  else if (unavailable) details = `${info.cli} status could not be verified. Refresh status to try again.`;
  else if ((!checking || connected) && health) {
    details = `${info.cli} ${health.installed ? 'installed' : 'not installed'} · ${health.authenticated ? 'Signed in' : 'Not signed in'} · ${health.subscription ? plan ? planLabel(provider, plan) : 'Eligible plan confirmed' : 'Eligible plan not confirmed'}`;
  }

  let currentRoute: string;
  if (!status) currentRoute = 'Checking which model route your Bots use.';
  else if (stale || status.statusUnavailable) currentRoute = 'Your Bots\' current model route could not be verified; refresh status to try again.';
  else if (status.selected) {
    const selected = PLAN_PROVIDERS.find(item => item.id === status.selected)!;
    const route = `your ${selected.name} through ${selected.cli}`;
    if (status.statusChecking && !subscriptionReady(status.providers[status.selected])) {
      currentRoute = `Your Bots are set to use ${route}; its connection is being checked.`;
    } else if (!status.connected || !subscriptionReady(status.providers[status.selected])) {
      currentRoute = `Your Bots are set to use ${route}, but that connection is not ready.`;
    } else {
      currentRoute = `Your Bots currently use ${route}${status.selected === provider ? '.' : `; ${connected ? `choose Use ${info.name}` : `connect your ${info.name}`} to switch.`}`;
    }
  } else {
    currentRoute = `Your Bots currently use API providers; ${connected ? `choose Use ${info.name}` : `connect your ${info.name}`} to switch.`;
  }
  const hasSavedState = !!health?.authenticated || !!health?.hasSavedState;
  return { connection, connected, checking, unavailable, canConnect, currentlyInUse, details, currentRoute, action, hasSavedState, probeFailed };
}
