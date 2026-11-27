import { useState } from 'react';
import { LayoutDashboard } from 'lucide-react';
import { Page, Section, Card, Row, ButtonGroup } from '../../components/layout';
import { SettingsMenu } from '../../components/config/SettingsControls';
import { DashboardForm, type DashboardDialogState } from './DashboardForm';
import { DASHBOARD_LIMIT, moveDashboard } from './model';
import { useDashboardManager, openDashboard } from './useDashboardManager';
import '../dashboard-ui.css';
import '../../styles/dashboards.css';
export default function DashboardsManager() {
  const manager = useDashboardManager(), { doc, busy, status, error, patch, ask, canAsk } = manager;
  const [dialog, setDialog] = useState<DashboardDialogState>();
  const full = doc.dashboards.length >= DASHBOARD_LIMIT;
  const show = (state: DashboardDialogState) => { manager.setError(''); setDialog(state); };
  return <Page type="list" className="dashboard-page dashboards-manager" aria-label="Dashboards">
    {status === 'loading' ? <p role="status">Loading dashboards...</p> : <Section>
      {!doc.dashboards.length && <p>Create a dashboard for your work.</p>}
      <ButtonGroup className="dashboard-manager-actions"><button className="btn btn--primary" disabled={busy || full || status === 'disabled'} onClick={() => show({ kind: 'create' })}>Create</button><button className="btn btn--secondary" disabled={!canAsk} onClick={ask}>Ask your agent</button></ButtonGroup>
      {full && <p role="status">You have reached the limit of {DASHBOARD_LIMIT} dashboards.</p>}
      {!!doc.dashboards.length && <Card>{doc.dashboards.map((dashboard, index) => <Row key={dashboard.id} className="dashboard-manager-row" title={<button type="button" className="dashboard-open" onClick={() => openDashboard(dashboard)}><LayoutDashboard size={20} aria-hidden /><span>{dashboard.name}</span><span className="dashboard-caption">{dashboard.widgets.length} {dashboard.widgets.length === 1 ? 'widget' : 'widgets'}</span></button>} trailing={<SettingsMenu ariaLabel={`Manage ${dashboard.name}`} disabled={busy} items={[
        ...(!full ? [{ label: 'Duplicate', onSelect: () => show({ kind: 'duplicate', dashboard }) }] : []),
        { label: 'Rename', onSelect: () => show({ kind: 'rename', dashboard }) },
        ...(index > 0 ? [{ label: 'Move up', onSelect: () => void patch(moveDashboard(doc, dashboard.id, -1)) }] : []),
        ...(index < doc.dashboards.length - 1 ? [{ label: 'Move down', onSelect: () => void patch(moveDashboard(doc, dashboard.id, 1)) }] : []),
        { label: 'Delete', danger: true, onSelect: () => show({ kind: 'delete', dashboard }) },
      ]} />} />)}</Card>}
      {error && !dialog && <p role="alert">{error}</p>}
    </Section>}
    {dialog && <DashboardForm state={dialog} {...manager} close={() => setDialog(undefined)} />}
  </Page>;
}
