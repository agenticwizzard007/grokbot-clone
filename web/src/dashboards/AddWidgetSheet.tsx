import { useState } from 'react';
import { WIDGETS } from '@shared/ui-config/registry-widgets';
import { Section, ButtonGroup } from '../components/layout';
import { DashboardDialog } from './Dialog';
import { defaultWidget, type Widget } from './model';
const descriptions = ['One clear number', 'Your latest items', 'Compare rows and columns', 'Trends over time', 'Progress toward a limit', 'Your Bots at work', 'Tasks grouped by state', 'Your next routine runs', 'A reminder or heading', 'Jump to your screens'];
export function AddWidgetSheet({ add, close, error }: { add(widget: Widget): Promise<boolean>; close(): void; error?: string }) {
  const [busy, setBusy] = useState(false);
  return <DashboardDialog title="Add widget" close={close}><Section><div className="dashboard-library">{WIDGETS.map((widget, index) => <button type="button" className="btn dashboard-library-item" key={widget.id} disabled={busy} onClick={async () => {
    setBusy(true); try { if (await add(defaultWidget(widget.id))) close(); } finally { setBusy(false); }
  }}><strong>{widget.label}</strong><span>{descriptions[index]}</span></button>)}</div>
    {error && <p role="alert">{error}</p>}<ButtonGroup><button className="btn" type="button" onClick={close}>Cancel</button></ButtonGroup></Section></DashboardDialog>;
}
