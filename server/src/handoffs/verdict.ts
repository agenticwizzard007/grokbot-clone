import type { CheckedVerdict, ExitRule, Verdict } from './contracts.js';
import { verdictSchema } from './schema.js';
import { HandoffError } from './errors.js';

export function recomputeVerdict(input: Verdict, exit: ExitRule): CheckedVerdict {
  const parsed = verdictSchema.safeParse(input);
  if (!parsed.success) throw new HandoffError('invalid_input', parsed.error.message);
  const verdict = parsed.data, answers = new Map(verdict.checklist.map(item => [item.id, item]));
  if (answers.size !== verdict.checklist.length) throw new HandoffError('invalid_input', 'Answer each checklist item once');
  let pass = verdict.pass;
  if (exit.mode === 'manual') pass = false;
  if (exit.mode === 'checklist') {
    const known = new Set(exit.items.map(item => item.id));
    if (known.size !== exit.items.length || verdict.checklist.some(item => !known.has(item.id))) throw new HandoffError('invalid_input', 'Unknown or duplicate checklist item');
    if (exit.items.some(item => item.required && !answers.has(item.id))) throw new HandoffError('invalid_input', 'Answer every required checklist item');
    pass = exit.items.every(item => !item.required || answers.get(item.id)?.pass === true)
      && (exit.minScore === undefined || (verdict.score !== undefined && verdict.score >= exit.minScore));
  }
  return { ...verdict, pass, claimedPass: verdict.pass, corrected: pass !== verdict.pass };
}
export interface IterationResult {
  iteration: number; outputId: string; contentHash: string; feedbackHash: string; verdict?: Verdict;
}
export function detectStall(history: readonly IterationResult[]): { stalled: boolean; scoreWarning: boolean } {
  const rows = [...history].sort((a, b) => a.iteration - b.iteration);
  const [a, b, c] = rows.slice(-3);
  const last = rows.at(-1), previous = rows.at(-2);
  const consecutive = !!last && !!previous && last.iteration === previous.iteration + 1;
  const triple = !!a && !!b && !!c && b.iteration === a.iteration + 1 && c.iteration === b.iteration + 1;
  return {
    stalled: consecutive && (!!last.contentHash && last.contentHash === previous.contentHash
      || triple && !!a.feedbackHash && a.feedbackHash === b.feedbackHash && b.feedbackHash === c.feedbackHash),
    scoreWarning: triple && a.verdict?.score !== undefined && b.verdict?.score !== undefined && c.verdict?.score !== undefined
      && b.verdict.score <= a.verdict.score && c.verdict.score <= a.verdict.score,
  };
}
export function selectBestOutput(history: readonly IterationResult[], exit: ExitRule): IterationResult | null {
  const score = (row: IterationResult) => exit.mode === 'checklist'
    ? exit.items.filter(item => item.required && row.verdict?.checklist.some(answer => answer.id === item.id && answer.pass)).length
    : row.verdict?.checklist.filter(item => item.pass).length ?? 0;
  return [...history].sort((a, b) => score(b) - score(a) || b.iteration - a.iteration || (a.outputId < b.outputId ? -1 : 1))[0] ?? null;
}
