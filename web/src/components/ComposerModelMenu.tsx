import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ArrowUpRight, Check, ChevronDown, ChevronLeft, ChevronRight, GripVertical, Minus, Search, Settings2, Star } from 'lucide-react';
import type { Bot } from '@shared/types';
import { configApi } from '../lib/configApi';
import { defaultEffortFor, effortDescription, effortLabel, isTopEffort, ICON_AUTHORS, effectiveEffort, effortsFor, fallbackShort, modelSelection, useModels, type PickerModel } from '../lib/models';
import { useStore } from '../store';
import { ClaudeMascot } from './ClaudeMascot';
import { ModelUsageDetails } from './ModelUsageDetails';

import { toast } from '../lib/toast';
import { shortcutLabel } from '../lib/shortcuts';
import { nextEffort } from '../lib/effortCycle';

/** OpenRouter's icon for the model's maker (served via our server), or a monogram. */
export function ProviderIcon({ author, size = 16 }: { author: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (author === 'openai') return <svg className="provider-icon" width={size} height={size} viewBox="20 20 88 88" aria-hidden="true"><use href="/assets/providers/openai.svg#mark" /></svg>;
  // Claude models: Claude's own mascot, never the Anthropic logo.
  if (author === 'anthropic') return <span className="provider-icon is-claude" style={{ width: size, height: size }}><ClaudeMascot size={size} /></span>;
  if (ICON_AUTHORS.has(author) && !failed) {
    return <img className="provider-icon" src={`/api/models/icon/${encodeURIComponent(author)}`} width={size} height={size} alt="" onError={() => setFailed(true)} />;
  }
  const hue = [...author].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return <span className="provider-icon is-mono" style={{ width: size, height: size, fontSize: size * 0.62, background: `hsl(${hue} 45% 92%)`, color: `hsl(${hue} 45% 32%)` }} aria-hidden>{(author[0] ?? '?').toUpperCase()}</span>;
}

/** Save a change to the Bot and reflect it at once (the server echoes it over the event stream too). */
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

export function ComposerModelMenu({ bot }: { bot: Bot }) {
  const [open, setOpen] = useState(false);
  const models = useModels();
  const mobile = useStore((s) => s.mobile);
  const accountId = useStore(s => s.user?.id);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => { setOpen(false); trigger.current?.focus({ preventScroll: true }); }, []);
  useLayoutEffect(() => { setOpen(false); }, [accountId, bot.id]);
  useEffect(() => { void models.load(); }, [accountId, models.load]);

  const known = models.status === 'ready' && !models.error && !!models.provider && !!models.billing;
  const planMode = known && models.billing === 'plan';
  const selection = modelSelection(bot, models);
  const current = known ? selection.current : undefined;
  const effort = known ? selection.effort : null;
  const label = models.status === 'loading' || models.status === 'idle' ? 'Loading models…' : models.status === 'error' || models.error ? 'Models unavailable' : !known ? 'Provider default' : current?.short ?? (planMode ? 'CLI default' : bot.model ? fallbackShort(bot.model) : 'Default model');
  const efforts = effortsFor(current);
  const ultra = isTopEffort(effort, current);

  return (
    <span className="model-pill-anchor">
      <button ref={trigger} type="button" className={`model-pill${ultra ? ' is-ultracode' : ''}`} onClick={() => { if (!open) void models.load(true); setOpen(!open); }} aria-haspopup="dialog" aria-expanded={open}
        aria-label={`Model: ${label}${known ? `, ${planMode ? 'Plan' : 'API'} connection` : ''}${efforts.length ? `, ${effort ? effortLabel(effort, current) : 'Default'} effort` : ''}${bot.fast && models.canFast ? ', fast' : ''}. Change`}>
        {current ? <ProviderIcon author={current.author} /> : known && !planMode && bot.model ? <ProviderIcon author={bot.model.split('/')[0]} /> : null}
        <span className="model-pill__name">{label}</span>
        {known && <span className="model-billing">{planMode ? 'Plan' : 'API'}</span>}
        {efforts.length > 0 && <span className="model-pill__effort">{effort ? effortLabel(effort, current) : 'Default'}</span>}
        {bot.fast && models.canFast && <span className="model-pill__fast" title="Fast: fastest providers">⚡︎</span>}
        <ChevronDown size={14} strokeWidth={1.75} aria-hidden className="model-pill__chev" />
      </button>
      {open && <ModelMenu bot={bot} current={current} onClose={close} sheet={mobile} />}
    </span>
  );
}

