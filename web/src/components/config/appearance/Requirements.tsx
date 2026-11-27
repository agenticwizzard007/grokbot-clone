import { useEffect, useRef, useState } from 'react';
import type { UiPreviewCardBody } from '@shared/ui-config/index';
import { EMPTY_REQUIREMENTS, type RequirementsFields, type RequirementsProfile } from '@shared/ui-config/adapt';
import { FOCUS_IDS, LENS_IDS } from '@shared/ui-config/adapt-keywords';
import { ADAPT_LENSES } from '@shared/ui-config/adapt-lenses';
import { ButtonGroup, Card, Row, Section } from '../../layout';
import { SettingsMenu } from '../SettingsControls';
import { UiPreviewCard } from '../../cards/UiPreviewCard';
import { useUiConfig } from '../../../customization';
import { appearanceRequest } from './api';
import { refreshAppearance, showAppearancePreview } from './runtime';
import '../../../styles/appearance.css';

type Snapshot = { profile: RequirementsProfile | null; revision: number; lens: typeof LENS_IDS[number] | null;
  rationale: string[]; question?: string; undoToken?: string; suggestions: { bots: { name: string; purpose: string }[]; templates: { name: string }[] } | null };
type Proposal = { previewId: string; summary: string[]; warnings: { message: string }[]; undoToken?: string; kept?: { message: string }[] };
const labels = { tasks: 'Tasks', bots: 'Bots', routines: 'Routines', usage: 'Usage', files: 'Files', chat: 'Chat', apps: 'Apps', team: 'Team' };

