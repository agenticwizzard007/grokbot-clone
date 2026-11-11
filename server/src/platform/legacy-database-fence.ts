import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { parseEvent } from '../messaging/inkbox/events.js';

const TABLE = 'legacy_owner_fences';
const PREFIX = 'swarm_legacy_fence_';
const VERSION = 1;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
interface Table { name: string; sql: string; columns: string[]; foreign: { table: string; from: string; to: string; seq?: number }[] }
export interface DatabaseFence { tenant: string; operation: string; fence: string; schemaHash: string; version: 1; boundary: 'database-only' }

function present(db: Database.Database) { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(TABLE); }
function tables(db: Database.Database): Table[] {
  return (db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!=? ORDER BY name").all(TABLE) as { name: string; sql: string }[])
    .map(row => ({ ...row, columns: (db.prepare(`PRAGMA table_info(${quote(row.name)})`).all() as { name: string }[]).map(c => c.name), foreign: db.prepare(`PRAGMA foreign_key_list(${quote(row.name)})`).all() as Table['foreign'] }));
}
function schemaHash(db: Database.Database, schema: Table[]) {
  const objects = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND tbl_name!=? AND substr(name,1,?)!=? ORDER BY type,name").all(TABLE, PREFIX.length, PREFIX);
  return createHash('sha256').update(JSON.stringify([VERSION, schema, objects])).digest('hex');
}

/** Pure decoder only: trigger functions must not query the busy SQLite connection.
 * A legacy binary lacking this function fails closed on messaging writes. */
export function registerLegacyFenceFunctions(db: Database.Database) {
  db.function('swarm_legacy_inbox_phone', { deterministic: true }, (source: unknown, payload: unknown) => {
    if (source !== 'inkbox' || typeof payload !== 'string' || Buffer.byteLength(payload) > 1024 * 1024) return null;
    try { return parseEvent(JSON.parse(payload))?.phone ?? null; } catch { return null; }
  });
}

/** Compile ownership to SQL, so late writers on another connection/process are
 * also fenced. Unknown schemas are refused, including empty extension tables.
 * server_settings is shared platform configuration and never tenant-exported. */
function ownerQueries(table: Table, alias: string, schema: Map<string, Table>, trail: string[] = []): string[] {
  const col = (name: string) => `${alias}.${quote(name)}`;
  if (table.name === 'users') return [`SELECT ${col('id')} AS owner`];
  if (table.name === 'server_settings') return [];
  if (trail.includes(table.name)) return table.columns.includes('user_id') ? [`SELECT ${col('user_id')} AS owner`] : [];
  const queries: string[] = [], refs = [...table.foreign];
  const reference = (from: string, target: string, to: string) => {
    if (table.columns.includes(from) && schema.has(target) && !refs.some(r => r.from === from && r.table === target && (r.to || 'id') === to)) refs.push({ from, table: target, to });
  };
  for (const name of ['user_id', 'provisional_user_id', 'link_user_id', 'attach_user_id', 'created_by']) reference(name, 'users', 'id');
  for (const name of ['bot_id', 'parent_bot_id', 'active_bot_id', 'from_bot_id', 'to_bot_id']) reference(name, 'bots', 'id');
  reference('link_session', 'auth_sessions', 'token');
  reference('connection_id', 'mcp_servers', 'id');
  reference('vm_id', 'vms', 'vm_id');
  reference('invite_code', 'messaging_invites', 'code');
  for (const ref of refs) {
    const parent = schema.get(ref.table);
    if (!parent) throw new Error(`Legacy ownership mapping is missing: ${table.name}.${ref.from}`);
    if (parent.name === 'users' && (ref.to || 'id') === 'id') {
      // Check the identity itself, even when a historical nullable reference no
      // longer resolves. A missing parent must not bypass a held identity.
      queries.push(`SELECT ${col(ref.from)} AS owner`); continue;
    }
    const next = `p${trail.length}`;
    const parents = ownerQueries(parent, next, schema, [...trail, table.name]);
    if (parents.length) queries.push(`SELECT u${trail.length}.id AS owner FROM ${quote(parent.name)} AS ${next} JOIN users AS u${trail.length} ON u${trail.length}.id IN (${parents.join(' UNION ALL ')}) WHERE ${next}.${quote(ref.to || 'id')}=${col(ref.from)}`);
  }
  // Phone ownership is stable while the user's own row is fenced.
  if (table.columns.includes('phone') && schema.get('users')?.columns.includes('phone')) queries.push(`SELECT id AS owner FROM users WHERE phone=${col('phone')} AND phone IS NOT NULL AND phone!=''`);
  if (table.name === 'messaging_inbox') {
    if (!schema.get('users')?.columns.includes('phone')) throw new Error('Legacy inbox phone ownership is unavailable.');
    queries.push(`SELECT id AS owner FROM users WHERE phone=swarm_legacy_inbox_phone(${col('source')},${col('payload')}) AND phone IS NOT NULL AND phone!=''`);
  }
  if (table.name === 'bots' && table.columns.includes('members')) queries.push(`SELECT b.user_id AS owner FROM bots b JOIN json_each(CASE WHEN ${col('members')} IS NULL THEN '[]' ELSE ${col('members')} END) m ON m.value=b.id`);
  return [...new Set(queries)];
}

function triggers(schema: Table[]) {
  const byName = new Map(schema.map(table => [table.name, table]));
  if (!byName.get('users')?.columns.includes('id')) throw new Error('Legacy users table is required.');
  if (byName.has('tenant_identity')) throw new Error('An isolated database is not a legacy migration source.');
  const output: { name: string; sql: string }[] = [];
  for (const table of schema) {
    if (/CREATE VIRTUAL TABLE/i.test(table.sql)) throw new Error('Legacy virtual tables require an explicit ownership migration.');
    if (table.foreign.some(ref => (ref.seq ?? 0) > 0)) throw new Error('Legacy composite foreign keys require explicit ownership migration.');
    const queries = (alias: string) => ownerQueries(table, alias, byName);
    if (table.name === 'server_settings') continue;
    if (!queries('NEW').length) throw new Error(`Legacy ownership mapping is missing: ${table.name}`);
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
      const owners = (operation === 'UPDATE' ? ['OLD', 'NEW'] : [operation === 'DELETE' ? 'OLD' : 'NEW']).flatMap(queries);
      const name = `${PREFIX}${createHash('sha256').update(`${table.name}:${operation}`).digest('hex').slice(0, 24)}`;
      output.push({ name, sql: `CREATE TRIGGER ${quote(name)} BEFORE ${operation} ON ${quote(table.name)}
        WHEN EXISTS(SELECT 1 FROM ${TABLE} WHERE tenant_id IN (${owners.join(' UNION ALL ')}) AND state='held')
        BEGIN SELECT RAISE(ABORT,'legacy_account_migration_hold'); END` });
    }
  }
  return output;
}

