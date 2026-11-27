import { useEffect, useRef, type ReactNode } from 'react';
import { Page } from '../components/layout';
export function DashboardDialog({ title, children, close }: { title: string; children: ReactNode; close(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const node = dialog.current!; node.showModal(); return () => node.close(); }, []);
  return <dialog ref={dialog} className="dashboard-dialog" aria-label={title} onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <Page title={title}>{children}</Page>
  </dialog>;
}
