import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Info } from 'lucide-react';
import { Menu, type MenuItem } from '../Menu';

export function SettingsMenu({ label = 'Manage', ariaLabel, items, disabled }: { label?: string; ariaLabel?: string; items: (MenuItem & { disabled?: boolean })[]; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return <span className="settings-menu">
    <button ref={trigger} type="button" className="cfg-btn cfg-btn--secondary" aria-label={ariaLabel} aria-expanded={open} aria-haspopup="menu" disabled={disabled} onClick={() => setOpen(value => !value)}>{label}</button>
    {open && <Menu items={items.filter(item => !item.disabled)} align="right" triggerRef={trigger} onClose={() => setOpen(false)} />}
  </span>;
}

export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const content = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState({left: 16, top: 16});
  useLayoutEffect(() => {
    if (!open || !anchor.current || !content.current) return;
    const place = () => {
      const target = anchor.current!.getBoundingClientRect();
      const tip = content.current!.getBoundingClientRect();
      setPosition({left: Math.max(16, Math.min(target.left, innerWidth - tip.width - 16)), top: Math.max(16, Math.min(target.bottom, innerHeight - tip.height - 16))});
    };
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);
  return <span ref={anchor} className="settings-info" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); } }}>
    <button type="button" className="settings-info__button" aria-label={label} aria-expanded={open} aria-describedby={open ? id : undefined} onFocus={() => setOpen(true)} onClick={() => setOpen(true)}><Info size={16} aria-hidden /></button>
    {open && <span ref={content} id={id} role="tooltip" className="settings-info__content" style={position}>{children}</span>}
  </span>;
}
