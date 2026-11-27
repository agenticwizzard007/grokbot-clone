import { ProviderMark } from '../ProviderMark';
import { providerBrand } from '../../lib/providerBrand';
import { useModels, effortsFor, effectiveEffort, effortLabel, defaultEffortFor, modelSelection } from '../../lib/models';
import { BotModelField } from './BotModelField';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { AvatarColor, AvatarShape, Bot, Routine } from '@shared/types';
import { BotAvatar } from '../../avatar/BotAvatar';
import { BirdPicker } from '../../avatar/BirdPicker';
import { COLOR_ORDER, botVars, palette } from '../../lib/colors';
import { KnowledgeScopeControl, PendingMemoryChanges, SkillPackageControls } from './KnowledgeManagement';
import { learningApi } from '../../lib/learningApi';
import { ApiError } from '../../lib/api';
import { LearningSettingsPanel } from './LearningSettings';
import { configApi, type BotPatch, type BotSettingsBundle, type KnowledgeSkill, type KnowledgeMemory } from '../../lib/configApi';
import { SkillHistory, SkillReview, MemoryEvidence, ConversationSearch, MemoryArchive } from './KnowledgePanels';
import { RoutineHistory } from './RoutineHistory';
import { openConversation, useBotSettingsDraft, useConfigUI, useVersion, type BotSettingsTab } from '../../configStore';
import { useStore } from '../../store';
import { Icon } from '../Icon';
import { Page, Section, Card, Row, ButtonGroup } from '../layout';
import { Modal } from '../modals/Modal';
import { BotAnalyticsTab } from './BotAnalyticsTab';
import { ConfirmButton, Field, Segmented, Switch, nextRunLabel, shortDate } from './ui';
import { confirmDialog } from '../../lib/confirmDialog';
import { toast } from '../../lib/toast';
import { prefillComposer } from '../Composer';
import '../../styles/setup-paper.css';
import { startFreshConversation } from '../../lib/useFreshConversation';
import { conversationUsagePercent } from '../../lib/conversationUsage';
import '../../styles/bot-details.css';

export function BotSettingsModal({ inline = false }: { inline?: boolean } = {}) {
  const target = useConfigUI((s) => s.botSettings);
  const discard = useConfigUI((s) => s.discardBotSettings);
  const bot = useStore((s) => s.bots.find((b) => b.id === target?.botId));
  const userId = useStore(state => state.user?.id);
  useEffect(() => { if (target && !bot && useStore.getState().bots.length) discard(); }, [bot, target, discard]);
  return target && bot ? <BotSettingsPage key={JSON.stringify([userId, bot.id])} bot={bot} tab={target.tab} inline={inline} userId={userId} /> : null;
}

const draftTabs = (labels: string[]) => {
  const unique = [...new Set(labels)];
  return unique.length > 1 ? `${unique.slice(0, -1).join(', ')} and ${unique[unique.length - 1]}` : unique[0] ?? 'this page';
};

