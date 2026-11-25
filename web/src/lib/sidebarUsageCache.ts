import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { useModels } from './models';

type Summary = Pick<ReturnType<typeof useModels.getState>, 'provider' | 'billing' | 'plan' | 'usage'>;
type Cached = { account: string; at: number; value: Summary };
const key = (account: string) => `swarm.usage-summary:${account}`;
const maxAge = 5 * 60_000;
function read(account?: string): Cached | null {
  try {
    const data = account && JSON.parse(sessionStorage.getItem(key(account)) || 'null');
    return data?.account === account && Date.now() - data.at < maxAge && data.value?.provider && data.value?.billing ? data : null;
  } catch { return null; }
}
/** Display-only stale data. It never selects a provider or authorizes a request. */
export function useSidebarUsageSummary() {
  const account = useStore(s => s.user?.id);
  const catalog = useModels();
  const [cached, setCached] = useState(() => read(account));
  const known = catalog.status === 'ready' && !!catalog.provider && !!catalog.billing && !catalog.error;
  useEffect(() => { setCached(read(account)); }, [account]);
  useEffect(() => {
    if (!account || !known) return;
    const value: Summary = { provider: catalog.provider, billing: catalog.billing, plan: catalog.plan, usage: catalog.usage };
    const next = { account, at: Date.now(), value };
    setCached(next);
    try { sessionStorage.setItem(key(account), JSON.stringify(next)); } catch { /* optional cache */ }
  }, [account, known, catalog.provider, catalog.billing, catalog.plan, catalog.usage]);
  const stale = !known && cached && cached.account === account && Date.now() - cached.at < maxAge ? cached.value : null;
  return { catalog, summary: known ? catalog : stale, stale: !!stale || catalog.stale };
}
// Clear persisted display data when this document signs out or changes accounts.
useStore.subscribe((state, previous) => {
  if (previous.user?.id && state.user?.id !== previous.user.id) {
    try { sessionStorage.removeItem(key(previous.user.id)); } catch { /* optional cache */ }
  }
});
