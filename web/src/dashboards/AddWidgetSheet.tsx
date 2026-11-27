import { useState } from 'react';
import { Hash, List, Table, ChartColumn, Gauge, Bot, Columns3, Calendar, StickyNote, Link, Sparkles, ArrowRightLeft, GitBranch, FileText, Plug } from 'lucide-react';
import { WIDGETS, type WidgetType } from '@shared/ui-config/registry-widgets';
import type { SourceId } from '@shared/ui-config/registry-sources';
import { Section, ButtonGroup } from '../components/layout';
import { DashboardDialog } from './Dialog';
import { WidgetSettings } from './WidgetSettings';
import { defaultWidget, type Widget } from './model';
const icons = { stat: Hash, list: List, table: Table, chart: ChartColumn, meter: Gauge, botStatus: Bot, taskBoard: Columns3, routineSchedule: Calendar, note: StickyNote, shortcuts: Link, agent: Sparkles };
const descriptions: Record<WidgetType, string> = { stat: 'One clear number', list: 'Your latest items', table: 'Compare rows and columns', chart: 'Trends over time', meter: 'Progress toward a limit', botStatus: 'Your Bots at work', taskBoard: 'Tasks grouped by state', routineSchedule: 'Your next routine runs', note: 'A reminder or heading', shortcuts: 'Jump to your screens', agent: 'Answers from your work' };
const sources = [
  ['handoffs.list', 'Handoffs', 'Work between your Bots', ArrowRightLeft], ['loops.list', 'Loops', 'Progress across rounds', GitBranch],
  ['outputs.recent', 'Recent outputs', 'Results from your Bots', FileText], ['connectors.status', 'Connected apps', 'Your app connections', Plug],
  ['email.recent', 'Recent email', 'Your latest email', List], ['calendar.upcoming', 'Upcoming events', 'Your next meetings', Calendar], ['crm.deals', 'Sales pipeline', 'Your active deals', ChartColumn],
] as const;
export function sourceWidget(id: SourceId, title: string): Widget { return { ...defaultWidget('list'), title, source: { id, params: {} } }; }
export function AddWidgetSheet({ add, close, error }: { add(widget: Widget): Promise<boolean>; close(): void; error?: string }) {
  const [busy, setBusy] = useState(false), [agent, setAgent] = useState<Widget>();
  const save = async (widget: Widget) => { setBusy(true); try { if (await add(widget)) close(); } finally { setBusy(false); } };
  if (agent) return <WidgetSettings widget={agent} title="Ask your agent" submitLabel="Add widget" error={error} close={() => setAgent(undefined)} save={async widget => { const saved = await add(widget); if (saved) close(); return saved; }} />;
  return <DashboardDialog title="Add widget" close={close}><Section><div className="dashboard-library">{WIDGETS.map(widget => { const Icon = icons[widget.id]; return <button type="button" className="btn dashboard-library-item" key={widget.id} disabled={busy} onClick={() => {
    if (widget.id === 'agent') setAgent({ ...defaultWidget('agent'), options: { prompt: '', display: 'text', schedule: 'manual' } }); else void save(defaultWidget(widget.id));
  }}><Icon size={20} aria-hidden="true" /><strong>{widget.id === 'agent' ? 'Ask your agent' : widget.label}</strong><span>{descriptions[widget.id]}</span></button>; })}
    {sources.map(([id, title, description, Icon]) => <button type="button" className="btn dashboard-library-item" key={id} disabled={busy} onClick={() => void save(sourceWidget(id, title))}><Icon size={20} aria-hidden /><strong>{title}</strong><span>{description}</span></button>)}
  </div>{error && <p role="alert">{error}</p>}<ButtonGroup><button className="btn" type="button" onClick={close}>Cancel</button></ButtonGroup></Section></DashboardDialog>;
}
