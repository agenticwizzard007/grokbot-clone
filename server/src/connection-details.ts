import type { Composio } from '@composio/core';

export type ConnectionStatus = 'active' | 'needs_reauth' | 'failed' | 'pending' | 'unknown';
export interface ConnectionDetails {
  accountLabel: string;
  displayStatus: ConnectionStatus;
  connectedAt: string | null;
  authorizationIncomplete?: boolean;
}
export function connectionStatus(status: string, disabled = false): ConnectionStatus {
  if (disabled) return 'needs_reauth';
  switch (status.toUpperCase().replace(/[\s-]+/g, '_')) {
    case 'ACTIVE': case 'CONNECTED': return 'active';
    case 'EXPIRED': case 'REVOKED': case 'INACTIVE': case 'DISABLED': case 'NEEDS_REAUTH': case 'REAUTH_REQUIRED': case 'AUTHORIZATION_REQUIRED': return 'needs_reauth';
    case 'FAILED': case 'ERROR': return 'failed';
    case 'INITIATED': case 'INITIALIZING': case 'INITIATING': case 'PENDING': case 'AUTHORIZATION_PENDING': case 'AWAITING_AUTHORIZATION': return 'pending';
    default: return 'unknown';
  }
}
export const connectionStatusLabel = (status: ConnectionStatus) => ({
  active: 'Active', needs_reauth: 'Needs reconnecting', failed: 'Failed', pending: 'Awaiting authorization', unknown: 'Status unavailable',
})[status];
export const fallbackAccountLabel = (id: string) => `Connected account ${id.length > 12 ? `${id.slice(0, 9)}...` : id}`;
export function connectedDate(value: string | null | undefined): string {
  return value && Number.isFinite(Date.parse(value))
    ? `Connected ${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(value))}`
    : 'Connected date unavailable';
}

type DisplayConnection = { id: string; status: string; isDisabled?: boolean; authorizationIncomplete?: boolean };
/** Presentation only. Never remove provider records or change execution authorization. */
export function visibleConnections<T extends DisplayConnection>(accounts: T[]): T[] {
  const seen = new Set<string>();
  return [...accounts].sort((a, b) => Number(connectionStatus(b.status, b.isDisabled) === 'active') - Number(connectionStatus(a.status, a.isDisabled) === 'active')).filter(account => {
    const status = connectionStatus(account.status);
    if (seen.has(account.id) || account.authorizationIncomplete || ['pending', 'failed'].includes(status)) return false;
    seen.add(account.id);
    return true;
  });
}

export function unfinishedAuthorization(account: { status: string; statusReason?: string | null }): boolean {
  return account.status === 'EXPIRED' && [
    'Authorization was started but not completed within 10 minutes',
    'Connection expired before authorization was started',
  ].includes(account.statusReason?.trim().replace(/\.$/, '') ?? '');
}

// Only known identity containers and fields, never arbitrary credential strings.
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() && value.length <= 320
  && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : undefined;
