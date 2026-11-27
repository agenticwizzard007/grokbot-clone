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
