import { useRef, useState } from 'react';
import type { PatchOp, Dashboard } from '@shared/ui-config';
import { useUiConfig, useUiPatch } from '../../customization';
import { useCustomization } from '../../customization/store';
import { navigation, openConversation } from '../../configStore';
import { dashboardSlug } from '../../lib/navigation';
import { prefillComposer } from '../../components/Composer';
import { useStore } from '../../store';
export function openDashboard(dashboard: Pick<Dashboard, 'id' | 'name'>) { navigation.navigate({ kind: 'dash', dashboard: dashboardSlug(dashboard) }); }
export function useDashboardManager() {
  const { saved: doc, status } = useUiConfig(), apply = useUiPatch();
  const lock = useRef(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const bots = useStore(state => state.bots);
  const patch = async (ops: PatchOp[], openNew = false) => {
    if (lock.current || !ops.length) return false;
    lock.current = true; setBusy(true); setError('');
    const ids = new Set(doc.dashboards.map(d => d.id));
    try {
      const result = await apply(ops, 'Manage dashboards');
      if (!result.ok) { setError(result.errors.map(error => error.message).join(' ')); return false; }
      if (openNew) { const created = useCustomization.getState().saved.dashboards.find(d => !ids.has(d.id)); if (created) openDashboard(created); }
      return true;
    } catch { setError('Could not save this change. Try again.'); return false; }
    finally { lock.current = false; setBusy(false); }
  };
  const ask = () => { const bot = bots.find(bot => bot.isPrimary) ?? bots[0]; if (bot) { prefillComposer(bot.id, 'Help me create a dashboard for '); openConversation(bot.id); } };
  return { doc, status, busy, error, setError, patch, ask, canAsk: !!bots.length };
}
