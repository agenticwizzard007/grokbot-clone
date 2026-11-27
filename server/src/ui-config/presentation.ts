import type { UiConfig, Widget } from './schema.js';
import { WIDGETS } from './registry-widgets.js';
import type { SourceId } from './registry-sources.js';

const genericTitles = new Set([...WIDGETS.flatMap(widget => [widget.id, widget.label]), 'Widget', 'Agent answer'].map(title => title.toLowerCase()));
const sourceTitles: Record<SourceId, string> = {
  'tasks.counts': 'All tasks', 'tasks.list': 'All tasks', 'tasks.series': 'Task progress',
  'bots.list': 'Bots', 'bots.status': 'Bots', 'needsYou.list': 'Needs you',
  'usage.summary': 'Usage this week', 'usage.series': 'Cost by day', 'usage.windows': 'Usage limits',
  'routines.list': 'Your routines', 'routines.upcoming': 'Upcoming routines',
  'runs.recent': 'Recent activity', 'runs.counts': 'Activity totals', 'runs.series': 'Activity by day',
  'handoffs.list': 'Open handoffs', 'loops.list': 'Active loops', 'outputs.recent': 'Recent outputs',
  'connectors.status': 'Connected apps', 'email.recent': 'Recent email', 'calendar.upcoming': 'Upcoming events', 'crm.deals': 'Sales pipeline',
};
/** Readable titles also cover old documents which predate contextual defaults. */
export function widgetTitle(widget: Widget): string {
  const title = widget.title?.trim();
  if (title && !genericTitles.has(title.toLowerCase())) return title;
  if (widget.type === 'agent') {
    const prompt = String(widget.options.prompt ?? '').trim().replace(/^(?:show|list|summarize)\s+(?:me\s+)?(?:my\s+)?/i, '').replace(/[.!?]+$/, '');
    const boundary = prompt.lastIndexOf(' ', 60);
    const short = prompt.length <= 60 ? prompt : boundary > 0 ? prompt.slice(0, boundary) : '';
    return short && !genericTitles.has(short.toLowerCase()) ? short[0].toUpperCase() + short.slice(1) : 'Your work at a glance';
  }
  if (widget.type === 'stat') {
    const labels: Record<string, string> = { working: 'Working now', needs_input: 'Needs input', done: 'Tasks completed', completed: 'Runs completed', failed: 'Failed runs', running: 'Running now', queued: 'Queued runs', costUsd: 'Spent this week', requests: 'Requests this week', tokens: 'Tokens used', computerHours: 'Computer hours' };
    if (labels[String(widget.options.field)]) return labels[String(widget.options.field)];
  }
  if (widget.source?.id === 'tasks.list' && widget.source.params.state === 'working') return 'Open tasks';
  if (widget.source?.id === 'tasks.list' && widget.source.params.state === 'needs_input') return 'Tasks needing input';
  if (widget.source?.id === 'tasks.list' && widget.source.params.state === 'done') return 'Completed tasks';
  if (widget.source) return sourceTitles[widget.source.id];
  return widget.type === 'note' ? 'My notes' : widget.type === 'shortcuts' ? 'Quick links' : 'Your work';
}
export function uniqueDashboardName(requested: string, names: Iterable<string>): string {
  const used = new Set([...names].map(name => name.trim().toLowerCase()));
  const name = requested.trim().slice(0, 40) || 'My week';
  if (!used.has(name.toLowerCase())) return name;
  const base = name.replace(/ \d+$/, '');
  for (let index = 2; ; index++) {
    const suffix = ` ${index}`, candidate = base.slice(0, 40 - suffix.length).trimEnd() + suffix;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}
/** Called only after validation. Unchanged saved data is never rewritten by an unrelated patch. */
export function normalizeDashboardPresentation(before: UiConfig, after: UiConfig): void {
  const existing = new Map(before.dashboards.map(dashboard => [dashboard.id, dashboard]));
  const names = after.dashboards.filter(dashboard => existing.get(dashboard.id)?.name === dashboard.name).map(dashboard => dashboard.name);
  for (const dashboard of after.dashboards) {
    const old = existing.get(dashboard.id);
    if (old?.name !== dashboard.name) { dashboard.name = uniqueDashboardName(dashboard.name, names); names.push(dashboard.name); }
    for (const widget of dashboard.widgets) {
      const previous = old?.widgets.find(item => item.id === widget.id);
      if (!previous || JSON.stringify(previous) !== JSON.stringify(widget)) widget.title = widgetTitle(widget);
    }
  }
}
