import { useState } from 'react';
import { LayoutDashboard } from 'lucide-react';
import { Page, Section, Card, Row, ButtonGroup } from '../../components/layout';
import { SettingsMenu } from '../../components/config/SettingsControls';
import { DashboardForm, type DashboardDialogState } from './DashboardForm';
import { DASHBOARD_LIMIT, moveDashboard } from './model';
import { useDashboardManager, openDashboard } from './useDashboardManager';
import { AgentDashboardSheet } from '../AgentDashboardSheet';
import { SuggestDashboardSheet } from '../SuggestDashboardSheet';
import { refreshUiConfig } from '../../customization/store';
import '../dashboard-ui.css';
export default function DashboardsManager() {
  const manager = useDashboardManager(), { doc, busy, status, error, patch } = manager;
  const [dialog, setDialog] = useState<DashboardDialogState>();
  const [flow, setFlow] = useState<'agent' | 'suggest'>();
  const [retrying, setRetrying] = useState(false);
  const ask = () => { setDialog(undefined); setFlow('agent'); };
  const suggest = () => { setDialog(undefined); setFlow('suggest'); };
  const full = doc.dashboards.length >= DASHBOARD_LIMIT;
  const show = (state: DashboardDialogState) => { manager.setError(''); setDialog(state); };
  return <Page type="list" className="dashboard-page dashboards-manager" aria-label="Dashboards">
    {status === 'loading' ? <p role="status">Loading dashboards...</p> : status !== 'ready' ? <Section><Card><Section><p role="status">{status === 'disabled' ? 'Dashboards are not available for your account yet.' : 'Could not load your dashboards.'}</p><ButtonGroup><button type="button" className="btn btn--secondary" disabled={retrying} onClick={async () => { setRetrying(true); try { await refreshUiConfig(); } finally { setRetrying(false); } }}>{retrying ? 'Retrying...' : 'Retry'}</button></ButtonGroup></Section></Card></Section> : <Section>
      {!doc.dashboards.length && <p>Create a dashboard for your work.</p>}
      <ButtonGroup className="dashboard-manager-actions"><button className="btn btn--primary" disabled={busy || full} aria-describedby={busy || full ? 'dashboard-create-reason' : undefined} onClick={() => show({ kind: 'create' })}>Create</button><button className="btn btn--secondary" onClick={ask}>Create with your agent</button><button type="button" className="btn btn--secondary" onClick={suggest}>Suggest a dashboard for me</button></ButtonGroup>
      {(full || busy) && <p id="dashboard-create-reason" role="status">{busy ? 'Saving your dashboard...' : `You have ${DASHBOARD_LIMIT} dashboards, the maximum. Delete one to create another.`}</p>}
      {!!doc.dashboards.length && <Card>{doc.dashboards.map((dashboard, index) => <Row key={dashboard.id} className="dashboard-manager-row" title={<button type="button" className="dashboard-open" onClick={() => openDashboard(dashboard)}><LayoutDashboard size={20} aria-hidden /><span>{dashboard.name}</span>{dashboard.widgets.length > 0 && <span className="dashboard-caption">{dashboard.widgets.length} {dashboard.widgets.length === 1 ? 'widget' : 'widgets'}</span>}</button>} trailing={<SettingsMenu ariaLabel={`Manage ${dashboard.name}`} disabled={busy} items={[
        ...(!full ? [{ label: 'Duplicate', onSelect: () => show({ kind: 'duplicate', dashboard }) }] : []),
        { label: 'Rename', onSelect: () => show({ kind: 'rename', dashboard }) },
        ...(index > 0 ? [{ label: 'Move up', onSelect: () => void patch(moveDashboard(doc, dashboard.id, -1)) }] : []),
        ...(index < doc.dashboards.length - 1 ? [{ label: 'Move down', onSelect: () => void patch(moveDashboard(doc, dashboard.id, 1)) }] : []),
        { label: 'Delete', danger: true, onSelect: () => show({ kind: 'delete', dashboard }) },
      ]} />} />)}{doc.dashboards.some(dashboard => !dashboard.widgets.length) && <p className="dashboard-empty-hint">Empty dashboards are ready for widgets. Open one and tap Add widget.</p>}</Card>}
      {error && !dialog && <p role="alert">{error}</p>}
    </Section>}
    {dialog && <DashboardForm state={dialog} {...manager} ask={ask} suggest={suggest} close={() => setDialog(undefined)} />}
    {flow === 'agent' && <AgentDashboardSheet close={() => setFlow(undefined)} />}
    {flow === 'suggest' && <SuggestDashboardSheet close={() => setFlow(undefined)} />}
  </Page>;
}
