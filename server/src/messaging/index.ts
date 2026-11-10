import { registerAdapter, startBridge } from './bridge.js';
import { resumeInbox } from './inbox.js';
import { startConnectionWatcher } from './connections.js';
import { ensureTunnel, inkboxAdapter } from './inkbox/adapter.js';

export { messagingApi, messagingPublic } from './routes.js';
export { inkboxWebhook } from './inkbox/adapter.js';

/** Wire messaging into the runtime. `process`: replay the inbox (off for extra servers sharing a database). */
export function initMessaging(opts: { process: boolean }) {
  registerAdapter(inkboxAdapter);
  startBridge();
  if (opts.process) {
    resumeInbox();
    // Greet people the moment they text "connect @<handle>" (one text to join).
    startConnectionWatcher();
    // Reopen the line's tunnel so texts keep arriving after a restart.
    void ensureTunnel().catch((e) => console.warn('[inkbox] tunnel failed:', e?.message ?? e));
  }
}
