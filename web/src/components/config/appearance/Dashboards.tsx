import { useState } from 'react';
import type { UiConfig } from '@shared/ui-config/index';
import { ButtonGroup, Row, Section, Card, Page } from '../../layout';
import { Modal } from '../../modals/Modal';
import { SettingsMenu } from '../SettingsControls';
import { createDashboard, deleteDashboard, renameDashboard, setValue } from './patches';
import type { Patch } from './LayoutControls';
export function Dashboards({ doc, patch, readSaved, error }: { error: string; doc: UiConfig; patch: Patch; readSaved: () => Promise<UiConfig> }) {
  const [dialog, setDialog] = useState<{ kind: 'new' | 'rename' | 'delete'; id?: string } | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const dashboard = doc.dashboards.find(d => d.id === dialog?.id);
  const open = (id: string) => { location.hash = `dash/${id}`; };
  return <Section title="Dashboards" aria-label="Dashboards" className="appearance-section">
    <Card>
      {doc.dashboards.map(d => <Row className="appearance-dashboard-row" key={d.id} title={d.name} subtitle={`${d.widgets.length} widget${d.widgets.length === 1 ? '' : 's'}`} trailing={<ButtonGroup>
        <span className="appearance-button"><button type="button" className="cfg-btn cfg-btn--secondary" aria-label={`Open ${d.name}`} onClick={() => open(d.id)}>Open</button></span>
        <SettingsMenu ariaLabel={`Manage ${d.name}`} items={[
          { label: 'Set as home', onSelect: () => void patch(setValue('/layout/home', { kind: 'dashboard', dashboardId: d.id })) },
          { label: 'Rename', onSelect: () => { setName(d.name); setDialog({ kind: 'rename', id: d.id }); } },
          { label: 'Delete', danger: true, onSelect: () => setDialog({ kind: 'delete', id: d.id }) },
        ]} />
      </ButtonGroup>} />)}
      <Row title="New dashboard" trailing={<button type="button" className="cfg-btn cfg-btn--secondary" aria-label="New dashboard" disabled={doc.dashboards.length >= 12} onClick={() => { setName(''); setDialog({ kind: 'new' }); }}>Create</button>} />
    </Card>
    {dialog && <Modal label={dialog.kind === 'delete' ? 'Delete dashboard' : dialog.kind === 'new' ? 'New dashboard' : 'Rename dashboard'} className="appearance-dialog" onClose={() => { if (!busy) setDialog(null); }}>
      <Page title={dialog.kind === 'delete' ? 'Delete dashboard' : dialog.kind === 'new' ? 'New dashboard' : 'Rename dashboard'}><form onSubmit={async e => {
        e.preventDefault(); setBusy(true);
        try {
          const ops = dialog.kind === 'new' ? createDashboard(name.trim()) : dialog.kind === 'rename' ? renameDashboard(doc, dialog.id!, name.trim()) : deleteDashboard(doc, dialog.id!);
          if (await patch(ops)) {
            setDialog(null);
            if (dialog.kind === 'new') { const saved = await readSaved(); const created = saved.dashboards.find(d => !doc.dashboards.some(old => old.id === d.id)); if (created) open(created.id); }
          }
        } finally { setBusy(false); }
      }}>
        {dialog.kind === 'delete' ? <p>Delete {dashboard?.name} and {dashboard?.widgets.length ?? 0} {dashboard?.widgets.length === 1 ? 'widget' : 'widgets'}?</p> : <label>Name<input className="text-input" value={name} maxLength={40} required onChange={e => setName(e.target.value)} autoFocus /></label>}
        {error && <p role="alert" className="cfg-error">{error}</p>}
        <ButtonGroup><button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={() => setDialog(null)}>Cancel</button><button type="submit" className={`cfg-btn cfg-btn--${dialog.kind === 'delete' ? 'danger' : 'primary'}`} disabled={busy || (dialog.kind !== 'delete' && !name.trim())}>{dialog.kind === 'delete' ? 'Delete' : 'Save'}</button></ButtonGroup>
      </form></Page>
    </Modal>}
  </Section>;
}
