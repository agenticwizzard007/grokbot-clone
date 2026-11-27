import type { Dashboard, UiConfig, PatchOp } from '@shared/ui-config';
export { deleteDashboard } from '../../components/config/appearance/patches';
export const DASHBOARD_LIMIT = 12;
export function createDashboard(name: string): PatchOp[] {
  return [{ op: 'add', path: '/dashboards/-', value: { id: '$new1', name: name.trim(), icon: 'layout-dashboard', widgets: [] } }];
}
export function duplicateDashboard(dashboard: Dashboard, name: string): PatchOp[] {
  const copy = structuredClone(dashboard);
  copy.id = '$new1'; copy.name = name.trim();
  copy.widgets = copy.widgets.map((widget, index) => ({ ...widget, id: `$new${index + 2}` }));
  return [{ op: 'add', path: '/dashboards/-', value: copy }];
}
export function renameDashboard(doc: UiConfig, id: string, name: string): PatchOp[] {
  const index = doc.dashboards.findIndex(dashboard => dashboard.id === id);
  return index < 0 ? [] : [{ op: 'test', path: `/dashboards/${index}/id`, value: id }, { op: 'replace', path: `/dashboards/${index}/name`, value: name.trim() }];
}
export function moveDashboard(doc: UiConfig, id: string, direction: -1 | 1): PatchOp[] {
  const index = doc.dashboards.findIndex(dashboard => dashboard.id === id), target = index + direction;
  return index < 0 || target < 0 || target >= doc.dashboards.length ? [] : [{ op: 'test', path: `/dashboards/${index}/id`, value: id }, { op: 'move', from: `/dashboards/${index}`, path: `/dashboards/${target}` }];
}
