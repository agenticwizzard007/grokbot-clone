import type Database from 'better-sqlite3';

/** Additive and idempotent. No per-user rows are created during deployment. */
export function initUiDatabase(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ui_config (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      doc TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      updated_by TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ui_config_history (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      doc TEXT NOT NULL,
      summary TEXT NOT NULL,
      actor TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(user_id, revision)
    );
    CREATE INDEX IF NOT EXISTS ui_config_history_user ON ui_config_history(user_id, revision DESC);
    CREATE TABLE IF NOT EXISTS ui_previews (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      base_revision INTEGER NOT NULL,
      patch TEXT NOT NULL,
      result_doc TEXT NOT NULL,
      summary TEXT NOT NULL,
      violations TEXT NOT NULL,
      id_map TEXT NOT NULL DEFAULT '{}',
      applied_revision INTEGER,
      intent TEXT NOT NULL,
      actor TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','applied','discarded','expired','superseded')),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ui_previews_user ON ui_previews(user_id, status, expires_at);
    CREATE TABLE IF NOT EXISTS ui_user_presets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      doc TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ui_user_presets_user ON ui_user_presets(user_id);
  `);
}

/** Shared by settings and isolated service fixtures. Flags are admin-only. */
export function initUiPreferences(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS account_preferences (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    ask_before_computer INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`);
  const columns = new Set((db.pragma('table_info(account_preferences)') as { name: string }[]).map(c => c.name));
  if (!columns.has('ui_agent_apply')) db.exec("ALTER TABLE account_preferences ADD COLUMN ui_agent_apply TEXT NOT NULL DEFAULT 'ask'");
  if (!columns.has('ui_custom_enabled')) db.exec('ALTER TABLE account_preferences ADD COLUMN ui_custom_enabled INTEGER DEFAULT NULL CHECK(ui_custom_enabled IN (0,1))');
}
