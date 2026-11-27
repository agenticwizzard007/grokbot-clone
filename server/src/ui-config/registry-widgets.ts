import { z } from 'zod';
import { botIdSchema, type SourceId } from './registry-sources.js';
export const WIDGET_TYPES = ['stat', 'list', 'table', 'chart', 'meter', 'botStatus', 'taskBoard', 'routineSchedule', 'note', 'shortcuts'] as const;
export type WidgetType = typeof WIDGET_TYPES[number];
export const plainText = (max: number, min = 0) => z.string().min(min).max(max).regex(/^[^<>\x00-\x1F\x7F-\x9F\u2013\u2014]*$/, 'Use plain text without control characters.');
export const noteText = z.string().max(2000).regex(/^[^<>\x00-\x08\x0B-\x1F\x7F-\x9F\u2013\u2014]*$/, 'Use plain Markdown without HTML.').refine(s => !/!\[|\]\(\s*(?!(?:https:\/\/|(?:bots|tasks|settings|dashboard:|bot:)))/i.test(s), 'Links must use HTTPS or an in-app route.');
export const shortcutTarget = plainText(320, 1).refine(s => /^(?:bots|tasks|settings|dashboard:d_[a-z0-9]{8}|bot:[a-zA-Z0-9_-]{1,100}|ask:[a-zA-Z0-9_-]{1,100}:[^<>]{1,200})$/.test(s), 'Choose an in-app destination.');
const field = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/).max(40), limit = z.number().int().min(1).max(10).optional();
export const WIDGET_OPTIONS = {
  stat: z.object({ field, format: z.enum(['number', 'usd', 'percent']).optional() }).strict(),
  list: z.object({ limit, fields: z.array(field).min(1).max(10).optional(), onClick: z.enum(['open', 'none']).optional() }).strict(),
  table: z.object({ columns: z.array(field).min(1).max(5), limit }).strict(),
  chart: z.object({ kind: z.enum(['bar', 'line', 'area']) }).strict(),
  meter: z.object({ window: z.number().int().min(0).max(24).optional() }).strict(),
  botStatus: z.object({ limit: z.number().int().min(1).max(12).optional() }).strict(),
  taskBoard: z.object({ botId: botIdSchema.optional() }).strict(),
  routineSchedule: z.object({ days: z.number().int().min(1).max(14).optional() }).strict(),
  note: z.object({ text: noteText }).strict(),
  shortcuts: z.object({ items: z.array(z.object({ label: plainText(40, 1), target: shortcutTarget }).strict()).min(1).max(6) }).strict(),
};
const listSources: SourceId[] = ['tasks.list', 'needsYou.list', 'routines.list', 'routines.upcoming', 'runs.recent', 'bots.list'];
const allowed: Record<WidgetType, SourceId[]> = { stat: ['tasks.counts', 'usage.summary', 'needsYou.list', 'runs.counts', 'bots.status'], list: listSources, table: listSources, chart: ['usage.series', 'runs.series', 'tasks.series'], meter: ['usage.windows'], botStatus: ['bots.status'], taskBoard: ['tasks.list'], routineSchedule: ['routines.upcoming'], note: [], shortcuts: [] };
const labels = ['Statistic', 'List', 'Table', 'Chart', 'Meter', 'Bot status', 'Task board', 'Routine schedule', 'Note', 'Shortcuts'];
export const WIDGETS = WIDGET_TYPES.map((id, i) => ({ id, label: labels[i], sources: allowed[id], optionsSchema: WIDGET_OPTIONS[id] }));
export const DASHBOARD_ICONS = ['layout-dashboard', 'chart-bar', 'list', 'check-square', 'calendar', 'bot', 'activity', 'star', 'home', 'briefcase'] as const;
