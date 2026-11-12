import { db } from '../db.js';
import '../db-config.js';
import { legacyWritableRows } from '../platform/legacy-database-fence.js';

function column(table: string, name: string, ddl: string) {
  if (!(db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(c => c.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
}
column('skills', 'revision', 'INTEGER NOT NULL DEFAULT 1');
column('skills', 'deleted_at', 'INTEGER');
column('memories', 'status', "TEXT NOT NULL DEFAULT 'active'");
column('memories', 'revision', 'INTEGER NOT NULL DEFAULT 1');
column('memories', 'evidence', "TEXT NOT NULL DEFAULT '[]'");
column('memories', 'run_id', 'TEXT');
column('memories', 'supersedes', 'TEXT');

// Native transactional translation of Hermes skill_ledger.py:298-322,502-550,
// f0e7b68e439f8c1962fcf9dcb0341aadf1e2a898 (MIT). Snapshots are immutable and
// mutations/rollback append revisions atomically, rather than best-effort JSONL.
db.exec(`
CREATE TABLE IF NOT EXISTS knowledge_skill_revisions (
 skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
 bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL, snapshot TEXT NOT NULL, action TEXT NOT NULL,
 actor TEXT NOT NULL, evidence TEXT NOT NULL DEFAULT '[]', run_id TEXT,
 created_at INTEGER NOT NULL, PRIMARY KEY(skill_id,revision));
CREATE TRIGGER IF NOT EXISTS knowledge_revision_immutable BEFORE UPDATE ON knowledge_skill_revisions
 BEGIN SELECT RAISE(ABORT,'Skill revisions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS knowledge_revision_no_delete BEFORE DELETE ON knowledge_skill_revisions
 WHEN EXISTS(SELECT 1 FROM bots WHERE id=OLD.bot_id)
 BEGIN SELECT RAISE(ABORT,'Skill revisions are immutable'); END;
CREATE TABLE IF NOT EXISTS knowledge_skill_proposals (
 id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
 skill_id TEXT NOT NULL, base_revision INTEGER NOT NULL, generation INTEGER NOT NULL,
 snapshot TEXT NOT NULL, reason TEXT NOT NULL, evidence TEXT NOT NULL, run_id TEXT,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
 created_at INTEGER NOT NULL, resolved_at INTEGER, resolved_by TEXT);
CREATE INDEX IF NOT EXISTS knowledge_proposals_bot ON knowledge_skill_proposals(bot_id,status,created_at);
CREATE TABLE IF NOT EXISTS knowledge_memory_suppressions (
 bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, fingerprint TEXT NOT NULL,
 text TEXT NOT NULL, evidence TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(bot_id,fingerprint));
CREATE TABLE IF NOT EXISTS knowledge_memory_events (
 id INTEGER PRIMARY KEY, memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
 bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, action TEXT NOT NULL,
 snapshot TEXT NOT NULL, actor TEXT NOT NULL, created_at INTEGER NOT NULL);
INSERT OR IGNORE INTO knowledge_skill_revisions(skill_id,bot_id,revision,snapshot,action,actor,created_at)
 SELECT id,bot_id,revision,json_object('name',name,'description',description,'body',body,'deleted',deleted_at IS NOT NULL),
 'import','migration',coalesce(updated_at,created_at) FROM skills
 WHERE NOT EXISTS(SELECT 1 FROM knowledge_skill_revisions r WHERE r.skill_id=skills.id AND r.revision=skills.revision)
 AND ${legacyWritableRows(db, 'skills')};
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_messages_fts USING fts5(
 text,bot_id UNINDEXED,generation UNINDEXED,seq UNINDEXED,role UNINDEXED,created_at UNINDEXED,tokenize='unicode61');
CREATE TRIGGER IF NOT EXISTS knowledge_messages_insert AFTER INSERT ON rows
 WHEN NEW.kind='message' AND json_valid(NEW.body) AND json_extract(NEW.body,'$.type')='message'
 AND coalesce(json_extract(NEW.body,'$.streaming'),0)=0
 BEGIN INSERT INTO knowledge_messages_fts(rowid,text,bot_id,generation,seq,role,created_at)
 VALUES(NEW.rowid,json_extract(NEW.body,'$.text'),NEW.bot_id,NEW.generation,NEW.seq,json_extract(NEW.body,'$.role'),NEW.created_at); END;
CREATE TRIGGER IF NOT EXISTS knowledge_messages_delete AFTER DELETE ON rows
 BEGIN DELETE FROM knowledge_messages_fts WHERE rowid=OLD.rowid; END;
CREATE TRIGGER IF NOT EXISTS knowledge_messages_update AFTER UPDATE OF body,kind ON rows
 BEGIN DELETE FROM knowledge_messages_fts WHERE rowid=OLD.rowid;
 INSERT INTO knowledge_messages_fts(rowid,text,bot_id,generation,seq,role,created_at)
 SELECT NEW.rowid,json_extract(NEW.body,'$.text'),NEW.bot_id,NEW.generation,NEW.seq,json_extract(NEW.body,'$.role'),NEW.created_at
 WHERE NEW.kind='message' AND json_valid(NEW.body) AND json_extract(NEW.body,'$.type')='message'
 AND coalesce(json_extract(NEW.body,'$.streaming'),0)=0; END;
CREATE TABLE IF NOT EXISTS knowledge_migrations (name TEXT PRIMARY KEY);
`);
db.transaction(() => {
  if (!db.prepare("SELECT 1 FROM knowledge_migrations WHERE name='fts-v1'").get()) {
    db.exec(`INSERT OR REPLACE INTO knowledge_messages_fts(rowid,text,bot_id,generation,seq,role,created_at)
      SELECT rowid,json_extract(body,'$.text'),bot_id,generation,seq,json_extract(body,'$.role'),created_at FROM rows
      WHERE kind='message' AND json_valid(body) AND json_extract(body,'$.type')='message' AND coalesce(json_extract(body,'$.streaming'),0)=0;
      INSERT INTO knowledge_migrations VALUES('fts-v1');`);
  }
})();
