import type { SuggestedToolkit } from './api';

/** A background ranking pass must not rewrite or reorder the cards being read. */
export function reconcileSuggestionDisplay(previous: SuggestedToolkit[] | undefined, next: SuggestedToolkit[], quiet: boolean): SuggestedToolkit[] {
  if (!quiet || !previous || previous.length !== next.length) return next;
  const incoming = new Map(next.map(app => [app.slug, app]));
  if (previous.some(app => !incoming.has(app.slug))) return next;
  return previous.map(app => ({ ...incoming.get(app.slug)!, reason: app.reason }));
}
