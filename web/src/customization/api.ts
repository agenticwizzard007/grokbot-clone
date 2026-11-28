import type { Violation } from '../../../server/src/ui-config/service';

export class UiApiError extends Error {
  constructor(readonly status: number, readonly errors: Violation[]) {
    super(errors[0]?.message ?? 'Could not update appearance.');
  }
}

/** All writes use the revision the caller actually saw. Conflicts are never retried silently. */
export async function uiRequest<T>(path: string, options: { method?: string; body?: unknown; revision?: number; etag?: number; signal?: AbortSignal } = {}): Promise<T | null> {
  const response = await fetch(`/api/ui${path}`, {
    method: options.method ?? 'GET', credentials: 'same-origin', signal: options.signal,
    headers: {
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(options.revision === undefined ? {} : { 'If-Match': `"${options.revision}"` }),
      ...(options.etag === undefined ? {} : { 'If-None-Match': `"${options.etag}"` }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  if (response.status === 304) return null;
  const body = await response.json().catch(() => ({ message: 'Could not load your dashboards.' }));
  if (!response.ok || body.code === 'disabled') throw new UiApiError(response.status, body.details ?? [{ path: '/', code: body.code ?? 'invalid_value', message: body.message ?? 'Could not update appearance.' }]);
  return body as T;
}
