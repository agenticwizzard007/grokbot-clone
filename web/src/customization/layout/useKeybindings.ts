import { useLayoutEffect, useReducer, useRef } from 'react';
import { useEffectiveConfig } from '../index';
import { navigation, useConfigUI } from '../../configStore';
import { useStore } from '../../store';
import { hasOpenModal } from '../../components/modals/Modal';
import { bindingMatches, effectiveBindings, setShortcutBindings } from '../../lib/shortcuts';
import { dashboardScreen } from './usePhoneTabs';

export function useKeybindings() {
  const { keybindings, dashboards } = useEffectiveConfig();
  const current = useRef({ bindings: effectiveBindings(keybindings), dashboards });
  current.current = { bindings: effectiveBindings(keybindings), dashboards };
  const [, refreshLabels] = useReducer(value => value + 1, 0);
  useLayoutEffect(() => { setShortcutBindings(keybindings); refreshLabels(); }, [keybindings]);
  useLayoutEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.repeat) return;
      const { bindings, dashboards } = current.current;
      const action = Object.keys(bindings).find(id => bindingMatches(bindings[id], event));
      // Composer owns legacy bubble listeners. Capture prevents a rebound key
      // from also triggering its previous action without editing that component.
      const legacy = (event.metaKey || event.ctrlKey) && (event.key.toLowerCase() === 'i'
        || event.shiftKey && ['Slash', 'KeyF'].includes(event.code));
      if (!action && !legacy) return;
      if (legacy || action) event.stopImmediatePropagation();
      if (!action) return;
      const state = useStore.getState();
      if (action !== 'search' && action !== 'settings' && (state.modal === 'search' || state.modal === 'apps' || hasOpenModal())) return;
      event.preventDefault();
      switch (action) {
        case 'search': state.setModal(state.modal === 'search' ? null : 'search'); break;
        case 'settings': useConfigUI.getState().openAppSettings(); break;
        case 'newBot': useConfigUI.getState().requestLeaveBotSettings(() => state.setModal('create')); break;
        case 'toggleSidebar': if (!state.mobile) state.set({ sidebarCollapsed: !state.sidebarCollapsed }); break;
        case 'toggleDetails': state.set({ detailsOpen: !state.detailsOpen }); break;
        case 'goBots': navigation.navigate({ kind: 'bots' }); break;
        case 'goTasks': navigation.navigate({ kind: 'work', route: { tab: 'Tasks' } }); break;
        case 'focusComposer': document.querySelector<HTMLTextAreaElement>('.main-pane:not([hidden]) .composer__input')?.focus(); break;
        case 'effort': case 'fast': {
          const composer = document.querySelector('.main-pane:not([hidden]) .composer');
          const bot = state.bots.find(b => b.id === state.selectedBotId);
          if (!bot || !composer?.contains(document.activeElement)) break;
          void Promise.all([import('../../components/ComposerModelMenu'), import('../../lib/models')]).then(([actions, models]) => {
            if (action === 'effort') actions.cycleEffort(bot, models.modelSelection(bot, models.useModels.getState()).current);
            else if (models.useModels.getState().canFast) actions.toggleFast(bot);
          });
          break;
        }
        default: {
          const dashboard = dashboards[Number(action.slice(-1)) - 1];
          if (action.startsWith('goDashboard') && dashboard) navigation.navigate(dashboardScreen(dashboard.id));
        }
      }
    };
    window.addEventListener('keydown', keydown, true);
    return () => window.removeEventListener('keydown', keydown, true);
  }, []);
}
