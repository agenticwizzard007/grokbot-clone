import { isNativeApp } from '../lib/native';
import { useStore } from '../store';

export type ShortcutStatus = 'loading' | 'signin' | 'missing-agent' | 'started' | 'failed';
declare global {
  interface Window { swarmStartMainVoice?: (requestID: string) => ShortcutStatus }
}

export function installVoiceEntry() {
  if (!isNativeApp) return;
  const start = (requestID: string): ShortcutStatus => {
    if (typeof requestID !== 'string' || !/^[a-f\d-]{36}$/i.test(requestID)) return 'failed';
    const state = useStore.getState();
    if (document.visibilityState !== 'visible' || !state.authChecked) return 'loading';
    return state.user ? 'loading' : 'signin';
  };
  window.swarmStartMainVoice = start;
  return () => { if (window.swarmStartMainVoice === start) delete window.swarmStartMainVoice; };
}
