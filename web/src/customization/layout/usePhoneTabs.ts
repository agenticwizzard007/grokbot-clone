import { House, LayoutDashboard, ListTodo, Search, Settings } from 'lucide-react';
import type { UiConfig } from '@shared/ui-config/schema';
import type { Screen } from '../../lib/navigation';
import { useEffectiveConfig } from '../index';

export function dashboardScreen(id: string): Screen {
  return { kind: 'dash', dashboard: id };
}

export function phoneTabsFor(doc: UiConfig) {
  const builtins = {
    bots: { label: 'Bots', Icon: House, target: { kind: 'bots' } as Screen },
    tasks: { label: 'Tasks', Icon: ListTodo, target: { kind: 'work', route: { tab: 'Tasks' } } as Screen },
    search: { label: 'Search', Icon: Search, target: { kind: 'search' } as Screen },
    settings: { label: 'Settings', Icon: Settings, target: { kind: 'settings' } as Screen },
  };
  let dashboardAdded = false;
  const ids = [...new Set(doc.layout.phoneTabs)].filter(id => {
    if (Object.hasOwn(builtins, id)) return true;
    if (dashboardAdded || !id.startsWith('dashboard:') || !doc.dashboards.some(d => d.id === id.slice(10))) return false;
    dashboardAdded = true;
    return true;
  }).slice(0, 5);
  if (!ids.includes('settings')) { if (ids.length === 5) ids.pop(); ids.push('settings'); }
  for (const id of ['bots', 'tasks', 'search'] as const) if (ids.length < 3 && !ids.includes(id)) ids.push(id);
  return ids.map(id => {
    if (Object.hasOwn(builtins, id)) return { id, ...builtins[id as keyof typeof builtins] };
    const dashboard = doc.dashboards.find(d => d.id === id.slice(10))!;
    return { id, label: dashboard.name, Icon: LayoutDashboard, target: dashboardScreen(dashboard.id) };
  });
}

export function isPhoneTab(screen: Screen, tabs: ReturnType<typeof phoneTabsFor>): boolean {
  return tabs.some(({ target }) => {
    if (target.kind !== screen.kind) return false;
    if (screen.kind === 'settings') return !screen.section;
    if (screen.kind === 'work') return !screen.route.botSlug && screen.route.tab === 'Tasks';
    if (screen.kind === 'dash' && target.kind === 'dash') return screen.dashboard === target.dashboard || screen.dashboard.endsWith(`-${target.dashboard}`);
    return true;
  });
}

// Built-in roots keep their tab bar even when a user removes that tab.
export function isPhoneRoot(screen: Screen, tabs: ReturnType<typeof phoneTabsFor>): boolean {
  return isPhoneTab(screen, tabs) || screen.kind === 'bots' || screen.kind === 'search'
    || (screen.kind === 'settings' && !screen.section) || (screen.kind === 'work' && !screen.route.botSlug);
}
export function usePhoneTabs() { return phoneTabsFor(useEffectiveConfig()); }
