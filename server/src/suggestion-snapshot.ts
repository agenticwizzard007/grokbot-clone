import { SUGGESTION_FILTER_VERSION } from './suggestion-policy.js';
import type { Toolkit } from './types.js';

export const SUGGESTION_SNAPSHOT_VERSION = 1;
export type SuggestionSnapshot = {
  version: number;
  filterVersion: string;
  computedAt: number;
  hasContext: boolean;
  suggestions: (Pick<Toolkit, 'slug' | 'name' | 'noAuth' | 'managedAuth' | 'categories'> & { reason: string })[];
};

/** Shared validation for durable and browser snapshots. Never retain generated prose or URLs. */
export function readSuggestionSnapshot(value: unknown): SuggestionSnapshot | undefined {
  const saved = value as SuggestionSnapshot | null;
  if (!saved || saved.version !== SUGGESTION_SNAPSHOT_VERSION || saved.filterVersion !== SUGGESTION_FILTER_VERSION
    || !Number.isSafeInteger(saved.computedAt) || saved.computedAt < 0 || typeof saved.hasContext !== 'boolean'
    || !Array.isArray(saved.suggestions) || saved.suggestions.length > 4
    || !saved.suggestions.every(app => app && typeof app.slug === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(app.slug)
      && typeof app.name === 'string' && app.name.length > 0 && app.name.length <= 100 && typeof app.noAuth === 'boolean')) return;
  return { version: SUGGESTION_SNAPSHOT_VERSION, filterVersion: SUGGESTION_FILTER_VERSION,
    computedAt: saved.computedAt, hasContext: saved.hasContext,
    suggestions: saved.suggestions.map(app => ({ slug: app.slug, name: app.name, noAuth: app.noAuth,
      managedAuth: !!app.managedAuth, categories: [], reason: `${app.name} was suggested for this Bot.` })) };
}
