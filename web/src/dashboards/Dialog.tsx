import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import '../styles/config.css';
import { Page } from '../components/layout';
export function DashboardDialog({ title, children, close }: { title: string; children: ReactNode; close(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const node = dialog.current!; node.showModal(); return () => node.close(); }, []);
  return <dialog ref={dialog} className="dashboard-dialog" aria-label={title} onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <Page><header className="dashboard-dialog-heading"><h1>{title}</h1><button type="button" className="cfg-btn cfg-btn--secondary" aria-label="Close" title="Close" onClick={close}><X size={20} aria-hidden="true" /></button></header>{children}</Page>
  </dialog>;
}
