import { Empty, Value, numberOption, type WidgetProps } from './shared';
import { fieldLabel, widgetLabel } from '../model';
export default function Table({ widget, data }: WidgetProps) {
  const rows = data?.rows?.slice(0, numberOption(widget, 'limit', 5, 10)) ?? [];
  if (!rows.length) return <Empty text="No rows yet." />;
  const columns = (Array.isArray(widget.options.columns) ? widget.options.columns : ['title', 'state']).slice(0, 5) as string[];
  return <table className="dashboard-table"><caption className="dashboard-sr-only">{widgetLabel(widget)}</caption><thead><tr>{columns.map(field => <th key={field} scope="col">{fieldLabel(field)}</th>)}</tr></thead>
    <tbody>{rows.map((row, index) => <tr key={String(row.id ?? index)}>{columns.map(field => <td key={field}><Value row={row} field={field} /></td>)}</tr>)}</tbody></table>;
}
