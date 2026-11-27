import { Empty, type WidgetProps } from './shared';
export default function RoutineSchedule({ widget, data }: WidgetProps) {
  const days = typeof widget.options.days === 'number' ? widget.options.days : 7;
  const rows = data?.rows?.filter(row => Number(row.at) <= Date.now() + days * 86400_000).slice(0, Math.max(1, Math.min(10, widget.rows * 2 - 1))) ?? [];
  if (!rows.length) return <Empty text="No upcoming runs." />;
  return <ol className="dashboard-schedule">{rows.map((row, index) => <li key={`${row.routineId}:${index}`}><strong>{String(row.name)}</strong><span>{String(row.botName)}</span><time dateTime={new Date(Number(row.at)).toISOString()}>{new Date(Number(row.at)).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}</time></li>)}</ol>;
}
