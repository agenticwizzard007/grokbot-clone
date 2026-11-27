import { useRef, useState } from 'react';
import type { UiConfig } from '@shared/ui-config/index';
import { Row, ButtonGroup } from '../../layout';
import { Modal } from '../../modals/Modal';
import { SettingsMenu } from '../SettingsControls';
import { AppearanceSection, SelectRow } from './Controls';
import { appearanceRequest, exportAppearance } from './api';
type HistoryEntry = { revision: number; summary: string[]; actor: string; createdAt: number };
export function Manage({ doc, revision, run, onPreview, onChange }: { doc: UiConfig; revision: number; run: (fn: () => Promise<unknown>) => Promise<void>; onPreview: (id: string) => Promise<void>; onChange: () => Promise<void> }) {
  const input = useRef<HTMLInputElement>(null);
  const [dialog, setDialog] = useState<'history' | 'reset' | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [scope, setScope] = useState('appearance');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mutate = async (path: string, body: unknown) => { setBusy(true); setError(''); try { await appearanceRequest(path, 'POST', body, revision); await onChange(); setDialog(null); } catch (failure) { setError((failure as Error).message); throw failure; } finally { setBusy(false); } };
  return <AppearanceSection title="Manage">
    <Row title="Appearance" trailing={<ButtonGroup><button type="button" className="cfg-btn cfg-btn--secondary" disabled={revision === 0} onClick={() => void run(() => mutate('/ui/undo', { steps: 1 }))}>Undo</button><SettingsMenu ariaLabel="Manage appearance" items={[
      { label: 'Export', onSelect: () => void run(exportAppearance) },
      { label: 'Import', onSelect: () => input.current?.click() },
      { label: 'History', onSelect: () => void run(async () => { const result = await appearanceRequest<{ history: HistoryEntry[] }>('/ui/history'); setHistory(result.history.slice(0, 50)); setDialog('history'); }) },
      { label: 'Reset', danger: true, onSelect: () => setDialog('reset') },
    ]} /></ButtonGroup>} />
    <input ref={input} type="file" accept="application/json,.json" aria-label="Import appearance file" className="sr-only" tabIndex={-1} onChange={e => {
      const file = e.target.files?.[0]; e.target.value = ''; if (!file) return;
      void run(async () => {
        if (file.size > 256 * 1024) throw new Error('Choose a file smaller than 256 KB.');
        const result = await appearanceRequest<{ previewId: string }>('/ui/import/preview', 'POST', JSON.parse(await file.text()), revision);
        await onPreview(result.previewId);
      });
    }} />
    {dialog && <Modal label={dialog === 'history' ? 'Appearance history' : 'Reset appearance'} className="appearance-dialog" onClose={() => { if (!busy) setDialog(null); }}>
      {error && <p role="alert" className="cfg-error">{error}</p>}
      {dialog === 'history' ? <>
        {!history.length && <p>No changes yet.</p>}
        {history.map(entry => <Row key={entry.revision} title={`Revision ${entry.revision}`} subtitle={<><span>{entry.actor.startsWith('agent:') ? 'Agent' : entry.actor} · {new Date(entry.createdAt).toLocaleDateString()}</span><ul>{entry.summary.map((line, i) => <li key={i}>{line}</li>)}</ul></>} trailing={<button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} aria-label={`Restore revision ${entry.revision}`} onClick={() => void run(() => mutate(`/ui/history/${entry.revision}/restore`, {}))}>Restore</button>} />)}
      </> : <>
        <SelectRow label="Reset" value={scope} options={[{ value: 'appearance', label: 'Appearance' }, { value: 'all', label: 'Everything' }]} onChange={setScope} />
        <p>Clears colors, fonts, spacing, navigation, visibility and shortcuts. {scope === 'all' ? `Deletes ${doc.dashboards.length} dashboards and ${doc.dashboards.reduce((n, d) => n + d.widgets.length, 0)} widgets.` : `Keeps ${doc.dashboards.length} dashboards.`}</p>
        <ButtonGroup><button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={() => setDialog(null)}>Cancel</button><button type="button" className="cfg-btn cfg-btn--danger" disabled={busy} onClick={() => void run(() => mutate('/ui/reset', { scope }))}>Reset</button></ButtonGroup>
      </>}
    </Modal>}
  </AppearanceSection>;
}
