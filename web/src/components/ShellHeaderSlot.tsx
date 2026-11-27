import { useLayoutEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Keep chat actions in the shared top bar without remounting the conversation. */
export function ShellHeaderSlot({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => { setHost(document.getElementById('shell-chat-header')); }, []);
  return host ? createPortal(children, host) : children;
}
