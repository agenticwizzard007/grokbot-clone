import { Fragment, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { ExternalLink, type LucideIcon } from 'lucide-react';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  hint?: string;
  /** A Lucide icon, shown before the label. */
  icon?: LucideIcon;
  /** Draw a divider above this item, to group related actions. */
  separatorBefore?: boolean;
  /** Opens something outside the app: shows an external-link mark. */
  external?: boolean;
}

/** Small popover menu anchored by its parent (position: relative). Closes on outside click / Escape; arrow keys move between items. */
export function Menu({ items, onClose, align = 'left', placement = 'below', children }: { items: MenuItem[]; onClose: () => void; align?: 'left' | 'right' | 'center'; placement?: 'below' | 'above'; children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    const t = setTimeout(() => document.addEventListener('mousedown', down));
    document.addEventListener('keydown', key, true);
    return () => { clearTimeout(t); document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key, true); };
  }, [onClose]);

  const move = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const list = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
    if (!list.length) return;
    e.preventDefault();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : e.key === 'ArrowDown' ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
    list[next].focus();
  };

  // Take focus when opened so arrow keys work at once (the container, not an item, so mouse users see no ring).
  useEffect(() => { ref.current?.focus({ preventScroll: true }); }, []);

  const withIcons = items.some((it) => it.icon);
  return (
    <div ref={ref} className={`menu is-${align} is-${placement}${withIcons ? ' has-icons' : ''}`} role="menu" tabIndex={-1} onKeyDown={move}>
      {children}
      {items.map((it, i) => {
        const Icon = it.icon;
        return (
          <Fragment key={it.label}>
            {it.separatorBefore && i > 0 && <div className="menu__sep" role="separator" />}
            <button type="button" role="menuitem" className={`menu__item${it.danger ? ' is-danger' : ''}`} onClick={() => { onClose(); it.onSelect(); }}>
              <span className="menu__main">
                {Icon && <Icon size={16} strokeWidth={1.75} className="menu__icon" aria-hidden />}
                <span className="menu__label">{it.label}</span>
              </span>
              {it.hint && <span className="menu__hint">{it.hint}</span>}
              {it.external && <ExternalLink size={14} strokeWidth={1.75} className="menu__icon menu__icon--end" aria-hidden />}
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}