function BotSettingsPage({ bot, tab, inline, userId }: { bot: Bot; tab: BotSettingsTab; inline: boolean; userId?: string }) {
  const routines = useStore(state => state.routines[bot.id]);
  const memVersion = useVersion(`memories:${bot.id}`);
  const [data, setData] = useState<BotSettingsBundle | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showSources, setShowSources] = useState(false);
  const [footer, setFooter] = useState<HTMLElement | null>(null);
  // The General draft lives here so it survives tab switches (null = nothing edited yet).
  const [generalDraft, setGeneralDraft] = useState<GeneralDraft | null>(null);
  const request = useRef(0);
  const generalDirty = generalDraft !== null && changedFields(generalDraft.values, generalDraft.base).length > 0;
  // R2F-004: drafts on every tab are tracked in configStore, so every way out of this page asks first.
  useBotSettingsDraft('general', 'General', generalDirty);
  const dirty = useConfigUI(state => state.botSettingsDirty);
  const drafts = useConfigUI(state => state.botSettingsDrafts);
  const leaving = useConfigUI(state => state.botSettingsLeave);
  const discards = useConfigUI(state => state.botSettingsDiscards);
  const firstDiscards = useRef(discards);
  useEffect(() => { if (discards !== firstDiscards.current) setGeneralDraft(null); }, [discards]);
  // Switching tabs keeps the General draft; other tabs' forms close with their tab, so those ask first.
  const setTab = (next: BotSettingsTab) => {
    const open = () => useConfigUI.getState().openBotSettings(bot.id, next);
    const others = Object.keys(useConfigUI.getState().botSettingsDrafts).some(id => id !== 'general');
    if (next !== tab && others) useConfigUI.getState().requestLeaveBotSettings(open); else open();
  };
  const discardAndClose = useCallback(() => { setGeneralDraft(null); useConfigUI.getState().discardBotSettings(); }, []);
  // Back, Escape and the close button ask first when a tab has unsaved edits.
  const onClose = useCallback(() => useConfigUI.getState().closeBotSettings(), []);
  const keepEditing = () => {
    useConfigUI.getState().resolveLeaveBotSettings(false);
    const labels = Object.values(useConfigUI.getState().botSettingsDrafts);
    if (tab !== 'general' && labels.length && labels.every(label => label === 'General')) setTab('general');
  };
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const reload = useCallback(() => {
    const version = ++request.current;
    const isCurrent = () => version === request.current && useStore.getState().user?.id === userId;
    configApi.settings(bot.id).then(value => { if (isCurrent()) { setData(value); setLoadError(null); } })
      .catch(failure => { if (isCurrent()) setLoadError(failure.message); });
  }, [bot.id, userId]);
  useEffect(() => { reload(); return () => { request.current += 1; }; }, [reload, memVersion]);
  useEffect(() => { void useStore.getState().loadRoutines(bot.id).catch(() => {}); }, [bot.id]);

  const tabs: { id: BotSettingsTab; label: string; count?: number }[] = [
    { id: 'general', label: 'General' },
    { id: 'skills', label: 'Skills', count: data?.skills.length },
    { id: 'memories', label: 'Memories', count: data?.memories.length },
    { id: 'routines', label: 'Routines', count: (routines ?? data?.routines)?.length },
    { id: 'learning', label: 'Learning' },
    { id: 'analytics', label: 'Analytics' },
  ];
  const label = tabs.find(item => item.id === tab)?.label;
  const sourcesOpen = tab === 'memories' && showSources;
  useEffect(() => {
    if (!inline) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || useConfigUI.getState().appSettings || document.querySelector('.modal-root') || useStore.getState().modal === 'create') return;
      event.preventDefault();
      if (useConfigUI.getState().botSettingsLeave) useConfigUI.getState().resolveLeaveBotSettings(false);
      else if (sourcesOpen) setShowSources(false);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [inline, onClose, sourcesOpen]);
  const content = <>
      <div className="pb-bot-settings__body" style={botVars(bot.avatarColor)}>
        <nav className="pb-settings-tabs" aria-label="Bot settings sections">
          {tabs.map(t => <button key={t.id} type="button" onClick={() => { setShowSources(false); setTab(t.id); }} aria-current={tab === t.id || undefined}>{t.label}</button>)}
        </nav>
        <div className="pb-bot-settings__form"><Page type="form">
        {leaving && <div className="cfg-guard" role="alertdialog" aria-label="Discard unsaved changes?">
          <div className="cfg-row__text"><div className="cfg-row__title">Discard unsaved changes?</div><div className="cfg-row__sub">Your edits on {draftTabs(Object.values(drafts))} have not been saved.</div></div>
          <ButtonGroup>
            <button type="button" className="cfg-btn cfg-btn--secondary" autoFocus onClick={keepEditing}>Keep editing</button>
            <button type="button" className="cfg-btn cfg-btn--danger" onClick={() => { setGeneralDraft(null); useConfigUI.getState().resolveLeaveBotSettings(true); }}>Discard</button>
          </ButtonGroup>
        </div>}
        <Section title={sourcesOpen ? 'Conversation sources' : label}>
        <div className="bot-settings-page__content" key={tab}>
          {loadError && ['skills', 'memories', 'routines'].includes(tab) && <div className="cfg-error" role="alert">Could not load settings: {loadError} <button className="cfg-btn cfg-btn--secondary" type="button" onClick={reload}>Retry</button></div>}
          {tab === 'general' && <GeneralTab bot={bot} onClose={discardAndClose} draft={generalDraft} setDraft={setGeneralDraft} />}
          {tab === 'skills' && <SkillsTab bot={bot} skills={data?.skills} onChange={reload} />}
          {tab === 'memories' && <>
            <div className="bot-settings-page__memories" hidden={sourcesOpen}><MemoriesTab bot={bot} data={data} onChange={reload} onSearch={() => setShowSources(true)} /></div>
            {sourcesOpen && <><ConversationSearch botId={bot.id} expanded /><button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setShowSources(false)}>Close sources</button></>}
          </>}
          {tab === 'routines' && <RoutinesTab bot={bot} routines={routines ?? data?.routines} />}
          {tab === 'analytics' && <BotAnalyticsTab bot={bot} />}
          {tab === 'learning' && <LearningSettingsPanel botId={bot.id} compactBot footer={footer} />}
        </div>
        </Section>
        </Page></div>
      </div>
      <footer className="pb-settings-footer" ref={setFooter}>{tab !== 'learning' && <ButtonGroup>
        <button type="button" className="cfg-btn cfg-btn--secondary" onClick={onClose}>Cancel</button>
        <button type="submit" form="pb-general-form" className="cfg-btn cfg-btn--primary" disabled={tab !== 'general' || !generalDirty}><span className="pb-desktop-save">Save changes</span><span className="pb-phone-save">Save</span></button>
      </ButtonGroup>}</footer>
    </>;
  return inline ? <main className="setup-paper bot-settings-page pb-bot-settings" aria-label={`${bot.name} settings`}>{content}</main>
    : <Modal onClose={onClose} className="setup-paper setup-paper--dialog bot-settings-page bot-settings" label={`${bot.name} settings`}>{content}</Modal>;
}

