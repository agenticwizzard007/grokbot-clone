import { DEFAULT_CONFIG, REGISTRY, type PatchOp, type UiConfig } from '@shared/ui-config/index';

export const setValue = (path: string, value: unknown): PatchOp[] => [{ op: 'add', path, value }];
export function resetLayout(includeDashboards: boolean): PatchOp[] {
  return [
    ...setValue('/layout', structuredClone(DEFAULT_CONFIG.layout)),
    ...setValue('/components', Object.fromEntries(REGISTRY.components.map(item => [item.id, item.default]))),
    ...setValue('/keybindings', {}),
    ...(includeDashboards ? setValue('/dashboards', []) : []),
  ];
}
export function sidebarVisibility(doc: UiConfig, id: string, visible: boolean): PatchOp[] {
  const hidden = doc.layout.sidebar.hidden.filter(item => item !== id);
  return setValue('/layout/sidebar/hidden', visible ? hidden : [...hidden, id]);
}
export function moveSidebar(doc: UiConfig, from: number, direction: -1 | 1): PatchOp[] {
  const to = from + direction;
  if (to < 0 || to >= doc.layout.sidebar.order.length) return [];
  return [{ op: 'move', from: `/layout/sidebar/order/${from}`, path: `/layout/sidebar/order/${to}` }];
}
export function createDashboard(name: string): PatchOp[] {
  return [{ op: 'add', path: '/dashboards/-', value: { id: '$new1', name, icon: 'layout-dashboard', widgets: [] } }];
}
export function renameDashboard(doc: UiConfig, id: string, name: string): PatchOp[] {
  const index = doc.dashboards.findIndex(d => d.id === id);
  return [{ op: 'test', path: `/dashboards/${index}/id`, value: id }, ...setValue(`/dashboards/${index}/name`, name)];
}
/** Remove every reference atomically, including shortcut widgets in other dashboards. */
export function deleteDashboard(doc: UiConfig, id: string): PatchOp[] {
  const index = doc.dashboards.findIndex(d => d.id === id);
  const patch: PatchOp[] = [{ op: 'test', path: `/dashboards/${index}/id`, value: id }];
  if (doc.layout.home.kind === 'dashboard' && doc.layout.home.dashboardId === id) patch.push(...setValue('/layout/home', { kind: 'default' }));
  patch.push(...setValue('/layout/pinned', doc.layout.pinned.filter(p => p.type !== 'dashboard' || p.id !== id)));
  const tabs = doc.layout.phoneTabs.filter(tab => tab !== `dashboard:${id}`);
  for (const tab of ['bots', 'tasks', 'search']) if (tabs.length < 3 && !tabs.includes(tab)) tabs.splice(Math.max(0, tabs.indexOf('settings')), 0, tab);
  patch.push(...setValue('/layout/phoneTabs', tabs));
  doc.dashboards.forEach((dashboard, di) => {
    if (dashboard.id === id) return;
    [...dashboard.widgets.entries()].reverse().forEach(([wi, widget]) => {
      if (widget.type !== 'shortcuts' || !Array.isArray(widget.options.items)) return;
      const items = widget.options.items.filter(item => item.target !== `dashboard:${id}`);
      if (!items.length) patch.push({ op: 'remove', path: `/dashboards/${di}/widgets/${wi}` });
      else if (items.length !== widget.options.items.length) patch.push(...setValue(`/dashboards/${di}/widgets/${wi}/options/items`, items));
    });
  });
  patch.push({ op: 'remove', path: `/dashboards/${index}` });
  return patch;
}
export function recordedShortcut(event: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): string | null {
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(event.key)) return null;
  const key = /^Key[A-Z]$/.test(event.code) ? event.code.slice(3) : /^Digit\d$/.test(event.code) ? event.code.slice(5) : event.key;
  return [...(event.metaKey || event.ctrlKey ? ['Mod'] : []), ...(event.altKey ? ['Alt'] : []), ...(event.shiftKey ? ['Shift'] : []), key.length === 1 ? key.toUpperCase() : key].join('+');
}

export function phoneTabPatch(doc: UiConfig, index: number, value: string): PatchOp[] {
  const tabs = Array.from({ length: 5 }, (_, i) => doc.layout.phoneTabs[i] ?? '');
  if (tabs[index] === 'settings') return [];
  const previous = tabs.indexOf(value);
  if (value && previous >= 0 && previous !== index) tabs[previous] = tabs[index];
  tabs[index] = value;
  return setValue('/layout/phoneTabs', tabs.filter(Boolean));
}
