import { db } from '../../db.js';
import { getLive } from '../../store.js';
import { cachedWindows } from './cached-windows.js';
import { SourceError, sourceById, type SourceData, type Params, type Source } from './catalog.js';
import { SourceRunner } from './runner.js';

export type DataResult = (SourceData & { ok: true; fetchedAt: number }) |
  { ok: false; code: string; message: string; fetchedAt: number };
export interface DataRequest { key: string; source: string; params: unknown }

/** Project once more at the API boundary so future source changes fail closed. */
export function project(source: Source, data: SourceData): SourceData {
  const pick = (row: Record<string, unknown>) => Object.fromEntries(source.fields.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]));
  return { count: data.count, ...(data.available === undefined ? {} : { available: data.available }),
    ...(data.rows ? { rows: data.rows.slice(0, source.series ? 31 : 25).map(pick) } : {}),
    ...(data.value ? { value: pick(data.value) } : {}) };
}

export class DataExecutor {
  private cache = new Map<string, DataResult & { ok: true }>();
  private pending = new Map<string, Promise<DataResult>>();
  private runner = new SourceRunner();
  constructor(private clock = Date.now) {}

  async execute(userId: string, request: DataRequest): Promise<DataResult> {
    const fail = (code: string, message: string): DataResult => ({ ok: false, code, message, fetchedAt: this.clock() });
    const source = sourceById.get(request.source);
    if (!source) return fail('not_found', 'Data source not found.');
    const parsed = source.paramsSchema.safeParse(request.params);
    if (!parsed.success) return fail('invalid_value', 'Invalid data source parameters.');
    const params = parsed.data as Params;
    // Recheck ownership even for a warm cache after a Bot was removed or moved.
    if (!userId || (params.botId && !db.prepare('SELECT 1 FROM bots WHERE user_id=? AND id=?').get(userId, params.botId))) return fail('not_found', 'Bot not found.');
    const key = JSON.stringify([userId, source.id, Object.fromEntries(Object.entries(params).sort(([a], [b]) => a.localeCompare(b)))]);
    const hit = this.cache.get(key);
    if (hit && this.clock() - hit.fetchedAt < 10_000) return structuredClone(hit);
    const pending = this.pending.get(key);
    if (pending) return structuredClone(await pending);
    const work = (async (): Promise<DataResult> => {
      try {
        const data = source.id === 'usage.windows' ? cachedWindows(userId) : await this.runner.run(source.id, userId, params);
        if (source.id === 'bots.status') for (const bot of data.rows ?? []) {
          const live = getLive(String(bot.id));
          if (live.awaiting) bot.status = 'needs_you';
          else if (bot.status !== 'needs_you' && live.isRunning) bot.status = 'working';
        }
        const result = { ...project(source, data), ok: true as const, fetchedAt: this.clock() };
        for (const [key, value] of this.cache) if (this.clock() - value.fetchedAt >= 10_000) this.cache.delete(key);
        if (this.cache.size >= 2048) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, result);
        return result;
      } catch (error) {
        return error instanceof SourceError ? fail(error.code, error.message) : fail('unavailable', 'Data is unavailable.');
      }
    })();
    this.pending.set(key, work);
    try { return structuredClone(await work); } finally { this.pending.delete(key); }
  }

  close() { this.runner.close(); this.cache.clear(); }
}
