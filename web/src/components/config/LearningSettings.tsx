import { useEffect, useState } from 'react';
import { learningApi, type LearningSettings as Settings, type LearningSettingsView, type LearningReview } from '../../lib/learningApi';
import { useNativeRefresh } from '../../lib/useNativeRefresh';
import { useStore } from '../../store';
import './native-learning.css';

const flags: { key: keyof Settings; label: string; hint: string }[] = [
  { key: 'enabled', label: 'Learning enabled', hint: 'Allow learning for this account or Bot.' },
  { key: 'automaticReview', label: 'Automatic reviews', hint: 'Review eligible finished turns in the background.' },
  { key: 'memoryReview', label: 'Review memories', hint: 'Learn durable preferences and environment facts.' },
  { key: 'skillReview', label: 'Review skills', hint: 'Improve reusable procedures and their resources.' },
  { key: 'skillApproval', label: 'Require approval for skill changes', hint: 'Off by default: validated changes activate directly with history and undo. Existing pending proposals stay pending.' },
];
export function LearningSettingsPanel({ botId }: { botId?: string }) {
  const [view, setView] = useState<LearningSettingsView | null>(null), [draft, setDraft] = useState<Settings | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [attempt, setAttempt] = useState(0);
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
  const numberField = (key: keyof Settings, label: string, min: number, max?: number) => <label key={key}>{label}<input type="number" min={min} max={max} required value={draft?.[key] as number ?? ''} onChange={e => set(key, e.currentTarget.valueAsNumber)} /></label>;
  return <div className="cfg-page learning-settings native-panel">
    <header><div><h2>Learning</h2><p>{botId ? 'Account defaults apply unless this Bot has an override.' : 'Account defaults for Hermes reviews, skill activation and maintenance.'}</p></div></header>
    {error && <div className="cfg-error" role="alert">{error} <button className="cfg-btn cfg-btn--secondary" type="button" onClick={() => setAttempt(n => n + 1)}>Reload settings</button></div>}
    {!draft && !error && <p role="status">Loading learning settings…</p>}
    {draft && view && <form className="learning-fields" onSubmit={e => { e.preventDefault(); void save(); }}>
      {botId && <div className="native-meta">{view.overrides && Object.keys(view.overrides).length ? `Bot overrides: ${Object.keys(view.overrides).join(', ')}` : 'All values inherited from account settings.'} · Settings revision {view.revision}</div>}
      <div className="cfg-card learning-fields">{flags.map(f => <label className="native-check" key={f.key}><input type="checkbox" checked={draft[f.key] as boolean} onChange={e => set(f.key, e.currentTarget.checked)} /><span><strong>{f.label}</strong><small style={{ display: 'block' }}>{f.hint}</small></span></label>)}
        <p className="native-meta">Unattended memory replacements and removals always wait for your review. New knowledge stays private to its Bot until you explicitly share it.</p>
      </div>
      <div className="learning-grid">
        {numberField('memoryTurnInterval', 'Memory review interval (turns)', 1)}
        {numberField('skillIterationInterval', 'Skill review interval (tool iterations)', 1)}
        {numberField('maxIterations', 'Review step limit', 1, 128)}
        <label>Aggregate input token limit<input type="number" value={draft.maxInputTokens ?? ''} placeholder="Derive from model context" onChange={e => set('maxInputTokens', e.currentTarget.value === '' ? null : e.currentTarget.valueAsNumber)} /><small>Blank uses the model’s context budget. Zero disables the budget.</small></label>
      </div>
      <details><summary>Review model route</summary><p className="native-meta">Blank uses the originating model and provider. An auxiliary route requires a currently connected adapter.</p><div className="learning-grid"><label>Auxiliary model<input value={draft.auxiliaryModel ?? ''} onChange={e => set('auxiliaryModel', e.currentTarget.value || null)} /></label><label>Auxiliary provider<input value={draft.auxiliaryProvider ?? ''} onChange={e => set('auxiliaryProvider', e.currentTarget.value || null)} /></label></div></details>
      <details><summary>Skill maintenance</summary><div className="learning-fields">
        <label className="native-check"><input type="checkbox" checked={draft.curatorEnabled} onChange={e => set('curatorEnabled', e.currentTarget.checked)} />Enable periodic maintenance</label>
        <div className="learning-grid">{numberField('curatorIntervalHours', 'Maintenance interval (hours)', 1)}{numberField('curatorMinIdleHours', 'Minimum idle time (hours)', 0)}{numberField('curatorStaleDays', 'Mark stale after (days)', 1)}{numberField('curatorArchiveDays', 'Archive after (days)', 1)}</div>
        <label className="native-check"><input type="checkbox" checked={draft.curatorConsolidate} onChange={e => set('curatorConsolidate', e.currentTarget.checked)} />Allow model-driven consolidation (off by default)</label>
        <p className="native-meta">Pinned, locked and routine-referenced packages are protected. Archived packages retain recoverable history.</p>
      </div></details>
      <div className="learning-actions"><button className="cfg-btn cfg-btn--primary" disabled={busy || JSON.stringify(draft) === JSON.stringify(view.settings)} type="submit">{busy ? 'Saving…' : botId ? 'Save Bot overrides' : 'Save learning settings'}</button>{botId && <button className="cfg-btn cfg-btn--secondary" disabled={busy || !Object.keys(view.overrides ?? {}).length} type="button" onClick={() => void save(true)}>Use account defaults</button>}</div>
      {notice && <p role="status">{notice}</p>}
    </form>}
    <LearningReviews botId={botId} />
  </div>;
}

