import { useSyncExternalStore } from 'react';

const query = window.matchMedia('(max-width: 760px)');
const subscribe = (notify: () => void) => { query.addEventListener('change', notify); return () => query.removeEventListener('change', notify); };
export const useCompactLayout = () => useSyncExternalStore(subscribe, () => query.matches, () => false);
