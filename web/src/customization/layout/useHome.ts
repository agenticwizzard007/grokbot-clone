import { useEffect, useRef } from 'react';
import type { UiConfig } from '@shared/ui-config/schema';
import { useEffectiveConfig, useUiConfig } from '../index';
import { navigation } from '../../configStore';
import { useStore } from '../../store';
import { dashboardScreen } from './usePhoneTabs';
import type { Screen } from '../../lib/navigation';

const openedWithHash = typeof window !== 'undefined' && !!window.location.hash;
export function homeScreen(doc: UiConfig): Screen | null {
  const home = doc.layout.home;
  if (home.kind === 'bots') return { kind: 'bots' };
  if (home.kind === 'tasks') return { kind: 'work', route: { tab: 'Tasks' } };
  if (home.kind === 'dashboard' && doc.dashboards.some(d => d.id === home.dashboardId)) return dashboardScreen(home.dashboardId);
  return null;
}

export function useHome() {
  const doc = useEffectiveConfig();
  const { status } = useUiConfig();
  const loaded = useStore(s => s.botsLoaded);
  const handled = useRef(openedWithHash);
  const initialRoute = useRef(window.location.hash);
  useEffect(() => {
    if (handled.current || !loaded || status === 'loading') return;
    handled.current = true;
    // A deliberate route chosen while the config loads has priority over home.
    if ((initialRoute.current && initialRoute.current !== window.location.hash) || navigation.trail.length > 0) return;
    const target = homeScreen(doc);
    if (target) navigation.navigate(target, 'replace');
  }, [loaded, status, doc]);
}