const email = (value: unknown) => { const candidate = text(value); return candidate && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate : undefined; };
export function connectionIdentity(account: any, toolkit: string): string | undefined {
  const sources: any[] = [];
  const visit = (value: any, depth: number) => {
    if (!value || typeof value !== 'object' || depth > 5 || sources.includes(value)) return;
    sources.push(value);
    for (const key of ['data', 'params', 'state', 'val', 'connectionParams', 'connection_params', 'metadata', 'profile', 'user', 'member', 'account', 'person', 'owner', 'bot', 'authed_user', 'response_data']) visit(value[key], depth + 1);
  };
  visit(account, 0);
  const first = (read: (p: any) => string | undefined) => sources.map(read).find(Boolean);
  const address = first(p => email(p.emailAddress) ?? email(p.email_address) ?? email(p.email) ?? email(p.displayName) ?? email(p.display_name));
  if (toolkit === 'slack') {
    const workspace = first(p => text(p.team?.name) ?? text(p.team?.domain) ?? text(p.team) ?? text(p.team_name) ?? text(p.workspace?.name) ?? text(p.workspace_name));
    const user = first(p => text(p.user?.real_name) ?? text(p.user?.name) ?? text(p.user?.profile?.display_name) ?? text(p.user) ?? text(p.user_name))
      ?? address ?? first(p => text(p.real_name) ?? text(p.display_name) ?? text(p.displayName) ?? text(p.name));
    return [workspace, user].filter((v, i, all) => v && all.indexOf(v) === i).join(' · ') || undefined;
  }
  if (toolkit === 'notion') return first(p => text(p.workspace_name) ?? text(p.workspace?.name)) ?? address ?? first(p => text(p.name));
  if (toolkit === 'github' || toolkit === 'gitlab') return first(p => text(p.login) ?? text(p.username)) ?? address;
  if (['gmail', 'googlecalendar', 'googledrive', 'googledocs', 'googlesheets'].includes(toolkit)) return address;
  return address ?? first(p => text(p.username) ?? text(p.login) ?? text(p.displayName) ?? text(p.accountIdentifier) ?? text(p.accountName) ?? text(p.name));
}
function createdAt(account: any): string | null {
  const value = account?.createdAt ?? account?.created_at;
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

// Explicit read-only fallbacks for providers whose metadata omits a current-user endpoint.
const PROFILE_ENDPOINTS: Record<string, string> = {
  gmail: 'https://gmail.googleapis.com/gmail/v1/users/me/profile',
  slack: 'https://slack.com/api/auth.test', github: 'https://api.github.com/user',
  notion: 'https://api.notion.com/v1/users/me',
  googledrive: 'https://www.googleapis.com/drive/v3/about?fields=user',
  googlecalendar: 'https://www.googleapis.com/oauth2/v2/userinfo',
  googledocs: 'https://www.googleapis.com/oauth2/v2/userinfo',
  googlesheets: 'https://www.googleapis.com/oauth2/v2/userinfo',
};
function logLookup(toolkit: string, stage: string, error?: any) {
  // Do not log exception messages, payloads, identifiers, headers, or credentials.
  const status = error?.status ?? error?.cause?.status;
  const reason = typeof status === 'number' ? `http_${status}`
    : ['TimeoutError', 'AbortError'].includes(error?.name) ? 'timeout' : error ? 'request_failed' : 'identity_missing';
  console.warn('[connection-identity]', { toolkit: /^[a-z0-9_]{1,80}$/.test(toolkit) ? toolkit : 'other', stage, reason });
}
async function bounded<T>(signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(new DOMException('Lookup timed out', 'TimeoutError')), 1200);
  try {
    return await Promise.race([work(controller.signal), new Promise<never>((_, reject) => {
      if (controller.signal.aborted) reject(controller.signal.reason);
      else controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    })]);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

/** Scoped to provider project (one instance), user and account. Keep last good labels
 * on failure and invalidation; never cache an empty result for more than five seconds. */
export function createConnectionDetailsCache() {
  type Saved = { accountLabel?: string; connectedAt: string | null };
  const cache = new Map<string, { expires: number; promise: Promise<Saved> }>();
  return {
    clear() { cache.clear(); },
    invalidate(userId: string) { for (const [key, entry] of cache) if (JSON.parse(key)[0] === userId) entry.expires = 0; },
    async details(client: Composio<any>, userId: string, item: any, signal?: AbortSignal): Promise<ConnectionDetails> {
      const toolkit: string = item.toolkit.slug;
      const key = JSON.stringify([userId, item.id, toolkit]);
      const label = connectionIdentity(item, toolkit), date = createdAt(item);
      const status = connectionStatus(item.status, item.isDisabled);
      let entry = cache.get(key);
      if (!entry || Date.now() >= entry.expires) {
        const previous = entry;
        const next = { expires: Date.now() + 300_000, promise: Promise.resolve({ connectedAt: date }) as Promise<Saved> };
        next.promise = (async () => {
          const old = await previous?.promise;
          let accountLabel = label, connectedAt = date ?? old?.connectedAt ?? null;
          if (!accountLabel || !connectedAt) {
            try {
              const account = await bounded(signal, signal => client.connectedAccounts.get(item.id, { signal }));
              accountLabel ??= connectionIdentity(account, toolkit);
              connectedAt ??= createdAt(account);
            } catch (error) { logLookup(toolkit, 'account', error); }
          }
          if ((!accountLabel || (toolkit === 'slack' && !accountLabel.includes(' · '))) && status === 'active') {
            let endpoint = PROFILE_ENDPOINTS[toolkit];
            try {
              const info = await bounded(signal, signal => client.toolkits.get(toolkit, { signal }));
              // Metadata can describe writes. Identity resolution only permits GET.
              if (info.getCurrentUserEndpoint && info.getCurrentUserEndpointMethod === 'GET') endpoint = info.getCurrentUserEndpoint;
            } catch (error) { logLookup(toolkit, 'toolkit', error); }
            const read = async (endpoint: string) => {
              try {
                const profile = await bounded(signal, signal => client.tools.proxyExecute({ connectedAccountId: item.id, userId, endpoint, method: 'GET' }, { signal }));
                if (profile.status >= 200 && profile.status < 300) return connectionIdentity(profile.data, toolkit);
                logLookup(toolkit, 'profile', { status: profile.status });
              } catch (error) { logLookup(toolkit, 'profile', error); }
            };
            if (endpoint) accountLabel = (await read(endpoint)) ?? accountLabel;
            // userinfo uses OAuth email scope; users.getProfile instead accepts gmail.readonly,
            // gmail.modify or gmail.metadata. Neither path sends or reads messages.
            if (!accountLabel && toolkit === 'gmail') accountLabel = await read(endpoint === PROFILE_ENDPOINTS.gmail
              ? 'https://openidconnect.googleapis.com/v1/userinfo' : PROFILE_ENDPOINTS.gmail);
            if (!accountLabel) logLookup(toolkit, 'resolve');
          }
          if (!accountLabel) next.expires = Date.now() + 5_000;
          return { accountLabel: accountLabel ?? old?.accountLabel, connectedAt };
        })();
        cache.delete(key); cache.set(key, next);
        if (cache.size > 2000) cache.delete(cache.keys().next().value!);
        entry = next;
      }
      const saved = await entry.promise;
      return { accountLabel: (toolkit === 'slack' && saved.accountLabel?.includes(' · ') ? saved.accountLabel : label ?? saved.accountLabel) ?? fallbackAccountLabel(item.id),
        connectedAt: date ?? saved.connectedAt, displayStatus: status, ...(unfinishedAuthorization(item) ? { authorizationIncomplete: true } : {}) };
    },
  };
}
