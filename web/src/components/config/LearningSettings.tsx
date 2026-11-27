import { InfoTip } from './SettingsControls';
import { Card, Row, ButtonGroup } from '../layout';
import { modelDisplayName } from '../../lib/modelDisplay';
import { ProviderLabel } from '../ProviderMark';
import { Blocks, Clock3, Gauge, ShieldCheck } from 'lucide-react';
import { SettingIcon, SettingRow } from './SettingRow';
import { useEffect, useRef, useState } from 'react';
import { learningApi, type LearningSettings as Settings, type LearningSettingsView, type LearningReview, type SkillMaintenanceOutcome } from '../../lib/learningApi';
import { useNativeRefresh } from '../../lib/useNativeRefresh';
import { useBotSettingsDraft, useConfigUI } from '../../configStore';
import { useStore } from '../../store';
import './native-learning.css';

const flags: { key: keyof Settings; label: string; hint: string }[] = [
  { key: 'enabled', label: 'Learning enabled', hint: 'On: allow new learning reviews and skill maintenance using the options below. Off: stop new reviews and skill maintenance. Saved memories and skills remain available.' },
  { key: 'automaticReview', label: 'Automatic reviews', hint: 'On: review eligible finished turns in the background while Learning is on. Off: start reviews yourself with Refine now.' },
  { key: 'memoryReview', label: 'Review memories', hint: 'On: include durable preferences and environment facts in reviews. Off: skip memory review.' },
  { key: 'skillReview', label: 'Review skills', hint: 'On: review reusable procedures and their resources. Off: skip skill review.' },
  { key: 'skillApproval', label: 'Approve skill changes', hint: 'On: skill changes made by your Bot wait for your review. Off: on a connected Claude or OpenAI plan, skill changes you request in chat take effect immediately. Background changes still need review unless they pass the automatic improvement checks you enabled.' },
];
export function LearningSettingsPanel({ botId }: { botId?: string }) {
  const userId = useStore(state => state.user?.id);
  return <LearningSettingsForm key={JSON.stringify([userId, botId])} botId={botId} />;
}

