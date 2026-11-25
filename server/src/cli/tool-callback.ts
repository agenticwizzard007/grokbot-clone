import type { NativeToolCall, NativeToolHandler, NativeToolResult } from './native-tools.js';
import { cliDiagnostic, cliErrorClass, safeToolName } from './diagnostics.js';

export const hasNativeTools = (params: unknown): boolean => Array.isArray((params as any)?.nativeTools) && (params as any).nativeTools.length > 0;

function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** A callback capability belongs to exactly one generation, never its socket's other jobs. */
export class ToolCallbacks {
  private audit = cliDiagnostic();
  private active = true;
  private stopped = false;
  private requestBytes = 0;
  private resultBytes = 0;
  private tail: Promise<void> = Promise.resolve();
  private calls = new Map<string, { payload: string; result: Promise<NativeToolResult> }>();
  private names: Set<string>;
  private cancel!: (error: Error) => void;
  private cancelled = new Promise<never>((_resolve, reject) => { this.cancel = reject; });

  constructor(params: unknown, private handler?: NativeToolHandler) {
    this.names = new Set(hasNativeTools(params) ? (params as any).nativeTools.map((tool: any) => tool?.name).filter((name: unknown) => typeof name === 'string') : []);
    void this.cancelled.catch(() => {});
  }

  run(value: unknown): Promise<NativeToolResult> {
    const call = value as NativeToolCall;
    const tool = safeToolName(call?.name);
    const action = call?.name === 'SWARM_APPS_EXECUTE' ? safeToolName(call?.arguments?.tool_slug) : undefined;
    try {
      const result = this.admit(value);
      this.audit?.({ event: 'tool', tool, action, admission: 'admitted' });
      return result.then(reply => {
        const text = typeof reply.output === 'string' ? reply.output : '';
        let status: string | undefined, connectionRequired = false;
        try { const parsed = JSON.parse(text); status = parsed?.status; connectionRequired = !!parsed?.connectionRequest; } catch { /* Most outputs are plain text. */ }
        this.audit?.({ event: 'tool_result', tool, action, admission: status === 'pending_approval' ? 'pending_approval' : connectionRequired ? 'connection_required' : reply.isError ? 'refused' : 'returned',
          ...(reply.isError ? { errorClass: cliErrorClass(text) } : {}), stopped: reply.stop === true });
        return reply;
      }, error => { this.audit?.({ event: 'tool_result', tool, action, admission: 'refused', errorClass: cliErrorClass(error) }); throw error; });
    } catch (error) { this.audit?.({ event: 'tool', tool, action, admission: 'rejected', errorClass: cliErrorClass(error) }); throw error; }
  }

  private admit(value: unknown): Promise<NativeToolResult> {
    if (!this.active) throw new Error('CLI generation is no longer active.');
    if (!this.handler || !this.names.size) throw new Error('Native CLI tool callback is unavailable.');
    const call = value as NativeToolCall;
    if (!call || typeof call.id !== 'string' || !call.id || call.id.length > 1024 || typeof call.name !== 'string' ||
      !this.names.has(call.name) || !call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) {
      throw new Error('Invalid native CLI tool call.');
    }
    const payload = canonical({ name: call.name, arguments: call.arguments });
    const bytes = Buffer.byteLength(payload);
    if (bytes > 1_000_000) throw new Error('Native CLI tool arguments are too large.');
    const prior = this.calls.get(call.id);
    if (prior) {
      if (prior.payload !== payload) throw new Error('Native CLI tool call ID was reused with different arguments.');
      return prior.result;
    }
    if (this.stopped) throw new Error('Native CLI generation has stopped.');
    if (this.calls.size >= 512 || this.requestBytes + bytes > 8 * 1024 * 1024) throw new Error('Native CLI tool requests exceeded the generation limit.');
    this.requestBytes += bytes;
    // Defer invocation until the ID has been reserved, even for synchronous handlers.
    const result = Promise.race([this.cancelled, this.tail.then(() => {
      if (!this.active || this.stopped) throw new Error('Native CLI generation has stopped.');
      return this.handler!(call);
    })]).then(value => {
      if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'output') ||
        (value.stop !== undefined && typeof value.stop !== 'boolean') || (value.isError !== undefined && typeof value.isError !== 'boolean')) throw new Error('Invalid native CLI tool result.');
      if (value.stop) this.stopped = true;
      const resultBytes = Buffer.byteLength(JSON.stringify(value));
      // Leave framing space inside the sockets' 8 MB limit; also bound replay caches.
      if (resultBytes > 8 * 1024 * 1024 - 4096 || this.resultBytes + resultBytes > 64 * 1024 * 1024) throw new Error('Native CLI tool results exceeded the generation limit.');
      this.resultBytes += resultBytes;
      return value;
    });
    this.tail = result.then(() => {}, () => { this.stopped = true; });
    this.calls.set(call.id, { payload, result });
    return result;
  }

  close() {
    if (!this.active) return;
    this.active = false;
    this.calls.clear();
    this.cancel(new Error('CLI generation is no longer active.'));
  }
}
