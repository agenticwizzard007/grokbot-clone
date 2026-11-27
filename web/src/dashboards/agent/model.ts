import { UI_WIDGET_ROUTES, type AgentWidgetResult, type WidgetAction } from '@shared/ui-config';
import { parseScreen } from '../../lib/navigation';
export function widgetRoute(kind: keyof typeof UI_WIDGET_ROUTES, dashboardId: string, widgetId: string) {
  return UI_WIDGET_ROUTES[kind].replace(':dashboardId', encodeURIComponent(dashboardId)).replace(':widgetId', encodeURIComponent(widgetId));
}
export function updatedCaption(at: number | null, now = Date.now()) {
  if (at === null) return '';
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (!minutes) return 'Updated just now';
  if (minutes < 60) return `Updated ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `Updated ${hours} ${hours === 1 ? 'hour' : 'hours'} ago` : `Updated ${Math.floor(hours / 24)} ${hours < 48 ? 'day' : 'days'} ago`;
}
export function openActionScreen(action: WidgetAction) {
  return action.type === 'open' && action.route.startsWith('#') ? parseScreen(action.route) : null;
}
export const actionLabel = (action: WidgetAction) => ({ open: 'Open', send: 'Send to agent', approve: 'Approve' })[action.type];
export const emptyAnswer = (doc: AgentWidgetResult | null) => !doc || (doc.kind === 'list' && !doc.rows.length);
