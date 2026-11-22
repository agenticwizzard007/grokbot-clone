import { useSyncExternalStore } from 'react';
import { Modal } from '../components/modals/Modal';

/** One app-wide confirm dialog. Call confirmDialog(); App mounts <ConfirmPortal /> once. */
export interface ConfirmRequest { title: string; body?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean }
type Pending = ConfirmRequest & { id: number; resolve: (ok: boolean) => void };

let pending: Pending | null = null;
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };

export function confirmDialog(request: ConfirmRequest): Promise<boolean> {
  // A second request replaces an open one; the replaced caller sees Cancel.
  pending?.resolve(false);
  return new Promise<boolean>(resolve => {
    pending = { ...request, id: nextId++, resolve };
    emit();
  });
}

function settle(ok: boolean) {
  const current = pending;
  if (!current) return;
  pending = null;
  emit();
  current.resolve(ok);
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => pending;

export function ConfirmPortal() {
  const request = useSyncExternalStore(subscribe, snapshot, snapshot);
  if (!request) return null;
  return <Modal key={request.id} onClose={() => settle(false)} className="confirm-dialog" label={request.title}>
    <div style={{ width: 400, maxWidth: 'calc(100vw - 48px)' }}>
      <div className="modal__header"><h2 className="modal__title">{request.title}</h2></div>
      {request.body && <p style={{ margin: 0, padding: 16, fontSize: 13, lineHeight: '20px', color: 'var(--color-text-secondary)' }}>{request.body}</p>}
      <div className="modal__footer">
        <button type="button" className="btn btn--sm btn--secondary" onClick={() => settle(false)}>{request.cancelLabel ?? 'Cancel'}</button>
        <button type="button" className="btn btn--sm btn--primary" onClick={() => settle(true)}>{request.confirmLabel ?? 'Confirm'}</button>
      </div>
    </div>
  </Modal>;
}
