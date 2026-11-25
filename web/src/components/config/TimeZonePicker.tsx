import { useId, useMemo, useRef, useState } from 'react';
import type { TimeZoneOption } from './settingsLogic';

/** Searchable listbox with explicit selection so typing never saves a partial zone. */
export function TimeZonePicker({ value, options, disabled, onChange }: {
  value: string; options: TimeZoneOption[]; disabled: boolean; onChange: (value: string) => void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const matches = useMemo(() => options.filter(option => `${option.label} ${option.value}`.toLowerCase().includes(query.trim().toLowerCase().replaceAll('_', ' '))
    || option.value.toLowerCase().includes(query.trim().toLowerCase())), [options, query]);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  const choose = (zone: string) => { close(); onChange(zone); };
  const move = (index: number) => {
    setActive(index);
    document.getElementById(`${id}-${index}`)?.scrollIntoView({ block: 'nearest' });
  };
  return <div className="settings-timezone" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <button ref={trigger} type="button" className="text-input settings-timezone__trigger" aria-label="Time zone" aria-describedby={`${id}-value`} aria-haspopup="listbox" aria-expanded={open} disabled={disabled}
      onClick={() => { setOpen(!open); setQuery(''); setActive(0); }}>
      <span id={`${id}-value`}>{value ? options.find(option => option.value === value)?.label ?? value : 'Not set (using UTC)'}</span>
    </button>
    {open && <div className="settings-timezone__panel">
      <input autoFocus type="search" className="text-input" role="combobox" aria-label="Search time zones" placeholder="Search city or time zone" aria-autocomplete="list"
        aria-expanded="true" aria-controls={id} aria-activedescendant={matches[active] ? `${id}-${active}` : undefined}
        value={query} onChange={event => { setQuery(event.target.value); setActive(0); }} onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
          if (event.key === 'Enter') { event.preventDefault(); if (matches[active]) choose(matches[active].value); }
          if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && matches.length) {
            event.preventDefault();
            move(event.key === 'Home' ? 0 : event.key === 'End' ? matches.length - 1 : (active + (event.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
          }
        }} />
      <ul id={id} role="listbox" aria-label="Time zones" className="settings-timezone__options">
        {matches.map((option, index) => <li key={option.value} id={`${id}-${index}`} role="option" aria-selected={option.value === value}
          className={index === active ? 'is-active' : undefined} onMouseDown={event => event.preventDefault()} onClick={() => choose(option.value)}>
          {option.label}
        </li>)}
      </ul>
      {!matches.length && <p role="status">No time zones match. Try a city or IANA time zone.</p>}
    </div>}
  </div>;
}
