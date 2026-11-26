import { planLabel } from '../lib/planLabel';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ArrowUpRight, Check, ChevronDown, ChevronLeft, ChevronRight, GripVertical, Minus, Search, Settings2, Star } from 'lucide-react';
import type { Bot } from '@shared/types';
import { configApi } from '../lib/configApi';
import { defaultEffortFor, effortDescription, effortLabel, isTopEffort, effectiveEffort, effortsFor, fallbackShort, modelSelection, useModels, type PickerModel } from '../lib/models';
import { useStore } from '../store';
import { ProviderMark } from './ProviderMark';
import { ModelUsageDetails } from './ModelUsageDetails';
import { PlanConnections } from './PlanConnections';
import { useConfigUI } from '../configStore';

import { toast } from '../lib/toast';
import { shortcutLabel } from '../lib/shortcuts';
import { nextEffort } from '../lib/effortCycle';
import { lastModelLabel, rememberModelLabel } from '../lib/modelMemory';
import { composerModelLabel } from '../lib/composerModelLabel';


async function patchBot(bot: Bot, p: Partial<Pick<Bot, 'model' | 'effort' | 'fast'>>) {
  const st = useStore.getState();
  st.set({ bots: st.bots.map((b) => (b.id === bot.id ? { ...b, ...p } : b)) });
  try {
    const { bot: saved } = await configApi.updateBot(bot.id, p);
    const now = useStore.getState();
    now.set({ bots: now.bots.map((b) => (b.id === saved.id ? saved : b)) });
  } catch {
    const now = useStore.getState();
    now.set({ bots: now.bots.map((b) => (b.id === bot.id ? bot : b)) });
  }
}

/** Next effort in the cycle (weakest to strongest, then wraps), skipping "No thinking". Shows a toast. */
export function cycleEffort(bot: Bot, m: PickerModel | undefined) {
  const current = modelSelection(bot, useModels.getState()).effort ?? effectiveEffort(bot.effort, m);
  const next = nextEffort(effortsFor(m), current);
  if (!next) return;
  toast(`Effort: ${effortLabel(next, m)}`);
  void patchBot(bot, { effort: next, ...(m?.billing === 'plan' ? { model: m.id, fast: false } : {}) });
}

export const toggleFast = (bot: Bot) => void patchBot(bot, { fast: !bot.fast });

export const ComposerModelMenu = memo(function ComposerModelMenu({ bot }: { bot: Bot }) {
  const [open, setOpen] = useState(false);
  const models = useModels();
  const mobile = useStore((s) => s.mobile);
  const detailsOpen = useStore((s) => s.detailsOpen);
  const accountId = useStore(s => s.user?.id);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => { setOpen(false); trigger.current?.focus({ preventScroll: true }); }, []);
  useLayoutEffect(() => { setOpen(false); }, [accountId, bot.id]);
  // Let Details take focus, and allow the picker to reopen while it stays open.
  useLayoutEffect(() => { if (detailsOpen) setOpen(false); }, [detailsOpen]);
  useEffect(() => { void models.load(); }, [accountId, models.load]);

  const known = models.status === 'ready' && !models.error && !!models.provider && !!models.billing;
  const planMode = known && models.billing === 'plan';
  const selection = modelSelection(bot, models);
  const current = known ? selection.current : undefined;
  const effort = known ? selection.effort : null;
  const loading = models.status === 'loading' || models.status === 'idle';
  const label = loading ? lastModelLabel(accountId, bot) : models.status === 'error' || models.error ? 'Models unavailable' : !known ? 'Provider default' : current ? fallbackShort(current.id, current.short) : (planMode ? 'CLI default' : bot.model ? fallbackShort(bot.model) : 'Default model');
  const rememberedLabel = composerModelLabel(label, models.provider, planMode);
  useEffect(() => { if (known) rememberModelLabel(accountId, bot, rememberedLabel); }, [accountId, bot.id, bot.model, known, rememberedLabel]);
  const currentPlan = planLabel(models.provider, models.plan);
  const billingDescription = planMode ? `Uses your ${currentPlan}` : 'Uses API billing';
  const compactLabel = planMode ? (models.provider === 'codex-cli' ? 'Codex' : 'Claude') : label;
  const codexPlan = planMode && models.provider === 'codex-cli';
  const efforts = effortsFor(current);
  const ultra = isTopEffort(effort, current);

  return (
    <span className="model-pill-anchor">
      <button ref={trigger} type="button" className={`model-pill${ultra ? ' is-ultracode' : ''}`} onClick={() => { if (!open && !loading) void models.load(true); setOpen(!open); }} aria-haspopup="dialog" aria-expanded={open} aria-busy={loading}
        title={`${label}${known ? `. ${billingDescription}` : ''}`}
        aria-label={`Model: ${label}${known ? `, ${billingDescription}` : ''}${efforts.length ? `, ${effort ? effortLabel(effort, current) : 'Default'} effort` : ''}${bot.fast && models.canFast ? ', fast' : ''}. Change`}>
        <span className="model-pill__provider" aria-hidden>
          <ProviderMark provider={current?.author ?? (known && planMode ? models.provider : loading ? label : bot.model)} reserve />
        </span>
        <span className="model-pill__name">{composerModelLabel(mobile ? compactLabel : label, models.provider, planMode)}</span>
        {known && !codexPlan && !(mobile && planMode) && <span className="model-billing" title={billingDescription}>{planMode ? currentPlan : 'API'}</span>}
        {efforts.length > 0 && <span className="model-pill__effort">{effort ? effortLabel(effort, current) : 'Default'}</span>}
        {bot.fast && models.canFast && <span className="model-pill__fast" title="Fast: fastest providers">⚡︎</span>}
        <ChevronDown size={14} strokeWidth={1.75} aria-hidden className="model-pill__chev" />
      </button>
      {open && <ModelMenu bot={bot} current={current} onClose={close} sheet={mobile} />}
    </span>
  );
});

