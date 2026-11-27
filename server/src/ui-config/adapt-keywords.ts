/** Versioned, deliberately small vocabulary. User text is never interpreted as instructions. */
export const LENS_IDS = ['sales', 'operations', 'support', 'engineering', 'research', 'creator', 'general'] as const;
export type LensId = typeof LENS_IDS[number];
export const FOCUS_IDS = ['tasks', 'bots', 'routines', 'usage', 'files', 'chat', 'apps', 'team'] as const;
export type FocusId = typeof FOCUS_IDS[number];
export const ADAPT_KEYWORDS: Readonly<Record<LensId, { focus: readonly FocusId[]; words: readonly string[] }>> = {
  sales: { focus: ['tasks', 'routines', 'bots'], words: ['sales', 'outbound', 'outreach', 'pipeline', 'leads', 'follow ups', 'followups', 'agency'] },
  operations: { focus: ['routines', 'usage', 'apps'], words: ['operations', 'reports', 'report', 'recurring', 'daily', 'manager', 'usage'] },
  support: { focus: ['tasks', 'chat', 'team'], words: ['support', 'queue', 'queues', 'response', 'customers', 'tickets', 'triage'] },
  engineering: { focus: ['tasks', 'bots', 'apps'], words: ['engineering', 'engineer', 'builds', 'reviews', 'code', 'deploy', 'bugs'] },
  research: { focus: ['files', 'bots', 'chat'], words: ['research', 'reading', 'synthesis', 'papers', 'sources', 'analysis', 'study'] },
  creator: { focus: ['files', 'routines', 'apps'], words: ['creator', 'content', 'calendar', 'publish', 'writing', 'posts', 'editorial'] },
  general: { focus: [], words: [] },
};
Object.values(ADAPT_KEYWORDS).forEach(entry => { Object.freeze(entry.focus); Object.freeze(entry.words); Object.freeze(entry); });
Object.freeze(ADAPT_KEYWORDS);
