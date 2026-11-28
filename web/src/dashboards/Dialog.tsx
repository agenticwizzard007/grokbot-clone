import { useEffect, useRef, type ReactNode } from 'react';
import { ChevronLeft, X } from 'lucide-react';
import '../styles/config.css';
import { Page } from '../components/layout';
export function DashboardDialog({ title, children, close, fullScreen = false }: { title: string; children: ReactNode; close(): void; fullScreen?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const node = dialog.current!, opener = document.activeElement;
    node.showModal();
    return () => {
      node.close();
      // Restore after the sheet has unmounted and its trigger is no longer inert.
      queueMicrotask(() => { if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true }); });
    };
  }, []);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [title]);
  return <dialog ref={dialog} className={`dashboard-dialog${fullScreen ? ' dashboard-dialog--full' : ''}`} aria-label={title} onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }} onKeyDown={event => {
    if (event.key !== 'Tab' || event.defaultPrevented) return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]')]
      .filter(node => node.tabIndex >= 0 && !node.matches(':disabled') && node.checkVisibility());
    const first = controls[0], last = controls.at(-1), active = document.activeElement;
    // Roving controls and the heading can hold focus outside the Tab order.
    const beforeFirst = first && active && (first.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_PRECEDING);
    const afterLast = last && active && (last.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING);
    if (!first) { event.preventDefault(); event.currentTarget.focus(); }
    else if (event.shiftKey && (active === first || beforeFirst)) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && (active === last || afterLast)) { event.preventDefault(); first.focus(); }
  }}>
    <div className="dashboard-dialog-back"><button type="button" onClick={close}><ChevronLeft size={20} aria-hidden="true" />Back</button></div>
    <Page><header className="dashboard-dialog-heading"><h1 ref={heading} tabIndex={-1}>{title}</h1><button type="button" className="cfg-btn cfg-btn--secondary" aria-label="Close" title="Close" onClick={close}><X size={20} aria-hidden="true" /></button></header>{children}</Page>
  </dialog>;
}
