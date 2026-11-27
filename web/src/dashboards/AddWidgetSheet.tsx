import { useState } from 'react';
import { Hash, List, Table, ChartColumn, Gauge, Bot, Columns3, Calendar, StickyNote, Link } from 'lucide-react';
import { WIDGETS } from '@shared/ui-config/registry-widgets';
import { Section, ButtonGroup } from '../components/layout';
import { DashboardDialog } from './Dialog';
import { defaultWidget, type Widget } from './model';
const icons = [Hash, List, Table, ChartColumn, Gauge, Bot, Columns3, Calendar, StickyNote, Link, Bot];
const descriptions = ['One clear number', 'Your latest items', 'Compare rows and columns', 'Trends over time', 'Progress toward a limit', 'Your Bots at work', 'Tasks grouped by state', 'Your next routine runs', 'A reminder or heading', 'Jump to your screens', 'Answers from your agent'];
export function AddWidgetSheet({ add, close, error }: { add(widget: Widget): Promise<boolean>; close(): void; error?: string }) {
  const [busy, setBusy] = useState(false);
  return <DashboardDialog title="Add widget" close={close}><Section><div className="dashboard-library">{WIDGETS.map((widget, index) => { const Icon = icons[index]; return <button type="button" className="dashboard-library-item" key={widget.id} disabled={busy} onClick={async () => {
    setBusy(true); try { if (await add(defaultWidget(widget.id))) close(); } finally { setBusy(false); }
  }}><Icon size={20} aria-hidden="true" /><strong>{widget.label}</strong><span>{descriptions[index]}</span></button>; })}</div>
    {error && <p role="alert">{error}</p>}<ButtonGroup><button className="cfg-btn cfg-btn--secondary" type="button" onClick={close}>Cancel</button></ButtonGroup></Section></DashboardDialog>;
}
