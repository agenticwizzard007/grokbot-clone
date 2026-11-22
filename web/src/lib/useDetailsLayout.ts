import { useSyncExternalStore } from 'react';

// Keep aligned with the three-column breakpoint in bot-details.css.
const query = window.matchMedia('(max-width: 1100px)');
const subscribe = (notify: () => void) => {
  query.addEventListener('change', notify);
  return () => query.removeEventListener('change', notify);
};
export const detailsReplaceChat = () => query.matches;
export const useDetailsReplaceChat = () => useSyncExternalStore(subscribe, detailsReplaceChat);
