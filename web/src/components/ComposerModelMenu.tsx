import { planLabel } from '../lib/planLabel';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Check, ChevronDown, ChevronLeft, ChevronRight, GripVertical, Search, Settings2, Star, X } from 'lucide-react';
import type { Bot } from '@shared/types';
import { configApi } from '../lib/configApi';
import { effortLabel, isTopEffort, effectiveEffort, effortsFor, fallbackShort, modelSelection, useModels, type PickerModel } from '../lib/models';
import { useStore } from '../store';
import { LabelWords, ProviderMark } from './ProviderMark';
import { providerBrand } from '../lib/providerBrand';
import { ModelUsageDetails } from './ModelUsageDetails';
import { PlanConnections } from './PlanConnections';
import { useConfigUI } from '../configStore';

import { toast } from '../lib/toast';
import { nextEffort } from '../lib/effortCycle';
import { lastModelLabel, rememberModelLabel } from '../lib/modelMemory';
import { useComposerLabel } from '../lib/useComposerLabel';
import { planMenuLabel } from '../lib/planConnections';
import { getCachedCliStatus, subscribeCliStatus } from '../lib/cliApi';
import { composerLabelSteps, composerModelLabel } from '../lib/composerModelLabel';


const isPhone = () => window.matchMedia('(max-width: 480px)').matches;
const subscribePhone = (changed: () => void) => {
  const media = window.matchMedia('(max-width: 480px)');
  media.addEventListener('change', changed);
  return () => media.removeEventListener('change', changed);
};

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
  const sheet = useSyncExternalStore(subscribePhone, isPhone, () => false);
  const detailsOpen = useStore((s) => s.detailsOpen);
  const accountId = useStore(s => s.user?.id);
  const trigger = useRef<HTMLButtonElement>(null);
  const historyClose = useRef<((afterClose?: () => void) => void) | null>(null);
  const close = useCallback((afterClose?: () => void) => {
    if (historyClose.current) { historyClose.current(afterClose); return; }
    setOpen(false); trigger.current?.focus({ preventScroll: true }); afterClose?.();
  }, []);
  useEffect(() => {
    if (!open || !sheet) return;
    const url = location.href;
    const marker = `model-picker-${Date.now()}`;
    let after: (() => void) | undefined;
    let closing = false;
    history.pushState({ ...history.state, swarmModelPicker: marker }, '', url);
    const pop = () => {
      historyClose.current = null;
      setOpen(false); trigger.current?.focus({ preventScroll: true });
      after?.();
    };
    historyClose.current = callback => {
      if (closing) return;
      closing = true; after = callback;
      if (history.state?.swarmModelPicker === marker && location.href === url) history.back();
      else pop();
    };
    window.addEventListener('popstate', pop);
    return () => {
      window.removeEventListener('popstate', pop); historyClose.current = null;
      if (history.state?.swarmModelPicker === marker && location.href === url) history.back();
    };
  }, [open, sheet]);
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
  const efforts = effortsFor(current);
  const ultra = isTopEffort(effort, current);
  const markProvider = providerBrand(current?.author) ?? current?.id ?? (known && planMode ? models.provider : loading ? providerBrand(label) ?? bot.model : bot.model);
  const hasMark = !!(providerBrand(markProvider) ?? providerBrand(known ? models.provider : null));
  const fullEffort = efforts.length ? effort ? effortLabel(effort, current) : 'Default' : '';
  const shown = useComposerLabel(trigger, composerLabelSteps(label, known ? models.provider : null, planMode, models.plan, fullEffort, hasMark));

  return (
    <span className="model-pill-anchor">
      <button ref={trigger} type="button" className={`model-pill${ultra ? ' is-ultracode' : ''}${shown.compact ? ' is-compact' : ''}`} onClick={() => { if (open) close(); else { if (!loading) void models.load(true); setOpen(true); } }} aria-haspopup="dialog" aria-expanded={open} aria-busy={loading}
        title={`${rememberedLabel}${known ? `. ${billingDescription}` : ''}${fullEffort ? `. ${fullEffort} effort` : ''}`}
        aria-label={`Model: ${label}${known ? `, ${billingDescription}` : ''}${efforts.length ? `, ${effort ? effortLabel(effort, current) : 'Default'} effort` : ''}${bot.fast && models.canFast ? ', fast' : ''}. Change`}>
        <span className="model-pill__provider" aria-hidden>
          <ProviderMark provider={markProvider} fallbackProvider={known ? models.provider : undefined} reserve />
        </span>
        <span className="model-pill__name">{shown.name}</span>
        {known && shown.billing && <span className="model-billing" title={billingDescription}>{shown.billing}</span>}
        {fullEffort && <span className="model-pill__effort">{shown.effort}</span>}
        {bot.fast && models.canFast && <span className="model-pill__fast" title="Fast: fastest providers">⚡︎</span>}
        <ChevronDown size={14} strokeWidth={1.75} aria-hidden className="model-pill__chev" />
      </button>
      {open && <ModelMenu bot={bot} current={current} onClose={close} sheet={sheet} />}
    </span>
  );
});

