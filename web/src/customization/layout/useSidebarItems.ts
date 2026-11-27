import { useEffect } from 'react';
import { NAV_IDS, type NavId } from '@shared/ui-config/registry-nav';
import { DEFAULT_CONFIG, type UiConfig } from '@shared/ui-config/schema';
import { useEffectiveConfig } from '../index';
import { useStore } from '../../store';

export function sidebarItemsFor(doc: UiConfig, bots: { id: string; name: string }[]) {
  const { order, hidden } = doc.layout.sidebar;
  const items = [...new Set(order)].filter(id => NAV_IDS.includes(id) && id !== 'search' && (id === 'settings' || !hidden.includes(id)));
  if (!items.includes('settings')) items.push('settings');
  const pinned = doc.layout.pinned.flatMap(pin => {
    const item = pin.type === 'bot' ? bots.find(b => b.id === pin.id) : doc.dashboards.find(d => d.id === pin.id);
    return item ? [{ ...pin, name: item.name }] : [];
  });
  return { items: items as NavId[], pinned, dashboards: doc.dashboards,
    standardOrder: JSON.stringify(order) === JSON.stringify(DEFAULT_CONFIG.layout.sidebar.order) && !pinned.length && !doc.dashboards.length,
    search: !hidden.includes('search') };
}

export function useSidebarItems() {
  const doc = useEffectiveConfig();
  const bots = useStore(s => s.bots);
  return sidebarItemsFor(doc, bots);
}

export function useSidebarDefault() {
  const preference = useEffectiveConfig().layout.sidebar.collapsed;
  useEffect(() => {
    if (typeof preference === 'boolean') useStore.getState().set({ sidebarCollapsed: preference });
  }, [preference]);
}
