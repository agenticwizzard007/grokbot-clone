import type { Dashboard, Widget } from '@shared/ui-config/schema';
import type { PatchOp } from '@shared/ui-config/service';
import { type WidgetType } from '@shared/ui-config/registry-widgets';
import { routeDashboard } from '../lib/navigation';
export { dashboardSlug } from '../lib/navigation';
export type { Dashboard, Widget };
export interface WidgetData { ok: boolean; rows?: Record<string, unknown>[]; value?: Record<string, unknown>; count?: number; available?: boolean; fetchedAt?: number; message?: string }
export interface WidgetState { status: 'loading' | 'ready' | 'error'; data?: WidgetData; error?: string; refreshing?: boolean }
export { widgetTitle as widgetLabel } from '@shared/ui-config/presentation';
import { widgetTitle } from '@shared/ui-config/presentation';
export const columnSpan = (span: number, width: number, type?: Widget['type']) => width < 360 ? type === 'stat' && span === 4 ? 2 : span <= 4 ? 1 : 2 : width <= 480 ? type === 'stat' && span === 4 ? 2 : span <= 4 ? 3 : 6 : width <= 1023 ? Math.ceil(span / 2) : span;
export function findDashboard(dashboards: Dashboard[], reference?: string) {
  return reference ? routeDashboard(reference, dashboards) : undefined;
}
export function widgetSource(widget: Widget) {
  const source = widget.source;
  if (source && widget.type === 'taskBoard' && typeof widget.options.botId === 'string' && !source.params.botId) return { ...source, params: { ...source.params, botId: widget.options.botId } };
  return source;
}
export const sourceKey = (widget: Widget) => { const source = widgetSource(widget); return source ? JSON.stringify([source.id, Object.fromEntries(Object.entries(source.params).sort(([a], [b]) => a.localeCompare(b)))]) : ''; };
export function defaultWidget(type: WidgetType): Widget {
  const widget = widgetDefaults(type);
  return { ...widget, title: widgetTitle(widget) };
}
function widgetDefaults(type: WidgetType): Widget {
  const base = { id: '$new1', type, span: 6, rows: 3, refreshSec: 60 as const };
  switch (type) {
    case 'agent': return { ...base, title: 'Daily summary', rows: 3, options: { prompt: 'Summarize my open tasks and what needs my input.', display: 'text', schedule: 'manual' }, refreshSec: 0 };
    case 'stat': return { ...base, span: 4, rows: 1, source: { id: 'tasks.counts', params: {} }, options: { field: 'total', format: 'number' } };
    case 'list': return { ...base, source: { id: 'tasks.list', params: { limit: 10 } }, options: { limit: 5, onClick: 'open' } };
    case 'table': return { ...base, source: { id: 'tasks.list', params: { limit: 10 } }, options: { columns: ['title', 'state', 'botName'], limit: 5 } };
    case 'chart': return { ...base, source: { id: 'usage.series', params: { range: '7d', metric: 'cost' } }, options: { kind: 'bar' } };
    case 'meter': return { ...base, rows: 2, source: { id: 'usage.windows', params: {} }, options: { window: 0 } };
    case 'botStatus': return { ...base, rows: 4, source: { id: 'bots.status', params: { limit: 6 } }, options: { limit: 6 } };
    case 'taskBoard': return { ...base, span: 12, rows: 5, source: { id: 'tasks.list', params: { limit: 25 } }, options: {} };
    case 'routineSchedule': return { ...base, rows: 4, source: { id: 'routines.upcoming', params: { days: 7 } }, options: { days: 7 } };
    case 'note': return { ...base, options: { text: '## My notes\nAdd a reminder for your week.' }, refreshSec: 0 };
    case 'shortcuts': return { ...base, rows: 2, options: { items: [{ label: 'Tasks', target: 'tasks' }] }, refreshSec: 0 };
  }
}
export type ToolbarAction = 'earlier' | 'later' | 'narrower' | 'wider' | 'shorter' | 'taller' | 'remove';
export function widgetAction(dashboardIndex: number, widgets: Widget[], id: string, action: ToolbarAction): PatchOp[] {
  const index = widgets.findIndex(widget => widget.id === id); if (index < 0) return [];
  const path = `/dashboards/${dashboardIndex}/widgets/${index}`, widget = widgets[index];
  const guard: PatchOp = { op: 'test', path: `${path}/id`, value: id };
  if (action === 'remove') return [guard, { op: 'remove', path }];
  if (action === 'earlier' || action === 'later') {
    const to = index + (action === 'earlier' ? -1 : 1);
    return to < 0 || to >= widgets.length ? [] : [guard, { op: 'move', from: path, path: `/dashboards/${dashboardIndex}/widgets/${to}` }];
  }
  const field = action === 'narrower' || action === 'wider' ? 'span' : 'rows';
  const value = widget[field] + (action === 'narrower' || action === 'shorter' ? -1 : 1);
  return value < 1 || value > (field === 'span' ? 12 : 6) ? [] : [guard, { op: 'replace', path: `${path}/${field}`, value }];
}
export const fieldLabel = (field: string) => ({ botName: 'Bot', botId: 'Bot', updatedAt: 'Updated', createdAt: 'Created', startedAt: 'Started', durationMs: 'Duration', lastRunAt: 'Last run', routineId: 'Routine', costUsd: 'Cost', openTasks: 'Open tasks', needs_input: 'Needs input', needs_you: 'Needs you', working: 'Working', ready: 'Ready', done: 'Done', completed: 'Completed', failed: 'Failed', running: 'Running', queued: 'Queued', title: 'Title', name: 'Name', state: 'State', kind: 'Kind', schedule: 'Schedule', enabled: 'Enabled', day: 'Day', value: 'Value', created: 'Created', count: 'Count', requests: 'Requests', tokens: 'Tokens', computerHours: 'Computer hours' } as Record<string, string>)[field] ?? field.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ');
export const textValue = (value: unknown, field = ''): string => value == null ? 'Unavailable' : typeof value === 'boolean' ? value ? 'Yes' : 'No' : typeof value === 'number' && /At$|^at$/.test(field) ? new Date(value).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : field === 'state' || field === 'status' ? fieldLabel(String(value)) : String(value);
