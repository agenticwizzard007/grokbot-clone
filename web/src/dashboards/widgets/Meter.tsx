import { Empty, type WidgetProps } from './shared';
export default function Meter({ widget, data }: WidgetProps) {
  const index = typeof widget.options.window === 'number' ? widget.options.window : 0;
  const row = data?.rows?.[index];
  if (!data?.available || !row || typeof row.usedPercent !== 'number') return <Empty text="No cached limits available." />;
  const percent = Math.min(100, Math.max(0, row.usedPercent));
  return <div className="dashboard-meter"><strong>{String(row.label ?? 'Usage')}</strong><progress max="100" value={percent} aria-label={String(row.label ?? 'Usage')} />
    <span>{percent}% used</span>{typeof row.resetsAt === 'number' && <span className="dashboard-muted">Resets {new Date(row.resetsAt).toLocaleString()}</span>}</div>;
}
