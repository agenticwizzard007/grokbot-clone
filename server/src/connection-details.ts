import type { Composio } from '@composio/core';

export type ConnectionStatus = 'active' | 'needs_reauth' | 'failed' | 'pending' | 'unknown';
export interface ConnectionDetails {
  accountLabel: string;
  displayStatus: ConnectionStatus;
  connectedAt: string | null;
}
export function connectionStatus(status: string, disabled = false): ConnectionStatus {
  if (disabled) return 'needs_reauth';
  switch (status.toUpperCase().replace(/[\s-]+/g, '_')) {
    case 'ACTIVE': case 'CONNECTED': return 'active';
    case 'EXPIRED': case 'REVOKED': case 'INACTIVE': case 'DISABLED': case 'NEEDS_REAUTH': case 'REAUTH_REQUIRED': case 'AUTHORIZATION_REQUIRED': return 'needs_reauth';
    case 'FAILED': case 'ERROR': return 'failed';
    case 'INITIATED': case 'INITIALIZING': case 'INITIATING': case 'PENDING': case 'AUTHORIZATION_PENDING': return 'pending';
    default: return 'unknown';
  }
}
export const connectionStatusLabel = (status: ConnectionStatus) => ({
  active: 'Active', needs_reauth: 'Needs reauth', failed: 'Failed', pending: 'Awaiting authorization', unknown: 'Status unavailable',
})[status];
export const fallbackAccountLabel = (id: string) => `Connected account ${id.length > 12 ? `${id.slice(0, 9)}...` : id}`;
export function connectedDate(value: string | null | undefined): string {
  return value && Number.isFinite(Date.parse(value))
    ? `Connected ${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(value))}`
    : 'Connected date unavailable';
}

// Project only known identity fields. Never serialize credential state or provider errors.
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() && value.length <= 320
  && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : undefined;
const email = (value: unknown) => { const candidate = text(value); return candidate && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate : undefined; };
function identity(account: any, gmail: boolean): string | undefined {
  const sources = [account, account?.data, account?.state?.val, account?.params, account?.metadata];
  const profiles = sources.flatMap(s => [s, s?.profile, s?.user, s?.account]);
  for (const p of profiles) {
    const found = email(p?.emailAddress) ?? email(p?.email_address) ?? email(p?.email);
    if (found) return found;
  }
  if (!gmail) for (const p of profiles) {
    const found = text(p?.username) ?? text(p?.login) ?? text(p?.accountIdentifier) ?? text(p?.accountName) ?? text(p?.name) ?? text(p?.alias);
    if (found) return found;
  }
}
function createdAt(account: any): string | null {
  const value = account?.createdAt ?? account?.created_at;
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

/** Display metadata only. Ownership and execution status always come from a fresh scoped list.
 * Each instance belongs to one provider project; entries are also scoped by user and account.
 * Successful metadata lasts five minutes, failed lookups retry after thirty seconds. */
export function createConnectionDetailsCache() {
  const cache = new Map<string, { expires: number; promise: Promise<{ accountLabel?: string; connectedAt: string | null }> }>();
  return {
    clear() { cache.clear(); },
    invalidate(userId: string) { for (const key of cache.keys()) if (JSON.parse(key)[0] === userId) cache.delete(key); },
    async details(client: Composio<any>, userId: string, item: any, signal?: AbortSignal): Promise<ConnectionDetails> {
      const key = JSON.stringify([userId, item.id, item.toolkit.slug]);
      const gmail = item.toolkit.slug === 'gmail';
      const label = identity(item, gmail), date = createdAt(item);
      let entry = cache.get(key);
      if (!entry || Date.now() >= entry.expires) {
        const previous = entry;
        const next = { expires: Date.now() + 300_000, promise: Promise.resolve({ connectedAt: date }) as Promise<{ accountLabel?: string; connectedAt: string | null }> };
        next.promise = (async () => {
          const old = await previous?.promise;
          let accountLabel = label, connectedAt = date ?? old?.connectedAt ?? null;
          const timeout = AbortSignal.timeout(2000);
          const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
          if (!accountLabel || !connectedAt) {
            try {
              const account = await client.connectedAccounts.get(item.id, { signal: bounded });
              accountLabel ??= identity(account, gmail);
              connectedAt ??= createdAt(account);
            } catch { /* A display lookup must not hide a connection. */ }
          }
          if (gmail && !accountLabel && item.status === 'ACTIVE' && !item.isDisabled) {
            try {
              // Gmail users.getProfile: read only, bound to the already verified private account.
              const profile = await client.tools.proxyExecute({ connectedAccountId: item.id,
                endpoint: 'https://gmail.googleapis.com/gmail/v1/users/me/profile', method: 'GET' }, { signal: bounded });
              if (profile.status >= 200 && profile.status < 300) accountLabel = email((profile.data as any)?.emailAddress);
            } catch { /* Keep cached identity or an explicit account-id fallback. */ }
          }
          if (!accountLabel || !connectedAt) next.expires = Date.now() + 30_000;
          return { accountLabel: accountLabel ?? old?.accountLabel, connectedAt };
        })();
        cache.delete(key);
        cache.set(key, next);
        if (cache.size > 2000) cache.delete(cache.keys().next().value!);
        entry = next;
      }
      const saved = await entry.promise;
      return { accountLabel: label ?? saved.accountLabel ?? fallbackAccountLabel(item.id),
        connectedAt: date ?? saved.connectedAt, displayStatus: connectionStatus(item.status, item.isDisabled) };
    },
  };
}
