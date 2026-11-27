// Synthetic configuration data only. Actual defaults come from the running contract.
export const PRESETS = ['swarm', 'midnight', 'paper', 'focus', 'contrast', 'calm'];
export const MATRIX = [...PRESETS, 'hostile'];
export const WIDTHS = [390, 1280];
export const MODES = ['light', 'dark'];
export const THEME_PATCH = [
  { op: 'replace', path: '/theme/mode', value: 'dark' },
  { op: 'add', path: '/theme/colors/dark/primary', value: '#2DD4BF' },
  { op: 'add', path: '/theme/colors/light/primary', value: '#0F766E' },
];
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
export function mergeDocument(base, overlay) {
  if (Array.isArray(overlay) || overlay === null || typeof overlay !== 'object') return structuredClone(overlay);
  const result = structuredClone(base ?? {});
  for (const [key, value] of Object.entries(overlay)) result[key] = mergeDocument(result[key], value);
  return result;
}
export function matrixDocument(defaults, fixture, mode, presetDoc = {}) {
  if (!MATRIX.includes(fixture)) throw new Error(`Unknown matrix fixture: ${fixture}`);
  let doc = mergeDocument(defaults, presetDoc);
  doc.preset = fixture === 'hostile' ? 'swarm' : fixture;
  doc.theme.mode = mode;
  doc.dashboards = [{ id: 'd_00000001', name: 'Fixture dashboard', icon: 'layout-dashboard', description: '', widgets: widgets() }];
  if (fixture === 'hostile') {
    doc.theme.font.scale = 'xlarge'; doc.theme.density = 'comfortable'; doc.theme.radius = 'round';
    doc.dashboards = Array.from({ length: 12 }, (_, i) => ({
      ...structuredClone(doc.dashboards[0]), id: `d_${String(i + 1).padStart(8, '0')}`,
      name: `Test dashboard ${i + 1} with a longer name`,
      widgets: doc.dashboards[0].widgets.map((w, j) => ({ ...structuredClone(w), id: `w_${String(i * 24 + j + 1).padStart(8, '0')}`, title: `Long fixture label for ${w.type} that should wrap` })),
    }));
  }
  return doc;
}
export function corruptDocument(defaults) {
  const doc = structuredClone(defaults);
  doc.layout.sidebar.hidden = ['settings']; doc.layout.phoneTabs = ['tasks'];
  doc.keybindings.settings = null; doc.theme.font.scale = 'tiny';
  doc.theme.colors.light = { pane: '#FFFFFF', ink: '#FFFFFF' };
  return doc;
}