function ModelMenu({ bot, current, onClose, sheet }: { bot: Bot; current: PickerModel | undefined; onClose: () => void; sheet: boolean }) {
  const { models, byId, favourites, canFast, status, error, setFavourites, provider, billing, plan } = useModels();
  const [q, setQ] = useState('');
  const [view, setView] = useState<'main' | 'effort' | 'usage' | 'connections'>('main');
  const [effortModelId, setEffortModelId] = useState<string | null>(null);
  const [inlineEffort, setInlineEffort] = useState(sheet);
  const [menuOffset, setMenuOffset] = useState(0);
  const [editing, setEditing] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const effortRef = useRef<HTMLUListElement>(null);
  const effortTrigger = useRef<HTMLElement | null>(null);
  const usageTrigger = useRef<HTMLButtonElement>(null);
  const connectionsTrigger = useRef<HTMLButtonElement>(null);
  const known = status === 'ready' && !error && !!provider && !!billing;
  const loading = status === 'idle' || status === 'loading';
  const usageLabel = known ? billing === 'plan' ? 'Plan & usage' : 'API details' : 'Connection details';
  const back = () => {
    const fromUsage = view === 'usage';
    const fromConnections = view === 'connections';
    const label = effortTrigger.current?.getAttribute('aria-label');
    setView('main');
    requestAnimationFrame(() => {
      const trigger = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(button => button.getAttribute('aria-label') === label);
      (fromConnections ? connectionsTrigger.current : fromUsage ? usageTrigger.current : trigger ?? search.current)?.focus();
    });
  };
  const openEffort = (model: PickerModel, trigger: HTMLElement) => {
    effortTrigger.current = trigger; setEffortModelId(model.id); setView('effort');
  };
  useLayoutEffect(() => {
    const anchor = ref.current?.parentElement;
    const chat = anchor?.closest('.chat');
    const measure = () => {
      const left = (anchor?.getBoundingClientRect().left ?? 4) - 4;
      // Details can narrow the chat without resizing the window.
      const right = Math.min(innerWidth, chat?.getBoundingClientRect().right ?? innerWidth) - 12;
      const offset = sheet ? 0 : Math.min(0, right - left - 340);
      setMenuOffset(offset);
      setInlineEffort(sheet || left + offset + 588 > right);
    };
    const observer = new ResizeObserver(measure);
    if (chat) observer.observe(chat);
    if (anchor) observer.observe(anchor);
    measure(); window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [sheet]);
  useEffect(() => {
    if (view === 'effort') (effortRef.current?.querySelector<HTMLElement>('[aria-selected="true"]') ?? effortRef.current?.querySelector<HTMLElement>('button'))?.focus();
  }, [view, effortModelId, inlineEffort]);

  // One focus-contained picker: Escape returns from details/effort before closing.
  useEffect(() => {
    const down = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as Element).closest?.('.model-pill')) onClose(); };
    const key = (e: KeyboardEvent) => {
      // R2F-030: the side effort flyout sits next to the open model list, so Escape closes the picker in one
      // press. Only views that replace the list (Connection details, the inline effort sheet) step back first.
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (view === 'usage' || view === 'connections' || (view === 'effort' && inlineEffort)) back(); else onClose(); }
      if (e.key !== 'Tab') return;
      const items = [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href]') ?? [])].filter(el => el.getClientRects().length > 0);
      const first = items[0], last = items.at(-1);
      if (!first || !last) { e.preventDefault(); return; }
      const inside = items.includes(document.activeElement as HTMLElement);
      if (e.shiftKey && (!inside || document.activeElement === first)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (!inside || document.activeElement === last)) { e.preventDefault(); first.focus(); }
    };
    const t = setTimeout(() => document.addEventListener('pointerdown', down));
    document.addEventListener('keydown', key, true);
    return () => { clearTimeout(t); document.removeEventListener('pointerdown', down); document.removeEventListener('keydown', key, true); };
  }, [onClose, view, inlineEffort]);
  useEffect(() => { (sheet ? ref.current?.querySelector<HTMLElement>('[role=dialog]') : search.current)?.focus({ preventScroll: true }); }, [sheet]);
  useLayoutEffect(() => { if (view === 'usage' || view === 'connections') ref.current?.querySelector<HTMLElement>('.mm-back')?.focus({ preventScroll: true }); }, [view]);

  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return models.filter((m) => m.short.toLowerCase().includes(s) || m.name.toLowerCase().includes(s) || m.id.includes(s)).slice(0, 40);
  }, [q, models]);

  const favs = favourites.map((id) => byId.get(id)).filter(Boolean) as PickerModel[];
  const target = effortModelId ? byId.get(effortModelId) : current;
  const efforts = effortsFor(target);
  const currentEffort = modelSelection(bot, useModels.getState()).effort;
  const effort = target?.id === current?.id ? currentEffort : null;
  const rowEffort = (m: PickerModel) => !editing && effortsFor(m).length > 0 && (
    <button type="button" className="mm-row__effort" aria-label={`Effort for ${m.short}`} aria-haspopup="listbox" aria-expanded={view === 'effort' && target?.id === m.id}
      onClick={e => openEffort(m, e.currentTarget)}>
      <span className={m.id === current?.id && isTopEffort(currentEffort, m) ? 'uc-text' : undefined}>{m.id === current?.id && currentEffort ? effortLabel(currentEffort, current) : 'Effort'}</span><ChevronRight size={12} aria-hidden />
    </button>
  );

  const choose = (m: PickerModel) => {
    // Save the closest supported level in both billing modes.
    void patchBot(bot, { model: m.id, effort: effectiveEffort(bot.effort, m), ...(m.billing === 'plan' ? { fast: false } : {}) });
    onClose();
  };
  const toggleFav = (id: string) => setFavourites(favourites.includes(id) ? favourites.filter((x) => x !== id) : [...favourites, id]);
  const move = (from: number, to: number) => {
    if (to < 0 || to >= favs.length || from === to) return;
    const ids = favs.map((m) => m.id);
    const [x] = ids.splice(from, 1);
    ids.splice(to, 0, x);
    void setFavourites(ids);
  };
  const rowKeys = (i: number) => (e: ReactKeyboardEvent) => {
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); move(i, i + (e.key === 'ArrowUp' ? -1 : 1)); }
  };

  const modelRow = (m: PickerModel, i: number | null) => {
    const selected = m.id === current?.id;
    return (
      <li key={m.id} className={`mm-row${selected ? ' is-selected' : ''}${drag === i ? ' is-dragging' : ''}`}
        draggable={i !== null && !sheet} onDragStart={() => setDrag(i)} onDragEnd={() => setDrag(null)}
        onDragOver={(e) => { if (drag !== null && i !== null) { e.preventDefault(); if (drag !== i) { move(drag, i); setDrag(i); } } }}>
        {i !== null ? <GripVertical size={14} strokeWidth={1.75} className="mm-row__grip" aria-hidden /> : <span className="mm-row__grip" aria-hidden />}
        <button type="button" className="mm-row__main" onClick={() => choose(m)} onKeyDown={i !== null ? rowKeys(i) : undefined} aria-current={selected || undefined}
          title={i !== null ? 'Alt+↑/↓ to reorder' : undefined}>
          <ProviderMark provider={m.author} />
          <span className="mm-row__name">{fallbackShort(m.id, m.short)}{m.resolvedModel && <small className="mm-row__resolved">{fallbackShort(m.resolvedModel)}</small>}</span>
          <span className="model-billing" title={billing === 'plan' ? `Uses your ${planLabel(provider, plan)}` : 'Uses API billing'}>{billing === 'plan' ? 'Subscription' : 'API'}</span>
          {!m.vision && <span className="mm-row__meta">No images</span>}
        </button>
        {rowEffort(m)}
        {editing && i !== null ? (
          <button type="button" className="mm-row__act" onClick={() => toggleFav(m.id)} aria-label={`Remove ${m.short} from favourites`}><Minus size={14} strokeWidth={2} /></button>
        ) : selected ? (
          <Check size={16} strokeWidth={2} className="mm-row__check" aria-label="Selected" />
        ) : provider === 'openrouter' ? (
          <a className="mm-row__act" href={`https://openrouter.ai/${m.id}`} target="_blank" rel="noreferrer noopener" aria-label={`${m.short} on OpenRouter`} onClick={(e) => e.stopPropagation()}><ArrowUpRight size={14} strokeWidth={1.75} /></a>
        ) : null}
      </li>
    );
  };

  const effortList = (
    <ul ref={effortRef} className="mm-efforts" role="listbox" aria-label="Effort" onKeyDown={event => {
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]')];
      const index = options.indexOf(document.activeElement as HTMLButtonElement);
      options[event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length]?.focus();
    }}>
      {efforts.map((e) => (
        <li key={e}>
          <button type="button" role="option" aria-selected={e === effort} className={`mm-effort${isTopEffort(e, target) ? ' is-ultracode' : ''}${e === effort ? ' is-selected' : ''}`}
            onClick={() => { if (target) void patchBot(bot, { model: target.id, effort: e, ...(target.billing === 'plan' ? { fast: false } : {}) }); onClose(); }}>
            <span className="mm-effort__text"><span className="mm-effort__label">{effortLabel(e, target)}</span><span className="mm-effort__desc">{e === defaultEffortFor(target) ? `Default · ${effortDescription(e, target)}` : effortDescription(e, target)}</span></span>
            {e === effort && <Check size={16} strokeWidth={2} aria-hidden />}
          </button>
        </li>
      ))}
    </ul>
  );

  return (
    <>
      {sheet && <div className="mm-scrim" aria-hidden onClick={onClose} />}
      <div ref={ref} className={`mm-wrap${sheet ? ' is-sheet' : ''}`} style={sheet ? undefined : { marginLeft: menuOffset }}>
      <div className={`model-menu${sheet ? ' is-sheet' : ''}`} role="dialog" aria-modal="true" tabIndex={-1} aria-label={view === 'connections' ? 'Connect a plan' : view === 'usage' ? 'Connection details' : 'Choose a model'}>
        {view === 'usage' || view === 'connections' ? <>
          <div className="mm-sheet-head"><button type="button" className="mm-back" aria-label="Back to models" onClick={back}><ChevronLeft size={18} aria-hidden /><span>Back to models</span></button></div>
          {view === 'usage' ? <ModelUsageDetails onClose={onClose} /> : <div className="usage-mode__panel">
            <PlanConnections onClose={onClose} />
            <button type="button" onClick={() => { onClose(); useConfigUI.getState().openAppSettings('keys'); }}>Manage API keys</button>
          </div>}
        </> : inlineEffort && view === 'effort' ? (
          <>
            <div className="mm-sheet-head"><button type="button" className="mm-back" aria-label="Back to models" onClick={back}><ChevronLeft size={18} strokeWidth={1.75} /><ProviderMark provider={target?.author} /><span>{target?.short} · Effort</span></button></div>
            {effortList}
          </>
        ) : (
          <>
            <label className="mm-search">
              <Search size={16} strokeWidth={1.75} aria-hidden />
              <input ref={search} type="search" placeholder="Search models" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search models" />
            </label>
            {known && billing === 'plan' && <div className="mm-empty">
              <p><ProviderMark provider={provider} /> {provider === 'codex-cli' ? 'Codex picks the model for each request. Uses your ChatGPT plan. Check plan limits in your ChatGPT account.' : `Uses your ${planLabel(provider, plan)} through Claude Code.`}</p>
              <button type="button" className="link-btn" onClick={() => { onClose(); useConfigUI.getState().openAppSettings('subscriptions'); }}>Models &amp; access</button>
              {provider === 'codex-cli' && <> · <a href="https://chatgpt.com/codex/settings/usage" target="_blank" rel="noreferrer noopener">View ChatGPT plan usage</a></>}
            </div>}
            {loading ? <div className="mm-empty" role="status">Loading models...</div> : error || status === 'error' ? <div className="mm-empty" role="status">Models unavailable. <button type="button" className="link-btn" onClick={() => void useModels.getState().load(true)}>Retry</button></div> : q.trim() ? (
              <ul className="mm-list">
                {results.length === 0 && <li className="mm-empty">No models match “{q.trim()}”.</li>}
                {results.map((m) => (
                  <li key={m.id} className={`mm-row${m.id === current?.id ? ' is-selected' : ''}`}>
                    <span className="mm-row__grip" aria-hidden />
                    <button type="button" className="mm-row__main" onClick={() => choose(m)}>
                      <ProviderMark provider={m.author} />
                      <span className="mm-row__name">{fallbackShort(m.id, m.short)}{m.resolvedModel && <small className="mm-row__resolved">{fallbackShort(m.resolvedModel)}</small>}</span>
          <span className="model-billing" title={billing === 'plan' ? `Uses your ${planLabel(provider, plan)}` : 'Uses API billing'}>{billing === 'plan' ? 'Subscription' : 'API'}</span>
          {!m.vision && <span className="mm-row__meta">No images</span>}
                      <span className="mm-row__meta">{m.author}</span>
                    </button>
                    {rowEffort(m)}
                    <button type="button" className={`mm-row__act mm-star${favourites.includes(m.id) ? ' is-on' : ''}`} onClick={() => toggleFav(m.id)} aria-pressed={favourites.includes(m.id)} aria-label={`${favourites.includes(m.id) ? 'Remove from' : 'Add to'} favourites`}>
                      <Star size={14} strokeWidth={1.75} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <ul className="mm-list" aria-label="Favourite models">
                {favs.map((m, i) => modelRow(m, i))}
                {current && !favourites.includes(current.id) && modelRow(current, null)}
                {!favs.length && status === 'ready' && !error && <li className="mm-empty">Search to add favourites.</li>}
              </ul>
            )}
            {!q.trim() && (
              <div className="mm-section">
                {current && effortsFor(current).length > 0 && (
                  <button type="button" aria-label="Effort" className={`mm-item${view === 'effort' ? ' is-open' : ''}`} onClick={e => view === 'effort' ? back() : openEffort(current, e.currentTarget)} aria-expanded={view === 'effort'}>
                    <span>Effort</span>
                    <span className={`mm-item__value${isTopEffort(currentEffort, current) ? ' is-ultracode' : ''}`}>{currentEffort ? effortLabel(currentEffort, current) : 'Default'}<ChevronRight size={14} strokeWidth={1.75} /></span>
                  </button>
                )}
                {canFast && (
                  <div className="mm-item">
                    <span className="mm-item__text">Fast <span className="mm-item__hint">Fastest providers</span></span>
                    <span className="mm-item__value">
                      {!sheet && <kbd className="mm-kbd is-plain">{shortcutLabel('fast')}</kbd>}
                      <button type="button" role="switch" aria-checked={bot.fast} aria-label="Fast: route to the fastest providers" className={`toggle${bot.fast ? ' is-on' : ''}`} onClick={() => toggleFast(bot)}><span className="toggle__knob" /></button>
                    </span>
                  </div>
                )}
              </div>
            )}
            <div className="mm-section">
              <button ref={connectionsTrigger} type="button" className="mm-item" onClick={() => setView('connections')}>
                <span>Connect plan</span><ChevronRight size={16} aria-hidden />
              </button>
              <button ref={usageTrigger} type="button" className="mm-item" onClick={() => setView('usage')}>
                <span>{usageLabel}</span><ChevronRight size={16} aria-hidden />
              </button>
            </div>
            <div className="mm-foot">
              <button type="button" className="mm-foot__edit" onClick={() => setEditing(!editing)} aria-pressed={editing}>
                <Settings2 size={14} strokeWidth={1.75} aria-hidden />{editing ? 'Done' : 'Edit'}
              </button>
              {!sheet && effortsFor(current).length > 0 && <span className="mm-foot__hint"><kbd className="mm-kbd">{shortcutLabel('effort')}</kbd>Cycle effort</span>}
            </div>
          </>
        )}
      </div>
      {!inlineEffort && view === 'effort' && <div className="mm-flyout"><div className="mm-effort-model"><ProviderMark provider={target?.author} /> {target?.short}</div>{effortList}</div>}
      </div>
    </>
  );
}
