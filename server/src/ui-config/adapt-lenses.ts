import type { Widget } from './schema.js';
import type { RequirementsFields } from './adapt.js';
import { DASHBOARD_KEYWORDS } from './adapt-keywords.js';

type Recipe = Omit<Widget, 'id'>;
const recipes: Record<string, Recipe> = {
  tasks: { type: 'list', title: 'Recent tasks', span: 6, rows: 3, source: { id: 'tasks.list', params: { limit: 5 } }, options: { limit: 5 } },
  routines: { type: 'routineSchedule', title: 'Upcoming routines', span: 6, rows: 3, source: { id: 'routines.upcoming', params: { days: 7 } }, options: { days: 7 } },
  usage: { type: 'chart', title: 'Daily usage', span: 6, rows: 3, source: { id: 'usage.series', params: { range: '7d', metric: 'requests' } }, options: { kind: 'bar' } },
  bots: { type: 'botStatus', title: 'Bot activity', span: 6, rows: 3, source: { id: 'bots.status', params: { limit: 6 } }, options: { limit: 6 } },
  runs: { type: 'list', title: 'Recent runs', span: 6, rows: 3, source: { id: 'runs.recent', params: { limit: 5 } }, options: { limit: 5 } },
};
export function dashboardWidgets(profile: RequirementsFields): Widget[] {
  const words = new Set([profile.role, ...profile.goals, ...profile.workflows.map(workflow => workflow.name)].join(' ').toLowerCase().split(/[^a-z0-9]+/));
  const ranked = Object.keys(recipes).map(id => ({ id, score: Number(profile.focus.includes(id as typeof profile.focus[number])) * 3 + DASHBOARD_KEYWORDS[id].filter(word => words.has(word)).length }))
    .sort((a, b) => b.score - a.score);
  const selected = ranked.filter(item => item.score > 0).slice(0, 4).map(item => item.id);
  for (const id of ['tasks', 'bots']) if (selected.length < 2 && !selected.includes(id)) selected.push(id);
  const widgets: Recipe[] = [
    { type: 'stat', title: 'Tasks', span: 6, rows: 1, source: { id: 'tasks.counts', params: {} }, options: { field: 'total' } },
    { type: 'stat', title: 'Needs you', span: 6, rows: 1, source: { id: 'needsYou.list', params: {} }, options: { field: 'count' } },
    ...selected.map(id => recipes[id]),
  ];
  // Fill the final row when there is an odd number of detail widgets.
  if (selected.length % 2) widgets[widgets.length - 1] = { ...widgets.at(-1)!, span: 12 };
  return widgets.map((widget, index) => ({ ...structuredClone(widget), id: `$new${index + 2}` }));
}
