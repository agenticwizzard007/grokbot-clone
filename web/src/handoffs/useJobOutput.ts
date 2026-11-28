import { useEffect, useState } from 'react';
import { handoffApi, type RunOutput } from './api';
import { ApiError } from '../lib/api';

/** Chat reads are quiet, bounded and independent of unrelated output events. */
export function useJobOutput(jobId: string | undefined, enabled: boolean) {
  const [state, setState] = useState<{ jobId: string; output: RunOutput | null }>();
  useEffect(() => {
    if (!jobId || !enabled) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined, delay = 1000;
    const read = async () => {
      try {
        const result = await handoffApi.outputByJob(jobId, controller.signal);
        if (controller.signal.aborted) return;
        setState({ jobId, output: result.output });
        if (result.terminal) return;
      } catch (error) {
        // Empty and failed background reads never surface a toast or log.
        if (error instanceof ApiError && [401, 403, 404, 410].includes(error.status)) return;
      }
      if (!controller.signal.aborted) {
        timer = setTimeout(read, delay);
        delay = Math.min(delay * 2, 30_000);
      }
    };
    void read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [jobId, enabled]);
  return enabled && state && state.jobId === jobId ? state.output : null;
}
