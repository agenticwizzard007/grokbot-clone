import { z } from 'zod';
export const SOURCE_IDS = ['tasks.counts', 'tasks.list', 'tasks.series', 'bots.list', 'bots.status', 'needsYou.list', 'usage.summary', 'usage.series', 'usage.windows', 'routines.list', 'routines.upcoming', 'runs.recent', 'runs.counts', 'runs.series'] as const;
export type SourceId = typeof SOURCE_IDS[number];
export const botIdSchema = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/);
const botId = botIdSchema.optional(), limit = z.number().int().min(1).max(25).optional();
const range = z.enum(['today', '7d', '30d', 'month']);
export const SOURCE_PARAMS = {
  'tasks.counts': z.object({ botId }).strict(),
  'tasks.list': z.object({ botId, state: z.enum(['working', 'needs_input', 'done']).optional(), limit }).strict(),
  'tasks.series': z.object({ range, botId }).strict(),
  'bots.list': z.object({ limit }).strict(), 'bots.status': z.object({ limit }).strict(), 'needsYou.list': z.object({ limit }).strict(),
  'usage.summary': z.object({ range }).strict(), 'usage.series': z.object({ range, metric: z.enum(['cost', 'requests', 'tokens']) }).strict(),
  'usage.windows': z.object({}).strict(), 'routines.list': z.object({ botId }).strict(),
  'routines.upcoming': z.object({ days: z.number().int().min(1).max(14).optional() }).strict(),
  'runs.recent': z.object({ botId, limit }).strict(), 'runs.counts': z.object({ range, botId }).strict(),
  'runs.series': z.object({ range, group: z.enum(['day', 'state']) }).strict(),
};
const fields: Record<SourceId, string[]> = {
  'tasks.counts': ['working', 'needs_input', 'done', 'total'], 'tasks.list': ['id', 'title', 'state', 'botName', 'botId', 'updatedAt'], 'tasks.series': ['day', 'created', 'done'],
  'bots.list': ['id', 'name', 'avatarShape', 'avatarColor', 'lastActiveAt'], 'bots.status': ['id', 'name', 'status', 'openTasks'], 'needsYou.list': ['id', 'type', 'botName', 'title', 'createdAt'],
  'usage.summary': ['costUsd', 'requests', 'tokens', 'computerHours'], 'usage.series': ['day', 'value'], 'usage.windows': ['label', 'usedPercent', 'resetsAt', 'available'],
  'routines.list': ['id', 'name', 'schedule', 'enabled', 'lastRunAt', 'botName'], 'routines.upcoming': ['routineId', 'name', 'at', 'botName'],
  'runs.recent': ['id', 'botName', 'kind', 'state', 'startedAt', 'durationMs'], 'runs.counts': ['completed', 'failed', 'running', 'queued'], 'runs.series': ['day', 'state', 'value'],
};
const labels = ['Task counts', 'Tasks', 'Task history', 'Bots', 'Bot status', 'Needs you', 'Usage summary', 'Usage history', 'Usage windows', 'Routines', 'Upcoming routines', 'Recent runs', 'Run counts', 'Run history'];
export const SOURCES = SOURCE_IDS.map((id, i) => ({ id, label: labels[i], paramsSchema: SOURCE_PARAMS[id], fields: [...fields[id], 'count'], maxRows: 25, maxPoints: 31 }));
