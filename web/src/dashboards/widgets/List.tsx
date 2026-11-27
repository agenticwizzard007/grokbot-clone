import { Empty, Value, numberOption, rowTitle, rowHref, type WidgetProps } from './shared';
import { fieldLabel } from '../model';
export default function List({ widget, data }: WidgetProps) {
  const rows = data?.rows?.slice(0, numberOption(widget, 'limit', 5, 10)) ?? [];
  if (!rows.length) return <Empty widget={widget} text={widget.source?.id === 'handoffs.list' ? 'No handoffs in progress.' : widget.source?.id === 'loops.list' ? 'No loops in progress.' : widget.source?.id === 'outputs.recent' ? 'No outputs yet.' : 'No items yet.'} />;
  if (widget.source?.id === 'connectors.status' && rows.every(row => !row.connected)) return <div className="dashboard-empty-data"><p>Connect an app to see your data.</p><a className="btn" href="#settings/apps">Connect</a></div>;
  const fields = Array.isArray(widget.options.fields) ? widget.options.fields as string[] : ['botName', 'state'];
  return <ul className="dashboard-list">{rows.map((row, index) => { const href = rowHref(widget, row); return <li key={String(row.id ?? row.routineId ?? index)}>
    {href ? <a className="dashboard-list-title" href={href}>{rowTitle(row)}</a> : <strong className="dashboard-list-title">{rowTitle(row)}</strong>}
    <div className="dashboard-list-meta">{fields.filter(field => !['id', 'title', 'name'].includes(field) && row[field] != null).map(field => <span key={field} aria-label={fieldLabel(field)}><Value row={row} field={field} /></span>)}</div>
  </li>; })}</ul>;
}
