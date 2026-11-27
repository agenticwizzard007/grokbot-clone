import { Empty, Status, numberOption, type WidgetProps } from './shared';
export default function BotStatus({ widget, data }: WidgetProps) {
  const rows = data?.rows?.slice(0, numberOption(widget, 'limit', 6, 12)) ?? [];
  if (!rows.length) return <Empty widget={widget} text="No Bots yet." />;
  return <ul className="dashboard-bot-grid">{rows.map(row => <li key={String(row.id)}><span className="dashboard-bot-avatar" aria-hidden="true">{String(row.name ?? 'Bot').slice(0, 1)}</span>
    <div><a href={`#bot/${encodeURIComponent(String(row.id))}`}>{String(row.name)}</a><Status value={row.status} /><span className="dashboard-muted">{Number(row.openTasks) || 0} open tasks</span></div></li>)}</ul>;
}
