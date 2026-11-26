import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { cliErrorClass, safeToolName, type CliDiagnosticEvent } from '../cli/diagnostics.js';
import { recordApiRun } from '../cli/run-diagnostics.js';

type Event = Pick<CliDiagnosticEvent, 'event' | 'admission' | 'approvalId' | 'errorClass' | 'stopped'> & { tool?: string; manifestCount?: number };
const context = new AsyncLocalStorage<(event: Event) => void>();

/** Only server classifications and validated tool identifiers reach the record. */
export function apiRunDiagnostic(event: Event) {
  if (event.tool === 'tool_search' || event.tool === 'tool_describe') return;
  context.getStore()?.({ ...event, ...(event.tool ? { tool: safeToolName(event.tool) } : {}) });
}

export async function withApiRunDiagnostics<T>(userId: string, provider: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  const record = recordApiRun(userId);
  const generationId = randomUUID();
  let manifestCount = 0, finished = false;
  const emit = (event: Event) => {
    // An aborted tool can settle after its turn. It cannot reopen the record.
    if (finished) return;
    manifestCount = event.manifestCount ?? manifestCount;
    record({ ...event, generationId, provider, runtime: 'api', manifestCount });
  };
  return context.run(emit, async () => {
    emit({ event: 'start' });
    try {
      const result = await work();
      emit({ event: 'finish', stopped: signal.aborted });
      return result;
    } catch (error) {
      emit({ event: 'failure', errorClass: signal.aborted ? 'cancelled' : cliErrorClass(error) });
      throw error;
    } finally { finished = true; }
  });
}
