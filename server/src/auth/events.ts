import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';

type Provider = 'google' | 'apple' | 'openrouter';
type Surface = 'legacy' | 'platform';
type Stage = 'request' | 'attempt' | 'provider' | 'identity' | 'account' | 'session' | 'delivery';
type Reason = 'invalid_request' | 'attempt_invalid' | 'attempt_expired' | 'provider_failure' | 'provider_denied' | 'invalid_identity' | 'link_conflict' | 'reauth_required' | 'storage_failure' | 'busy';
const stages: readonly Stage[] = ['request', 'attempt', 'provider', 'identity', 'account', 'session', 'delivery'];
const reasons = new Map<string, Reason>([
  ['email_link_required', 'link_conflict'], ['identity_already_linked', 'link_conflict'],
  ['reauth_required', 'reauth_required'], ['account_revoked', 'reauth_required'],
  ['Attempt expired.', 'attempt_expired'], ['Native attempt expired.', 'attempt_expired'],
  ['Invalid attempt.', 'attempt_invalid'], ['Link session changed.', 'reauth_required'],
  ['Authorization failed.', 'invalid_request'],
]);
for (const provider of ['google', 'apple', 'openrouter']) {
  for (const [suffix, reason] of Object.entries({
    session: 'attempt_expired', expired: 'attempt_expired', denied: 'provider_denied',
    unavailable: 'provider_failure', pending: 'provider_failure', permissions: 'invalid_identity',
    identity: 'invalid_identity', email_required: 'invalid_identity', already_linked: 'link_conflict',
    link_required: 'link_conflict', link_signin: 'reauth_required', busy: 'busy',
    key: 'invalid_identity', management: 'invalid_identity',
  } satisfies Record<string, Reason>)) reasons.set(`${provider}_${suffix}`, reason);
}
const diagnostics = new WeakMap<Context, { correlationId: string; provider: Provider; surface: Surface; stage: Stage; logged: boolean }>();

/** Only server-owned enums and a fresh random ID cross the logging boundary. Never serialize errors or requests. */
export function authFailure(c: Context, error: unknown) {
  const event = diagnostics.get(c);
  if (!event || event.logged) return;
  const code = typeof error === 'string' ? error : error instanceof Error ? error.message : undefined;
  const fallback: Reason = event.stage === 'provider' ? 'provider_failure' : event.stage === 'identity' ? 'invalid_identity'
    : event.stage === 'request' ? 'invalid_request' : 'storage_failure';
  const reason = (code && reasons.get(code)) || fallback;
  event.logged = true;
  console.warn(JSON.stringify({ event: 'authentication_failure', correlation_id: event.correlationId,
    provider: event.provider, surface: event.surface, stage: event.stage, status: 'failure', error_code: reason }));
}

export function authStage(c: Context, stage: Stage) {
  const event = diagnostics.get(c);
  if (event && stages.includes(stage)) event.stage = stage;
}

/** Also contains errors before the callback's existing catch, so framework logging cannot expose raw failures. */
export function authBoundary(provider: Provider, surface: Surface, handler: (c: Context) => Response | Promise<Response>, fallback: (c: Context) => Response) {
  return async (c: Context) => {
    const correlationId = randomUUID();
    diagnostics.set(c, { correlationId, provider, surface, stage: 'request', logged: false });
    c.header('X-Auth-Correlation-ID', correlationId);
    try { return await handler(c); }
    catch (error) {
      authFailure(c, error);
      try { return fallback(c); }
      catch { return c.text('Authentication failed.', 500); }
    }
  };
}
