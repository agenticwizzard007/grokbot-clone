import { WebSocket } from 'ws';
import { assertTenant, isTenant } from '../deployment.js';
import type { RunnerOptions, LoginHandle } from '../cli/hosted.js';
import type { CliProvider } from '../cli/store.js';
import { hasNativeTools, ToolCallbacks } from '../cli/tool-callback.js';

function connect(options: RunnerOptions, message: Record<string, unknown>) {
  if (!isTenant || !options.tenantUserId || !process.env.SWARM_RUNNER_SOCKET?.startsWith('/run/swarm/')) throw new Error('Isolated subscription runner unavailable.');
  assertTenant(options.tenantUserId);
  if (options.signal?.aborted) throw new Error('Subscription request cancelled.');
  const callbacks = new ToolCallbacks(message.operation === 'generate' ? message.params : undefined, message.operation === 'generate' ? options.onToolCall : undefined);
  // ws derives socketPath from its Unix URL and overwrites a socketPath option.
  const ws = new WebSocket(`ws+unix://${process.env.SWARM_RUNNER_SOCKET}:/cli`, { maxPayload: 8 * 1024 * 1024 });
  let readyResolve: () => void, readyReject: (e: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  // RPC callers await done; login callers await ready. Both rejections are handled immediately.
  void ready.catch(() => {});
  let settled = false;
  const done = new Promise<any>((resolve, reject) => {
    const requestedTimeout = (message.params as any)?.timeoutMs;
    const timeout = message.operation === 'generate' && Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? Math.min(requestedTimeout, 16 * 60_000) : 16 * 60_000;
    const timer = setTimeout(() => fail(new Error('Subscription runner timed out.')), timeout);
    const startTimer = setTimeout(() => fail(new Error('Subscription runner did not start.')), 12_000);
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(startTimer);
      callbacks.close();
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
    const toolReply = (id: string, reply: Record<string, unknown>) => {
      if (settled || ws.readyState !== WebSocket.OPEN) return;
      try { ws.send(JSON.stringify({ type: 'tool_result', id, ...reply }), error => { if (error) fail(new Error('Subscription runner disconnected.')); }); }
      catch { fail(new Error('Invalid native CLI tool result.')); }
    };
    ws.on('message', raw => {
      if (settled) return;
      try {
        const value = JSON.parse(raw.toString());
        if (value.type === 'ready') { clearTimeout(startTimer); readyResolve(); }
        else if (value.type === 'data' && typeof value.data === 'string') options.onData?.(value.data);
        else if (value.type === 'tool_call') {
          // Never give status/catalog/login a capability to execute Swarm tools.
          const pending = callbacks.run(value.call);
          void pending.then(result => toolReply(value.call.id, { result }), error => toolReply(value.call.id, { error: error instanceof Error ? error.message.slice(0, 1000) : 'Native CLI tool call failed.' }));
        }
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
  async readCatalog(params: unknown, options: RunnerOptions) {
    const provider = (params as { provider?: string })?.provider;
    if (provider !== 'codex' && provider !== 'claude') throw new Error('Select a subscription provider.');
    return connect(options, { operation: 'catalog', provider }).done;
  },
  async runGeneration(params: unknown, options: RunnerOptions) {
    const provider = (params as { provider?: string })?.provider;
    if (provider !== 'codex' && provider !== 'claude') throw new Error('Select a subscription provider.');
    if (hasNativeTools(params) && !options.onToolCall) throw new Error('Native CLI tool callback is unavailable.');
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
