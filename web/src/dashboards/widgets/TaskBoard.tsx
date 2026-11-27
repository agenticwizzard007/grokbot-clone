import { Empty, type WidgetProps } from './shared';
export default function TaskBoard({ widget, data }: WidgetProps) {
  if (!data?.rows?.length) return <Empty widget={widget} text="No tasks yet." />;
  return <div className="dashboard-task-board">{[['working', 'Working'], ['needs_input', 'Needs input'], ['done', 'Done']].map(([state, label]) => <section key={state} aria-label={label}>
    <h3>{label}</h3><ul>{data.rows!.filter(row => row.state === state).slice(0, 5).map(row => <li key={String(row.id)}><a href={typeof row.botId === 'string' ? `#bot/${encodeURIComponent(row.botId)}/details/tasks` : '#tasks'}>{String(row.title)}</a></li>)}</ul>
    {!data.rows!.some(row => row.state === state) && <p className="dashboard-muted">No tasks</p>}
  </section>)}</div>;
}
