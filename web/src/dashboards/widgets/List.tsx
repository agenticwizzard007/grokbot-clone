import { Empty, Value, numberOption, rowTitle, rowHref, type WidgetProps } from './shared';
import { fieldLabel } from '../model';
export default function List({ widget, data }: WidgetProps) {
  // Size the card to whole rows, with room reserved for its title and View all.
  const capacity = Math.max(1, Math.floor((widget.rows * 104 - 16 - 64 - 44) / 72));
  const rows = data?.rows?.slice(0, Math.min(capacity, numberOption(widget, 'limit', 5, 10))) ?? [];
  const total = data?.count ?? data?.rows?.length ?? 0;
  const destination = widget.source?.id.startsWith('tasks.') || widget.source?.id === 'needsYou.list' ? '#tasks' : widget.source?.id === 'outputs.recent' ? '#reports' : widget.source?.id?.startsWith('bots.') ? '#bots' : undefined;
  const more = total > rows.length && destination ? <li className="dashboard-view-all"><a href={destination}>View all {total}</a></li> : null;
  if (!rows.length) return <Empty widget={widget} text={widget.source?.id === 'handoffs.list' ? 'No handoffs in progress.' : widget.source?.id === 'loops.list' ? 'No loops in progress.' : widget.source?.id === 'outputs.recent' ? 'No outputs yet.' : 'No items yet.'} />;
  if (widget.source?.id === 'connectors.status' && rows.every(row => !row.connected)) return <div className="dashboard-empty-data"><p>Connect an app to see your data.</p><a className="btn btn--secondary" href="#settings/apps">Connect</a></div>;
  const fields = Array.isArray(widget.options.fields) ? widget.options.fields as string[] : ['botName', 'state'];
  if (widget.source?.id === 'outputs.recent') return <ul className="dashboard-list dashboard-output-list">{rows.map((row, index) => {
    const href = rowHref(widget, row);
    const content = <><strong className="dashboard-list-title">{rowTitle(row)}</strong><span className="dashboard-list-meta">{fields.filter(field => !['id', 'title', 'name'].includes(field) && row[field] != null).map(field => <span key={field} aria-label={fieldLabel(field)}><Value row={row} field={field} /></span>)}</span></>;
    return <li key={String(row.id ?? index)}>{href ? <a className="dashboard-output-row" href={href}>{content}</a> : <div className="dashboard-output-row">{content}</div>}</li>;
  })}{more}</ul>;
  return <ul className="dashboard-list">{rows.map((row, index) => { const href = rowHref(widget, row); return <li key={String(row.id ?? row.routineId ?? index)}>
    {href ? <a className="dashboard-list-title" href={href}>{rowTitle(row)}</a> : <strong className="dashboard-list-title">{rowTitle(row)}</strong>}
    <div className="dashboard-list-meta">{fields.filter(field => !['id', 'title', 'name'].includes(field) && row[field] != null).map(field => <span key={field} aria-label={fieldLabel(field)}><Value row={row} field={field} /></span>)}</div>
  </li>; })}{more}</ul>;
}
