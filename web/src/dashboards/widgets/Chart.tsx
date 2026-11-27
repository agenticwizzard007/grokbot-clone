import { Empty, type WidgetProps } from './shared';
import { fieldLabel, widgetLabel } from '../model';
export default function Chart({ widget, data }: WidgetProps) {
  const rows = data?.rows?.slice(0, 31) ?? [];
  if (!rows.length || !data?.count) return <Empty widget={widget} text="No activity in this period." />;
  const fields = widget.source?.id === 'tasks.series' ? ['created', 'done'] : ['value'];
  const values = fields.map(field => rows.map(row => typeof row[field] === 'number' && Number.isFinite(row[field]) ? Math.max(0, Number(row[field])) : 0));
  const max = Math.max(...values.flat()) || 1, width = 480, height = 160, step = width / Math.max(1, rows.length);
  const y = (value: number) => height - value / max * (height - 12);
  return <div className="dashboard-chart">
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${widgetLabel(widget)}. Data table follows.`} preserveAspectRatio="none">
      <line x1="0" y1={height} x2={width} y2={height} className="dashboard-chart-axis" />
      {values.map((series, seriesIndex) => {
        const points = series.map((value, index) => `${step * (index + 0.5)},${y(value)}`).join(' ');
        return <g key={fields[seriesIndex]} className={`dashboard-chart-series dashboard-chart-series-${seriesIndex}`}>
          {widget.options.kind === 'bar' ? series.map((value, index) => <rect key={index} x={index * step + step * .1 + seriesIndex * step * .4} y={y(value)} width={Math.max(1, step * (fields.length > 1 ? .35 : .8))} height={height - y(value)} />)
            : <>{widget.options.kind === 'area' && <polygon className="dashboard-chart-area" points={`0,${height} ${points} ${width},${height}`} />}<polyline fill="none" points={points} vectorEffect="non-scaling-stroke" /></>}
        </g>;
      })}
    </svg>
    <div className="dashboard-chart-labels"><span>{String(rows[0].day ?? rows[0].state ?? '')}</span><span>{String(rows.at(-1)?.day ?? rows.at(-1)?.state ?? '')}</span></div>
    {fields.length > 1 && <div className="dashboard-chart-legend">{fields.map(field => <span key={field}>{fieldLabel(field)}</span>)}</div>}
    <table className="dashboard-sr-only"><caption>{widgetLabel(widget)} data</caption><thead><tr><th scope="col">Day or state</th>{fields.map(field => <th scope="col" key={field}>{fieldLabel(field)}</th>)}</tr></thead>
      <tbody>{rows.map((row, index) => <tr key={index}><th scope="row">{String(row.day ?? row.state)}</th>{fields.map(field => <td key={field}>{String(row[field] ?? 0)}</td>)}</tr>)}</tbody></table>
  </div>;
}
