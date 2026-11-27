import { ArrowUp, ArrowDown, Settings2, Trash2 } from 'lucide-react';
import { widgetAction, widgetLabel, type Dashboard, type Widget, type ToolbarAction } from './model';
import type { PatchOp } from '@shared/ui-config/service';
const actions = [
  ['earlier', 'Move up', ArrowUp], ['later', 'Move down', ArrowDown], ['settings', 'Settings', Settings2], ['remove', 'Remove', Trash2],
] as const;
export function DashboardEditor({ dashboard, dashboardIndex, widget, busy, patch, settings }: { dashboard: Dashboard; dashboardIndex: number; widget: Widget; busy: boolean; patch(ops: PatchOp[]): Promise<boolean>; settings(widget: Widget): void }) {
  return <div className="dashboard-toolbar" role="group" aria-label={`Edit ${widgetLabel(widget)}`}>{actions.map(([action, label, Icon]) => {
    const ops = action === 'settings' ? [] : widgetAction(dashboardIndex, dashboard.widgets, widget.id, action as ToolbarAction);
    return <button className="cfg-btn cfg-btn--secondary" type="button" key={action} title={label} aria-label={`${label}: ${widgetLabel(widget)}`} disabled={busy || (action !== 'settings' && !ops.length)} onClick={async () => {
      if (action === 'settings') { settings(widget); return; }
      const index = dashboard.widgets.findIndex(item => item.id === widget.id), next = dashboard.widgets[index + 1] ?? dashboard.widgets[index - 1];
      if (await patch(ops) && action === 'remove') requestAnimationFrame(() => {
        const target = next ? document.querySelector<HTMLElement>(`[data-widget-id="${CSS.escape(next.id)}"] button`) : document.querySelector<HTMLElement>('[data-dashboard-add]'); target?.focus();
      });
    }}><Icon size={18} aria-hidden="true" /></button>;
  })}</div>;
}
