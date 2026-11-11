import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { env } from './env.js';
import crypto from 'node:crypto';
import { deploymentRole, isTenant, tenantId, validateDeployment } from './deployment.js';
import { registerLegacyFenceFunctions, assertLegacyDatabaseFences } from './platform/legacy-database-fence.js';

validateDeployment();
if (!['standalone','tenant'].includes(deploymentRole)) throw new Error('Platform services cannot open application SQLite databases.');

fs.mkdirSync(path.dirname(env.dbPath), { recursive: true });
export const db = new Database(env.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.function('session_hash', (t: unknown) => crypto.createHash('sha256').update(String(t)).digest('hex'));
registerLegacyFenceFunctions(db);
assertLegacyDatabaseFences(db);
if (isTenant) {
  const manifest = JSON.parse(fs.readFileSync(process.env.TENANT_MANIFEST_FILE!, 'utf8'));
  if (manifest.tenantId !== tenantId || !manifest.volumeId || manifest.volumeId !== process.env.SWARM_VOLUME_ID) throw new Error('Volume ownership mismatch.');
  db.exec('CREATE TABLE IF NOT EXISTS tenant_identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), tenant_id TEXT NOT NULL)');
  const existing = db.prepare('SELECT tenant_id FROM tenant_identity WHERE singleton=1').get() as { tenant_id: string } | undefined;
  if (existing && existing.tenant_id !== tenantId) throw new Error('Database ownership mismatch.');
  db.prepare('INSERT OR IGNORE INTO tenant_identity VALUES(1,?)').run(tenantId);
}

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  avatar_url TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS login_attempts (
  id TEXT PRIMARY KEY,
  provisional_user_id TEXT NOT NULL,
  connected_account_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS computers (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  orgo_id TEXT,
  status TEXT NOT NULL DEFAULT 'absent',
  error TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS screens (
  bot_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  screen_id TEXT NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  avatar_shape TEXT NOT NULL DEFAULT 'blob',
  avatar_color TEXT NOT NULL DEFAULT 'blue',
  mode TEXT NOT NULL DEFAULT 'personal',
  is_primary INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  effort TEXT NOT NULL DEFAULT 'medium',
  generation INTEGER NOT NULL DEFAULT 1,
  next_seq INTEGER NOT NULL DEFAULT 1,
  rev INTEGER NOT NULL DEFAULT 0,
  unread INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_setups (
  bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
  brief TEXT NOT NULL,
  source TEXT NOT NULL,
  computer_status TEXT NOT NULL DEFAULT 'pending',
  computer_error TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rows (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (bot_id, generation, seq)
);
CREATE INDEX IF NOT EXISTS rows_rev ON rows(bot_id, updated_seq);
CREATE TABLE IF NOT EXISTS llm_items (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  item TEXT NOT NULL,
  PRIMARY KEY (bot_id, generation, idx)
);
CREATE TABLE IF NOT EXISTS pending_turns (
  bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
  state TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  row_seq INTEGER NOT NULL,
  call_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE TABLE IF NOT EXISTS policies (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool TEXT NOT NULL,
  mode TEXT NOT NULL,
  PRIMARY KEY (user_id, tool)
);
CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  schedule TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'working',
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS server_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS companion_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);
CREATE TABLE IF NOT EXISTS composio_sessions (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL
);
`);

// Idempotent column migrations for tables that predate a column.
function addColumn(table: string, col: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}
addColumn('composio_sessions', 'key_fingerprint', 'TEXT');
addColumn('approvals', 'binding_hash', 'TEXT');
addColumn('bots', 'voice', "TEXT NOT NULL DEFAULT 'luna'");
addColumn('bots', 'model', 'TEXT'); // per-Bot model (OpenRouter id like "anthropic/claude-sonnet-5.5", or a direct provider model); NULL = server default
addColumn('bots', 'voice_speed', 'REAL NOT NULL DEFAULT 1');
addColumn('bots', 'voice_language', "TEXT NOT NULL DEFAULT 'auto'");
addColumn('bots', 'fast', 'INTEGER NOT NULL DEFAULT 0'); // OpenRouter :nitro routing
addColumn('users', 'favorite_models', 'TEXT'); // JSON array of model ids, in the user's order
// Existing agents keep working; new teammates explicitly start in interviewing state.
addColumn('bot_setups', 'onboarding_status', "TEXT NOT NULL DEFAULT 'active'");
addColumn('bot_setups', 'revision', 'INTEGER NOT NULL DEFAULT 1');
addColumn('bot_setups', 'confirmed_at', 'INTEGER');
addColumn('bot_setups', 'pending_handoff', 'TEXT');
addColumn('auth_sessions', 'last_seen_at', 'INTEGER NOT NULL DEFAULT 0');
addColumn('auth_sessions', 'authenticated_at', 'INTEGER NOT NULL DEFAULT 0');
// Preserve standalone rename continuity by hashing existing bearer tokens once.
// In-flight legacy linking attempts are revoked when the old row is deleted;
// migration never refreshes authentication time or extends absolute expiry.
if (deploymentRole === 'standalone') db.transaction(() => {
  const legacy = db.prepare("SELECT * FROM auth_sessions WHERE length(token)<>64 OR token GLOB '*[^a-f0-9]*'").all() as { token: string; user_id: string; created_at: number; expires_at: number; last_seen_at: number; authenticated_at: number }[];
  const put = db.prepare('INSERT OR IGNORE INTO auth_sessions(token,user_id,created_at,expires_at,last_seen_at,authenticated_at) VALUES (?,?,?,?,?,?)');
  for (const row of legacy) put.run(crypto.createHash('sha256').update(row.token).digest('hex'), row.user_id, row.created_at, Math.min(row.expires_at, row.created_at + 7 * 86400_000), row.last_seen_at, row.authenticated_at);
})();
// Tenant migrations do not preserve old sessions. No bearer credential remains.
db.prepare("DELETE FROM auth_sessions WHERE length(token)<>64 OR token GLOB '*[^a-f0-9]*'").run();
db.exec(`CREATE TABLE IF NOT EXISTS account_roles (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 role TEXT NOT NULL CHECK(role='admin'), PRIMARY KEY(user_id,role));`);
if (isTenant) {
  if (db.prepare('SELECT 1 FROM users WHERE id<>? LIMIT 1').get(tenantId)) throw new Error('Foreign accounts in tenant database.');
  db.exec(`CREATE TRIGGER IF NOT EXISTS tenant_users_insert BEFORE INSERT ON users
    WHEN NEW.id <> (SELECT tenant_id FROM tenant_identity WHERE singleton=1)
    BEGIN SELECT RAISE(ABORT, 'Tenant identity mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS tenant_users_update BEFORE UPDATE OF id ON users
    WHEN NEW.id <> (SELECT tenant_id FROM tenant_identity WHERE singleton=1)
    BEGIN SELECT RAISE(ABORT, 'Tenant identity mismatch'); END;`);
}

export const now = () => Date.now();
