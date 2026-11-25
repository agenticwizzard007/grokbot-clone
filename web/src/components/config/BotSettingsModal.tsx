import { useModels, effortsFor, effectiveEffort, effortLabel, effortDescription, defaultEffortFor, modelSelection } from '../../lib/models';
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
import { openConversation, useReturnLabel, useBotSettingsDraft, useConfigUI, useVersion, type BotSettingsTab } from '../../configStore';
import { useStore } from '../../store';
import { Icon } from '../Icon';
import { SetupPaperHeader } from '../SetupPaperHeader';
import { Modal } from '../modals/Modal';
import { BotAnalyticsTab } from './BotAnalyticsTab';
import { Glyph } from './glyphs';
import { ConfirmButton, Field, Segmented, Switch, nextRunLabel, shortDate } from './ui';
import { confirmDialog } from '../../lib/confirmDialog';
import { toast } from '../../lib/toast';
import { prefillComposer } from '../Composer';
import '../../styles/setup-paper.css';
import { startFreshConversation } from '../../lib/useFreshConversation';
import { SuggestedIntegrations } from '../SuggestedIntegrations';

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
  const backTitle = useReturnLabel();
  const routines = useStore(state => state.routines[bot.id]);
  const memVersion = useVersion(`memories:${bot.id}`);
  const [data, setData] = useState<BotSettingsBundle | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showSources, setShowSources] = useState(false);
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
  // On phones the section tabs scroll sideways: keep the open one in view.
  const tabsNav = useRef<HTMLElement>(null);
  useEffect(() => { tabsNav.current?.querySelector<HTMLElement>('[aria-current]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); }, [tab]);
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
  const headings: Partial<Record<BotSettingsTab, string>> = {
    general: 'Identity, chat model, and settings for this Bot.', skills: 'Saved procedures and changes that need your review.',
    memories: 'Review preferences and facts, including where they came from.', routines: 'Schedules and run history for this Bot.', learning: 'Review learning activity, settings, and protected maintenance.',
  };
  const content = <>
      <SetupPaperHeader backLabel={sourcesOpen ? 'Back to memories' : backTitle} title={label} onBack={sourcesOpen ? () => setShowSources(false) : onClose} onClose={onClose} />
      <div className="setup-paper__column bot-settings-page__column" style={botVars(bot.avatarColor)}>
        <h1>{sourcesOpen ? 'Conversation sources' : bot.name}</h1>
        {leaving && <div className="cfg-guard" role="alertdialog" aria-label="Discard unsaved changes?">
          <div className="cfg-row__text"><div className="cfg-row__title">Discard unsaved changes?</div><div className="cfg-row__sub">Your edits on {draftTabs(Object.values(drafts))} have not been saved.</div></div>
          <div className="settings-row__actions">
            <button type="button" className="cfg-btn cfg-btn--secondary" autoFocus onClick={keepEditing}>Keep editing</button>
            <button type="button" className="cfg-btn cfg-btn--danger" onClick={() => { setGeneralDraft(null); useConfigUI.getState().resolveLeaveBotSettings(true); }}>Discard</button>
          </div>
        </div>}
        <nav ref={tabsNav} className="setup-paper__tabs" aria-label="Bot settings sections">
          {tabs.map((t) => (
            <button key={t.id} type="button" onClick={() => { setShowSources(false); setTab(t.id); }} aria-current={tab === t.id || undefined}>{t.label}</button>
          ))}
        </nav>
        <div className="bot-settings-page__content" key={tab}>
          {headings[tab] && <p className="setup-paper__subtitle bot-settings-page__intro">{sourcesOpen ? 'Find evidence in current or archived chats.' : headings[tab]}</p>}
          {loadError && ['skills', 'memories', 'routines'].includes(tab) && <div className="cfg-error" role="alert">Couldn’t load settings: {loadError} <button className="cfg-btn cfg-btn--secondary" type="button" onClick={reload}>Retry</button></div>}
          {tab === 'general' && <GeneralTab bot={bot} onClose={discardAndClose} draft={generalDraft} setDraft={setGeneralDraft} />}
          {tab === 'skills' && <SkillsTab bot={bot} skills={data?.skills} onChange={reload} />}
          {tab === 'memories' && <>
            <div className="bot-settings-page__memories" hidden={sourcesOpen}><MemoriesTab bot={bot} data={data} onChange={reload} onSearch={() => setShowSources(true)} /></div>
            {sourcesOpen && <><ConversationSearch botId={bot.id} expanded /><button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setShowSources(false)}>Close sources</button></>}
          </>}
          {tab === 'routines' && <RoutinesTab bot={bot} routines={routines ?? data?.routines} />}
          {tab === 'analytics' && <BotAnalyticsTab bot={bot} />}
          {tab === 'learning' && <LearningSettingsPanel botId={bot.id} />}
        </div>
      </div>
    </>;
  return inline ? <main className="setup-paper bot-settings-page" aria-label={`${bot.name} settings`}>{content}</main>
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

  return (
    <div className="cfg-page">
      <section className="cfg-section">
        <div className="cfg-look">
          <BotAvatar shape={draft.avatarShape} color={draft.avatarColor} size={72} />
          <div className="cfg-look__text">
            <div className="cfg-look__name">{draft.name || 'New Bot'}</div>
            <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setPicker(!picker)} aria-expanded={picker}>
              {picker ? 'Done' : 'Change look'}
            </button>
          </div>
        </div>
        {picker && <LookPicker shape={draft.avatarShape} color={draft.avatarColor} onShape={(s) => put('avatarShape', s)} onColor={(c) => put('avatarColor', c)} />}
      </section>

      <section className="cfg-section cfg-grid">
        <Field label="Name" htmlFor="cfg-name">
          <input id="cfg-name" className="text-input" value={draft.name} maxLength={60} onChange={(e) => put('name', e.target.value)} aria-invalid={!nameOk} />
        </Field>
        <Field label="Label" htmlFor="cfg-label" hint="Shown next to the name, like “Research” or “Inbox”.">
          <input id="cfg-label" className="text-input" value={draft.label} maxLength={40} placeholder="Add a label" onChange={(e) => put('label', e.target.value)} />
        </Field>
      </section>

      <section className="cfg-section">
        <Field label="About" htmlFor="cfg-about">
          <textarea id="cfg-about" className="text-input cfg-textarea" rows={2} value={draft.description} maxLength={300} placeholder="What is this Bot for?" onChange={(e) => put('description', e.target.value)} />
        </Field>
        <SuggestedIntegrations botId={bot.id} description={draft.description} instructions={draft.instructions} />
        <Field label="Instructions" htmlFor="cfg-instructions" hint={`Standing guidance ${draft.name || 'this Bot'} always follows, like tone, priorities or things to avoid. It also learns from chat, skills and memories.`}>
          <textarea id="cfg-instructions" className="text-input cfg-textarea cfg-textarea--tall" rows={7} value={draft.instructions} maxLength={8000} placeholder="e.g. Keep updates to three bullets. Never email anyone outside the team without asking." onChange={(e) => put('instructions', e.target.value)} />
        </Field>
        <Field label="Thinking effort" hint={supportedEfforts.length ? selectedEffort ? effortDescription(selectedEffort, modelInfo) : 'Uses the provider default.' : 'Select a model to see its supported effort levels. The default uses the provider’s settings.'}>
          {supportedEfforts.length > 0 && <Segmented label="Thinking effort" value={shownEffort} options={supportedEfforts} onChange={chooseEffort} />}
        </Field>
        <Field label="Model" hint="Which AI model this Bot thinks with. Default follows your active API or plan connection.">
          <BotModelField value={draft.model} onChange={chooseModel} />
        </Field>
        <Field label="Used as">
          <Segmented label="Bot type" value={draft.mode} options={[{ value: 'personal', label: 'Personal assistant' }, { value: 'teammate', label: 'Teammate' }]} onChange={(v) => put('mode', v)} />
        </Field>
      </section>

      <div className={`cfg-savebar${dirty ? ' is-dirty' : ''}`}>
        <span className={`cfg-savebar__note${note?.tone === 'error' ? ' is-error' : ''}`} role="status">{note?.text ?? (dirty ? 'Unsaved changes' : '')}</span>
        <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!dirty || saving} onClick={() => setDraft(() => null)}>Discard</button>
        <button type="button" className="cfg-btn cfg-btn--primary" disabled={!dirty || saving || !nameOk} onClick={save}>{saving ? 'Saving…' : 'Save changes'}</button>
      </div>

      <section className="cfg-section">
        <div className="cfg-section__label">Conversation</div>
        <div className="cfg-card">
          <div className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">New conversation</div>
              <div className="cfg-row__sub">Clears the chat. Memories, skills and routines stay.</div>
            </div>
            {/* MF-007: same confirm, toast and row reload as the chat entry points. */}
            <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => { void startFreshConversation(bot.id); }}>Start new</button>
          </div>
          {!bot.isPrimary && (
            <div className="cfg-row">
              <div className="cfg-row__text">
                <div className="cfg-row__title">Make primary</div>
                <div className="cfg-row__sub">Your go-to Bot. It reaches out first and keeps the others on track.</div>
              </div>
              <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => configApi.makePrimary(bot.id).then(() => flash(`${bot.name} is now your primary Bot`)).catch((e) => flash(e.message, 'error'))}>Make primary</button>
            </div>
          )}
        </div>
      </section>

      <section className="cfg-section">
        <div className="cfg-section__label">Danger zone</div>
        <div className="cfg-card">
          <div className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">Delete {bot.name}</div>
              <div className="cfg-row__sub">{bot.isPrimary ? 'Make another Bot primary first.' : 'Removes its chat, memories, skills and routines for good.'}</div>
            </div>
            <ConfirmButton
              disabled={bot.isPrimary}
              confirmLabel={`Delete ${bot.name}`}
              onConfirm={async () => {
                try {
                  await configApi.deleteBot(bot.id);
                  onClose();
                  const st = useStore.getState();
                  st.set({ bots: st.bots.filter((b) => b.id !== bot.id) });
                  st.loadBots().catch(() => {});
                } catch (e) { flash((e as Error).message, 'error'); }
              }}
            >
              Delete…
            </ConfirmButton>
          </div>
        </div>
      </section>
    </div>
  );
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
      {!skills ? <div className="cfg-empty">Loading…</div> : skills.length === 0 && editing !== 'new' ? (
        <div className="cfg-empty">
          No skills yet. Add a repeatable procedure, then ask for it by name in chat.
        </div>
      ) : (
        <div className="cfg-list">
          {skills.map((s) => editing === s.id ? (
            <SkillEditor key={s.id} botId={bot.id} skill={s} onDone={() => { setEditing(null); onChange(); }} />
          ) : (
            <article key={s.id} className="knowledge-item">
              <div className="knowledge-item__row"><div><strong>{s.name}</strong><p>{s.description || s.body.split('\n')[0]}</p></div><button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setEditing(s.id)} aria-label={`Edit ${s.name}`}>Edit skill</button></div>
              <details className="knowledge-item__details"><summary>Package, protections, and history</summary><SkillHistory skill={s} onChange={onChange} /><SkillPackageControls skillId={s.id} revision={s.revision} onChange={onChange} /></details>
            </article>
          ))}
        </div>
      )}
      <SkillReview botId={bot.id} version={(skills ?? []).map(s => `${s.id}:${s.revision}`).join(',')} onChange={onChange} />
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
      <textarea className="text-input cfg-textarea cfg-textarea--tall" rows={8} placeholder={'Write the steps to follow:\n1. …\n2. …'} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Skill steps" />
      {error && <div className="cfg-error" role="alert">{error}</div>}
      {stale && <div className="cfg-error" role="alert">This skill changed. Close and reopen it to edit the current revision.</div>}
      <div className="cfg-editor__actions">
        <button type="button" className="cfg-btn cfg-btn--secondary" onClick={onDone}>Cancel</button>
        <button type="submit" className="cfg-btn cfg-btn--primary" disabled={!can}>{busy ? 'Saving…' : skill ? 'Save skill' : 'Add skill'}</button>
      </div>
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
  const fill = data ? Math.min(100, Math.round((data.memory.historyChars / data.memory.compactAtChars) * 100)) : 0;
  return (
    <div className="cfg-page">
      {memoryError && <div className="cfg-error" role="alert">{memoryError}</div>}
      {(data?.memories.length ?? 0) > 6 && (
        <input className="text-input" placeholder="Search memories" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search memories" />
      )}
      {!data ? <div className="cfg-empty">Loading…</div> : memories.length === 0 ? (
        <div className="cfg-empty">{q ? 'No memories match.' : `Nothing yet. Tell ${bot.name} about yourself, or just chat. It’ll pick things up.`}</div>
      ) : (
        <div className="cfg-list">
          {memories.map((m) => (
            <details key={m.id} className="knowledge-item">
              <summary className="knowledge-item__row"><span><strong>{m.text}</strong><small>{m.target === 'environment' ? 'Environment fact' : 'User preference'}{m.evidenceKind ? ` · ${m.evidenceKind} evidence` : ''}</small></span><span className="knowledge-item__action">Open memory</span></summary>
              <div className="knowledge-item__details">
                <p className="native-meta">{m.source === 'learned' ? 'Learned' : 'Saved in chat'} · {shortDate(m.createdAt)} · revision {m.revision}</p>
                <MemoryEvidence key={`${m.id}:${m.revision}`} memory={m} onChange={onChange} />
                <KnowledgeScopeControl kind="memories" item={m} onChange={onChange} />
                <details className="knowledge-item__confirm"><summary>Forget this memory?</summary><p>It will no longer be used or relearned from these sources. The earlier record remains in history.</p><button type="button" className="cfg-btn cfg-btn--danger" onClick={() => void remove(m)}>Forget memory</button></details>
              </div>
            </details>
          ))}
        </div>
      )}
      <details className="knowledge-item"><summary className="knowledge-item__row"><span><strong>Pending changes</strong><small>The current fact remains active until you approve a change.</small></span><span className="knowledge-item__action">Review memory changes</span></summary><PendingMemoryChanges botId={bot.id} onChange={onChange} /></details>
      <div className="knowledge-item knowledge-item__row"><div><strong>Conversation sources</strong><p>Search current and archived conversations.</p></div><button type="button" className="cfg-btn cfg-btn--secondary" onClick={onSearch}>Search sources</button></div>
      <MemoryArchive botId={bot.id} version={(data?.memories ?? []).map(m => `${m.id}:${m.revision}`).join(',')} />
      {data && (
        <div className="cfg-meter" title="Older messages are summarized automatically when this fills up.">
          <div className="cfg-meter__label"><span>Conversation memory</span><span>{fill}% full</span></div>
          <div className="cfg-meter__track"><span style={{ width: `${fill > 0 ? Math.max(2, fill) : 0}%` }} /></div>
          <div className="cfg-field__hint">
            When it fills up, older messages get summarized so {bot.name} can keep going.
            {data.memory.lastCompaction ? ` Last summarized ${shortDate(data.memory.lastCompaction.created_at)}.` : ''}
          </div>
        </div>
      )}
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
      <div className="cfg-page__head">
        <div>
          <div className="cfg-page__title">Routines</div>
          <div className="cfg-page__sub">Recurring jobs {bot.name} runs on a schedule. To add or change one, ask in chat.</div>
        </div>
        {flash && <span className="cfg-savebar__note" role="status">{flash}</span>}
      </div>
      {!routines ? <div className="cfg-empty">Loading…</div> : routines.length === 0 ? (
        <div className="cfg-empty">No routines yet. Try asking {bot.name}: “every Friday at 4pm, recap my week”.</div>
      ) : (
        <div className="cfg-list">
          {routines.map((r) => <RoutineItem key={r.id} r={r} onFlash={say} />)}
        </div>
      )}
      <div className="setup-paper__actions"><button type="button" className="cfg-btn cfg-btn--secondary" onClick={askInChat}>Ask {bot.name} to add a routine</button></div>
      <RoutineHistory botId={bot.id} />
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
      toast((e as Error).message || `Couldn’t update ${r.name}.`, { tone: 'error' });
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
    catch (e) { toast((e as Error).message || `Couldn’t run ${r.name}.`, { tone: 'error' }); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (busy || !await confirmDialog({ title: `Delete ${r.name}?`, body: 'Future runs stop. Past runs and reports stay.', confirmLabel: 'Delete', danger: true })) return;
    setBusy(true);
    try { await configApi.deleteRoutine(r.id); onFlash('Deleted'); refresh(); }
    catch (e) { toast((e as Error).message || `Couldn’t delete ${r.name}.`, { tone: 'error' }); }
    finally { setBusy(false); }
  };
  return (
    <div className="cfg-item cfg-item--routine">
      <span className="cfg-item__icon"><Icon name="clock" size={14} /></span>
      <div className="cfg-item__text">
        <div className="cfg-item__title">{r.name}</div>
        <div className="cfg-item__sub">{enabled ? [r.description || r.schedule, nextRunLabel(r.nextRunAt, r.timezone)].filter(Boolean).join(' · ') : 'Paused'}</div>
        {r.activationPending && <div className="cfg-item__sub" role="status">Updating event subscription...</div>}
        {r.activationError && <div className="cfg-error" role="alert">{r.activationError} <button type="button" disabled={busy} onClick={() => void toggle(r.activationTarget ?? !enabled)}>Retry</button></div>}
        <div className="cfg-item__prompt">{r.prompt}</div>
      </div>
      <div className="cfg-item__actions">
        <button type="button" className="cfg-icon-btn" title="Run now" aria-label={`Run ${r.name} now`} disabled={busy} onClick={() => void runNow()}>
          <Glyph name="play" size={13} />
        </button>
        <button type="button" className="cfg-icon-btn" title="Delete" aria-label={`Delete ${r.name}`} disabled={busy} onClick={() => void remove()}>
          <Glyph name="trash" size={14} />
        </button>
        <Switch on={enabled} onChange={toggle} disabled={busy || r.activationPending} label={`${r.name} schedule on`} />
      </div>
    </div>
  );
}
