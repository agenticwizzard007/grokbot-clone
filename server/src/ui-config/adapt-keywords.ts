// Legacy lens ids remain readable in stored profiles, but no longer influence the app.
export const LENS_IDS = ['sales', 'operations', 'support', 'engineering', 'research', 'creator', 'general'] as const;
export const FOCUS_IDS = ['tasks', 'bots', 'routines', 'usage', 'files', 'chat', 'apps', 'team'] as const;
export type FocusId = typeof FOCUS_IDS[number];
/** Small deterministic map for dashboard content only. */
export const DASHBOARD_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  tasks: ['task', 'tasks', 'sales', 'outreach', 'pipeline', 'support', 'queue', 'content', 'review'],
  routines: ['routine', 'routines', 'daily', 'weekly', 'recurring', 'calendar'],
  usage: ['usage', 'cost', 'budget', 'operations', 'requests'],
  bots: ['bot', 'bots', 'team', 'assistant'],
  runs: ['engineering', 'build', 'builds', 'code', 'deploy', 'runs'],
};
