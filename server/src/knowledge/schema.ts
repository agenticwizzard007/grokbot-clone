import { db } from '../db.js';
import '../db-config.js';
import '../agent/jobs.js';
import { assertLegacyDatabaseFences, legacyWritableRows } from '../platform/legacy-database-fence.js';

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
column('memories', 'effective_at', 'INTEGER');
column('memories', 'superseded_revision', 'INTEGER');

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

// Native Hermes learning domain: owner keys let tenant migration discover every
// row. Additive defaults leave all previously pending proposals pending.
for (const [name, ddl] of Object.entries({ resources: "TEXT NOT NULL DEFAULT '{}'", locked: 'INTEGER NOT NULL DEFAULT 0', pinned: 'INTEGER NOT NULL DEFAULT 0', managed: 'INTEGER NOT NULL DEFAULT 1', scope: "TEXT NOT NULL DEFAULT 'private'", project_id: 'TEXT', last_used_at: 'INTEGER', curator_seen_at: 'INTEGER', lifecycle: "TEXT NOT NULL DEFAULT 'active'" })) column('skills', name, ddl);
for (const [name, ddl] of Object.entries({ target: "TEXT NOT NULL DEFAULT 'user'", evidence_kind: "TEXT NOT NULL DEFAULT 'human'", scope: "TEXT NOT NULL DEFAULT 'private'", project_id: 'TEXT' })) column('memories', name, ddl);
column('memory_jobs', 'cursor_generation', 'INTEGER NOT NULL DEFAULT 0');
column('memory_jobs', 'cursor_seq', 'INTEGER NOT NULL DEFAULT 0');
for(const [name,ddl] of Object.entries({fragment_generation:'INTEGER',fragment_seq:'INTEGER',fragment_offset:'INTEGER NOT NULL DEFAULT 0',fragment_hash:'TEXT'}))column('memory_jobs',name,ddl);
db.exec(`
CREATE TABLE IF NOT EXISTS knowledge_learning_settings (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 bot_id TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL, settings TEXT NOT NULL,
 updated_at INTEGER NOT NULL, PRIMARY KEY(user_id,bot_id));
CREATE TABLE IF NOT EXISTS knowledge_learning_state (
 bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 foreground_epoch INTEGER NOT NULL DEFAULT 0, memory_turns INTEGER NOT NULL DEFAULT 0,
 skill_iterations INTEGER NOT NULL DEFAULT 0, last_foreground_at INTEGER NOT NULL DEFAULT 0,
 curator_last_at INTEGER);
CREATE TABLE IF NOT EXISTS knowledge_learning_turns (
 job_id TEXT PRIMARY KEY REFERENCES agent_jobs(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS knowledge_learning_reviews (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
 job_id TEXT NOT NULL REFERENCES agent_jobs(id) ON DELETE CASCADE,
 parent_job_id TEXT REFERENCES agent_jobs(id) ON DELETE SET NULL,
 status TEXT NOT NULL DEFAULT 'queued', reason TEXT NOT NULL,
 review_memory INTEGER NOT NULL, review_skills INTEGER NOT NULL,
 model TEXT NOT NULL, provider TEXT NOT NULL, settings_revision TEXT NOT NULL,
 foreground_epoch INTEGER NOT NULL, generation INTEGER NOT NULL,
 snapshot TEXT NOT NULL, source_snapshot TEXT NOT NULL, settings TEXT NOT NULL,
 context_window INTEGER, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
 iterations INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0,
 output_tokens INTEGER NOT NULL DEFAULT 0, summary TEXT, error TEXT, claim TEXT);
CREATE INDEX IF NOT EXISTS knowledge_reviews_queue ON knowledge_learning_reviews(status,created_at);
CREATE TABLE IF NOT EXISTS knowledge_memory_changes (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
 memory_id TEXT REFERENCES memories(id) ON DELETE CASCADE, base_revision INTEGER NOT NULL,
 generation INTEGER NOT NULL, action TEXT NOT NULL, text TEXT, target TEXT NOT NULL,
 evidence TEXT NOT NULL, run_id TEXT, status TEXT NOT NULL DEFAULT 'pending',
 created_at INTEGER NOT NULL, resolved_at INTEGER);
CREATE TABLE IF NOT EXISTS knowledge_grants (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
 source_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
 kind TEXT NOT NULL, source_id TEXT NOT NULL, project_id TEXT,
 PRIMARY KEY(kind,source_id,bot_id));
CREATE TABLE IF NOT EXISTS knowledge_use_receipts (
 id INTEGER PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
 job_id TEXT NOT NULL, kind TEXT NOT NULL, source_id TEXT NOT NULL, revision INTEGER NOT NULL,
 resource TEXT NOT NULL DEFAULT '', hash TEXT NOT NULL, actor TEXT NOT NULL, created_at INTEGER NOT NULL,
 UNIQUE(job_id,kind,source_id,revision,resource,actor));
CREATE TRIGGER IF NOT EXISTS knowledge_receipt_immutable BEFORE UPDATE ON knowledge_use_receipts
 BEGIN SELECT RAISE(ABORT,'Knowledge receipts are immutable'); END;
`);

