import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';

type Fields = { event: string; tool?: string; action?: string; admission?: string; errorClass?: string; stopped?: boolean };
const context = new AsyncLocalStorage<(fields: Fields) => void>();
export const cliDiagnostic = () => context.getStore();
export const safeToolName = (name: unknown) => typeof name === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(name) ? name : 'invalid_name';

/** Classify only. Never log exception messages, arguments, bodies or credentials. */
export function cliErrorClass(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (/could not authenticate with the Swarm tool bridge/i.test(message)) return 'mcp_auth';
  if (/could not connect to the Swarm tool bridge/i.test(message)) return 'mcp_startup';
  if (/approval policy|CLI approval|blocked the Swarm tool handoff/i.test(message)) return 'cli_approval_rejected';
  if (/unavailable tool|invalid native CLI tool call|tool.*unavailable|tool.*not available/i.test(message)) return 'tool_unavailable';
  if (/timed out|timeout/i.test(message)) return 'timeout';
  if (/authenticat|sign in|subscription login/i.test(message)) return 'cli_auth';
  if (/MCP tools|MCP server|isolated configuration/i.test(message)) return 'mcp_configuration';
  if (/connection.*expired|reconnect/i.test(message)) return 'app_reconnect';
  if (/connection.*failed|could not be confirmed/i.test(message)) return 'app_connection';
  if (/declined|Not allowed/i.test(message)) return 'policy_denied';
  if (/cancel|ended|stopped/i.test(message)) return 'cancelled';
  if (/argument|schema/i.test(message)) return 'invalid_arguments';
  return 'tool_or_runner_error';
}

export async function withCliDiagnostics<T>(params: any, runtime: string, work: () => Promise<T>, scope?: { botId: string | null; jobId: string | null }): Promise<T> {
  const names: string[] = Array.isArray(params?.nativeTools) ? params.nativeTools.map((t: any) => safeToolName(t?.name)).sort() : [];
  const common = { generationId: randomUUID(), provider: params?.provider === 'claude' ? 'claude' : 'codex', runtime, botId: scope?.botId ?? null, jobId: scope?.jobId ?? null,
    manifestCount: names.length, manifestNamesHash: createHash('sha256').update(JSON.stringify(names)).digest('hex') };
  const log = (fields: Fields) => console.info('[cli-generation]', JSON.stringify({ ...common, ...fields }));
  return context.run(log, async () => {
    log({ event: 'start' });
    try {
      const result = await work();
      // Runner diagnostics are a bounded classification, never raw CLI output.
      const failures = (result as any)?.nativeDiagnostics;
      if (Array.isArray(failures)) for (const failure of failures.slice(0, 512)) {
        if (!names.includes(failure?.tool)) continue;
        log({ event: 'tool', tool: failure.tool, admission: 'cli_rejected', errorClass: failure.errorClass === 'cli_approval_rejected' ? 'cli_approval_rejected' : 'mcp_transport' });
      }
      if (!(result as any)?.stopped && Array.isArray(failures) && failures.some(f => names.includes(f?.tool) && f.errorClass === 'cli_approval_rejected')) {
        throw new Error('The CLI approval policy blocked the Swarm tool handoff. Update the Swarm server or reconnect your computer bridge in Settings > Subscriptions. The rejected tool call did not reach the app.');
      }
      log({ event: 'finish', stopped: (result as any)?.stopped === true });
      return result;
    } catch (error) { log({ event: 'failure', errorClass: cliErrorClass(error) }); throw error; }
  });
}