function LearningSettingsForm({ botId }: { botId?: string }) {
  const [view, setView] = useState<LearningSettingsView | null>(null), [draft, setDraft] = useState<Settings | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [attempt, setAttempt] = useState(0);
  const [showReviews, setShowReviews] = useState(false);
  useBotSettingsDraft(`learning:${botId ?? 'account'}`, 'Learning', !!botId && !!view && !!draft && JSON.stringify(draft) !== JSON.stringify(view.settings));
  useEffect(() => {
    let active = true; setView(null); setDraft(null); setNotice(''); setError('');
    learningApi.settings(botId).then(r => { if (active) { setView(r); setDraft(r.settings); } }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [botId, attempt]);
  const save = async (inherit = false) => {
    if (!view || !draft || busy) return;
    setBusy(true); setError(''); setNotice('');
    const changed = Object.fromEntries(Object.entries(draft).filter(([key, value]) => value !== view.settings[key as keyof Settings])) as Partial<Settings>;
    // Bot writes are the complete override map; preserve existing unrelated overrides.
    const patch = inherit ? {} : botId ? { ...view.overrides, ...changed } : changed;
    try { const next = await learningApi.saveSettings(view.revision, patch, botId); setView(next); setDraft(next.settings); setNotice(inherit ? 'Using account defaults.' : 'Learning settings saved.'); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setDraft(s => s ? { ...s, [key]: value } : s);
  const numberField = (key: keyof Settings, label: string, min: number, max?: number) => <label key={key}><SettingIcon icon={Clock3} /><span>{label}</span><input type="number" min={min} max={max} required value={draft?.[key] as number ?? ''} onChange={e => set(key, e.currentTarget.valueAsNumber)} /></label>;
  const overridden = Object.keys(view?.overrides ?? {});
  return <div className="cfg-page learning-settings native-panel">
    {botId && <h2>Learning</h2>}
    {!showReviews && <>
    {error && <div className="cfg-error" role="alert">{error} <button className="cfg-btn cfg-btn--secondary" type="button" onClick={() => setAttempt(n => n + 1)}>Reload settings</button></div>}
    {!draft && !error && <p role="status">Loading learning settings</p>}
    {draft && view && <form className="learning-fields" onSubmit={e => { e.preventDefault(); void save(); }}>
      {botId && <div className="learning-inheritance"><strong>{overridden.length ? 'This bot has overrides' : 'Using account defaults'}</strong><p>{overridden.length ? 'Values without an override inherit the account defaults.' : 'All values are inherited from account settings.'}</p></div>}
      <Card variant="list" className="learning-flags">{flags.map(field => <SettingRow key={field.key}
        icon={field.key === 'skillApproval' ? ShieldCheck : Blocks} title={<span className="settings-label-info"><label htmlFor={`learning-${field.key}`}>{field.label}</label><InfoTip label={`About ${field.label.toLowerCase()}`}>{botId ? overridden.includes(field.key) ? 'Bot override. ' : 'Inherited from the account. ' : ''}{field.hint}</InfoTip></span>}>
        <input id={`learning-${field.key}`} type="checkbox" checked={draft[field.key] as boolean} onChange={event => set(field.key, event.currentTarget.checked)} />
      </SettingRow>)}</Card>
      <details className="learning-disclosure"><summary>Review limits</summary>
        <div className="learning-grid">
          {numberField('memoryTurnInterval', 'Memory review interval (turns)', 1)}
          {numberField('skillIterationInterval', 'Skill review interval (tool iterations)', 1)}
          {numberField('maxIterations', 'Review step limit', 1, 128)}
          <label><SettingIcon icon={Gauge} /><span>Aggregate input token limit</span><input type="number" value={draft.maxInputTokens ?? ''} placeholder="32,000 tokens by default" onChange={e => set('maxInputTokens', e.currentTarget.value === '' ? null : e.currentTarget.valueAsNumber)} /><small>Blank uses a bounded limit of at most 32,000 tokens. Zero explicitly disables the input limit.</small></label>
          <label><SettingIcon icon={Blocks} /><span>Auxiliary model</span><input value={draft.auxiliaryModel ?? ''} onChange={e => set('auxiliaryModel', e.currentTarget.value || null)} /></label>
          <label><SettingIcon icon={Blocks} /><span>Auxiliary provider</span><input value={draft.auxiliaryProvider ?? ''} onChange={e => set('auxiliaryProvider', e.currentTarget.value || null)} /></label>
        </div>
        <p className="native-meta">Blank uses the originating model and provider. An auxiliary route requires a currently connected adapter.</p>
        <p className="native-meta">Explicit source-backed corrections can update a preference in the same scope. Inferred replacements and removals wait for review. New knowledge stays private until you share it.</p>
      </details>
      <details className="learning-disclosure"><summary>Skill maintenance</summary><div className="learning-fields">
        <SettingRow icon={Blocks} title={<label htmlFor="learning-curator-enabled">Enable periodic maintenance</label>}><input id="learning-curator-enabled" type="checkbox" checked={draft.curatorEnabled} onChange={e => set('curatorEnabled', e.currentTarget.checked)} /></SettingRow>
        <div className="learning-grid">{numberField('curatorIntervalHours', 'Maintenance interval (hours)', 1)}{numberField('curatorMinIdleHours', 'Minimum idle time (hours)', 0)}{numberField('curatorStaleDays', 'Mark stale after (days)', 1)}{numberField('curatorArchiveDays', 'Archive after (days)', 1)}</div>
        <SettingRow icon={Blocks} title={<label htmlFor="learning-curator-consolidate">Propose consolidation for review (off by default)</label>}><input id="learning-curator-consolidate" type="checkbox" checked={draft.curatorConsolidate} onChange={e => set('curatorConsolidate', e.currentTarget.checked)} /></SettingRow>
        <p className="native-meta">Pinned, locked and routine-referenced packages are protected. Archived packages retain recoverable history.</p>
        {botId && <SkillMaintenance botId={botId} settings={view.settings} />}
      </div></details>
      <Row className="learning-disclosure learning-disclosure--row" leading={<SettingIcon icon={Clock3} />} title="History" trailing={<><button className="cfg-btn cfg-btn--secondary" type="button" onClick={() => setShowReviews(true)}>View</button></>} />
      <ButtonGroup stack ><button className="cfg-btn cfg-btn--primary" disabled={busy || JSON.stringify(draft) === JSON.stringify(view.settings)} type="submit">{busy ? 'Saving' : botId ? 'Save Bot overrides' : 'Save'}</button>{botId && <button className="cfg-btn cfg-btn--secondary" disabled={busy || !Object.keys(view.overrides ?? {}).length} type="button" onClick={() => void save(true)}>Use account defaults</button>}</ButtonGroup>
      {notice && <p role="status">{notice}</p>}
    </form>}
    {!draft && error && <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setShowReviews(true)}>View</button>}
    </>}
    {showReviews && <>
      <button type="button" className="cfg-btn cfg-btn--secondary learning-back" onClick={() => setShowReviews(false)}>Close history</button>
      <LearningReviews botId={botId} />
    </>}
  </div>;
}

function SkillMaintenance({ botId, settings }: { botId: string; settings?: Settings }) {
  const userId = useStore(state => state.user?.id);
  const request = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [outcome, setOutcome] = useState<{ result: SkillMaintenanceOutcome; paused: boolean } | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  const run = async () => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    const current = () => !controller.signal.aborted && useStore.getState().user?.id === userId && request.current === controller;
    setBusy(true); setError(''); setOutcome(null);
    try {
      const result = await learningApi.curate(botId, controller.signal);
      if (current()) setOutcome({ result, paused: !!settings && (!settings.enabled || !settings.curatorEnabled) });
    } catch (failure) { if (current()) setError((failure as Error).message); }
    finally { if (current()) { request.current = null; setBusy(false); } }
  };
  const openSkills = () => useConfigUI.getState().requestLeaveBotSettings(() => useConfigUI.getState().openBotSettings(botId, 'skills'));
  return <section className="knowledge-maintenance" aria-label="Protected skill maintenance">
    <h3>Protected skill maintenance</h3>
    <p className="native-meta">Check eligible skills for staleness or archiving. Pinned, locked and routine-referenced skills stay protected. This is separate from Refine now.</p>
    <ButtonGroup stack ><button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => void run()} disabled={busy}>{busy ? 'Checking eligibility' : error ? 'Retry maintenance' : 'Run maintenance now'}</button><button type="button" className="cfg-btn cfg-btn--secondary" onClick={openSkills}>Review skills and archive</button></ButtonGroup>
    {error && <p className="cfg-error" role="alert">{error}</p>}
    {outcome && <p role="status">{outcome.result.deferred ? outcome.paused
      ? 'Maintenance deferred. Saved learning or maintenance settings are off.'
      : 'Maintenance deferred. The Bot may be busy or the required idle time or interval may not have elapsed.'
      : `Maintenance completed. Archived: ${outcome.result.archived.length}. Reported stale: ${outcome.result.stale.length}.`}</p>}
  </section>;
}

export function LearningReviews({ botId }: { botId?: string }) {
  const userId = useStore(state => state.user?.id);
  return <LearningReviewsPage key={JSON.stringify([userId, botId])} botId={botId} />;
}

function LearningReviewsPage({ botId }: { botId?: string }) {
  const [data, setData] = useState<{ reviews: LearningReview[]; nextBefore: number | null } | null>(null), [error, setError] = useState('');
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [refineBot, setRefineBot] = useState(botId ?? '');
  const [revision, refresh] = useNativeRefresh();
  const bots = useStore(s => s.bots);
  useEffect(() => {
    let active = true;
    learningApi.reviews(botId).then(r => { if (active) { setData(old => ({ ...r, reviews: [...r.reviews, ...(old?.reviews ?? []).filter(x => !r.reviews.some(n => n.id === x.id))], nextBefore: old && old.reviews.length > 20 ? old.nextBefore : r.nextBefore })); setError(''); } }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [botId, revision]);
  const action = async (run: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await run(); refresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const more = async () => {
    if (data?.nextBefore == null) return;
    const next = await learningApi.reviews(botId, data.nextBefore);
    setData(old => ({ ...next, reviews: [...(old?.reviews ?? []), ...next.reviews.filter(r => !old?.reviews.some(x => x.id === r.id))] }));
  };
  const chosen = botId ?? refineBot;
  return <section className="native-panel" aria-label="Learning review history">
    <header><h3>Review history and activity</h3><button className="cfg-btn cfg-btn--secondary" type="button" onClick={refresh}>Refresh reviews</button></header>
    <button className="cfg-btn cfg-btn--secondary" type="button" onClick={() => useConfigUI.getState().openAppSettings('usage')}>View background learning usage</button>
    <p className="native-meta">Reviews use multiple management steps. A completed review can make no changes; active and pending changes appear in Skills and Memories. Review token usage is background work; pricing appears in Usage.</p>
    <ButtonGroup stack >{!botId && <select aria-label="Bot to refine" value={refineBot} onChange={e => setRefineBot(e.currentTarget.value)}><option value="">Select a Bot</option>{bots.filter(b => b.kind !== 'room').map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select>}<button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy || !chosen} onClick={() => void action(async () => { const r = await learningApi.refine(chosen); setNotice(`Refinement ${r.review.status}. Review ${r.review.id}`); })}>{busy ? 'Updating' : 'Refine now'}</button></ButtonGroup>
    {notice && <p role="status">{notice}</p>}{error && <p className="cfg-error" role="alert">{error}</p>}
    {!data && !error && <p role="status">Loading review history</p>}
    {data?.reviews.length === 0 && <p>No learning reviews recorded yet.</p>}
    {data?.reviews.map(r => <details className="native-history" key={r.id}><summary>{bots.find(b => b.id === r.botId)?.name ?? 'Bot'} · {r.reason} · {r.status} · {new Date(r.createdAt).toLocaleString()}</summary>
      <p>{r.summary || 'No change summary recorded.'}</p>{r.error && <p className="cfg-error">{r.error}</p>}
      <p className="native-meta">Selected route: <ProviderLabel provider={r.model}>{r.model ? modelDisplayName(r.model) : 'Model not recorded'}</ProviderLabel> · <ProviderLabel provider={r.provider}>{r.provider ?? 'Provider not recorded'}</ProviderLabel>. Originating route: <ProviderLabel provider={r.originModel}>{r.originModel ? modelDisplayName(r.originModel) : 'Model not recorded'}</ProviderLabel> · <ProviderLabel provider={r.originProvider}>{r.originProvider ?? 'Provider not recorded'}</ProviderLabel>.</p>
      <p className="native-meta">{r.iterations} steps</p>
      <p className="native-meta">{!r.usageStatus || r.usageStatus === 'unavailable' ? 'Token usage unavailable.' : `Observed usage${r.usageStatus === 'partial' ? ' (partial)' : ''}: ${r.inputTokens.toLocaleString()} input / ${r.outputTokens.toLocaleString()} output tokens.`}{r.budgetInputTokens != null && ` Budget input count: ${r.budgetInputTokens.toLocaleString()} tokens; may include estimates for enforcing limits.`}</p>
      <small>Review {r.id}{r.parentJobId ? ` · Source job ${r.parentJobId}` : ''}{r.jobId ? ` · Review job ${r.jobId}` : ''} · Conversation {r.generation}</small>
      {['queued', 'running'].includes(r.status) && <button className="cfg-btn cfg-btn--secondary" type="button" disabled={busy} onClick={() => void action(() => learningApi.cancel(r.id))}>Cancel review</button>}
    </details>)}
    {data?.nextBefore != null && <button className="cfg-btn cfg-btn--secondary" disabled={busy} type="button" onClick={() => void action(more)}>Load older reviews</button>}
  </section>;
}
