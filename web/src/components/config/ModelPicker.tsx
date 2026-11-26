import { ProviderMark } from '../ProviderMark';
import { useStore } from '../../store';
import { useModels } from '../../lib/models';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { configApi, type ModelInfo } from '../../lib/configApi';
import { modelDisplayName } from '../../lib/modelDisplay';

type Provider = 'direct' | 'openrouter';
type ModelCatalog = { models: ModelInfo[]; error?: string; billing?: 'api' | 'plan' };
/** Share the latest request for labels, but always refresh when opening a picker. */
const cache = new Map<string, Promise<ModelCatalog>>();
export const refreshModels = () => { cache.clear(); void useModels.getState().load(true); };
const loadModels = (provider?: Provider, force = false) => {
  const k = `${useStore.getState().user?.id ?? 'anonymous'}:${provider ?? 'active'}`;
  if (force || !cache.has(k)) cache.set(k, (provider ? configApi.models(provider).then(d => ({ ...d, billing: 'api' as const })) : fetch('/api/models', { credentials: 'include' }).then(async r => { if (!r.ok) throw new Error('Could not load models.'); return r.json(); })).catch((e: Error) => ({ models: [], error: e.message })));
  return cache.get(k)!;
};
useStore.subscribe((state, previous) => {
  if (state.user?.id !== previous.user?.id) cache.clear();
});

const price = (m: ModelInfo) => {
  if (!m.price) return '';
  const f = (n: number) => (n === 0 ? 'free' : n < 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(n < 10 ? 1 : 0)}`);
  return m.price.input === 0 && m.price.output === 0 ? 'Free' : `${f(m.price.input)} in · ${f(m.price.output)} out / 1M tokens`;
};

/**
 * Searchable model picker. `value` null means "use the default" (when `defaultLabel` is given).
 * Models that can't see images get a warning: Bots need screenshots for browser work.
 */
export function ModelPicker({ value, onChange, defaultLabel, disabled, label = 'Model', provider }: {
  value: string | null;
  onChange: (id: string | null) => void;
  defaultLabel?: string;
  disabled?: boolean;
  label?: string;
  /** List this provider's models instead of the active provider's. */
  provider?: Provider;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [attempt, setAttempt] = useState(0);
  const panelId = useId();
  const userId = useStore(s => s.user?.id);
  const [loaded, setLoaded] = useState<{ userId?: string; provider?: Provider; data: ModelCatalog } | null>(null);
  const data = loaded && loaded.userId === userId && loaded.provider === provider ? loaded.data : null;
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let alive = true;
    setLoaded(null);
    loadModels(provider, open).then(data => { if (alive) setLoaded({ userId, provider, data }); });
    return () => { alive = false; };
  }, [provider, userId, open, attempt]);
  useEffect(() => { setOpen(false); setQuery(''); }, [userId, provider]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && box.current?.contains(e.target as Node)) { e.stopPropagation(); setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey, true); };
  }, [open]);

  const models = data?.models ?? [];
  const selected = value ? models.find((m) => m.id === value) : undefined;
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? models.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)) : models;
    return list.slice(0, 200);
  }, [models, query]);

  const pick = (id: string | null) => {
    if (disabled || useStore.getState().user?.id !== userId) return;
    onChange(id); setOpen(false); setQuery(''); trigger.current?.focus();
  };

  return (
    <div className="model-picker" ref={box}>
      <button ref={trigger} type="button" className="model-picker__button text-input" disabled={disabled} onClick={() => { setQuery(''); setOpen((o) => !o); }} aria-controls={open ? panelId : undefined} aria-expanded={open} aria-label={label}>
        <ProviderMark provider={value ?? defaultLabel} /><span className="model-picker__current">
          {value ? modelDisplayName(value, selected?.name) : defaultLabel ? `Default · ${defaultLabel}` : 'Choose a model'}
        </span>
        {data?.billing && <span className="model-billing">{data.billing === 'plan' ? 'Plan' : 'API'}</span>}
        {selected && !selected.vision && <span className="cfg-chip cfg-chip--warn">No images</span>}
      </button>
      {open && (
        <div className="model-picker__pop" id={panelId} onKeyDown={e => {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
          const options = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]')];
          if (!options.length) return;
          e.preventDefault();
          const activeIndex = options.indexOf(document.activeElement as HTMLButtonElement);
          const index = activeIndex < 0 ? e.key === 'ArrowDown' ? 0 : options.length - 1 : (activeIndex + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
          options[index]?.focus();
        }}>
          <input className="text-input model-picker__search" autoFocus placeholder={models.length ? `Search ${models.length} models…` : 'Search models…'} value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search models" />
          {data?.error && <div className="model-picker__empty" role="alert"><span>{data.error}</span> <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setAttempt(value => value + 1)}>Retry</button></div>}
          {!data && <div className="model-picker__empty" role="status">Loading models…</div>}
          {data && !data.error && !shown.length && <div className="model-picker__empty" role="status">{models.length ? 'No matching models.' : data.billing === 'plan' ? 'No models were reported by this CLI connection. Check Models & access.' : 'No models were reported. Check your connection in API keys.'}</div>}
          <div className="model-picker__list" role="listbox" aria-label={`${label} options`}>
            {defaultLabel && !query && (
              <button type="button" role="option" aria-selected={value === null} className={`model-picker__row${value === null ? ' is-selected' : ''}`} onClick={() => pick(null)}>
                <span className="model-picker__name"><ProviderMark provider={defaultLabel} />Default</span>
                <span className="model-picker__meta">{defaultLabel}</span>
              </button>
            )}
            {shown.map((m) => (
              <button type="button" role="option" aria-selected={m.id === value} key={m.id} className={`model-picker__row${m.id === value ? ' is-selected' : ''}`} onClick={() => pick(m.id)}>
                <span className="model-picker__name"><ProviderMark provider={m.id} />{modelDisplayName(m.id, m.name)}{(m.billing ?? data?.billing) && <span className="model-billing">{(m.billing ?? data?.billing) === 'plan' ? 'Plan' : 'API'}</span>}{!m.vision && <span className="cfg-chip cfg-chip--warn">No images</span>}</span>
                {price(m) && <span className="model-picker__meta">{price(m)}</span>}
              </button>
            ))}
          </div>
          <div className="model-picker__foot">Models marked “No images” can’t see screenshots, so browser work won’t go well with them.</div>
        </div>
      )}
    </div>
  );
}