// ---------------------------------------------------------------------------

type Draft = Pick<Bot, 'name' | 'label' | 'description' | 'instructions' | 'avatarShape' | 'avatarColor' | 'effort' | 'mode' | 'model'>;
// Keep the first-edit baseline with the values across live updates and settings tab switches.
type GeneralDraft = { base: Draft; values: Draft };
const draftOf = (b: Bot): Draft => ({ name: b.name, label: b.label, description: b.description, instructions: b.instructions, avatarShape: b.avatarShape, avatarColor: b.avatarColor, effort: b.effort, mode: b.mode, model: b.model ?? null });
const changedFields = (draft: Draft, base: Draft) => (Object.keys(draft) as (keyof Draft)[]).filter((k) => draft[k] !== base[k]);

function GeneralTab({ bot, onClose, draft: generalDraft, setDraft }: { bot: Bot; onClose: () => void; draft: GeneralDraft | null; setDraft: (update: (current: GeneralDraft | null) => GeneralDraft | null) => void }) {
  const base = generalDraft?.base ?? draftOf(bot);
  const draft = generalDraft?.values ?? base;
  const modelCatalog = useModels();
  const { current: modelInfo, effort: selectedEffort } = modelSelection(draft, modelCatalog);
  const supportedEfforts = effortsFor(modelInfo).map(value => ({ value, label: `${effortLabel(value, modelInfo)}${value === defaultEffortFor(modelInfo) ? ' (default)' : ''}` }));
  const shownEffort = selectedEffort ?? '';
  const [picker, setPicker] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);

  const changed = changedFields(draft, base);
  const dirty = changed.length > 0;
  const nameOk = draft.name.trim().length > 0;
  const updateDraft = (update: (current: Draft) => Draft) => setDraft(current => ({ base: current?.base ?? base, values: update(current?.values ?? draft) }));
  const put = <K extends keyof Draft>(k: K, v: Draft[K]) => updateDraft(d => ({ ...d, [k]: v }));
  const chooseEffort = (effort: Bot['effort'] | '') => {
    if (!effort) return;
    updateDraft(d => ({ ...d, effort, ...(modelInfo?.billing === 'plan' ? { model: modelInfo.id } : {}) }));
  };
  const chooseModel = (model: string | null) => updateDraft(d => {
    const next = { ...d, model };
    return { ...next, effort: effectiveEffort(next.effort, modelSelection(next, modelCatalog).current) };
  });
  const flash = (text: string, tone: 'ok' | 'error' = 'ok') => { setNote({ text, tone }); setTimeout(() => setNote(null), 2400); };

  const save = async () => {
    if (!dirty || !nameOk) return;
    setSaving(true);
    try {
      const patch: BotPatch = {};
      for (const k of changed) (patch as Record<string, unknown>)[k] = k === 'name' ? draft.name.trim() : draft[k];
      if (changed.includes('instructions')) patch.expectedInstructions = base.instructions;
      const { bot: next } = await configApi.updateBot(bot.id, patch);
      useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === next.id ? next : b)) }));
      setDraft(() => null);
      flash('Saved');
    } catch (e) {
      flash((e as Error).message, 'error');
      if (e instanceof ApiError && e.status === 409) await useStore.getState().loadBots().catch(() => {});
    } finally {
      setSaving(false);
    }
  };

  return <form id="pb-general-form" className="cfg-page pb-general" onSubmit={event => { event.preventDefault(); if (!saving) void save(); }}>
    <Field label="Name" htmlFor="cfg-name"><input id="cfg-name" className="text-input" value={draft.name} maxLength={60} onChange={e => put('name', e.target.value)} aria-invalid={!nameOk} /></Field>
    <Field label="Role" htmlFor="cfg-label"><input id="cfg-label" className="text-input" value={draft.label} maxLength={40} onChange={e => put('label', e.target.value)} /></Field>
    <Field label="Model"><BotModelField value={draft.model} onChange={chooseModel} /></Field>
    <Field label="Instructions" htmlFor="cfg-instructions"><textarea id="cfg-instructions" className="text-input cfg-textarea" rows={4} value={draft.instructions} maxLength={8000} onChange={e => put('instructions', e.target.value)} /></Field>
    <Row title="Approvals" trailing={<button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => useConfigUI.getState().openAppSettings('permissions')}>Permissions</button>} />
    <details className="pb-disclosure"><summary>More</summary>
      <Section title="Appearance"><Row leading={<BotAvatar shape={draft.avatarShape} color={draft.avatarColor} size={32} />} title="Character" trailing={<button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setPicker(!picker)} aria-expanded={picker}>{picker ? 'Done' : 'Change look'}</button>} />
        {picker && <LookPicker shape={draft.avatarShape} color={draft.avatarColor} onShape={v => put('avatarShape', v)} onColor={v => put('avatarColor', v)} />}
      </Section>
      <Field label="About" htmlFor="cfg-about"><textarea id="cfg-about" className="text-input cfg-textarea" rows={2} value={draft.description} maxLength={300} onChange={e => put('description', e.target.value)} /></Field>
      {!!supportedEfforts.length && <Field label="Thinking effort"><div className="provider-effort"><ProviderMark provider={providerBrand(modelInfo?.author) ?? modelInfo?.id} fallbackProvider={modelCatalog.provider} /><Segmented label="Thinking effort" value={shownEffort} options={supportedEfforts} onChange={chooseEffort} /></div></Field>}
      <Field label="Used as"><Segmented label="Bot type" value={draft.mode} options={[{ value: 'personal', label: 'Personal assistant' }, { value: 'teammate', label: 'Teammate' }]} onChange={v => put('mode', v)} /></Field>
      <Card><Row title="New conversation" subtitle="Memories, skills and routines stay." trailing={<button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => void startFreshConversation(bot.id)}>Start new</button>} />
        {!bot.isPrimary && <Row title="Primary Bot" trailing={<button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => configApi.makePrimary(bot.id).then(() => flash('Primary Bot updated')).catch(e => flash(e.message, 'error'))}>Make primary</button>} />}
        <Row title="Delete Bot" subtitle={bot.isPrimary ? 'Make another Bot primary first.' : 'Permanently removes this Bot and its history.'} trailing={<ConfirmButton disabled={bot.isPrimary} confirmLabel={`Delete ${bot.name}`} onConfirm={async () => {
          try { await configApi.deleteBot(bot.id); onClose(); const st = useStore.getState(); st.set({ bots: st.bots.filter(b => b.id !== bot.id) }); void st.loadBots().catch(() => {}); }
          catch (e) { flash((e as Error).message, 'error'); }
        }}>Delete</ConfirmButton>} />
      </Card>
    </details>
    {note && <p className={note.tone === 'error' ? 'cfg-error' : ''} role="status">{note.text}</p>}
  </form>;
}

