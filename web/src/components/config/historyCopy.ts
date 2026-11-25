const subjects: Record<string, string> = {
  setup: 'Setup', profile: 'Bot profile', skill: 'Skill', memory: 'Memory',
  'skill-proposal': 'Skill suggestion', 'memory-proposal': 'Memory suggestion',
  evaluation: 'Skill check', 'regression-check': 'Skill check',
  'promotion-policy': 'Skill approval rules', 'skill-lifecycle': 'Skill', 'learning-settings': 'Learning settings',
};
const actions: Record<string, string> = {
  updated: 'updated', update: 'updated', edit: 'updated', created: 'created', create: 'created',
  deleted: 'deleted', delete: 'deleted', archived: 'archived', archive: 'archived',
  pending: 'ready for review', approved: 'approved', rejected: 'declined',
  activated: 'activated', restored: 'restored', rollback: 'restored',
  'policy-updated': 'updated', 'settings-updated': 'updated',
  active: 'enabled', suspended: 'paused', retired: 'retired',
  passed: 'passed', failed: 'failed', accepted: 'approved', dismissed: 'dismissed',
  baseline: 'saved', recorded: 'recorded', completed: 'completed',
};

/** Unknown internal event names stay in Technical details, not in the customer summary. */
export function historySummary(kind: string, action: string): string {
  return `${subjects[kind.replaceAll('_', '-')] ?? 'Change'} ${actions[action] ?? 'recorded'}`;
}
