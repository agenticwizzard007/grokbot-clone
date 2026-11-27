import type { StoredPreview, UiConfig, Violation } from '@shared/ui-config/index';
export class AppearanceError extends Error {
  constructor(readonly errors: Violation[]) { super(errors.map(error => `${error.message}${error.hint ? ` ${error.hint}` : ''}${error.suggested ? ` Try ${error.suggested}.` : ''}`).join(' ')); }
}
export async function appearanceRequest<T>(path: string, method = 'GET', body?: unknown, revision?: number): Promise<T> {
  const response = await fetch(`/api${path}`, { method, credentials: 'include', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(revision === undefined ? {} : { 'If-Match': `"${revision}"` }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new AppearanceError(result.details ?? [{ code: result.code ?? 'invalid_value', path: '', message: result.message ?? 'Could not update appearance.' }]);
  return result as T;
}
export const readSaved = () => appearanceRequest<{ doc: UiConfig; revision: number }>('/ui/config');
export const readPreview = (id: string) => appearanceRequest<StoredPreview>(`/ui/previews/${encodeURIComponent(id)}`);
export async function exportAppearance() {
  const doc = await appearanceRequest<unknown>('/ui/export');
  const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'swarm-appearance.json'; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
