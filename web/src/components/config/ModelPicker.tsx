import { useEffect, useMemo, useRef, useState } from 'react';
import { configApi, type ModelInfo } from '../../lib/configApi';

/** Models for the active provider, fetched once per page load (and again after `refreshModels`). */
let cache: Promise<{ provider: 'xai' | 'openrouter'; models: ModelInfo[]; error?: string }> | null = null;
export const refreshModels = () => { cache = null; };
const loadModels = () => (cache ??= configApi.models().catch((e) => ({ provider: 'xai' as const, models: [], error: (e as Error).message })));

const price = (m: ModelInfo) => {
  if (!m.price) return '';
  const f = (n: number) => (n === 0 ? 'free' : n < 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(n < 10 ? 1 : 0)}`);
  return m.price.input === 0 && m.price.output === 0 ? 'Free' : `${f(m.price.input)} in · ${f(m.price.output)} out / 1M tokens`;
};

/**
 * Searchable model picker. `value` null means "use the default" (when `defaultLabel` is given).
 * Models that can't see images get a warning: Bots need screenshots for browser work.
 */
export function ModelPicker({ value, onChange, defaultLabel, disabled, label = 'Model' }: {
  value: string | null;
  onChange: (id: string | null) => void;
  defaultLabel?: string;
  disabled?: boolean;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [data, setData] = useState<{ models: ModelInfo[]; error?: string } | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => { let alive = true; loadModels().then((d) => { if (alive) setData(d); }); return () => { alive = false; }; }, []);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
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

  const pick = (id: string | null) => { onChange(id); setOpen(false); setQuery(''); };

  return (
    <div className="model-picker" ref={box}>
      <button type="button" className="model-picker__button text-input" disabled={disabled} onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open} aria-label={label}>
        <span className="model-picker__current">
          {value ? (selected?.name ?? value) : defaultLabel ? `Default · ${defaultLabel}` : 'Choose a model'}
        </span>
        {value && <span className="model-picker__id">{value}</span>}
        {selected && !selected.vision && <span className="cfg-chip cfg-chip--warn">No images</span>}
      </button>
      {open && (
        <div className="model-picker__pop" role="listbox" aria-label={`${label} options`}>
          <input className="text-input model-picker__search" autoFocus placeholder={`Search ${models.length} models…`} value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search models" />
          <div className="model-picker__list">
            {defaultLabel && !query && (
              <button type="button" role="option" aria-selected={value === null} className={`model-picker__row${value === null ? ' is-selected' : ''}`} onClick={() => pick(null)}>
                <span className="model-picker__name">Default</span>
                <span className="model-picker__meta">{defaultLabel} · set in Settings → API keys</span>
              </button>
            )}
            {data?.error && <div className="model-picker__empty">{data.error}</div>}
            {!data && <div className="model-picker__empty">Loading models…</div>}
            {data && !shown.length && <div className="model-picker__empty">{models.length ? 'No match.' : 'Add a model key in Settings → API keys first.'}</div>}
            {shown.map((m) => (
              <button type="button" role="option" aria-selected={m.id === value} key={m.id} className={`model-picker__row${m.id === value ? ' is-selected' : ''}`} onClick={() => pick(m.id)}>
                <span className="model-picker__name">{m.name}{!m.vision && <span className="cfg-chip cfg-chip--warn">No images</span>}</span>
                <span className="model-picker__meta">{m.id}{price(m) ? ` · ${price(m)}` : ''}</span>
              </button>
            ))}
          </div>
          <div className="model-picker__foot">Models marked “No images” can’t see screenshots, so browser work won’t go well with them.</div>
        </div>
      )}
    </div>
  );
}
