import type { composio } from './composio.js';

type Channel = {
  subscribed: boolean;
  bind(event: string, callback: () => void): void;
  unbind(event: string, callback: () => void): void;
};

/**
 * The pinned Composio SDK resolves subscribe() after binding handlers, before channel auth.
 * Its public API has no readiness callback. Keep this compatibility boundary isolated and
 * fail closed if the SDK's channel shape changes, rather than claiming delivery is ready.
 */
export async function waitForTriggerSubscription(client: ReturnType<typeof composio>) {
  const channel = (client.triggers as unknown as { pusherService?: { connection?: { channel?: Channel } } }).pusherService?.connection?.channel;
  if (!channel || typeof channel.bind !== 'function' || typeof channel.unbind !== 'function') {
    throw new Error('Event subscription readiness is unavailable.');
  }
  if (channel.subscribed) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      channel.unbind('pusher:subscription_succeeded', ready);
      channel.unbind('pusher:subscription_error', failed);
    };
    const ready = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error('Event subscription failed.')); };
    const timer = setTimeout(failed, 10_000);
    channel.bind('pusher:subscription_succeeded', ready);
    channel.bind('pusher:subscription_error', failed);
    if (channel.subscribed) ready();
  });
}
