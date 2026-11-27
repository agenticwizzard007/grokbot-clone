import { ChevronLeft } from 'lucide-react';
import { useLayoutEffect, useRef, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const stack: HTMLElement[] = [];
const savedInert = new Map<HTMLElement, boolean>();
export const hasOpenModal = () => stack.length > 0;

function syncModalBackground() {
  const top = stack.at(-1);
  for (const [element, wasInert] of savedInert) element.inert = wasInert;
  savedInert.clear();
  if (!top) return;
  for (const element of document.body.children) {
    if (!(element instanceof HTMLElement) || element === top) continue;
    savedInert.set(element, element.inert);
    element.inert = true;
  }
}

const PASS_THROUGH = 'button, a[href], [role="button"]';

/**
 * R2F-033: the backdrop closes the dialog on mouse down and is removed at once, so the browser drops the
 * click that follows (its press and release land on different elements). For light palettes, a press on a
 * navigation control under the backdrop (`passThrough`, a CSS scope such as '.sidebar') still activates it.
 */
function forwardReleaseTo(scope: string, x: number, y: number) {
  window.addEventListener('mouseup', up => {
    requestAnimationFrame(() => {
      const pick = (px: number, py: number) => document.elementFromPoint(px, py)?.closest<HTMLElement>(PASS_THROUGH) ?? null;
      const target = pick(x, y);
      if (!target || target !== pick(up.clientX, up.clientY) || !target.closest(scope) || target.closest('[inert]') || (target as HTMLButtonElement).disabled) return;
      target.click();
    });
  }, { once: true, capture: true });
}

/** Accessible dialog with keyboard containment, Escape, and focus restoration. */
export function Modal({ onClose, children, className, label, top, passThrough, embedded = false }: { onClose: () => void; children: ReactNode; className?: string; label: string; top?: number; passThrough?: string; embedded?: boolean }) {
  const scrimDown = (event: ReactMouseEvent) => {
    if (passThrough && event.button === 0) forwardReleaseTo(passThrough, event.clientX, event.clientY);
    onClose();
  };
  const ref = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useLayoutEffect(() => { close.current = onClose; }, [onClose]);
  useLayoutEffect(() => {
    const modal = root.current!;
    const prev = document.activeElement as HTMLElement | null;
    if (!embedded) { stack.push(modal); syncModalBackground(); }
    const k = (e: KeyboardEvent) => {
      if ((embedded ? stack.length > 0 : stack.at(-1) !== modal) || e.defaultPrevented) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close.current(); return; }
      if (e.key !== 'Tab' || embedded) return;
      const elements = [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? [])]
        .filter(el => el.offsetParent !== null);
      const first = elements[0], last = elements[elements.length - 1];
      if (!first) { e.preventDefault(); ref.current?.focus(); return; }
      if (e.shiftKey && (document.activeElement === first || !ref.current?.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !ref.current?.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', k, true);
    const t = setTimeout(() => {
      if ((!embedded && stack.at(-1) !== modal) || modal.contains(document.activeElement)) return;
      const el = ref.current?.querySelector<HTMLElement>('[autofocus], input, textarea, button');
      (el ?? ref.current)?.focus();
    });
    return () => {
      const wasTop = embedded || stack.at(-1) === modal;
      if (!embedded) { stack.splice(stack.indexOf(modal), 1); syncModalBackground(); }
      window.removeEventListener('keydown', k, true);
      clearTimeout(t);
      if (wasTop && prev?.isConnected && !prev.closest('[inert]') && !modal.contains(prev)) prev.focus({ preventScroll: true });
    };
  }, []);
  const content = (
    <div className={embedded ? "route-surface" : "modal-root"} ref={root}>
      {!embedded && <div className="modal-scrim" onMouseDown={scrimDown} />}
      <div ref={ref} className={`modal ${className ?? ''}`} role="dialog" tabIndex={-1} aria-modal={embedded ? undefined : true} aria-label={label} style={top !== undefined ? { marginTop: top } : undefined}>
        {!embedded && !className?.includes('phone-drawer') && <div className="modal-page-back"><button type="button" aria-label="Back" onClick={onClose}><ChevronLeft size={20} aria-hidden /><span>Back</span></button></div>}
        {children}
      </div>
    </div>
  );
  return embedded ? content : createPortal(content, document.body);
}