function LookPicker({ shape, color, onShape, onColor }: { shape: AvatarShape; color: AvatarColor; onShape: (s: AvatarShape) => void; onColor: (c: AvatarColor) => void }) {
  return (
    <div className="cfg-picker">
      <BirdPicker shape={shape} color={color} onShape={onShape} />
      <div className="swatches" role="radiogroup" aria-label="Character color">
        <div className="swatches__row">
          {COLOR_ORDER.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={c} className="swatch-cell" onClick={() => onColor(c)}>
              <span className={`swatch${color === c ? ' is-selected' : ''}`} style={{ background: palette(c).fill }} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function SkillsTab({ bot, skills, onChange }: { bot: Bot; skills: KnowledgeSkill[] | undefined; onChange: () => void }) {
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  return (
    <div className="cfg-page">
      {editing === 'new' && <SkillEditor botId={bot.id} onDone={() => { setEditing(null); onChange(); }} />}
      {!skills ? <div className="cfg-empty">Loading...</div> : skills.length === 0 && editing !== 'new' ? (
        <div className="cfg-empty">
          No skills yet.
        </div>
      ) : (
        <div className="cfg-list">
          {skills.map((s) => editing === s.id ? (
            <SkillEditor key={s.id} botId={bot.id} skill={s} onDone={() => { setEditing(null); onChange(); }} />
          ) : (
            <Card key={s.id}>
              <div className="knowledge-item__row"><div><strong>{s.name}</strong><p>{s.description}</p></div><button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setEditing(s.id)} aria-label={`Edit ${s.name}`}>Edit skill</button></div>
              <details className="knowledge-item__details"><summary>Skill details</summary><SkillHistory skill={s} onChange={onChange} /><SkillPackageControls skillId={s.id} revision={s.revision} onChange={onChange} /></details>
            </Card>
          ))}
        </div>
      )}
      <details className="pb-disclosure"><summary>Review skills</summary><SkillReview botId={bot.id} version={(skills ?? []).map(s => `${s.id}:${s.revision}`).join(',')} onChange={onChange} /></details>
      {editing !== 'new' && <div className="setup-paper__actions"><button type="button" className="cfg-btn cfg-btn--primary" onClick={() => setEditing('new')}>Add skill</button></div>}
    </div>
  );
}

function SkillEditor({ botId, skill, onDone }: { botId: string; skill?: KnowledgeSkill; onDone: () => void }) {
  const nameInput = useRef<HTMLInputElement>(null);
  // Focus Name once the form is on screen, after any focus restore from the button that opened it.
  useEffect(() => { const frame = requestAnimationFrame(() => nameInput.current?.focus()); return () => cancelAnimationFrame(frame); }, []);
  const [name, setName] = useState(skill?.name ?? '');
  const [description, setDescription] = useState(skill?.description ?? '');
  const [body, setBody] = useState(skill?.body ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [baseRevision] = useState(skill?.revision);
  const draftId = useId();
  useBotSettingsDraft(`skill:${draftId}`, 'Skills', !busy && (name !== (skill?.name ?? '') || description !== (skill?.description ?? '') || body !== (skill?.body ?? '')));
  const stale = skill && skill.revision !== baseRevision;
  const can = name.trim() && body.trim() && !busy && !stale;
  const save = async () => {
    if (!can) return;
    setBusy(true); setError(null);
    try {
      if (skill && baseRevision !== undefined) await learningApi.updateSkill(skill.id, { name, description, body, expectedRevision: baseRevision });
      else await configApi.createSkill(botId, { name, description, body });
      onDone();
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return (
    <form className="cfg-editor" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <input ref={nameInput} className="text-input" placeholder="Skill name, e.g. Weekly report" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoFocus aria-label="Skill name" />
      <input className="text-input" placeholder="When to use it (optional)" value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} aria-label="Skill description" />
      <textarea className="text-input cfg-textarea cfg-textarea--tall" rows={8} placeholder={'Write the steps to follow:\n1. ...\n2. ...'} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Skill steps" />
      {error && <div className="cfg-error" role="alert">{error}</div>}
      {stale && <div className="cfg-error" role="alert">This skill changed. Close and reopen it to edit the current revision.</div>}
      <ButtonGroup>
        <button type="button" className="cfg-btn cfg-btn--secondary" onClick={onDone}>Cancel</button>
        <button type="submit" className="cfg-btn cfg-btn--primary" disabled={!can}>{busy ? 'Saving...' : skill ? 'Save skill' : 'Add skill'}</button>
      </ButtonGroup>
    </form>
  );
}

// ---------------------------------------------------------------------------

function MemoriesTab({ bot, data, onChange, onSearch }: { bot: Bot; data: BotSettingsBundle | null; onChange: () => void; onSearch: () => void }) {
  const [q, setQ] = useState('');
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [memoryError, setMemoryError] = useState('');
  const memories = useMemo(() => (data?.memories ?? []).filter(m => m.botId === bot.id && m.status === 'active' && !hidden.has(m.id) && (!q || m.text.toLowerCase().includes(q.toLowerCase()))), [data, bot.id, hidden, q]);
  const remove = async (m: KnowledgeMemory) => {
    setHidden((h) => new Set(h).add(m.id));
    try { setMemoryError(''); await configApi.deleteMemory(m.id, m.revision); onChange(); } catch (e) { setMemoryError((e as Error).message); setHidden((h) => { const n = new Set(h); n.delete(m.id); return n; }); }
  };
  const fill = data ? conversationUsagePercent(data.memory.historyChars, data.memory.compactAtChars) : null;
  return (
    <div className="cfg-page">
      {memoryError && <div className="cfg-error" role="alert">{memoryError}</div>}
      {(
        <input className="text-input" placeholder="Search memories" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search memories" />
      )}
      {!data ? <div className="cfg-empty">Loading...</div> : memories.length === 0 ? (
        <div className="cfg-empty">{q ? 'No memories match.' : 'No memories yet.'}</div>
      ) : (
        <div className="cfg-list">
          {memories.map((m) => (
            <Card key={m.id}><details>
              <summary className="knowledge-item__row"><span><strong>{m.text}</strong><small>{m.target === 'environment' ? 'Environment fact' : 'User preference'}{m.evidenceKind ? ` · ${m.evidenceKind} evidence` : ''}</small></span><span className="knowledge-item__action">Open memory</span></summary>
              <div className="knowledge-item__details">
                <p className="native-meta">{m.source === 'learned' ? 'Learned' : 'Saved in chat'} · {shortDate(m.createdAt)} · revision {m.revision}</p>
                <MemoryEvidence key={`${m.id}:${m.revision}`} memory={m} onChange={onChange} />
                <KnowledgeScopeControl kind="memories" item={m} onChange={onChange} />
                <details className="knowledge-item__confirm"><summary>Forget this memory?</summary><p>It will no longer be used or relearned from these sources. The earlier record remains in history.</p><button type="button" className="cfg-btn cfg-btn--danger" onClick={() => void remove(m)}>Forget memory</button></details>
              </div>
            </details></Card>
          ))}
        </div>
      )}
      <details className="pb-disclosure"><summary>More</summary>
      <details className="knowledge-item"><summary className="knowledge-item__row"><span><strong>Pending changes</strong></span><span className="knowledge-item__action">Review</span></summary><PendingMemoryChanges botId={bot.id} onChange={onChange} /></details>
      <div className="knowledge-item knowledge-item__row"><div><strong>Conversation sources</strong></div><button type="button" className="cfg-btn cfg-btn--secondary" onClick={onSearch}>Search</button></div>
      <details className="pb-disclosure"><summary>Archive</summary><MemoryArchive botId={bot.id} version={(data?.memories ?? []).map(m => `${m.id}:${m.revision}`).join(',')} /></details>
      {data && (
        <details className="cfg-meter" title="Estimated size of saved conversation history before automatic summarizing.">
          <summary>Conversation history</summary><div className="cfg-meter__label"><span>Usage</span><span>{fill === null ? 'Usage unavailable' : `${fill}% used`}</span></div>
          <div className="cfg-meter__track"><span style={{ width: `${fill ?? 0}%` }} /></div>
          <div className="cfg-field__hint">
            Estimated conversation size, including tool results. At 100%, older messages are summarized automatically. Saved memories are separate.
            {data.memory.lastCompaction ? ` Last summarized ${shortDate(data.memory.lastCompaction.created_at)}.` : ''}
          </div>
        </details>
      )}
      </details>
      <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => { prefillComposer(bot.id, 'Please remember: '); openConversation(bot.id); }}>Add memory</button>
    </div>
  );
}

// ---------------------------------------------------------------------------

function RoutinesTab({ bot, routines }: { bot: Bot; routines: Routine[] | undefined }) {
  const [flash, setFlash] = useState<string | null>(null);
  const say = (t: string) => { setFlash(t); setTimeout(() => setFlash(null), 2200); };
  // PD-R2-02: routines are created in chat; this opens the chat with a starting prompt to edit and send.
  const askInChat = () => {
    prefillComposer(bot.id, ROUTINE_PROMPT);
    openConversation(bot.id);
  };
  return (
    <div className="cfg-page">
      {flash && <span role="status">{flash}</span>}
      {!routines ? <div className="cfg-empty">Loading...</div> : routines.length === 0 ? (
        <div className="cfg-empty">No routines yet.</div>
      ) : (
        <div className="cfg-list">
          {routines.map((r) => <RoutineItem key={r.id} r={r} onFlash={say} />)}
        </div>
      )}
      <div className="setup-paper__actions"><button type="button" className="cfg-btn cfg-btn--secondary" onClick={askInChat}>New routine</button></div>
      <details className="pb-disclosure"><summary>History</summary><RoutineHistory botId={bot.id} /></details>
    </div>
  );
}

const ROUTINE_PROMPT = 'Please add a routine: every weekday at 9am, ';

function RoutineItem({ r, onFlash }: { r: Routine; onFlash: (t: string) => void }) {
  const [enabled, setEnabled] = useState(r.enabled);
  const [busy, setBusy] = useState(false);
  useEffect(() => setEnabled(r.enabled), [r.enabled]);
  const toggle = async (v: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await configApi.setRoutine(r.id, v);
      setEnabled(result.routine.enabled); onFlash(v ? 'Resumed' : 'Paused');
    }
    catch (e) {
      toast((e as Error).message || `Could not update ${r.name}.`, { tone: 'error' });
    } finally { setBusy(false); refresh(); }
  };
  const refresh = () => {
    void useStore.getState().loadRoutines(r.botId).catch(() => {});
    useConfigUI.getState().bump(`routines:${r.botId}`);
  };
  // R2F-003: both actions ask in the shared dialog; nothing reverts on a timer and the icons never move.
  const runNow = async () => {
    if (busy || !await confirmDialog({ title: `Run ${r.name} now?`, body: 'It runs once now. Its schedule does not change.', confirmLabel: 'Run now' })) return;
    setBusy(true);
    try { await configApi.runRoutine(r.id); onFlash('Running now'); refresh(); }
    catch (e) { toast((e as Error).message || `Could not run ${r.name}.`, { tone: 'error' }); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (busy || !await confirmDialog({ title: `Delete ${r.name}?`, body: 'Future runs stop. Past runs and reports stay.', confirmLabel: 'Delete', danger: true })) return;
    setBusy(true);
    try { await configApi.deleteRoutine(r.id); onFlash('Deleted'); refresh(); }
    catch (e) { toast((e as Error).message || `Could not delete ${r.name}.`, { tone: 'error' }); }
    finally { setBusy(false); }
  };
  return (
    <Card className="cfg-item cfg-item--routine">
      <span className="cfg-item__icon"><Icon name="clock" size={14} /></span>
      <div className="cfg-item__text">
        <div className="cfg-item__title">{r.name}</div>
        <div className="cfg-item__sub">{enabled ? r.description || r.schedule : 'Paused'}</div>
        {r.activationPending && <div className="cfg-item__sub" role="status">Updating event subscription...</div>}
        {r.activationError && <div className="cfg-error" role="alert">{r.activationError} <button type="button" disabled={busy} onClick={() => void toggle(r.activationTarget ?? !enabled)}>Retry</button></div>}
<details><summary>Manage</summary><p>{r.prompt}</p><p>{nextRunLabel(r.nextRunAt, r.timezone)}</p><ButtonGroup><button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={() => void runNow()}>Run now</button><button type="button" className="cfg-btn cfg-btn--danger" disabled={busy} onClick={() => void remove()}>Delete</button></ButtonGroup></details>
      </div>
      <div className="cfg-item__actions">
        <Switch on={enabled} onChange={toggle} disabled={busy || r.activationPending} label={`${r.name} schedule on`} />
      </div>
    </Card>
  );
}
