import { useEffect, useRef, useState } from 'react';
import type { UiPreviewCardBody } from '@shared/ui-config/index';
import { EMPTY_REQUIREMENTS, type RequirementsFields, type RequirementsProfile } from '@shared/ui-config/adapt';
import { FOCUS_IDS } from '@shared/ui-config/adapt-keywords';
import { ButtonGroup, Card, Row, Section } from '../../layout';
import { SettingsMenu } from '../SettingsControls';
import { UiPreviewCard } from '../../cards/UiPreviewCard';
import { appearanceRequest, readPreview } from './api';
import '../../../styles/appearance.css';

type Snapshot = { profile: RequirementsProfile | null; revision: number; undoToken?: string };
type Proposal = { previewId: string; title: string; summary: string[]; warnings: { message: string }[] };
const labels = { tasks: 'Tasks', bots: 'Bots', routines: 'Routines', usage: 'Usage', files: 'Files', chat: 'Chat', apps: 'Apps', team: 'Team' };
const fieldStyle = { display: 'grid', gap: 8 };
const requirementsStyles = `
.requirements-settings { display: grid; gap: 24px; min-width: 0; font-size: 14px; line-height: 20px; color: var(--color-text-primary); }
.requirements-settings p { margin: 0; }
.requirements-settings :is(button, .cfg-btn) { gap: 8px; padding: 8px 16px; font-size: 14px; line-height: 20px; }
.requirements-settings .settings-menu > button { width: 100%; }
.requirements-settings .layout-row__subtitle { font-size: 13px; line-height: 20px; margin-top: 8px; }
.requirements-settings .cfg-chip { height: auto; padding: 4px 8px; font-size: 14px; line-height: 20px; }
.app-settings .requirements-settings :is(input, select, textarea) { width: 100%; min-width: 0; min-height: 44px; font: 400 14px/20px var(--font-stack); }
.app-settings .requirements-settings select { padding-right: 32px; }
.requirements-settings .text-input::placeholder { color: var(--color-text-secondary); }
.requirements-settings .requirements-focus[aria-pressed='true'] { box-shadow: inset 0 0 0 2px var(--color-primary); background: var(--color-bg-active); color: var(--color-text-primary); }
@media (max-width: 760px) { .app-settings .requirements-settings :is(input, select, textarea) { font-size: 16px; } }
`;

