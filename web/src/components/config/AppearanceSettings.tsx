import { useEffect, useRef, useState } from 'react';
import { type PatchOp, type UiPreviewCardBody, type Violation } from '@shared/ui-config/index';
import { useEffectiveConfig, useUiConfig, useUiPatch } from '../../customization';
import { openConversation } from '../../configStore';
import { useStore } from '../../store';
import { prefillComposer } from '../Composer';
import { ButtonGroup, Card, Row, Section } from '../layout';
import { Switch } from './ui';
import { UiPreviewCard } from '../cards/UiPreviewCard';
import { AppearanceSection } from './appearance/Controls';
import { LayoutControls } from './appearance/LayoutControls';
import { Shortcuts } from './appearance/Shortcuts';
import { Dashboards } from './appearance/Dashboards';
import { Manage } from './appearance/Manage';
import { appearanceRequest, AppearanceError, readPreview, readSaved } from './appearance/api';
import { refreshAppearance, showAppearancePreview } from './appearance/runtime';
import { Requirements } from './appearance/Requirements';
import '../../styles/appearance.css';

export function AppearanceSettings() {
  const doc = useEffectiveConfig();
  const { saved, revision, status } = useUiConfig();
  const write = useUiPatch();
  const bots = useStore(s => s.bots);
  const [errors, setErrors] = useState<Violation[]>([]);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [agentAuto, setAgentAuto] = useState(false);
  const [profileAvailable, setProfileAvailable] = useState(false);
  const [agentReady, setAgentReady] = useState(false);
  const [previewCard, setPreviewCard] = useState<UiPreviewCardBody | null>(null);
  useEffect(() => {
    let alive = true;
    void appearanceRequest('/ui/requirements').then(() => { if (alive) setProfileAvailable(true); }).catch(() => {});
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
    setPreviewCard({ card: 'ui_preview', previewId: id, title: 'Import layout', lines: preview.summary.slice(0, 6), moreCount: Math.max(0, preview.summary.length - 6), warnings: preview.warnings.map(w => w.message), status: preview.status });
  };
  const ask = () => { const bot = bots.find(b => b.isPrimary) ?? bots[0]; if (bot) { prefillComposer(bot.id, 'Help me create or edit a dashboard: '); openConversation(bot.id); } };
  if (status === 'disabled') return <p role="status">Layout settings are unavailable.</p>;
  return <div className="appearance-settings">
    <Section aria-label="Customize"><ButtonGroup><button type="button" className="cfg-btn cfg-btn--primary" disabled={!bots.length} onClick={ask}>Ask your agent</button></ButtonGroup></Section>
    {profileAvailable && <Requirements embedded />}
    {previewCard && <UiPreviewCard key={previewCard.previewId} body={previewCard} />}
    {errors.length > 0 && <Card role="alert" className="appearance-errors">{errors.map((error, i) => <p key={i}>{error.message}{error.hint ? ` ${error.hint}` : ''}{error.suggested ? ` Try ${error.suggested}.` : ''}</p>)}</Card>}
    <fieldset disabled={status === 'loading'} className="appearance-fields" aria-label="Layout controls" aria-busy={busy}>
      <Dashboards error={errors.map(e => e.message).join(' ')} doc={saved} patch={patch} readSaved={async () => (await readSaved()).doc} />
      <LayoutControls doc={doc} patch={patch} />
      <Shortcuts doc={doc} patch={patch} />
      <AppearanceSection title="Agent"><Row title="Apply my agent's changes right away" trailing={<Switch label="Apply my agent's changes right away" on={agentAuto} disabled={!agentReady} onChange={value => void run(async () => { await appearanceRequest('/account/preferences', 'PATCH', { uiAgentApply: value ? 'auto' : 'ask' }); setAgentAuto(value); })} />} /></AppearanceSection>
      <Manage doc={saved} revision={revision} run={run} onPreview={onPreview} onChange={refreshAppearance} />
    </fieldset>
  </div>;
}
