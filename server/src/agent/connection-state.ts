import { connectionsDetail, type AppConnection } from '../composio.js';
import { db } from '../db.js';
import { isTenant } from '../deployment.js';
import { env } from '../env.js';
import { withUsage } from '../usage-context.js';

export const CONNECTION_STATE_TIMEOUT_MS = 1500;
const MAX_SERVICES = 100;
const STATUSES = new Set(['ACTIVE', 'EXPIRED', 'INITIATED', 'INITIALIZING', 'INACTIVE', 'REVOKED', 'FAILED']);

interface ServiceState {
  toolkit: string;
  status: 'connected' | 'authorization_pending' | 'authorization_required';
  activeAccounts: number;
  pendingAuthorizations: number;
  expiredRecords: number;
  unfinishedAuthorizations: number;
  otherInactiveAccounts: number;
}
export interface ConnectionState {
  status: 'available' | 'unknown';
  scope: 'private_accounts' | 'registered_active_accounts';
  checkedAt: number;
  connectedToolkits: string[] | null;
  activeToolkitCount: number | null;
  totalAccounts: number | null;
  services: ServiceState[] | null;
  truncated: boolean;
  reason?: 'not_configured' | 'timeout' | 'provider_unavailable';
}

// The tenant gateway exposes only registered, provider-verified active accounts.
// Absence there cannot describe expired or unfinished provider authorizations.
const scope: ConnectionState['scope'] = isTenant ? 'registered_active_accounts' : 'private_accounts';

function owned(userId: string, botId: string) {
  if (!userId || !botId || !db.prepare('SELECT 1 FROM bots WHERE id=? AND user_id=?').get(botId, userId)) {
    throw new Error('Connection state is unavailable for this account and Bot.');
  }
}

function summarize(accounts: AppConnection[]): ConnectionState {
  const services = new Map<string, ServiceState>();
  const ids = new Set<string>();
  for (const account of accounts) {
    // A malformed or partial response is unknown, not an empty/complete inventory.
    if (typeof account.id !== 'string' || !account.id || ids.has(account.id) ||
        typeof account.toolkit !== 'string' || !/^[a-z][a-z0-9_]{0,99}$/.test(account.toolkit) ||
        !STATUSES.has(account.status)) throw new Error('Invalid connection inventory.');
    ids.add(account.id);
    let service = services.get(account.toolkit);
    if (!service) {
      service = { toolkit: account.toolkit, status: 'authorization_required', activeAccounts: 0,
        pendingAuthorizations: 0, expiredRecords: 0, unfinishedAuthorizations: 0, otherInactiveAccounts: 0 };
      services.set(account.toolkit, service);
    }
    if (account.status === 'ACTIVE' && !account.isDisabled) service.activeAccounts++;
    else if (account.status === 'EXPIRED') {
      service.expiredRecords++;
      if (account.authorizationIncomplete === true) service.unfinishedAuthorizations++;
    } else if (!account.isDisabled && ['INITIATED', 'INITIALIZING'].includes(account.status)) service.pendingAuthorizations++;
    else service.otherInactiveAccounts++;
    service.status = service.activeAccounts ? 'connected' : service.pendingAuthorizations ? 'authorization_pending' : 'authorization_required';
  }
  const all = [...services.values()].sort((a, b) => Number(!!b.activeAccounts) - Number(!!a.activeAccounts) || a.toolkit.localeCompare(b.toolkit));
  const visible = all.slice(0, MAX_SERVICES);
  return { status: 'available', scope, checkedAt: Date.now(), connectedToolkits: visible.filter(s => s.activeAccounts).map(s => s.toolkit),
    activeToolkitCount: all.filter(s => s.activeAccounts).length, totalAccounts: ids.size,
    services: visible, truncated: all.length > visible.length };
}

/** Native app metadata only: never discovers or executes service tools, starts auth, or changes accounts. */
export async function connectionState(userId: string, botId: string): Promise<ConnectionState> {
  owned(userId, botId);
  const unknown = (reason: NonNullable<ConnectionState['reason']>): ConnectionState => ({
    status: 'unknown', scope, checkedAt: Date.now(), connectedToolkits: null, activeToolkitCount: null,
    totalAccounts: null, services: null, truncated: false, reason,
  });
  if (!env.composioEnabled) return unknown('not_configured');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new Error('Connection lookup timed out.')); }, CONNECTION_STATE_TIMEOUT_MS);
    });
    const accounts = await Promise.race([
      withUsage({ userId, botId }, () => connectionsDetail(userId, { signal: controller.signal })), deadline,
    ]);
    owned(userId, botId);
    return summarize(accounts);
  } catch {
    return unknown(timedOut ? 'timeout' : 'provider_unavailable');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