function ModelMenu({ bot, current, onClose, sheet }: { bot: Bot; current: PickerModel | undefined; onClose: (afterClose?: () => void) => void; sheet: boolean }) {
  const { models, byId, favourites, canFast, status, error, setFavourites, provider, billing } = useModels();
  // Use the existing account snapshot without starting a provider status probe.
  const plansLabel = planMenuLabel(useSyncExternalStore(subscribeCliStatus, getCachedCliStatus, getCachedCliStatus));
  const [q, setQ] = useState('');
  const [view, setView] = useState<'main' | 'usage' | 'connections'>('main');
  const [editing, setEditing] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const usageTrigger = useRef<HTMLButtonElement>(null);
  const connectionsTrigger = useRef<HTMLButtonElement>(null);
  const loading = status === 'idle' || status === 'loading';
  const back = () => {
    const previous = view;
    setView('main');
    requestAnimationFrame(() => (previous === 'connections' ? connectionsTrigger.current : usageTrigger.current)?.focus());
  };
  useLayoutEffect(() => {
    const anchor = ref.current?.parentElement;
    const chat = anchor?.closest('.chat');
    const composer = anchor?.closest('.composer');
    const measure = () => {
      const anchorBox = anchor?.getBoundingClientRect();
      const composerTop = composer?.getBoundingClientRect().top ?? anchorBox?.top ?? innerHeight;
      const viewport = window.visualViewport;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportBottom = viewportTop + (viewport?.height ?? innerHeight);
      const menuBottom = sheet ? viewportBottom : Math.min(composerTop - 10, viewportBottom - 12);
      ref.current?.style.setProperty('--mm-available-height', `${Math.max(0, menuBottom - viewportTop - 12)}px`);
      ref.current?.style.setProperty('--mm-bottom', `${innerHeight - menuBottom}px`);
      const left = (anchorBox?.left ?? 4) - 4;
      const right = Math.min(innerWidth, chat?.getBoundingClientRect().right ?? innerWidth) - 12;
      ref.current?.style.setProperty('--mm-left', `${Math.max(12, Math.min(left, right - 340))}px`);
    };
    const observer = new ResizeObserver(measure);
    if (chat) observer.observe(chat);
    if (anchor) observer.observe(anchor);
    if (composer) observer.observe(composer);
    measure(); window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    window.visualViewport?.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('scroll', measure);
    return () => {
      observer.disconnect(); window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
      window.visualViewport?.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('scroll', measure);
    };
  }, [sheet]);

  useEffect(() => {
    const down = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as Element).closest?.('.model-pill')) onClose(); };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
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
  }, [onClose]);
  useEffect(() => { (sheet ? ref.current?.querySelector<HTMLElement>('[role=dialog]') : search.current)?.focus({ preventScroll: true }); }, [sheet]);
  useLayoutEffect(() => { if (view !== 'main') ref.current?.querySelector<HTMLElement>('.mm-back')?.focus({ preventScroll: true }); }, [view]);

  const favs = favourites.map(id => byId.get(id)).filter(Boolean) as PickerModel[];
  const visibleModels = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (query) return models.filter(m => `${fallbackShort(m.id, m.short)} ${m.name} ${m.id}`.toLowerCase().includes(query)).slice(0, 40);
    const list = [...favs];
    if (current && !list.some(m => m.id === current.id)) list.push(current);
    return list.length ? list : models.slice(0, 12);
  }, [q, models, favourites, current]);
  const efforts = [...effortsFor(current)].reverse();
  const effort = modelSelection(bot, useModels.getState()).effort;
  const choose = (m: PickerModel) => {
    void patchBot(bot, { model: m.id, effort: effectiveEffort(bot.effort, m), ...(m.billing === 'plan' ? { fast: false } : {}) });
    onClose();
  };
  const toggleFav = (id: string) => setFavourites(favourites.includes(id) ? favourites.filter(x => x !== id) : [...favourites, id]);
  const move = (from: number, to: number) => {
    if (to < 0 || to >= favourites.length || from === to) return;
    const ids = [...favourites];
    const [id] = ids.splice(from, 1); ids.splice(to, 0, id);
    void setFavourites(ids);
  };
  const rowKeys = (i: number) => (e: ReactKeyboardEvent) => {
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); move(i, i + (e.key === 'ArrowUp' ? -1 : 1)); }
  };
  const modelRow = (m: PickerModel) => {
    const selected = m.id === current?.id;
    const i = favourites.indexOf(m.id);
    const source = m.billing ?? billing;
    return <li key={m.id} className={`mm-row${selected ? ' is-selected' : ''}${drag === i ? ' is-dragging' : ''}`}
      draggable={editing && i >= 0 && !sheet} onDragStart={() => setDrag(i)} onDragEnd={() => setDrag(null)}
      onDragOver={e => { if (drag !== null && i >= 0) { e.preventDefault(); if (drag !== i) { move(drag, i); setDrag(i); } } }}>
      {editing && i >= 0 && <GripVertical size={14} className="mm-row__grip" aria-hidden />}
      <button type="button" className="mm-row__main" onClick={() => choose(m)} onKeyDown={i >= 0 ? rowKeys(i) : undefined} aria-current={selected || undefined}>
        <ProviderMark provider={providerBrand(m.author) ?? m.id} fallbackProvider={provider} />
        <span className="mm-row__text">
          <span className="mm-row__title"><span className="mm-row__name"><LabelWords>{fallbackShort(m.id, m.short)}</LabelWords></span><span className="model-billing">{source === 'plan' ? 'Plan' : 'API'}</span></span>
          {m.resolvedModel ? <small className="mm-row__resolved"><LabelWords>{fallbackShort(m.resolvedModel)}</LabelWords></small> : !m.vision && <small className="mm-row__resolved">Text only</small>}
        </span>
        {selected && <Check size={16} className="mm-row__check" aria-label="Selected" />}
      </button>
      {(editing || q.trim()) && <button type="button" className={`mm-row__act mm-star${i >= 0 ? ' is-on' : ''}`} onClick={() => toggleFav(m.id)} aria-pressed={i >= 0} aria-label={`${i >= 0 ? 'Remove from' : 'Add to'} favourites`}><Star size={14} /></button>}
    </li>;
  };

  return <>
    {sheet && <div className="mm-scrim" aria-hidden onClick={() => onClose()} />}
    <div ref={ref} className={`mm-wrap${sheet ? ' is-sheet' : ''}`}>
      <div className={`model-menu${sheet ? ' is-sheet' : ''}`} role="dialog" aria-modal="true" tabIndex={-1} aria-label={view === 'connections' ? plansLabel : view === 'usage' ? 'Connection details' : 'Model and effort'}>
        {sheet && <div className="mm-grabber" aria-hidden />}
        {(sheet || view !== 'main') && <div className="mm-sheet-head">
          {view !== 'main' ? <button type="button" className="mm-back" onClick={back}><ChevronLeft size={18} aria-hidden /><span>Back to models</span></button> : <h2>Model and effort</h2>}
          <button type="button" className="mm-close" aria-label="Close model picker" onClick={() => onClose()}><X size={18} aria-hidden /></button>
        </div>}
        {view === 'usage' ? <ModelUsageDetails onClose={onClose} /> : view === 'connections' ? <div className="usage-mode__panel"><PlanConnections onClose={onClose} /></div> : <>
          <label className="mm-search"><Search size={16} aria-hidden /><input ref={search} type="search" placeholder="Search models" value={q} onChange={e => setQ(e.target.value)} aria-label="Search models" />
            {!sheet && <button type="button" className="mm-close" aria-label="Close model picker" onClick={() => onClose()}><X size={16} aria-hidden /></button>}
          </label>
          {loading ? <div className="mm-empty" role="status">Loading models</div> : error || status === 'error' ? <div className="mm-empty" role="status">Unavailable <button type="button" className="link-btn" onClick={() => void useModels.getState().load(true)}>Retry</button></div> : <>
            {(['plan', 'api'] as const).map(source => <section className="mm-group" key={source} aria-label={source === 'plan' ? 'Your plans' : 'API billing'}>
              <div className="mm-group__head"><h3>{source === 'plan' ? 'Your plans' : 'API billing'}</h3></div>
              <ul className="mm-list">{visibleModels.filter(m => (m.billing ?? billing) === source).map(modelRow)}
                {!q.trim() && !models.length && billing === 'plan' && source === 'plan' && <li className="mm-row is-selected"><span className="mm-row__main"><ProviderMark provider={provider} /><span className="mm-row__name">{provider === 'codex-cli' ? 'Codex' : 'Claude'}</span><span className="model-billing">Plan</span></span></li>}
              </ul>
              {!q.trim() && (source === 'plan' ? <button ref={connectionsTrigger} type="button" className="mm-item" onClick={() => setView('connections')}><span>{plansLabel}</span><ChevronRight size={16} aria-hidden /></button>
                : <button type="button" className="mm-item" onClick={() => onClose(() => useConfigUI.getState().openAppSettings('keys'))}><span>Manage API keys</span><ChevronRight size={16} aria-hidden /></button>)}
            </section>)}
            {q.trim() && !visibleModels.length && <div className="mm-empty">No models found</div>}
          </>}
          {!q.trim() && current && efforts.length > 0 && <div className="mm-section mm-effort-section">
            <h3>Effort</h3>
            <div className="mm-efforts" role="radiogroup" aria-label="Effort" onKeyDown={event => {
              if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
              const index = options.indexOf(document.activeElement as HTMLButtonElement);
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : options.length - 1)) % options.length;
              options[next]?.focus(); options[next]?.click();
            }}>
              {efforts.map(level => <button key={level} type="button" role="radio" aria-checked={level === effort} tabIndex={level === effort ? 0 : -1}
                className={`mm-effort${level === effort ? ' is-selected' : ''}${isTopEffort(level, current) ? ' is-ultracode' : ''}`}
                onClick={() => void patchBot(bot, { model: current.id, effort: level, ...(current.billing === 'plan' ? { fast: false } : {}) })}>
                <span className="mm-effort__label">{effortLabel(level, current)}</span>
              </button>)}
            </div>
          </div>}
          {canFast && <div className="mm-item"><span>Fast</span><button type="button" role="switch" aria-checked={bot.fast} aria-label="Fast: route to the fastest providers" className={`toggle${bot.fast ? ' is-on' : ''}`} onClick={() => toggleFast(bot)}><span className="toggle__knob" /></button></div>}
          <div className="mm-foot">
            <button ref={usageTrigger} type="button" className="mm-foot__edit" onClick={() => setView('usage')}>Usage</button>
            <button type="button" className="mm-foot__edit" onClick={() => setEditing(!editing)} aria-pressed={editing} aria-label={editing ? 'Done editing favourites' : 'Edit favourites'} title={editing ? 'Done editing favourites' : 'Edit favourites'}><Settings2 size={14} aria-hidden />{editing && 'Done'}</button>
          </div>
        </>}
      </div>
    </div>
  </>;
}
