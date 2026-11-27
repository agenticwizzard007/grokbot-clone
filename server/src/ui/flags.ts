import type Database from 'better-sqlite3';

/** Explicit account values override the deployment default, including stage 1. */
export function uiEnabled(db: Database.Database, userId: string, globalFlag = process.env.UI_CUSTOMIZATION): boolean {
  const row = db.prepare('SELECT ui_custom_enabled FROM account_preferences WHERE user_id=?').get(userId) as { ui_custom_enabled: number | null } | undefined;
  return row?.ui_custom_enabled == null ? globalFlag === 'on' : row.ui_custom_enabled === 1;
}

export function uiAgentApplyMode(db: Database.Database, userId: string): 'ask' | 'auto' {
  const row = db.prepare('SELECT ui_agent_apply FROM account_preferences WHERE user_id=?').get(userId) as { ui_agent_apply: string } | undefined;
  return row?.ui_agent_apply === 'auto' ? 'auto' : 'ask';
}

/** Dark launch, staff, stable ten-percent cohort, and full rollout. */
export function uiAdaptEnabled(db: Database.Database, userId: string, stage = process.env.UI_ADAPT, staff = process.env.UI_ADAPT_STAFF_IDS ?? ''): boolean {
  const row = db.prepare('SELECT ui_adapt FROM account_preferences WHERE user_id=?').get(userId) as { ui_adapt: number | null } | undefined;
  if (row?.ui_adapt != null) return row.ui_adapt === 1;
  if (stage === '100' || stage === 'on') return true;
  if (stage === 'staff') return staff.split(',').map(id => id.trim()).includes(userId);
  if (stage !== '10') return false;
  let hash = 2166136261;
  for (const char of userId) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return hash % 100 < 10;
}
