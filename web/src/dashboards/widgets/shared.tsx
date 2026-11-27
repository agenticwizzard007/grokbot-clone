import type { Widget, WidgetData } from '../model';
import { fieldLabel, textValue } from '../model';
export interface WidgetProps { widget: Widget; data?: WidgetData }
export const numberOption = (widget: Widget, key: string, fallback: number, maximum: number) => typeof widget.options[key] === 'number' ? Math.min(maximum, Math.max(1, widget.options[key] as number)) : fallback;
export const Empty = ({ text = 'No data yet.' }: { text?: string }) => <p className="dashboard-empty-data">{text}</p>;
export function Status({ value }: { value: unknown }) { return <span className="dashboard-status" data-status={String(value)}><span aria-hidden="true">●</span> {fieldLabel(String(value ?? 'Unavailable'))}</span>; }
export const rowTitle = (row: Record<string, unknown>) => String(row.title ?? row.name ?? row.botName ?? 'Item');
export function rowHref(widget: Widget, row: Record<string, unknown>): string | undefined {
  if (widget.options.onClick === 'none') return;
  if (typeof row.botId === 'string') return `#bot/${encodeURIComponent(row.botId)}/details/tasks`;
  if (widget.source?.id === 'bots.list' && typeof row.id === 'string') return `#bot/${encodeURIComponent(row.id)}`;
  if (widget.source?.id.startsWith('tasks.') || widget.source?.id === 'needsYou.list') return '#tasks';
  return undefined;
}
export function Value({ row, field }: { row: Record<string, unknown>; field: string }) {
  return field === 'state' || field === 'status' ? <Status value={row[field]} /> : <>{textValue(row[field], field)}</>;
}
