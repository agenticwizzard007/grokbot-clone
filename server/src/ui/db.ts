import type Database from 'better-sqlite3';

/** Additive and idempotent. No per-user rows are created during deployment. */
export function initUiDatabase(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ui_requirements (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      doc TEXT NOT NULL,
      revision INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      updated_by TEXT NOT NULL,
      adaptation TEXT NOT NULL DEFAULT '{}'
    );
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
      kind TEXT NOT NULL DEFAULT 'config',
      UNIQUE(user_id, kind, revision)
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
  const historyColumns = new Set((db.pragma('table_info(ui_config_history)') as { name: string }[]).map(c => c.name));
  if (!historyColumns.has('kind')) db.transaction(() => {
    // Preserve every existing row while giving each document its own revision stream.
    db.exec(`
      CREATE TABLE ui_config_history_kinds (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL, doc TEXT NOT NULL, summary TEXT NOT NULL,
        actor TEXT NOT NULL, created_at INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'config',
        UNIQUE(user_id, kind, revision)
      );
      INSERT INTO ui_config_history_kinds(id,user_id,revision,doc,summary,actor,created_at)
        SELECT id,user_id,revision,doc,summary,actor,created_at FROM ui_config_history;
      DROP TABLE ui_config_history;
      ALTER TABLE ui_config_history_kinds RENAME TO ui_config_history;
      CREATE INDEX ui_config_history_user ON ui_config_history(user_id,revision DESC);
    `);
  })();
  const previewColumns = new Set((db.pragma('table_info(ui_previews)') as { name: string }[]).map(c => c.name));
  if (!previewColumns.has('id_map')) db.exec("ALTER TABLE ui_previews ADD COLUMN id_map TEXT NOT NULL DEFAULT '{}'");
  if (!previewColumns.has('applied_revision')) db.exec('ALTER TABLE ui_previews ADD COLUMN applied_revision INTEGER');
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
  if (!columns.has('ui_adapt')) db.exec('ALTER TABLE account_preferences ADD COLUMN ui_adapt INTEGER DEFAULT NULL CHECK(ui_adapt IN (0,1))');
}