column('knowledge_learning_reviews','knowledge_snapshot',"TEXT NOT NULL DEFAULT '[]'");
// Receipts cascade directly from both users and bots. During account deletion
// SQLite may delete receipts before bots, but the user has already been removed.
// Only parent erasure may bypass immutability; ordinary receipt deletion cannot.
// Replace the definition on existing volumes too, atomically with no unguarded
// interval for another connection and no changes to the recorded evidence.
db.transaction(() => {
  db.exec('DROP TRIGGER IF EXISTS knowledge_receipt_no_delete');
  db.exec(`CREATE TRIGGER knowledge_receipt_no_delete BEFORE DELETE ON knowledge_use_receipts
    WHEN EXISTS(SELECT 1 FROM users WHERE id=OLD.user_id)
      AND EXISTS(SELECT 1 FROM bots WHERE id=OLD.bot_id)
    BEGIN SELECT RAISE(ABORT,'Knowledge receipts are immutable'); END;`);
  // A source held for tenant migration binds its exact schema. Refuse an old
  // held schema and roll this replacement back; never invalidate that boundary.
  assertLegacyDatabaseFences(db);
}).immediate();
column('knowledge_learning_state','skill_reset_job_id','TEXT');
column('knowledge_learning_state','skill_reset_iteration','INTEGER');
column('knowledge_skill_proposals','actor',"TEXT NOT NULL DEFAULT 'legacy'");
column('knowledge_skill_proposals','source_versions',"TEXT NOT NULL DEFAULT '[]'");
column('knowledge_learning_reviews','selected_model','TEXT');
column('knowledge_learning_reviews','selected_provider','TEXT');
column('knowledge_learning_reviews','budget_input_tokens','INTEGER NOT NULL DEFAULT 0');
column('knowledge_learning_reviews','usage_status',"TEXT NOT NULL DEFAULT 'unavailable'");

column('knowledge_skill_proposals','settings_revision',"TEXT NOT NULL DEFAULT ''");
column('knowledge_skill_proposals','policy_revision','INTEGER NOT NULL DEFAULT 0');
column('knowledge_skill_proposals','base_hash',"TEXT NOT NULL DEFAULT ''");
db.exec(`
CREATE TABLE IF NOT EXISTS knowledge_promotion_policies (
 skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
 bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL, snapshot TEXT NOT NULL, actor TEXT NOT NULL,
 created_at INTEGER NOT NULL, PRIMARY KEY(skill_id,revision));
CREATE TABLE IF NOT EXISTS knowledge_skill_evaluations (
 id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
 proposal_id TEXT NOT NULL REFERENCES knowledge_skill_proposals(id) ON DELETE CASCADE,
 candidate_hash TEXT NOT NULL, source_hash TEXT NOT NULL, base_hash TEXT NOT NULL,
 policy_revision INTEGER NOT NULL, settings_revision TEXT NOT NULL,
 evaluator TEXT NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL,
 results TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS knowledge_evaluations_candidate ON knowledge_skill_evaluations(proposal_id,created_at);
CREATE TABLE IF NOT EXISTS knowledge_skill_promotions (
 id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
 skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
 proposal_id TEXT NOT NULL REFERENCES knowledge_skill_proposals(id) ON DELETE CASCADE,
 evaluation_id TEXT NOT NULL REFERENCES knowledge_skill_evaluations(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL, policy_revision INTEGER NOT NULL, actor TEXT NOT NULL,
 rollback TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(skill_id,revision));
CREATE TABLE IF NOT EXISTS knowledge_memory_reviews (
 id TEXT PRIMARY KEY,bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
 sources TEXT NOT NULL,result TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS knowledge_procedure_applications (
 id TEXT PRIMARY KEY,bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
 skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,revision INTEGER NOT NULL,
 job_id TEXT, input_hash TEXT NOT NULL,output TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS knowledge_skill_regressions (
 id TEXT PRIMARY KEY,bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
 skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,revision INTEGER NOT NULL,
 policy_revision INTEGER NOT NULL,checks TEXT NOT NULL,action TEXT NOT NULL,
 rollback_revision INTEGER,reason TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TRIGGER IF NOT EXISTS knowledge_candidate_frozen BEFORE UPDATE OF bot_id,skill_id,base_revision,generation,snapshot,reason,evidence,run_id,created_at,actor,source_versions,settings_revision,policy_revision,base_hash ON knowledge_skill_proposals
 BEGIN SELECT RAISE(ABORT,'Skill candidate inputs are immutable'); END;
`);
for (const table of ['knowledge_promotion_policies','knowledge_skill_evaluations','knowledge_skill_promotions','knowledge_memory_reviews','knowledge_procedure_applications','knowledge_skill_regressions']) {
 db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_immutable BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Learning evidence is immutable'); END;
 CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} WHEN EXISTS(SELECT 1 FROM bots WHERE id=OLD.bot_id) BEGIN SELECT RAISE(ABORT,'Learning evidence is immutable'); END;`);
}
db.exec(`CREATE TRIGGER IF NOT EXISTS knowledge_review_inputs_frozen BEFORE UPDATE OF user_id,bot_id,parent_job_id,reason,review_memory,review_skills,model,provider,settings_revision,foreground_epoch,generation,snapshot,source_snapshot,settings,knowledge_snapshot,context_window,created_at ON knowledge_learning_reviews WHEN OLD.status!='queued' BEGIN SELECT RAISE(ABORT,'Executed learning inputs are immutable'); END;`);
