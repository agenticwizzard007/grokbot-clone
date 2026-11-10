import { useSyncExternalStore } from 'react';

const subscribe = (notify: () => void) => {
  document.addEventListener('visibilitychange', notify);
  return () => document.removeEventListener('visibilitychange', notify);
};
const visible = () => document.visibilityState === 'visible';

/** Background tabs should not keep a remote screen capturing or a VM awake. */
export const usePageVisible = () => useSyncExternalStore(subscribe, visible);
