import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ArrowUpRight, Check, ChevronDown, ChevronLeft, ChevronRight, GripVertical, Minus, Search, Settings2, Star } from 'lucide-react';
import type { Bot, Effort } from '@shared/types';
import { configApi } from '../lib/configApi';
import { EFFORT_DESC, EFFORT_LABEL, ICON_AUTHORS, effectiveEffort, effortsFor, fallbackShort, useModels, type PickerModel } from '../lib/models';
import { useStore } from '../store';
import { ClaudeMascot } from './ClaudeMascot';

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = IS_MAC ? '⌘' : 'Ctrl+';

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

/** Next effort in the cycle (strongest → weakest → strongest), skipping "No thinking". */
export function cycleEffort(bot: Bot, m: PickerModel | undefined) {
  const list: Effort[] = effortsFor(m).filter((e) => e !== 'none');
  if (!list.length) return;
  const cur = list.indexOf(effectiveEffort(bot.effort, m));
  void patchBot(bot, { effort: list[(cur + 1) % list.length] });
}
export const toggleFast = (bot: Bot) => void patchBot(bot, { fast: !bot.fast });

export function ComposerModelMenu({ bot }: { bot: Bot }) {
  const [open, setOpen] = useState(false);
  const models = useModels();
  const mobile = useStore((s) => s.mobile);
  useEffect(() => { void models.load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const planMode = models.billing === 'plan';
  const effectiveId = !planMode && (!bot.model || /^(claude|codex)\//.test(bot.model)) ? models.defaultModel : bot.model;
  const current = effectiveId ? models.byId.get(effectiveId) : undefined;
  const label = models.status === 'loading' ? 'Loading models…' : models.status === 'error' ? 'Models unavailable' : current?.short ?? (planMode ? 'CLI default' : effectiveId ? fallbackShort(effectiveId) : 'Default model');
  const effort = effectiveEffort(bot.effort, current);
  const efforts = effortsFor(current);
  const ultra = !planMode && bot.effort === 'ultracode';

  return (
    <span className="model-pill-anchor">
      <button type="button" className={`model-pill${ultra ? ' is-ultracode' : ''}`} onClick={() => { if (!open) void models.load(true); setOpen(!open); }} aria-haspopup="dialog" aria-expanded={open}
        aria-label={`Model: ${label}${models.billing ? `, ${planMode ? 'Plan' : 'API'} connection` : ''}${efforts.length ? `, ${EFFORT_LABEL[effort]} effort` : ''}${bot.fast && models.canFast ? ', fast' : ''}. Change`}>
        {current ? <ProviderIcon author={current.author} /> : !planMode && bot.model ? <ProviderIcon author={bot.model.split('/')[0]} /> : null}
        <span className="model-pill__name">{label}</span>
        {models.billing && <span className="model-billing">{planMode ? 'Plan' : 'API'}</span>}
        {efforts.length > 0 && <span className="model-pill__effort">{EFFORT_LABEL[effort]}</span>}
        {bot.fast && models.canFast && <span className="model-pill__fast" title="Fast: fastest providers">⚡︎</span>}
        <ChevronDown size={14} strokeWidth={1.75} aria-hidden className="model-pill__chev" />
      </button>
      {open && <ModelMenu bot={bot} current={current} onClose={() => setOpen(false)} sheet={mobile} />}
    </span>
  );
}

function ModelMenu({ bot, current, onClose, sheet }: { bot: Bot; current: PickerModel | undefined; onClose: () => void; sheet: boolean }) {
  const { models, byId, favourites, canFast, status, error, setFavourites, provider, billing, plan, usage } = useModels();
  const [q, setQ] = useState('');
  const [view, setView] = useState<'main' | 'effort'>('main');
  const [editing, setEditing] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  // Close on outside press / Escape (Escape steps back from the effort list first).
  useEffect(() => {
    const down = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as Element).closest?.('.model-pill')) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); if (view === 'effort') setView('main'); else onClose(); } };
    const t = setTimeout(() => document.addEventListener('pointerdown', down));
    document.addEventListener('keydown', key, true);
    return () => { clearTimeout(t); document.removeEventListener('pointerdown', down); document.removeEventListener('keydown', key, true); };
  }, [onClose, view]);
  useEffect(() => { if (!sheet) search.current?.focus({ preventScroll: true }); }, [sheet]);

  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return models.filter((m) => m.short.toLowerCase().includes(s) || m.name.toLowerCase().includes(s) || m.id.includes(s)).slice(0, 40);
  }, [q, models]);

  const favs = favourites.map((id) => byId.get(id)).filter(Boolean) as PickerModel[];
  const efforts = effortsFor(current);
  const effort = effectiveEffort(bot.effort, current);

  const choose = (m: PickerModel) => {
    // Keep the effort the user picked when the new model accepts it; else the server snaps it.
    void patchBot(bot, { model: m.id, ...(m.billing === 'plan' ? { effort: effectiveEffort(bot.effort, m), fast: false } : {}) });
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
    <ul className="mm-efforts" role="listbox" aria-label="Effort">
      {efforts.map((e) => (
        <li key={e}>
          <button type="button" role="option" aria-selected={e === effort} className={`mm-effort${e === 'ultracode' ? ' is-ultracode' : ''}${e === effort ? ' is-selected' : ''}`}
            onClick={() => { void patchBot(bot, { effort: e }); onClose(); }}>
            <span className="mm-effort__text"><span className="mm-effort__label">{EFFORT_LABEL[e]}</span><span className="mm-effort__desc">{e === current?.defaultEffort ? 'The model’s default' : EFFORT_DESC[e]}</span></span>
            {e === effort && <Check size={16} strokeWidth={2} aria-hidden />}
          </button>
        </li>
      ))}
    </ul>
  );

  return (
    <>
      {sheet && <div className="mm-scrim" aria-hidden onClick={onClose} />}
      <div ref={ref} className={`mm-wrap${sheet ? ' is-sheet' : ''}`}>
      <div className={`model-menu${sheet ? ' is-sheet' : ''}`} role="dialog" aria-label="Choose a model">
        {sheet && view === 'effort' ? (
          <>
            <div className="mm-sheet-head"><button type="button" className="mm-back" onClick={() => setView('main')}><ChevronLeft size={18} strokeWidth={1.75} /> Effort</button></div>
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
                  <li key={m.id} className={`mm-row${m.id === bot.model ? ' is-selected' : ''}`}>
                    <span className="mm-row__grip" aria-hidden />
                    <button type="button" className="mm-row__main" onClick={() => choose(m)}>
                      <ProviderIcon author={m.author} />
                      <span className="mm-row__name">{m.short}{m.resolvedModel && <small className="mm-row__resolved">{m.resolvedModel}</small>}</span>
          <span className="model-billing">{billing === 'plan' ? 'Plan' : 'API'}</span>
          {!m.vision && <span className="mm-row__meta">No images</span>}
                      <span className="mm-row__meta">{m.author}</span>
                    </button>
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
                {efforts.length > 0 && (
                  <button type="button" className={`mm-item${view === 'effort' ? ' is-open' : ''}`} onClick={() => setView(view === 'effort' ? 'main' : 'effort')} aria-expanded={view === 'effort'}>
                    <span>Effort</span>
                    <span className={`mm-item__value${effort === 'ultracode' ? ' is-ultracode' : ''}`}>{EFFORT_LABEL[effort]}<ChevronRight size={14} strokeWidth={1.75} /></span>
                  </button>
                )}
                {canFast && (
                  <div className="mm-item">
                    <span className="mm-item__text">Fast <span className="mm-item__hint">Fastest providers</span></span>
                    <span className="mm-item__value">
                      {!sheet && <kbd className="mm-kbd is-plain">{MOD}⇧F</kbd>}
                      <button type="button" role="switch" aria-checked={bot.fast} aria-label="Fast: route to the fastest providers" className={`toggle${bot.fast ? ' is-on' : ''}`} onClick={() => toggleFast(bot)}><span className="toggle__knob" /></button>
                    </span>
                  </div>
                )}
              </div>
            )}
            {billing === 'plan' && <div className="mm-plan-usage" aria-label="Plan usage">
              <strong>{plan ? `${plan} plan` : 'Connected plan'}</strong>
              {usage?.available ? usage.windows.map((w, i) => <div key={i}>
                <span>{w.label}: {w.usedPercent}% used</span>
                {w.resetsAt !== null && <small>Resets {new Date(w.resetsAt).toLocaleString()}</small>}
              </div>) : <div>Plan usage unavailable from the CLI.</div>}
              {usage && <small>Checked {new Date(usage.checkedAt).toLocaleTimeString()}. Provider limits apply across your account.</small>}
            </div>}
            <div className="mm-foot">
              <button type="button" className="mm-foot__edit" onClick={() => setEditing(!editing)} aria-pressed={editing}>
                <Settings2 size={14} strokeWidth={1.75} aria-hidden />{editing ? 'Done' : 'Edit'}
              </button>
              {!sheet && efforts.length > 0 && <span className="mm-foot__hint"><kbd className="mm-kbd">{MOD}⇧/</kbd>Cycle effort</span>}
            </div>
          </>
        )}
      </div>
      {!sheet && view === 'effort' && <div className="mm-flyout">{effortList}</div>}
      </div>
    </>
  );
}
