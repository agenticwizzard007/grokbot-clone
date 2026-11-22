import type { AgentSetupView, ComputerState } from '@shared/types';
import { useStore } from '../../store';

/**
 * R2F-021: one source for computer readiness copy, used by the coworker setup card, Details Activity
 * and the Setup tab, so the same state reads the same words everywhere.
 */
export function computerStatusText(computer: ComputerState | null): string {
  if (computer?.provider === 'local') return computer.status === 'running' ? 'Connected' : 'Not connected';
  switch (computer?.status) {
    case 'running': return 'Awake';
    case 'starting': case 'resuming': case 'creating': return 'Agent waking up';
    case 'suspending': return 'Going to sleep…';
    case 'error': return 'Unreachable';
    default: return 'Asleep';
  }
}

type SetupComputer = Pick<AgentSetupView['computer'], 'status'> | null | undefined;

/** The Bot's setup must finish preparing its computer first; after that the live computer state applies. */
export function computerReadiness(computer: ComputerState | null, setup?: SetupComputer): string {
  return setup?.status === 'pending' ? 'Preparation pending' : computerStatusText(computer);
}

/** "Computer: Awake", "Computer: Preparation pending", "Computer: Not connected". */
export const computerStatusLine = (computer: ComputerState | null, setup?: SetupComputer) => `Computer: ${computerReadiness(computer, setup)}`;

/** The status line as text, reading the live computer from the store. */
export function ComputerStatusLine({ setup }: { setup?: SetupComputer }) {
  const computer = useStore(state => state.computer);
  return <>{computerStatusLine(computer, setup)}</>;
}
