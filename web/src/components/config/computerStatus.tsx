import type { ComputerState } from '@shared/types';
import { useStore } from '../../store';

/**
 * R2F-021: one source for computer readiness copy, used by the coworker setup card, Details Activity
 * and the Setup tab, so the same state reads the same words everywhere.
 */
export function computerStatusText(computer: ComputerState | null): string {
  if (!computer) return 'Checking status…';
  if (computer?.provider === 'local') return computer.status === 'running' ? 'Connected' : 'Not connected';
  switch (computer?.status) {
    case 'running': return 'Awake';
    case 'starting': case 'resuming': case 'creating': return 'Agent waking up';
    case 'suspending': return 'Going to sleep…';
    case 'error': return 'Unreachable';
    default: return 'Asleep';
  }
}

/** Live state is shared by all surfaces. Setup preparation is a separate prerequisite. */
export const computerReadiness = computerStatusText;

/** "Computer: Awake", "Computer: Asleep", "Computer: Not connected". */
export const computerStatusLine = (computer: ComputerState | null) => `Computer: ${computerReadiness(computer)}`;

/** The status line as text, reading the live computer from the store. */
export function ComputerStatusLine() {
  const computer = useStore(state => state.computer);
  return <>{computerStatusLine(computer)}</>;
}
