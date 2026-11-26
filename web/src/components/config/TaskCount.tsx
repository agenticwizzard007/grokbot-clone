import { taskCountText } from '../../lib/taskCount';

export function TaskCount({ state, count, label, className, name = 'Pending input count', quietZero = false }: { state: 'loading' | 'unavailable' | 'ready'; count: number; label: string; className: string; name?: string; quietZero?: boolean }) {
  const quiet = state !== 'ready' || quietZero && count === 0;
  return <span className={`${className}${quiet ? ' is-neutral' : ''}`} data-state={state} aria-label={state === 'ready' ? label : `${name} ${state}`}>
    {state === 'ready' ? quietZero && count === 0 ? null : taskCountText(count) : <span aria-hidden="true">·</span>}
  </span>;
}
