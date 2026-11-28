import { useState } from 'react';
import { createPortal } from 'react-dom';
import { RefreshCw } from 'lucide-react';
import type { PatchOp } from '@shared/ui-config/service';
import { Page, Section, Card, ButtonGroup } from '../components/layout';
import { useEffectiveConfig, useUiPatch, useUiConfig } from '../customization';
import { AgentDashboardSheet } from './AgentDashboardSheet';
import { SuggestDashboardSheet } from './SuggestDashboardSheet';
import { DashboardGrid } from './DashboardGrid';
import { DashboardEditor } from './DashboardEditor';
import { AddWidgetSheet } from './AddWidgetSheet';
import { WidgetSettings } from './WidgetSettings';
import { findDashboard, type Widget, type Dashboard } from './model';
import { useWidgetData } from './useWidgetData';
import './dashboard-ui.css';

export default function DashboardView({ dashboardId, id, slug }: { dashboardId?: string; id?: string; slug?: string }) {
  const config = useEffectiveConfig(), { status } = useUiConfig();
  const reference = dashboardId ?? id ?? slug ?? decodeURIComponent(window.location.hash.replace(/^#dash\//, ''));
  const dashboard = findDashboard(config.dashboards, reference);
  if (status === 'loading' && !dashboard) return <Page type="wide" title="Dashboard"><Section><Card><p role="status">Loading dashboard...</p></Card></Section></Page>;
  if (!dashboard) return <Page type="wide" title="Dashboard"><Section><Card><p>This dashboard is unavailable.</p><a className="btn btn--secondary" href="#bots">Open Bots</a></Card></Section></Page>;
  return <DashboardScreen key={dashboard.id} dashboard={dashboard} index={config.dashboards.findIndex(item => item.id === dashboard.id)} />;
}
function DashboardScreen({ dashboard, index }: { dashboard: Dashboard; index: number }) {
  const [editing, setEditing] = useState(false), [add, setAdd] = useState(false), [settings, setSettings] = useState<Widget>();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const apply = useUiPatch(), data = useWidgetData(dashboard.widgets);
  const patch = async (ops: PatchOp[]) => {
    if (!ops.length || busy) return false;
    setBusy(true); setError('');
    try {
      const result = await apply([{ op: 'test', path: `/dashboards/${index}/id`, value: dashboard.id }, ...ops], 'Edit dashboard');
      if (!result.ok) { setError(result.errors.map(error => error.message).join(' ')); return false; }
      return true;
    } catch { setError('Could not save this change. Try again.'); return false; }
    finally { setBusy(false); }
  };
  const [flow, setFlow] = useState<'agent' | 'suggest'>();
  const ask = () => setFlow('agent');
  const header = document.getElementById('dashboard-header-actions');
  const Actions = editing ? ButtonGroup : 'div';
  return <Page type="wide" className="dashboard-page" aria-label={dashboard.name}>
    {dashboard.description && <header className="dashboard-heading"><p>{dashboard.description}</p></header>}
    {!!dashboard.widgets.length && header && createPortal(<Actions className={`dashboard-header-actions${editing ? ' dashboard-header-actions--editing' : ''}`}>{editing ? <>
      <button type="button" className="btn btn--secondary" data-dashboard-add disabled={busy || dashboard.widgets.length >= 24} onClick={() => { setError(''); setAdd(true); }}>Add widget</button>
      <button type="button" className="btn btn--primary" disabled={busy} onClick={() => setEditing(false)}>Done</button>
    </> : <>
      <button type="button" className="btn btn--secondary dashboard-refresh" aria-label="Refresh dashboard" title="Refresh dashboard" onClick={() => data.refresh()} disabled={!dashboard.widgets.some(widget => widget.source)}><RefreshCw size={20} aria-hidden /></button>
      <button type="button" className="btn btn--text" aria-label="Edit dashboard" onClick={() => { setError(''); setEditing(true); }}>Edit</button>
    </>}</Actions>, header)}
    {error && !add && !settings && <p className="dashboard-error" role="alert">{error}</p>}
    {!dashboard.widgets.length ? <Section><Card className="dashboard-empty"><p>Your dashboard is empty.</p><ButtonGroup><button className="btn btn--primary" type="button" data-dashboard-add onClick={() => { setEditing(true); setAdd(true); }}>Add widget</button><button className="btn btn--secondary" type="button" onClick={ask}>Create with your agent</button><button className="btn btn--secondary" type="button" onClick={() => setFlow('suggest')}>Suggest a dashboard for me</button></ButtonGroup></Card></Section>
      : <DashboardGrid dashboardId={dashboard.id} move={editing ? (from, to) => { const source = dashboard.widgets.findIndex(w => w.id === from), target = dashboard.widgets.findIndex(w => w.id === to); if (source >= 0 && target >= 0 && source !== target) void patch([{ op: 'test', path: `/dashboards/${index}/widgets/${source}/id`, value: from }, { op: 'test', path: `/dashboards/${index}/widgets/${target}/id`, value: to }, { op: 'move', from: `/dashboards/${index}/widgets/${source}`, path: `/dashboards/${index}/widgets/${target}` }]); } : undefined} widgets={dashboard.widgets} states={data.states} observe={data.observe} refresh={data.refresh}
        toolbar={editing ? widget => <DashboardEditor dashboard={dashboard} dashboardIndex={index} widget={widget} busy={busy} patch={patch} settings={widget => { setError(''); setSettings(widget); }} /> : undefined} />}
    {flow === 'agent' && <AgentDashboardSheet close={() => setFlow(undefined)} />}
    {flow === 'suggest' && <SuggestDashboardSheet close={() => setFlow(undefined)} />}
    {add && <AddWidgetSheet close={() => setAdd(false)} error={error} add={widget => patch([{ op: 'add', path: `/dashboards/${index}/widgets/-`, value: widget }])} />}
    {settings && <WidgetSettings widget={settings} error={error} close={() => setSettings(undefined)} save={widget => {
      const position = dashboard.widgets.findIndex(item => item.id === settings.id);
      if (position < 0) { setError('This widget was removed.'); return Promise.resolve(false); }
      return patch([{ op: 'test', path: `/dashboards/${index}/widgets/${position}/id`, value: settings.id }, { op: 'replace', path: `/dashboards/${index}/widgets/${position}`, value: widget }]);
    }} />}
  </Page>;
}
