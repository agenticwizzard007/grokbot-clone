// Mutation results are spoken to customers. Keep handles and revisions in the
// read/list tools, not in confirmations that a model might abbreviate.
export function skillConfirmation(result: any): string {
  const name = result.skill?.name ?? result.proposal?.name;
  if (result.proposal?.status === 'superseded') return `The skill "${name}" is already saved. This proposal does not need review.`;
  if (!result.activated) return `Proposed changes to the skill "${name}" for review. They are not active yet.`;
  return result.skill?.deleted ? `Archived the skill "${name}".` : `Saved the skill "${name}". It is active now.`;
}

export function memoryConfirmation(result: any): string {
  if (result.results) return result.results.map(memoryConfirmation).join('\n');
  if (result.skipped === 'suppressed') return 'This fact was not saved because it was previously forgotten or replaced.';
  if (result.skipped === 'duplicate') return 'This fact is already saved in memory.';
  if (result.change) return 'Proposed a memory change for review. It is not active yet.';
  if (result.deleted) return 'Forgot the saved memory.';
  return `Saved to memory: ${result.memory.text}`;
}
