import type { Dashboard, Widget } from './schema.js';
import type { FocusId, LensId } from './adapt-keywords.js';

export interface Lens {
  version: 1; id: LensId; label: string; home: Omit<Dashboard, 'id'>;
  promoted: readonly string[]; landing: 'home';
  bots: readonly { name: string; purpose: string }[];
  templates: readonly { name: string; template: 'overview' | 'tasks' | 'usage' | 'bot' }[];
  shortcuts: readonly { route: string; binding: string }[];
  rationale: string; focus: readonly FocusId[];
}
const widget = (id: number, type: Widget['type'], title: string, span: number, rows: number, source: Widget['source'], options: Widget['options'] = {}): Widget =>
  ({ id: `w_adapt00${id}`, type, title, span, rows, ...(source ? { source } : {}), options });
const counts = (title: string, field = 'total') => widget(1, 'stat', title, 6, 1, { id: 'tasks.counts', params: {} }, { field });
const attention = () => widget(2, 'stat', 'Needs you', 6, 1, { id: 'needsYou.list', params: {} }, { field: 'count' });
const tasks = (title: string) => widget(3, 'list', title, 6, 3, { id: 'tasks.list', params: { limit: 10 } }, { limit: 5 });
const schedule = () => widget(4, 'routineSchedule', 'Upcoming routines', 6, 3, { id: 'routines.upcoming', params: { days: 7 } }, { days: 7 });
const bots = () => widget(4, 'botStatus', 'Bot activity', 6, 3, { id: 'bots.status', params: { limit: 6 } }, { limit: 6 });
const shortcutTargets: Record<string, { route: string; binding: string }> = {
  allBots: { route: 'bots', binding: 'Alt+B' }, tasks: { route: 'tasks', binding: 'Alt+T' },
  routines: { route: 'all/routines', binding: 'Alt+R' }, usage: { route: 'settings/usage', binding: 'Alt+U' },
  files: { route: 'reports', binding: 'Alt+F' },
};
const recipe = (id: LensId, label: string, promoted: string[], focus: FocusId[], widgets: Widget[], suggestions: [string, string][], template: 'overview' | 'tasks' | 'usage' | 'bot', rationale: string): Lens => ({
  version: 1, id, label, promoted, focus, landing: 'home', home: { name: label, icon: 'layout-dashboard', description: '', widgets: [
    ...widgets, widget(5, 'note', 'Suggested Bots', 12, 4, undefined, { text: suggestions.map(([name, purpose]) => `**${name}**\n\n${purpose}`).join('\n\n') }),
  ] },
  bots: suggestions.map(([name, purpose]) => ({ name, purpose })),
  templates: [{ name: `${label} overview`, template }, { name: 'Weekly review', template: 'overview' }],
  shortcuts: promoted.slice(0, 2).map(id => ({ ...shortcutTargets[id] })), rationale,
});
export const ADAPT_LENSES: Readonly<Record<LensId, Lens>> = {
  sales: recipe('sales', 'Pipeline', ['tasks', 'routines', 'allBots'], ['tasks', 'routines', 'bots'],
    [counts('Pipeline tasks'), attention(), tasks('Follow ups'), schedule()],
    [['Follow up helper', 'Draft follow ups for your review.'], ['Pipeline reviewer', 'Summarize pipeline tasks.'], ['Outreach planner', 'Plan your next outreach steps.']], 'tasks', 'Pipeline widgets for outreach and follow ups.'),
  operations: recipe('operations', 'Operations', ['routines', 'usage', 'tasks'], ['routines', 'usage', 'apps'],
    [widget(1, 'meter', 'Usage window', 6, 1, { id: 'usage.windows', params: {} }), widget(2, 'stat', 'Weekly requests', 6, 1, { id: 'usage.summary', params: { range: '7d' } }, { field: 'requests' }),
      widget(3, 'chart', 'Daily usage', 6, 3, { id: 'usage.series', params: { range: '7d', metric: 'requests' } }, { kind: 'bar' }), schedule()],
    [['Daily report helper', 'Prepare a daily operations report.'], ['Routine reviewer', 'Review recurring work.'], ['Usage watcher', 'Summarize usage for your review.']], 'usage', 'Usage and routines for recurring work.'),
  support: recipe('support', 'Support queue', ['tasks', 'allBots', 'routines'], ['tasks', 'chat', 'team'],
    [counts('Open queue', 'needs_input'), attention(), tasks('Response queue'), bots()],
    [['Queue triage helper', 'Organize requests for your review.'], ['Response drafter', 'Draft replies for your approval.'], ['Support reviewer', 'Summarize recurring support questions.']], 'tasks', 'Queue widgets for support and response.'),
  engineering: recipe('engineering', 'Build and review', ['tasks', 'allBots', 'files'], ['tasks', 'bots', 'apps'],
    [counts('Build tasks'), attention(), widget(3, 'list', 'Recent runs', 6, 3, { id: 'runs.recent', params: { limit: 5 } }, { limit: 5 }), bots()],
    [['Review helper', 'Prepare a review checklist.'], ['Build reporter', 'Summarize recent build runs.'], ['Bug triage helper', 'Organize bug reports for review.']], 'tasks', 'Tasks and runs for builds and reviews.'),
  research: recipe('research', 'Research desk', ['files', 'allBots', 'tasks'], ['files', 'bots', 'chat'],
    [counts('Research tasks'), attention(), tasks('Reading queue'), bots()],
    [['Reading helper', 'Organize your reading tasks.'], ['Synthesis drafter', 'Draft a synthesis for review.'], ['Source reviewer', 'Prepare a source review checklist.']], 'bot', 'Reading tasks and Bots for synthesis.'),
  creator: recipe('creator', 'Content calendar', ['routines', 'files', 'tasks'], ['files', 'routines', 'apps'],
    [counts('Content tasks'), attention(), tasks('Content queue'), schedule()],
    [['Content planner', 'Outline your next content tasks.'], ['Draft reviewer', 'Prepare edits for your review.'], ['Calendar helper', 'Plan recurring content work.']], 'tasks', 'Content tasks and routines for publishing.'),
  general: recipe('general', 'Your overview', ['allBots', 'tasks'], [], [counts('Tasks'), attention(), tasks('Recent tasks'), bots()],
    [['Planning helper', 'Organize your next steps.'], ['Review helper', 'Prepare a weekly review.'], ['Task helper', 'Break work into manageable tasks.']], 'overview', 'A tidy overview of tasks and Bots.'),
};
function freeze(value: unknown): void { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } }
freeze(ADAPT_LENSES);
