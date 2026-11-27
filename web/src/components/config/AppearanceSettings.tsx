import { useEffect, useRef, useState } from 'react';
import { REGISTRY, type PatchOp, type UiPreviewCardBody, type Violation } from '@shared/ui-config/index';
import { useEffectiveConfig, useUiConfig, useUiPatch } from '../../customization';
import { openConversation } from '../../configStore';
import { useStore } from '../../store';
import { prefillComposer } from '../Composer';
import { ButtonGroup, Card, Row, Section } from '../layout';
import { Switch } from './ui';
import { UiPreviewCard } from '../cards/UiPreviewCard';
import { AppearanceSection, Choice, SelectRow } from './appearance/Controls';
import { LayoutControls } from './appearance/LayoutControls';
import { Shortcuts } from './appearance/Shortcuts';
import { Dashboards } from './appearance/Dashboards';
import { Manage } from './appearance/Manage';
import { choosePreset, setAccent, setValue } from './appearance/patches';
import { appearanceRequest, AppearanceError, readPreview, readSaved } from './appearance/api';
import { refreshAppearance, showAppearancePreview } from './appearance/runtime';
import '../../styles/appearance.css';

const SWATCHES = ['#3043AB', '#0F766E', '#1D4ED8', '#7E22CE', '#BE185D', '#B45309', '#15803D', '#475569'];
export function AppearanceSettings() {
  const doc = useEffectiveConfig();
  const { saved, revision, status } = useUiConfig();
  const write = useUiPatch();
  const bots = useStore(s => s.bots);
  const [errors, setErrors] = useState<Violation[]>([]);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [agentAuto, setAgentAuto] = useState(false);
  const [agentReady, setAgentReady] = useState(false);
  const [previewCard, setPreviewCard] = useState<UiPreviewCardBody | null>(null);
  const mode = doc.theme.mode === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : doc.theme.mode;
  const [hex, setHex] = useState('');
  useEffect(() => { setHex(doc.theme.colors[mode].primary ?? (mode === 'dark' ? '#B5C1FF' : '#3043AB')); }, [doc.theme.colors, mode]);
  useEffect(() => {
    let alive = true;
    void appearanceRequest<{ uiAgentApply: string }>('/account/preferences').then(value => { if (alive) { setAgentAuto(value.uiAgentApply === 'auto'); setAgentReady(true); } }).catch(error => { if (alive) setErrors([{ path: '', code: 'invalid_value', message: error.message }]); });
    return () => { alive = false; };
  }, []);
  const run = async (fn: () => Promise<unknown>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setErrors([]);
    try { await fn(); } catch (error) { setErrors(error instanceof AppearanceError ? error.errors : [{ path: '', code: 'invalid_value', message: (error as Error).message }]); }
    finally { pending.current = false; setBusy(false); }
  };
  const patch = async (ops: PatchOp[]) => {
    if (!ops.length) return true;
    let ok = false;
    await run(async () => { const result = await write(ops); if (!result.ok) setErrors(result.errors); else ok = true; });
    return ok;
  };
  const onPreview = async (id: string) => {
    await showAppearancePreview(id);
    const preview = await readPreview(id);
    setPreviewCard({ card: 'ui_preview', previewId: id, title: preview.intent, lines: preview.summary.slice(0, 6), moreCount: Math.max(0, preview.summary.length - 6), warnings: preview.warnings.map(w => w.message), status: preview.status });
  };
  const ask = () => { const bot = bots.find(b => b.isPrimary) ?? bots[0]; if (bot) { prefillComposer(bot.id, 'Change how my app looks: '); openConversation(bot.id); } };
  const colorErrors = errors.filter(error => error.code === 'accessibility' || error.path.includes('/colors'));
  if (status === 'disabled') return <p role="status">Appearance is unavailable.</p>;
  return <div className="appearance-settings">
    <Section aria-label="Customize"><Row title="Or change it here." trailing={<button type="button" className="cfg-btn cfg-btn--primary" disabled={!bots.length} onClick={ask}>Ask your agent</button>} /></Section>
    {previewCard && <UiPreviewCard key={previewCard.previewId} body={previewCard} />}
    {errors.length > 0 && <Card role="alert" className="appearance-errors">{errors.map((error, i) => <p key={i}>{error.message}{error.hint ? ` ${error.hint}` : ''}{error.suggested ? ` Try ${error.suggested}.` : ''}</p>)}</Card>}
    <fieldset disabled={status === 'loading'} className="appearance-fields" aria-label="Appearance controls" aria-busy={busy}>
      <Section title="Look" aria-label="Look" className="appearance-section">
        <div className="appearance-presets">{REGISTRY.presets.map(preset => <Card key={preset.id}><button type="button" className="appearance-preset cfg-btn cfg-btn--secondary" aria-pressed={doc.preset === preset.id} onClick={() => void run(async () => { const result = await appearanceRequest<{ previewId: string }>('/ui/patches/preview', 'POST', { patch: choosePreset(preset.id), intent: `${preset.label} appearance` }, revision); await onPreview(result.previewId); })}>{preset.label}</button></Card>)}</div>
        <Choice label="Mode" value={doc.theme.mode} values={['light', 'dark', 'system']} onChange={v => void patch(setValue('/theme/mode', v))} />
      </Section>
      <AppearanceSection title="Color">
        <Row title="Accent" trailing={<span className="cfg-chip" role="status">{colorErrors.length ? 'Low contrast' : 'OK'}</span>} />
        <div className="appearance-swatches">{SWATCHES.map(color => <button key={color} type="button" className="cfg-btn cfg-btn--secondary" aria-label={`Accent ${color}`} aria-pressed={doc.theme.colors[mode].primary === color} onClick={() => void patch(setAccent(mode, color))}><span style={{ backgroundColor: color }} aria-hidden /></button>)}</div>
        <form onSubmit={e => { e.preventDefault(); void patch(setAccent(mode, hex)); }}><Row className="appearance-control" title={<label htmlFor="appearance-hex">Custom</label>} trailing={<ButtonGroup><input id="appearance-hex" className="text-input" value={hex} spellCheck={false} maxLength={7} onChange={e => setHex(e.target.value)} aria-invalid={colorErrors.length > 0} /><button type="submit" className="cfg-btn cfg-btn--secondary">Save</button></ButtonGroup>} /></form>
      </AppearanceSection>
      <AppearanceSection title="Text">
        <SelectRow label="Font" value={doc.theme.font.ui} options={REGISTRY.fonts.map(font => ({ value: font.id, label: font.label }))} onChange={v => void patch(setValue('/theme/font/ui', v))} />
        <Choice label="Size" value={doc.theme.font.scale} values={['default', 'large', { value: 'xlarge', label: 'Extra large' }]} onChange={v => void patch(setValue('/theme/font/scale', v))} />
      </AppearanceSection>
      <AppearanceSection title="Spacing">
        <Choice label="Density" value={doc.theme.density} values={['compact', 'default', 'comfortable']} onChange={v => void patch(setValue('/theme/density', v))} />
        <Choice label="Corners" value={doc.theme.radius} values={['sharp', 'default', 'round']} onChange={v => void patch(setValue('/theme/radius', v))} />
      </AppearanceSection>
      <LayoutControls doc={doc} patch={patch} />
      <Shortcuts doc={doc} patch={patch} />
      <Dashboards doc={saved} patch={patch} readSaved={async () => (await readSaved()).doc} />
      <AppearanceSection title="Agent"><Row title="Apply my agent's changes right away" trailing={<Switch label="Apply my agent's changes right away" on={agentAuto} disabled={!agentReady} onChange={value => void run(async () => { await appearanceRequest('/account/preferences', 'PATCH', { uiAgentApply: value ? 'auto' : 'ask' }); setAgentAuto(value); })} />} /></AppearanceSection>
      <Manage doc={saved} revision={revision} run={run} onPreview={onPreview} onChange={refreshAppearance} />
    </fieldset>
  </div>;
}