export function Requirements() {
  const [saved, setSaved] = useState<Snapshot | null>(null);
  const [fields, setFields] = useState<RequirementsFields>(structuredClone(EMPTY_REQUIREMENTS));
  const [goals, setGoals] = useState('');
  const [preview, setPreview] = useState<UiPreviewCardBody | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const hydrate = (value: Snapshot) => {
    setSaved(value); setFields(value.profile ?? structuredClone(EMPTY_REQUIREMENTS)); setGoals(value.profile?.goals.join('\n') ?? '');
  };
  useEffect(() => {
    let alive = true;
    void appearanceRequest<Snapshot>('/ui/requirements').then(value => { if (alive) hydrate(value); }).catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, []);
  const run = async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(''); setMessage('');
    try { await action(); } catch (e) { setError((e as Error).message); }
    finally { lock.current = false; setBusy(false); }
  };
  const save = async () => {
    const values = { role: fields.role, goals: goals.split('\n').map(goal => goal.trim()).filter(Boolean), workflows: fields.workflows, focus: fields.focus };
    const patch = Object.entries(values).map(([key, value]) => ({ op: 'add', path: `/${key}`, value }));
    await appearanceRequest('/ui/requirements', 'PUT', { patch }, saved!.revision);
    const latest = await appearanceRequest<Snapshot>('/ui/requirements');
    hydrate(latest);
    return latest;
  };
  const propose = async () => {
    const latest = await save();
    const result = await appearanceRequest<Proposal>('/ui/requirements/suggest', 'POST', {}, latest.revision);
    setPreview({ card: 'ui_preview', previewId: result.previewId, title: result.title,
      lines: result.summary, moreCount: 0, warnings: result.warnings.map(w => w.message), status: 'pending' });
  };
  if (!saved) return <Section role="region" aria-label="About you"><p role={error ? 'alert' : 'status'}>{error || 'Loading your requirements...'}</p></Section>;
  return <div role="region" aria-label="About you" className="requirements-settings">
    <style>{requirementsStyles}</style>
    {error && <p role="alert">{error}</p>}
    {message && <p role="status"><span className="cfg-chip">{message}</span></p>}
    {!preview && <fieldset disabled={busy || !saved} className="appearance-fields" aria-label="Your requirements" aria-busy={busy}>
      <Card style={{ display: 'grid', gap: 16, padding: 16 }}>
        <Row title="Profile" trailing={<SettingsMenu ariaLabel="Manage requirements" disabled={!saved.profile} items={[
          { label: 'Reset', danger: true, onSelect: () => void run(async () => { await appearanceRequest('/ui/requirements', 'DELETE', {}, saved.revision); hydrate(await appearanceRequest<Snapshot>('/ui/requirements')); setMessage('Cleared'); }) },
        ]} />} />
        <label style={fieldStyle}>Role<input className="text-input" maxLength={60} value={fields.role} onChange={e => setFields({ ...fields, role: e.target.value })} /></label>
        <label style={fieldStyle}>Goals<textarea aria-label="Goals" className="text-input" rows={3} value={goals} placeholder="One goal per line, up to six" onChange={e => setGoals(e.target.value)} /></label>
        <Section title="Workflows">
          {fields.workflows.map((workflow, i) => <Card key={i} style={{ display: 'grid', gap: 8, padding: 16 }}>
            <label style={fieldStyle}>Workflow {i + 1}<input className="text-input" maxLength={80} value={workflow.name} onChange={e => setFields({ ...fields, workflows: fields.workflows.map((w, n) => n === i ? { ...w, name: e.target.value } : w) })} /></label>
            <label style={fieldStyle}>Cadence<select aria-label={`Cadence ${i + 1}`} className="text-input" value={workflow.cadence} onChange={e => setFields({ ...fields, workflows: fields.workflows.map((w, n) => n === i ? { ...w, cadence: e.target.value as typeof w.cadence } : w) })}>
              <option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="ad_hoc">As needed</option>
            </select></label>
            <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setFields({ ...fields, workflows: fields.workflows.filter((_, n) => n !== i) })}>Remove workflow {i + 1}</button>
          </Card>)}
          <button type="button" className="cfg-btn cfg-btn--secondary" disabled={fields.workflows.length >= 8} onClick={() => setFields({ ...fields, workflows: [...fields.workflows, { name: '', cadence: 'weekly' }] })}>Add workflow</button>
        </Section>
        <Section title="Focus"><div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
          {FOCUS_IDS.map(id => <button type="button" key={id} className="cfg-btn cfg-btn--secondary requirements-focus" aria-pressed={fields.focus.includes(id)} onClick={() => setFields({ ...fields, focus: fields.focus.includes(id) ? fields.focus.filter(f => f !== id) : [...fields.focus, id] })}>{labels[id]}</button>)}
        </div></Section>
        <ButtonGroup stack>
          <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => void run(async () => { await save(); setMessage('Saved'); })}>Save changes</button>
          <button type="button" className="cfg-btn cfg-btn--primary" onClick={() => void run(propose)}>Suggest a dashboard</button>
        </ButtonGroup>
      </Card>
    </fieldset>}
    {preview && <>
      <UiPreviewCard key={preview.previewId} body={preview} />
      <ButtonGroup><button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={() => void run(async () => {
        if ((await readPreview(preview.previewId)).status === 'pending') await appearanceRequest(`/ui/previews/${preview.previewId}/discard`, 'POST', {});
        setPreview(null);
      })}>Edit profile</button></ButtonGroup>
    </>}
    {saved?.undoToken && <ButtonGroup><button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={() => void run(async () => {
      await appearanceRequest('/ui/requirements', 'PUT', { undoReset: saved.undoToken }, saved.revision);
      hydrate(await appearanceRequest<Snapshot>('/ui/requirements')); setPreview(null); setMessage('Reset undone');
    })}>Undo reset</button></ButtonGroup>}
  </div>;
}
