import { WebSocket } from 'ws';
import { assertTenant, isTenant } from '../deployment.js';
import type { RunnerOptions, LoginHandle } from '../cli/hosted.js';
import type { CliProvider } from '../cli/store.js';

function connect(options: RunnerOptions, message: Record<string, unknown>) {
  if (!isTenant || !options.tenantUserId || !process.env.SWARM_RUNNER_SOCKET?.startsWith('/run/swarm/')) throw new Error('Isolated subscription runner unavailable.');
  assertTenant(options.tenantUserId);
  const ws = new WebSocket('ws://localhost/cli', { socketPath: process.env.SWARM_RUNNER_SOCKET, maxPayload: 8 * 1024 * 1024 });
  let readyResolve: () => void, readyReject: (e: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  // RPC callers await done; login callers await ready. Both rejections are handled immediately.
  void ready.catch(() => {});
  let settled = false;
  const done = new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => fail(new Error('Subscription runner timed out.')), 16 * 60_000);
    const startTimer = setTimeout(() => fail(new Error('Subscription runner did not start.')), 12_000);
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(startTimer);
      options.signal?.removeEventListener('abort', abort);
      if (error) { readyReject(error); reject(error); } else resolve(value);
      ws.close();
    };
    const fail = (error: Error) => { finish(error); ws.terminate(); };
    const abort = () => fail(new Error('Subscription request cancelled.'));
    options.signal?.addEventListener('abort', abort, { once: true });
    ws.once('open', () => {
      if (options.signal?.aborted) return abort();
      ws.send(JSON.stringify({ ...message, tenantId: options.tenantUserId, cols: options.cols, rows: options.rows }));
    });
    ws.on('message', raw => {
      try {
        const value = JSON.parse(raw.toString());
        if (value.type === 'ready') { clearTimeout(startTimer); readyResolve(); }
        else if (value.type === 'data' && typeof value.data === 'string') options.onData?.(value.data);
        else if (value.type === 'result') finish(undefined, value.result);
        else if (value.type === 'error') fail(new Error('The isolated subscription runner failed. No API fallback was used.'));
      } catch { fail(new Error('Invalid runner response.')); }
    });
    ws.on('error', () => fail(new Error('Isolated subscription runner unavailable.')));
    ws.on('close', () => { if (!settled) fail(new Error('Subscription runner disconnected.')); });
  });
  void done.catch(() => {});
  return { ready, done, send: (value: unknown) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); }, cancel: () => ws.terminate() };
}
export const isolatedRunner = {
  async checkProviders(options: RunnerOptions) {
    const [codex, claude] = await Promise.all((['codex', 'claude'] as const).map(provider => connect(options, { operation: 'status', provider }).done));
    return { codex, claude };
  },
  async runGeneration(params: unknown, options: RunnerOptions) {
    const provider = (params as { provider?: string })?.provider;
    if (provider !== 'codex' && provider !== 'claude') throw new Error('Select a subscription provider.');
    return connect(options, { operation: 'generate', provider, params }).done;
  },
  async startLogin(provider: CliProvider, options: RunnerOptions): Promise<LoginHandle> {
    const rpc = connect(options, { operation: 'login', provider });
    await rpc.ready;
    return { write: data => rpc.send({ type: 'input', data }), resize: (cols, rows) => rpc.send({ type: 'resize', cols, rows }), cancel: rpc.cancel, done: rpc.done };
  },
  async deleteProfiles(options: RunnerOptions) {
    for (const provider of ['codex', 'claude']) await connect(options, { operation: 'delete', provider }).done;
  },
};
