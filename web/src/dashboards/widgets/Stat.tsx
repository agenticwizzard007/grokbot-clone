import { Empty, type WidgetProps } from './shared';
export default function Stat({ widget, data }: WidgetProps) {
  const field = String(widget.options.field ?? 'count');
  const value = field === 'count' ? data?.count : data?.value?.[field];
  if ((data?.count === 0 && value === 0) || typeof value !== 'number' || !Number.isFinite(value)) return <Empty widget={widget} text={widget.source?.id === 'needsYou.list' ? 'Nothing needs you.' : widget.source?.id.startsWith('usage.') ? 'No usage yet.' : widget.source?.id.startsWith('tasks.') ? 'No tasks yet.' : 'No data yet.'} />;
  const format = widget.options.format;
  const text = format === 'usd' ? new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value)
    : format === 'percent' ? `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)}%` : new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
  return <output className="dashboard-stat">{text}</output>;
}