export function LearningReviews({ botId }: { botId?: string }) {
  const [data, setData] = useState<{ reviews: LearningReview[]; nextBefore: number | null } | null>(null), [error, setError] = useState('');
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [refineBot, setRefineBot] = useState(botId ?? '');
  const [revision, refresh] = useNativeRefresh();
  const bots = useStore(s => s.bots);
  useEffect(() => {
    let active = true; setData(null); setError(''); setNotice('');
    learningApi.reviews(botId).then(r => { if (active) setData(r); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [botId]);
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
    <p className="native-meta">Reviews use multiple management steps. A completed review can make no changes; active and pending changes appear in Skills and Memories. Review token usage is background work; pricing appears in Usage.</p>
    <div className="learning-actions">{!botId && <select aria-label="Bot to refine" value={refineBot} onChange={e => setRefineBot(e.currentTarget.value)}><option value="">Select a Bot</option>{bots.filter(b => b.kind !== 'room').map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select>}<button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy || !chosen} onClick={() => void action(async () => { const r = await learningApi.refine(chosen); setNotice(`Refinement ${r.review.status}. Review ${r.review.id}`); })}>{busy ? 'Updating…' : 'Refine now'}</button></div>
    {notice && <p role="status">{notice}</p>}{error && <p className="cfg-error" role="alert">{error}</p>}
    {!data && !error && <p role="status">Loading review history…</p>}
    {data?.reviews.length === 0 && <p>No learning reviews recorded yet.</p>}
    {data?.reviews.map(r => <details className="native-history" key={r.id}><summary>{bots.find(b => b.id === r.botId)?.name ?? 'Bot'} · {r.reason} · {r.status} · {new Date(r.createdAt).toLocaleString()}</summary>
      <p>{r.summary || 'No change summary recorded.'}</p>{r.error && <p className="cfg-error">{r.error}</p>}
      <p className="native-meta">{r.model ?? 'Originating model'} · {r.provider ?? 'Originating provider'} · {r.iterations} steps · {r.inputTokens.toLocaleString()} input / {r.outputTokens.toLocaleString()} output tokens · Settings revision {r.settingsRevision}</p>
      <small>Review {r.id}{r.parentJobId ? ` · Source job ${r.parentJobId}` : ''}{r.jobId ? ` · Review job ${r.jobId}` : ''} · Conversation {r.generation}</small>
      {['queued', 'running'].includes(r.status) && <button className="cfg-btn cfg-btn--secondary" type="button" disabled={busy} onClick={() => void action(() => learningApi.cancel(r.id))}>Cancel review</button>}
    </details>)}
    {data?.nextBefore != null && <button className="cfg-btn cfg-btn--secondary" disabled={busy} type="button" onClick={() => void action(more)}>Load older reviews</button>}
  </section>;
}
