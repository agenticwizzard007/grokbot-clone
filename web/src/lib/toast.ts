import { createElement, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

/** One app-wide toast. Views call toast(); App mounts <ToastPortal /> once so no panel or modal can hide it. */
export type ToastTone = 'info' | 'error';
export type ToastState = { id: number; message: string; tone: ToastTone } | null;

const DURATION_MS = 3000;
let current: ToastState = null;
let nextId = 1;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function emit() { for (const listener of listeners) listener(); }

export function toast(message: string, opts?: { tone?: ToastTone }): void {
  const text = message.trim();
  if (!text) return;
  clearTimeout(timer);
  current = { id: nextId++, message: text, tone: opts?.tone ?? 'info' };
  emit();
  timer = setTimeout(dismissToast, opts?.tone === 'error' ? DURATION_MS * 2 : DURATION_MS);
}

export function dismissToast(): void {
  clearTimeout(timer);
  timer = undefined;
  if (!current) return;
  current = null;
  emit();
}

export function currentToast(): ToastState { return current; }

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function ToastPortal() {
  const state = useSyncExternalStore(subscribe, currentToast, currentToast);
  if (!state || typeof document === 'undefined') return null;
  return createPortal(createElement('div', {
    key: state.id,
    className: `toast toast--global${state.tone === 'error' ? ' toast--error' : ''}`,
    role: state.tone === 'error' ? 'alert' : 'status',
    'aria-live': state.tone === 'error' ? 'assertive' : 'polite',
    onClick: dismissToast,
    // Fixed to the viewport so Details, Settings and modals can never cover it.
    style: { position: 'fixed', top: 16, zIndex: 1000, maxWidth: 'calc(100vw - 32px)', textAlign: 'center', cursor: 'default',
      ...(state.tone === 'error' ? { background: 'var(--color-danger)', color: '#fff' } : {}) },
  }, state.message), document.body);
}
