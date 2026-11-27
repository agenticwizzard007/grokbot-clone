import type { z } from 'zod';
import { SOURCES as SOURCE_REGISTRY } from '../../ui-config/registry-sources.js';
import { resolveSource } from './queries.js';
import { cachedWindows } from './cached-windows.js';

export type Params = Record<string, string | number>;
export interface SourceData { rows?: Record<string, unknown>[]; value?: Record<string, unknown>; count: number; available?: boolean }
export interface Source {
  id: string;
  label: string;
  paramsSchema: z.ZodType;
  fields: readonly string[];
  series: boolean;
  resolve(userId: string, params: Params): SourceData;
}

/** Shared schemas remain authoritative. Only optional parameters receive defaults. */
export const SOURCES: readonly Source[] = SOURCE_REGISTRY.map(metadata => {
  const defaults: Params = metadata.id === 'routines.upcoming' ? { days: 7 }
    : ['tasks.list', 'bots.list', 'bots.status', 'needsYou.list', 'runs.recent'].includes(metadata.id) ? { limit: 10 } : {};
  return { ...metadata, series: metadata.id.endsWith('.series'),
    paramsSchema: metadata.paramsSchema.transform(params => ({ ...defaults, ...params })),
    resolve: (userId, params) => {
      const data = metadata.id === 'usage.windows' ? cachedWindows(userId) : resolveSource(metadata.id, userId, params);
      const pick = (row: Record<string, unknown>) => Object.fromEntries(metadata.fields.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]));
      return { ...data, ...(data.rows ? { rows: data.rows.map(pick) } : {}), ...(data.value ? { value: pick(data.value) } : {}) };
    },
  };
});
export const sourceById = new Map(SOURCES.map(source => [source.id, source]));

export class SourceError extends Error {
  constructor(public code: 'not_found' | 'timeout' | 'unavailable', message: string) { super(message); }
}
