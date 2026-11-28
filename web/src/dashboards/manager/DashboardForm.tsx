import { useState } from 'react';
import { uniqueDashboardName } from '@shared/ui-config/presentation';
import type { Dashboard, PatchOp, UiConfig } from '@shared/ui-config';
import { ButtonGroup, Section } from '../../components/layout';
import { DashboardDialog } from '../Dialog';
import { createDashboard, deleteDashboard, duplicateDashboard, renameDashboard } from './model';
export type DashboardDialogState = { kind: 'create' } | { kind: 'rename' | 'duplicate' | 'delete'; dashboard: Dashboard };
export function DashboardForm({ state, doc, busy, error, patch, close, ask, suggest }: {
  state: DashboardDialogState; doc: UiConfig; busy: boolean; error: string; patch(ops: PatchOp[], openNew?: boolean): Promise<boolean>; close(): void; ask(): void; suggest(): void;
}) {
  const [name, setName] = useState(state.kind === 'create' ? uniqueDashboardName('My week', doc.dashboards.map(d => d.name)) : state.kind === 'duplicate' ? uniqueDashboardName(`${state.dashboard.name.slice(0, 35)} copy`, doc.dashboards.map(d => d.name)) : state.dashboard.name);
  const label = { create: 'Create dashboard', rename: 'Rename dashboard', duplicate: 'Duplicate dashboard', delete: 'Delete dashboard' }[state.kind];
  return <DashboardDialog title={label} close={() => { if (!busy) close(); }}><form onSubmit={async event => {
    event.preventDefault();
    if (busy || (state.kind !== 'delete' && !name.trim())) return;
    const ops = state.kind === 'create' ? createDashboard(name) : state.kind === 'rename' ? renameDashboard(doc, state.dashboard.id, name) : state.kind === 'duplicate' ? duplicateDashboard(state.dashboard, name) : deleteDashboard(doc, state.dashboard.id);
    if (await patch(ops, state.kind === 'create' || state.kind === 'duplicate')) close();
  }}><Section>{state.kind === 'create' && <button type="button" className="btn btn--secondary" disabled={busy} onClick={suggest}>Suggest a dashboard for me</button>}{state.kind === 'delete' ? <p>Delete {state.dashboard.name} and its {state.dashboard.widgets.length} {state.dashboard.widgets.length === 1 ? 'widget' : 'widgets'}?</p> : <label className="dashboard-field">Name<input autoFocus required maxLength={40} value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>}
    {(busy || (state.kind !== 'delete' && !name.trim())) && <p id="dashboard-name-hint" role="status">{busy ? 'Saving your dashboard...' : 'Enter a dashboard name.'}</p>}
    {error && <p role="alert">{error}</p>}
    <ButtonGroup><button type="button" className="btn btn--secondary" disabled={busy} onClick={close}>Cancel</button><button type="submit" className={`btn ${state.kind === 'delete' ? 'btn--danger' : 'btn--primary'}`} disabled={busy || (state.kind !== 'delete' && !name.trim())} aria-describedby={busy || !name.trim() ? 'dashboard-name-hint' : undefined}>{state.kind === 'delete' ? 'Delete' : state.kind === 'create' ? 'Create' : state.kind === 'duplicate' ? 'Duplicate' : 'Save'}</button></ButtonGroup>
    {state.kind === 'create' && <button type="button" className="btn btn--secondary" disabled={busy} onClick={ask}>Create with your agent</button>}
  </Section></form></DashboardDialog>;
}
