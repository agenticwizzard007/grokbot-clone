import { z } from 'zod';
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
const botId = z.string().min(1).max(128).optional();
const range = z.enum(['today', '7d', '30d', 'month']).default('7d');
const limit = z.number().int().min(1).max(25).default(10);
const def = (id: string, label: string, shape: z.ZodRawShape, fields: string[], series = false): Source => ({
  id, label, paramsSchema: z.object(shape).strict(), fields, series,
  resolve: (userId, params) => {
    const data = id === 'usage.windows' ? cachedWindows(userId) : resolveSource(id, userId, params);
    const pick = (row: Record<string, unknown>) => Object.fromEntries(fields.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]));
    return { ...data, ...(data.rows ? { rows: data.rows.map(pick) } : {}), ...(data.value ? { value: pick(data.value) } : {}) };
  },
});

/** Public metadata and projection allowlists. No user supplied query or column names. */
export const SOURCES: readonly Source[] = [
  def('tasks.counts', 'Task counts', { botId }, ['working', 'needs_input', 'done', 'total']),
  def('tasks.list', 'Tasks', { botId, state: z.enum(['working', 'needs_input', 'done']).optional(), limit }, ['id', 'title', 'state', 'botName', 'botId', 'updatedAt']),
  def('tasks.series', 'Tasks by day', { range, botId }, ['day', 'created', 'done'], true),
  def('bots.list', 'Bots', { limit }, ['id', 'name', 'avatarShape', 'avatarColor', 'lastActiveAt']),
  def('bots.status', 'Bot status', { limit }, ['id', 'name', 'status', 'openTasks']),
  def('needsYou.list', 'Needs you', { limit }, ['id', 'type', 'botName', 'title', 'createdAt']),
  def('usage.summary', 'Usage summary', { range }, ['costUsd', 'requests', 'tokens', 'computerHours']),
  def('usage.series', 'Usage by day', { range, metric: z.enum(['cost', 'requests', 'tokens']).default('cost') }, ['day', 'value'], true),
  def('usage.windows', 'Usage windows', {}, ['label', 'usedPercent', 'resetsAt']),
  def('routines.list', 'Routines', { botId }, ['id', 'name', 'schedule', 'enabled', 'lastRunAt', 'botName']),
  def('routines.upcoming', 'Upcoming routines', { days: z.number().int().min(1).max(14).default(7) }, ['routineId', 'name', 'at', 'botName']),
  def('runs.recent', 'Recent runs', { botId, limit }, ['id', 'botName', 'kind', 'state', 'startedAt', 'durationMs']),
  def('runs.counts', 'Run counts', { range, botId }, ['completed', 'failed', 'running', 'queued']),
  def('runs.series', 'Runs over time', { range, group: z.enum(['day', 'state']).default('day') }, ['day', 'state', 'count'], true),
];
export const sourceById = new Map(SOURCES.map(source => [source.id, source]));

export class SourceError extends Error {
  constructor(public code: 'not_found' | 'timeout' | 'unavailable', message: string) { super(message); }
}
