import { useLayoutEffect, useRef, type ReactNode } from 'react';
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

/** Accessible dialog with keyboard containment, Escape, and focus restoration. */
export function Modal({ onClose, children, className, label, top }: { onClose: () => void; children: ReactNode; className?: string; label: string; top?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useLayoutEffect(() => { close.current = onClose; }, [onClose]);
  useLayoutEffect(() => {
    const modal = root.current!;
    const prev = document.activeElement as HTMLElement | null;
    stack.push(modal);
    syncModalBackground();
    const k = (e: KeyboardEvent) => {
      if (stack.at(-1) !== modal || e.defaultPrevented) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close.current(); return; }
      if (e.key !== 'Tab') return;
      const elements = [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? [])]
        .filter(el => el.offsetParent !== null);
      const first = elements[0], last = elements[elements.length - 1];
      if (!first) { e.preventDefault(); ref.current?.focus(); return; }
      if (e.shiftKey && (document.activeElement === first || !ref.current?.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !ref.current?.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', k, true);
    const t = setTimeout(() => {
      if (stack.at(-1) !== modal || modal.contains(document.activeElement)) return;
      const el = ref.current?.querySelector<HTMLElement>('[autofocus], input, textarea, button');
      (el ?? ref.current)?.focus();
    });
    return () => {
      const wasTop = stack.at(-1) === modal;
      stack.splice(stack.indexOf(modal), 1);
      syncModalBackground();
      window.removeEventListener('keydown', k, true);
      clearTimeout(t);
      if (wasTop && prev?.isConnected && !prev.closest('[inert]') && !modal.contains(prev)) prev.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(
    <div className="modal-root" ref={root}>
      <div className="modal-scrim" onMouseDown={onClose} />
      <div ref={ref} className={`modal ${className ?? ''}`} role="dialog" tabIndex={-1} aria-modal="true" aria-label={label} style={top !== undefined ? { marginTop: top } : undefined}>
        {children}
      </div>
    </div>,
    document.body,
  );
}
