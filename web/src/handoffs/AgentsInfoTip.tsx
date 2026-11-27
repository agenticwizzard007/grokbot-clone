import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Info } from 'lucide-react';

/** Keep the shared Settings tooltip outside the section action's text box. */
export function AgentsInfoTip({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId(), anchor = useRef<HTMLSpanElement>(null), content = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState({ left: 16, top: 16 });
  const container = anchor.current?.closest('.agents-settings');
  useLayoutEffect(() => {
    if (!open || !anchor.current || !content.current) return;
    const place = () => {
      const target = anchor.current!.getBoundingClientRect(), tip = content.current!.getBoundingClientRect();
      setPosition({ left: Math.max(16, Math.min(target.left, innerWidth - tip.width - 16)), top: Math.max(16, Math.min(target.bottom, innerHeight - tip.height - 16)) });
    };
    place();
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);
  return <span ref={anchor} className="settings-info" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); } }}>
    <button type="button" className="settings-info__button" aria-label={label} aria-expanded={open} aria-describedby={open ? id : undefined} onFocus={() => setOpen(true)} onClick={() => setOpen(true)}><Info size={16} aria-hidden /></button>
    {open && container && createPortal(<span ref={content} id={id} role="tooltip" className="settings-info__content" style={position}>{children}</span>, container)}
  </span>;
}
