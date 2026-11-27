// Synthetic configuration data only. Actual defaults come from the running contract.
export const MATRIX = ['default', 'navigation', 'dashboard-seeded', 'dashboard-empty'];
export const WIDTHS = [390, 1280];
export const LAYOUT_PATCH = [
  { op: 'replace', path: '/layout/home', value: { kind: 'tasks' } },
  { op: 'replace', path: '/layout/phoneTabs', value: ['tasks', 'bots', 'search', 'settings'] },
];
export function widgets(temporary = false) {
  const items = [
    ['stat', 'Working tasks', 4, 1, 'tasks.counts', {}, { field: 'working', format: 'number' }],
    ['stat', 'Needs you', 4, 1, 'needsYou.list', {}, { field: 'count', format: 'number' }],
    ['stat', 'Spent this week', 4, 1, 'usage.summary', { range: '7d' }, { field: 'costUsd', format: 'usd' }],
    ['list', 'Open tasks', 6, 3, 'tasks.list', { limit: 10 }, { limit: 5 }],
    ['chart', 'Cost by day', 6, 3, 'usage.series', { range: '7d', metric: 'cost' }, { kind: 'bar' }],
    ['table', 'Task table', 6, 3, 'tasks.list', { limit: 10 }, { columns: ['title', 'state'], limit: 5 }],
    ['meter', 'Usage window', 6, 3, 'usage.windows', {}, { window: 0 }],
    ['botStatus', 'Bot status', 6, 3, 'bots.status', { limit: 6 }, { limit: 6 }],
    ['taskBoard', 'Task board', 6, 3, 'tasks.list', { limit: 10 }, {}],
    ['routineSchedule', 'Upcoming routines', 12, 3, 'routines.upcoming', { days: 7 }, { days: 7 }],
    ['note', 'Fixture notes', 6, 2, null, {}, { text: '## Test notes\nOnly placeholder content.' }],
    ['shortcuts', 'Quick links', 6, 2, null, {}, { items: [{ label: 'Open tasks', target: 'tasks' }] }],
  ];
  return items.map(([type, title, span, rows, source, params, options], index) => ({
    id: temporary ? `$new${index + 2}` : `w_${String(index + 1).padStart(8, '0')}`,
    type, title, span, rows, ...(source ? { source: { id: source, params } } : {}), options,
  }));
}
export function dashboardPatch() {
  return [
    { op: 'add', path: '/dashboards/-', value: { id: '$new1', name: 'My week', icon: 'layout-dashboard', description: '', widgets: widgets(true) } },
    { op: 'add', path: '/layout/pinned/-', value: { type: 'dashboard', id: '$new1' } },
  ];
}
export function matrixDocument(defaults, fixture) {
  if (!MATRIX.includes(fixture)) throw new Error(`Unknown matrix fixture: ${fixture}`);
  const doc = structuredClone(defaults);
  if (fixture === 'navigation') {
    doc.layout.home = { kind: 'tasks' };
    doc.layout.phoneTabs = ['tasks', 'bots', 'search', 'settings'];
  }
  if (fixture.startsWith('dashboard-')) {
    doc.dashboards = [{ id: 'd_00000001', name: 'Fixture dashboard', icon: 'layout-dashboard', description: '', widgets: widgets() }];
    doc.layout.pinned = [{ type: 'dashboard', id: 'd_00000001' }];
  }
  return doc;
}
export function corruptDocument(defaults) {
  const doc = structuredClone(defaults);
  doc.layout.sidebar.hidden = ['settings']; doc.layout.phoneTabs = ['tasks'];
  doc.keybindings.settings = null;
  return doc;
}
// Chat actions use stable JSON pointers after the proposal is confirmed.
export const DASHBOARD_EDITS = [
  { name: 'add', intent: 'Add a note with my weekly goal', patch: [{ op: 'add', path: '/dashboards/0/widgets/-', value: { id: '$new1', type: 'note', title: 'Weekly goal', span: 6, rows: 2, options: { text: 'Review the fixture tasks weekly.' } } }] },
  { name: 'remove', intent: 'Remove the added weekly goal note', patch: [{ op: 'remove', path: '/dashboards/0/widgets/12' }] },
  { name: 'reorder', intent: 'Move working tasks after needs you', patch: [{ op: 'move', from: '/dashboards/0/widgets/0', path: '/dashboards/0/widgets/1' }] },
  { name: 'resize', intent: 'Make working tasks wider and taller', patch: [{ op: 'replace', path: '/dashboards/0/widgets/1/span', value: 6 }, { op: 'replace', path: '/dashboards/0/widgets/1/rows', value: 2 }] },
];
export const REQUIREMENTS = {
  sales: { role: 'Sales coordinator', goals: ['Follow up on outreach and pipeline'], workflows: [{ name: 'Pipeline review', cadence: 'weekly' }], focus: ['tasks', 'routines', 'bots'], lens: 'sales' },
  operations: { role: 'Operations coordinator', goals: ['Daily reports and usage review'], workflows: [{ name: 'Usage report', cadence: 'daily' }], focus: ['routines', 'usage'], lens: 'operations' },
  support: { role: 'Support coordinator', goals: ['Manage response queues'], workflows: [{ name: 'Queue review', cadence: 'daily' }], focus: ['tasks', 'chat', 'team'], lens: 'support' },
};
export const requirementsPatch = profile => Object.entries(profile).map(([key, value]) => ({ op: 'add', path: `/${key}`, value }));