function ModelMenu({ bot, current, onClose, sheet }: { bot: Bot; current: PickerModel | undefined; onClose: () => void; sheet: boolean }) {
  const { models, byId, favourites, canFast, status, error, setFavourites, provider, billing } = useModels();
  const [q, setQ] = useState('');
  const [view, setView] = useState<'main' | 'effort' | 'usage'>('main');
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
  const known = status === 'ready' && !error && !!provider && !!billing;
  const usageLabel = known ? billing === 'plan' ? 'Plan & usage' : 'API details' : 'Connection details';
  const back = () => {
    const fromUsage = view === 'usage';
    const label = effortTrigger.current?.getAttribute('aria-label');
    setView('main');
    requestAnimationFrame(() => {
      const trigger = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(button => button.getAttribute('aria-label') === label);
      (fromUsage ? usageTrigger.current : trigger ?? search.current)?.focus();
    });
  };
  const openEffort = (model: PickerModel, trigger: HTMLElement) => {
    effortTrigger.current = trigger; setEffortModelId(model.id); setView('effort');
  };
  useLayoutEffect(() => {
    const measure = () => {
      const left = (ref.current?.parentElement?.getBoundingClientRect().left ?? 4) - 4;
      const offset = sheet ? 0 : Math.min(0, innerWidth - 12 - left - 340);
      setMenuOffset(offset);
      setInlineEffort(sheet || left + offset + 588 > innerWidth - 12);
    };
    measure(); window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
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
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (view === 'usage' || (view === 'effort' && inlineEffort)) back(); else onClose(); }
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
  }, [onClose, view]);
  useEffect(() => { (sheet ? ref.current?.querySelector<HTMLElement>('[role=dialog]') : search.current)?.focus({ preventScroll: true }); }, [sheet]);
  useLayoutEffect(() => { if (view === 'usage') ref.current?.querySelector<HTMLElement>('.mm-back')?.focus({ preventScroll: true }); }, [view]);

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
          <ProviderIcon author={m.author} />
          <span className="mm-row__name">{m.short}{m.resolvedModel && <small className="mm-row__resolved">{m.resolvedModel}</small>}</span>
          <span className="model-billing">{billing === 'plan' ? 'Plan' : 'API'}</span>
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
      <div className={`model-menu${sheet ? ' is-sheet' : ''}`} role="dialog" aria-modal="true" tabIndex={-1} aria-label={view === 'usage' ? 'Connection details' : 'Choose a model'}>
        {view === 'usage' ? <>
          <div className="mm-sheet-head"><button type="button" className="mm-back" aria-label="Back to models" onClick={back}><ChevronLeft size={18} aria-hidden /><span>Back to models</span></button></div>
          <ModelUsageDetails onClose={onClose} />
        </> : inlineEffort && view === 'effort' ? (
          <>
            <div className="mm-sheet-head"><button type="button" className="mm-back" aria-label="Back to models" onClick={back}><ChevronLeft size={18} strokeWidth={1.75} /><span>{target?.short} · Effort</span></button></div>
            {effortList}
          </>
        ) : (
          <>
            <label className="mm-search">
              <Search size={16} strokeWidth={1.75} aria-hidden />
              <input ref={search} type="search" placeholder="Search models" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search models" />
            </label>
            {q.trim() ? (
              <ul className="mm-list">
                {results.length === 0 && <li className="mm-empty">No models match “{q.trim()}”.</li>}
                {results.map((m) => (
                  <li key={m.id} className={`mm-row${m.id === current?.id ? ' is-selected' : ''}`}>
                    <span className="mm-row__grip" aria-hidden />
                    <button type="button" className="mm-row__main" onClick={() => choose(m)}>
                      <ProviderIcon author={m.author} />
                      <span className="mm-row__name">{m.short}{m.resolvedModel && <small className="mm-row__resolved">{m.resolvedModel}</small>}</span>
          <span className="model-billing">{billing === 'plan' ? 'Plan' : 'API'}</span>
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
                {status === 'loading' && !favs.length && <li className="mm-empty">Loading models…</li>}
                {status !== 'loading' && error && !favs.length && <li className="mm-empty">Couldn’t load models: {error}</li>}
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
      {!inlineEffort && view === 'effort' && <div className="mm-flyout"><div className="mm-effort-model">{target?.short}</div>{effortList}</div>}
      </div>
    </>
  );
}
