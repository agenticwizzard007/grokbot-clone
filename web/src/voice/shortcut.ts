import { useConfigUI } from '../configStore';
import { isNativeApp } from '../lib/native';
import { useStore } from '../store';
import { isCallActive, startCall, toggleMute, useVoice } from './call';

type ShortcutStatus = 'loading' | 'signin' | 'missing-agent' | 'started' | 'failed';

declare global {
  interface Window { swarmStartMainVoice?: (requestID: string) => ShortcutStatus }
}

/** Native-to-web only. It cannot invoke native APIs, change servers, or establish a session. */
export function installVoiceShortcut() {
  if (!isNativeApp) return () => {};
  const handled = new Set<string>();
  const start = (requestID: string): ShortcutStatus => {
    if (typeof requestID !== 'string' || !/^[a-f\d-]{36}$/i.test(requestID)) return 'failed';
    if (handled.has(requestID)) return 'started';
    const state = useStore.getState();
    if (document.visibilityState !== 'visible' || !state.authChecked) return 'loading';
    if (!state.user) return 'signin';
    if (!state.botsLoaded) return 'loading';
    // Never fall back to the most recent chat or another agent.
    const main = state.bots.find(bot => bot.isPrimary);
    if (!main) return 'missing-agent';

    try {
      const config = useConfigUI.getState();
      config.closeAppSettings();
      config.closeBotSettings();
      config.setView('chat');
      state.set({ modal: null, viewerOpen: false, detailsOpen: false });
      state.selectBot(main.id);
      const call = useVoice.getState();
      if (isCallActive(call) && call.botId === main.id && call.muted) toggleMute();
      startCall(main.id); // Reuses an existing call with the main agent.
      handled.add(requestID);
      if (handled.size > 64) handled.delete(handled.values().next().value!);
      return 'started';
    } catch { return 'failed'; }
  };
  window.swarmStartMainVoice = start;
  return () => { if (window.swarmStartMainVoice === start) delete window.swarmStartMainVoice; };
}