export function Requirements() {
  const { revision: uiRevision } = useUiConfig();
  const [saved, setSaved] = useState<Snapshot | null>(null);
  const [fields, setFields] = useState<RequirementsFields>(structuredClone(EMPTY_REQUIREMENTS));
  const [goals, setGoals] = useState('');
  const [preview, setPreview] = useState<UiPreviewCardBody | null>(null);
  const [kept, setKept] = useState<string[]>([]);
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
  // Applying a preview may claim or relinquish managed paths and advance the profile revision.
  useEffect(() => {
    let alive = true;
    void appearanceRequest<Snapshot>('/ui/requirements').then(value => { if (alive) setSaved(value); }).catch(() => {});
    return () => { alive = false; };
  }, [uiRevision]);
  const run = async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(''); setMessage('');
    try { await action(); } catch (e) { setError((e as Error).message); }
    finally { lock.current = false; setBusy(false); }
  };
  const propose = async (reset: boolean) => {
    if (!saved) return;
    const current = await appearanceRequest<Snapshot>('/ui/requirements');
    const result = await appearanceRequest<Proposal>(reset ? '/ui/requirements' : '/ui/requirements/adapt', reset ? 'DELETE' : 'POST', {}, current.revision);
    await showAppearancePreview(result.previewId);
    setKept(result.kept?.map(item => item.message) ?? []);
    setPreview({ card: 'ui_preview', previewId: result.previewId, title: reset ? 'Reset requirements and arrangement' : 'Your proposed workspace',
      lines: result.summary.slice(0, 6), moreCount: Math.max(0, result.summary.length - 6), warnings: result.warnings.map(w => w.message), status: 'pending' });
    const latest = await appearanceRequest<Snapshot>('/ui/requirements');
    if (reset) hydrate(latest); else setSaved(latest);
  };
  if (!saved) return <Section role="region" aria-label="About your use"><p role={error ? 'alert' : 'status'}>{error || 'Loading your requirements...'}</p></Section>;
  return <div role="region" aria-label="About your use" className="requirements-settings">
    <p>Share your role, goals and routine work.</p>
    {error && <p role="alert">{error}</p>}
    {message && <p role="status"><span className="cfg-chip">{message}</span></p>}
    <fieldset disabled={busy || !saved} className="appearance-fields" aria-label="Your requirements" aria-busy={busy}>
      <Section title="Profile" action={<SettingsMenu ariaLabel="Manage requirements" disabled={!saved.profile} items={[
          { label: 'Reset', danger: true, onSelect: () => void run(() => propose(true)) },
        ]} />}><Card className="requirements-form-card">
        <label className="requirements-field">Role<input className="text-input" maxLength={60} value={fields.role} onChange={e => setFields({ ...fields, role: e.target.value })} /></label>
        <label className="requirements-field">Goals<textarea aria-label="Goals" className="text-input" rows={3} value={goals} placeholder="One goal per line, up to six" onChange={e => setGoals(e.target.value)} /></label>
        <label className="requirements-field">Lens<select aria-label="Lens" className="text-input" value={fields.lens ?? ''} onChange={e => { const next = { ...fields }; if (e.target.value) next.lens = e.target.value as RequirementsFields['lens']; else delete next.lens; setFields(next); }}>
          <option value="">Automatic</option>{LENS_IDS.map(id => <option key={id} value={id}>{ADAPT_LENSES[id].label}</option>)}
        </select></label>
      </Card></Section>
      <Section title="Workflows">
        {fields.workflows.map((workflow, i) => <Card key={i} className="requirements-form-card">
          <label className="requirements-field">Workflow {i + 1}<input className="text-input" maxLength={80} value={workflow.name} onChange={e => setFields({ ...fields, workflows: fields.workflows.map((w, n) => n === i ? { ...w, name: e.target.value } : w) })} /></label>
          <label className="requirements-field">Cadence<select aria-label={`Cadence ${i + 1}`} className="text-input" value={workflow.cadence} onChange={e => setFields({ ...fields, workflows: fields.workflows.map((w, n) => n === i ? { ...w, cadence: e.target.value as typeof w.cadence } : w) })}>
            <option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="ad_hoc">As needed</option>
          </select></label>
          <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setFields({ ...fields, workflows: fields.workflows.filter((_, n) => n !== i) })}>Remove workflow {i + 1}</button>
        </Card>)}
        <button type="button" className="cfg-btn cfg-btn--secondary" disabled={fields.workflows.length >= 8} onClick={() => setFields({ ...fields, workflows: [...fields.workflows, { name: '', cadence: 'weekly' }] })}>Add workflow</button>
      </Section>
      <Section title="Focus"><Card><div className="requirements-focus-grid">
        {FOCUS_IDS.map(id => <button type="button" key={id} className="cfg-btn cfg-btn--secondary requirements-focus" aria-pressed={fields.focus.includes(id)} onClick={() => setFields({ ...fields, focus: fields.focus.includes(id) ? fields.focus.filter(f => f !== id) : [...fields.focus, id] })}>{labels[id]}</button>)}
      </div></Card></Section>
      <ButtonGroup stack>
        <button type="button" className="cfg-btn cfg-btn--primary" onClick={() => void run(async () => {
          const values = { role: fields.role, goals: goals.split('\n').map(goal => goal.trim()).filter(Boolean), workflows: fields.workflows, focus: fields.focus };
          const patch: unknown[] = Object.entries(values).map(([key, value]) => ({ op: 'add', path: `/${key}`, value }));
          if (fields.lens) patch.push({ op: 'add', path: '/lens', value: fields.lens });
          else if (saved?.profile?.lens) patch.push({ op: 'remove', path: '/lens' });
          await appearanceRequest('/ui/requirements', 'PUT', { patch }, saved!.revision);
          hydrate(await appearanceRequest<Snapshot>('/ui/requirements')); setMessage('Saved');
        })}>Save changes</button>
        <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!saved?.profile} onClick={() => void run(() => propose(false))}>Re-adapt</button>
      </ButtonGroup>
    </fieldset>
    {preview && <UiPreviewCard key={preview.previewId} body={preview} />}
    {kept.length > 0 && <Card>{kept.map(line => <p key={line}>{line}</p>)}</Card>}
    {saved?.undoToken && <ButtonGroup><button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={() => void run(async () => {
      await appearanceRequest('/ui/requirements', 'PUT', { undoReset: saved.undoToken }, saved.revision);
      hydrate(await appearanceRequest<Snapshot>('/ui/requirements')); await refreshAppearance(); setPreview(null); setMessage('Reset undone');
    })}>Undo reset</button></ButtonGroup>}
    {saved?.lens && <Section title="Workspace"><Card>
      <Row title={ADAPT_LENSES[saved.lens].label} subtitle={saved.rationale[0]} />
      {saved.rationale.length > 1 && <details className="requirements-details"><summary>Why this view</summary><ul>{saved.rationale.slice(1).map(line => <li key={line}>{line}</li>)}</ul></details>}
      {saved.question && <p>{saved.question}</p>}
    </Card></Section>}
    {saved?.suggestions && <>
      <Section title="Suggested Bots"><Card className="requirements-list">{saved.suggestions.bots.map(bot => <Row key={bot.name} title={bot.name} subtitle={bot.purpose} />)}<ButtonGroup><a className="cfg-btn cfg-btn--secondary" href="#new-bot">Create a Bot</a></ButtonGroup></Card></Section>
      <Section title="Suggested dashboards"><Card className="requirements-list">{saved.suggestions.templates.map(template => <Row key={template.name} title={template.name} />)}<ButtonGroup><a className="cfg-btn cfg-btn--secondary" href="#settings/appearance">Choose a template</a></ButtonGroup></Card></Section>
    </>}
  </div>;
}