function replacementTriggers(db: Database.Database, schema: Table[]) {
  const byName = new Map(schema.map(table => [table.name, table])), output: { name: string; sql: string }[] = [];
  for (const table of schema) {
    if (table.name === 'server_settings') continue;
    // REPLACE's implicit deletes can skip delete triggers on another connection.
    // Guard every unique conflict, including rowid and index-specific collation.
    const indexes = db.prepare(`PRAGMA index_list(${quote(table.name)})`).all() as { name: string; unique: number; partial: number }[];
    const guards: { name: string; condition: string }[] = [];
    if (!/WITHOUT\s+ROWID/i.test(table.sql)) {
      const rowid = ['rowid', '_rowid_', 'oid'].find(name => !table.columns.includes(name));
      if (!rowid) throw new Error('Legacy rowid shadowing requires explicit migration.');
      guards.push({ name: 'rowid', condition: `prior.${rowid}=NEW.${rowid}` });
    }
    for (const index of indexes.filter(index => index.unique)) {
      const columns = (db.prepare(`PRAGMA index_xinfo(${quote(index.name)})`).all() as { name: string | null; key: number; coll: string }[]).filter(c => c.key);
      if (columns.some(c => c.name === null)) throw new Error('Legacy expression unique indexes require explicit migration.');
      // Including rows outside a partial index is conservative and blocks only
      // conflicting held data; it cannot allow REPLACE to bypass ownership.
      guards.push({ name: index.name, condition: columns.map(c => `prior.${quote(c.name!)} COLLATE ${quote(c.coll)}=NEW.${quote(c.name!)}`).join(' AND ') });
    }
    for (const guard of guards) {
      const owners = ownerQueries(table, 'prior', byName);
      for (const operation of ['INSERT', 'UPDATE']) {
        const name = `${PREFIX}${createHash('sha256').update(`${table.name}:${guard.name}:${operation}:replace`).digest('hex').slice(0, 24)}`;
        output.push({ name, sql: `CREATE TRIGGER ${quote(name)} BEFORE ${operation} ON ${quote(table.name)}
          WHEN EXISTS(SELECT 1 FROM ${quote(table.name)} prior WHERE ${guard.condition} AND EXISTS(SELECT 1 FROM ${TABLE} WHERE state='held' AND tenant_id IN (${owners.join(' UNION ALL ')})))
          BEGIN SELECT RAISE(ABORT,'legacy_account_migration_hold'); END` });
      }
    }
  }
  return output;
}
function expected(db: Database.Database, schema = tables(db)) { return [...triggers(schema), ...replacementTriggers(db, schema)]; }
function normalize(sql: string) { return sql.replace(/\s+/g, ' ').trim(); }

/** Called at startup before accepting work. Never repair a changed schema or a
 * missing fence silently; a trusted migration maintenance operation must review it. */
