import { useEffect, useState, useSyncExternalStore } from 'react';

// Same account-keyed local preference convention as detailsDefault.
export const dashboardDisclosureKey = (userId: string) => `swarm.${userId}.dashboardsExpanded`;
export function readDashboardDisclosure(userId: string | null | undefined): boolean | null {
  if (!userId) return null;
  try {
    const value = localStorage.getItem(dashboardDisclosureKey(userId));
    return value === '1' ? true : value === '0' ? false : null;
  } catch { return null; }
}
export function writeDashboardDisclosure(userId: string | null | undefined, expanded: boolean) {
  if (!userId) return;
  try { localStorage.setItem(dashboardDisclosureKey(userId), expanded ? '1' : '0'); } catch { /* Session state still works without storage. */ }
}
const shortViewport = () => window.matchMedia('(max-height: 759px)').matches;
const subscribeViewport = (changed: () => void) => {
  const media = window.matchMedia('(max-height: 759px)');
  media.addEventListener('change', changed);
  return () => media.removeEventListener('change', changed);
};
export function useDashboardDisclosure(userId: string | undefined) {
  const short = useSyncExternalStore(subscribeViewport, shortViewport, () => false);
  const [choice, setChoice] = useState(() => ({ userId, value: readDashboardDisclosure(userId) }));
  const value = choice.userId === userId ? choice.value : readDashboardDisclosure(userId);
  useEffect(() => {
    setChoice({ userId, value: readDashboardDisclosure(userId) });
    const sync = (event: StorageEvent) => {
      if (!event.key || userId && event.key === dashboardDisclosureKey(userId)) setChoice({ userId, value: readDashboardDisclosure(userId) });
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, [userId]);
  return { short, expanded: value ?? !short, setExpanded: (expanded: boolean) => {
    writeDashboardDisclosure(userId, expanded);
    setChoice({ userId, value: expanded });
  } };
}