export function assertLegacyDatabaseFences(db: Database.Database) {
  if (!present(db) || !db.prepare(`SELECT 1 FROM ${TABLE} WHERE state='held' LIMIT 1`).get()) return;
  const schema = tables(db), hash = schemaHash(db, schema);
  if (db.prepare(`SELECT 1 FROM ${TABLE} WHERE state='held' AND (schema_hash!=? OR version!=?) LIMIT 1`).get(hash, VERSION)) throw new Error('Legacy migration schema changed; source must remain stopped.');
  const installed = new Map((db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE ?").all(`${PREFIX}%`) as { name: string; sql: string }[]).map(row => [row.name, normalize(row.sql)]));
  for (const trigger of expected(db, schema)) if (installed.get(trigger.name) !== normalize(trigger.sql)) throw new Error('Legacy database fence is missing or changed; source must remain stopped.');
}
export function legacyAccountHeld(db: Database.Database, tenant: string) {
  return present(db) && !!db.prepare(`SELECT 1 FROM ${TABLE} WHERE tenant_id=? AND state='held'`).get(tenant);
}
export function legacyHeldOwners(db: Database.Database): string[] {
  return present(db) ? (db.prepare(`SELECT tenant_id FROM ${TABLE} WHERE state='held'`).all() as { tenant_id: string }[]).map(row => row.tenant_id) : [];
}

/** For trusted housekeeping SQL only; never use a caller-supplied table/alias. */
export function legacyWritableRows(db: Database.Database, tableName: string): string {
  if (!legacyHeldOwners(db).length) return '1';
  const schema = new Map(tables(db).map(t => [t.name, t]));
  const table = schema.get(tableName);
  if (!table) throw new Error('Unknown legacy housekeeping table.');
  const queries = ownerQueries(table, quote(tableName), schema);
  return queries.length ? `NOT EXISTS (SELECT 1 FROM (${queries.join(' UNION ')}) owned JOIN ${TABLE} held ON held.tenant_id=owned.owner AND held.state='held')` : '1';
}

export function assertLegacyFenceCurrent(db: Database.Database, receipt: DatabaseFence) {
  assertLegacyDatabaseFences(db);
  if (!present(db) || !db.prepare(`SELECT 1 FROM ${TABLE} WHERE tenant_id=? AND operation=? AND CAST(fence AS TEXT)=? AND schema_hash=? AND state='held' AND version=?`).get(receipt.tenant, receipt.operation, receipt.fence, receipt.schemaHash, receipt.version)) throw new Error('Legacy migration fence changed; source remains held.');
}

/** Trusted local maintenance primitive, not a public API and not proof of file
 * or process quiescence. Callers must not turn this receipt into SourceCheckpoint.
 * There is deliberately no release method until reconciled rollback is wired. */
export function holdLegacyDatabase(db: Database.Database, tenant: string, operation: string, fence: string): DatabaseFence {
  if (!/^usr_[A-Za-z0-9_-]{8,100}$/.test(tenant) || !/^[A-Za-z0-9_:-]{16,180}$/.test(operation) || !/^[1-9]\d{0,18}$/.test(fence) || BigInt(fence) > 9223372036854775807n) throw new Error('Invalid legacy migration fence.');
  registerLegacyFenceFunctions(db);
  return db.transaction((): DatabaseFence => {
    assertLegacyDatabaseFences(db);
    if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(tenant)) throw new Error('Legacy account not found.');
    const schema = tables(db), hash = schemaHash(db, schema), definitions = expected(db, schema);
    db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE}(tenant_id TEXT PRIMARY KEY,operation TEXT NOT NULL,fence INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('held','released')),schema_hash TEXT NOT NULL,version INTEGER NOT NULL,updated_at INTEGER NOT NULL)`);
    const current = db.prepare(`SELECT operation,CAST(fence AS TEXT) AS fence,state FROM ${TABLE} WHERE tenant_id=?`).get(tenant) as { operation: string; fence: string; state: string } | undefined;
    if (current && (current.operation !== operation || current.state !== 'held' || BigInt(current.fence) > BigInt(fence))) throw new Error('Legacy migration fence superseded or requires reconciliation.');
    for (const trigger of definitions) db.exec(trigger.sql.replace('CREATE TRIGGER ', 'CREATE TRIGGER IF NOT EXISTS '));
    db.prepare(`INSERT INTO ${TABLE} VALUES(?,?,?,'held',?,?,?) ON CONFLICT(tenant_id) DO UPDATE SET fence=excluded.fence,updated_at=excluded.updated_at`).run(tenant, operation, BigInt(fence), hash, VERSION, Date.now());
    assertLegacyDatabaseFences(db);
    return { tenant, operation, fence, schemaHash: hash, version: VERSION, boundary: 'database-only' };
  }).immediate();
}
