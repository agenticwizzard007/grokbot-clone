import { db } from '../db.js';
// All FK parents must exist even when workflows initialize coordination without
// importing the report runtime (migration fences inspect the complete FK graph).
import '../deliverables/schema.js';

db.exec(`CREATE TABLE IF NOT EXISTS coordination_requests (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 from_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
 to_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
 text TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('request','result')),
 status TEXT NOT NULL CHECK(status IN ('queued','deferred','admitted','completed','failed')),
 correlation_id TEXT NOT NULL,parent_request_id TEXT REFERENCES coordination_requests(id) ON DELETE SET NULL,depth INTEGER NOT NULL,
 audience TEXT NOT NULL DEFAULT 'internal' CHECK(audience='internal'),idempotency_key TEXT NOT NULL,
 job_id TEXT REFERENCES agent_jobs(id) ON DELETE SET NULL,result TEXT,reason TEXT NOT NULL DEFAULT '',revision INTEGER NOT NULL DEFAULT 1,
 claim_token TEXT,claim_until INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
 UNIQUE(user_id,idempotency_key));
 CREATE INDEX IF NOT EXISTS coordination_requests_pending ON coordination_requests(status,seq);
 CREATE TABLE IF NOT EXISTS coordination_admissions (
 request_id TEXT PRIMARY KEY REFERENCES coordination_requests(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 job_id TEXT NOT NULL UNIQUE REFERENCES agent_jobs(id) ON DELETE CASCADE,admitted_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS coordination_supervision (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 enabled INTEGER NOT NULL DEFAULT 1,authority_revision INTEGER NOT NULL DEFAULT 1,
 primary_bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL,source_cursor INTEGER NOT NULL DEFAULT 0,
 last_tick_at INTEGER,last_error TEXT,last_review_at INTEGER);
 CREATE TABLE IF NOT EXISTS coordination_wakes (
 id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 authority_revision INTEGER NOT NULL,source_cursor INTEGER NOT NULL,source_version TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','admitted','completed','superseded','failed')),
 job_id TEXT REFERENCES agent_jobs(id) ON DELETE SET NULL,reason TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
 UNIQUE(user_id,authority_revision,source_version));
 CREATE TABLE IF NOT EXISTS coordination_reports (
 id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 period TEXT NOT NULL,source_id TEXT NOT NULL,source_revision TEXT NOT NULL,
 report_job_id TEXT NOT NULL REFERENCES agent_jobs(id) ON DELETE CASCADE,delivery_id TEXT NOT NULL,
 covered_at INTEGER NOT NULL,UNIQUE(user_id,period,source_id,source_revision));`);
db.exec(`CREATE TABLE IF NOT EXISTS coordination_report_intents (
 job_id TEXT PRIMARY KEY REFERENCES agent_jobs(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 period TEXT NOT NULL,sources TEXT NOT NULL,created_at INTEGER NOT NULL,settled_at INTEGER);`);
db.exec(`CREATE TABLE IF NOT EXISTS coordination_job_outcomes (
 job_id TEXT PRIMARY KEY REFERENCES agent_jobs(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
 status TEXT NOT NULL,final_text TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);`);

// A synopsis is an immutable observation window, independent of agent/model jobs.
// Delivery checkpoints advance only over a contiguous prefix of acknowledged reports.
db.exec(`CREATE TABLE IF NOT EXISTS coordination_report_cursors (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 materialized_through INTEGER NOT NULL DEFAULT 0,materialized_seq INTEGER NOT NULL DEFAULT 0,
 delivered_through INTEGER NOT NULL DEFAULT 0,delivered_seq INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS coordination_synopses (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
 slot_key TEXT NOT NULL,first_slot TEXT NOT NULL,slot_count INTEGER NOT NULL,timezone TEXT NOT NULL,
 window_start INTEGER NOT NULL,window_end INTEGER NOT NULL,source_from INTEGER NOT NULL,source_through INTEGER NOT NULL,
 observed_at INTEGER NOT NULL,destination TEXT NOT NULL,gaps TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'capturing' CHECK(status IN ('capturing','preparing','ready')),
 source_count INTEGER NOT NULL DEFAULT 0,changed_count INTEGER NOT NULL DEFAULT 0,
 content TEXT,content_sha256 TEXT,generation_deadline INTEGER NOT NULL,
 generation_owner INTEGER,generation_birth TEXT,generation_note TEXT,
 artifact_id TEXT REFERENCES output_artifacts(id) ON DELETE SET NULL,
 delivery_id TEXT REFERENCES artifact_deliveries(id) ON DELETE SET NULL,
 delivered_at INTEGER,last_error TEXT,next_attempt_at INTEGER NOT NULL DEFAULT 0,failure_count INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,
 UNIQUE(user_id,slot_key));
CREATE INDEX IF NOT EXISTS coordination_synopsis_owner ON coordination_synopses(user_id,seq);
CREATE TABLE IF NOT EXISTS coordination_synopsis_sources (
 report_id TEXT NOT NULL REFERENCES coordination_synopses(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 ordinal INTEGER NOT NULL,source_id TEXT NOT NULL,revision TEXT NOT NULL,kind TEXT NOT NULL,
 state TEXT NOT NULL,title TEXT NOT NULL,owner TEXT,details TEXT NOT NULL,changed INTEGER NOT NULL,
 PRIMARY KEY(report_id,ordinal),UNIQUE(report_id,source_id));
CREATE TABLE IF NOT EXISTS coordination_synopsis_pages (
 report_id TEXT NOT NULL REFERENCES coordination_synopses(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,page INTEGER NOT NULL,
 artifact_id TEXT NOT NULL REFERENCES output_artifacts(id) ON DELETE CASCADE,
 PRIMARY KEY(report_id,page));
CREATE TRIGGER IF NOT EXISTS coordination_synopsis_snapshot_immutable BEFORE UPDATE OF
 user_id,bot_id,slot_key,first_slot,slot_count,timezone,window_start,window_end,source_from,source_through,observed_at,destination,gaps,source_count,changed_count ON coordination_synopses
 WHEN OLD.status!='capturing' BEGIN SELECT RAISE(ABORT,'Report snapshot is immutable'); END;
CREATE TRIGGER IF NOT EXISTS coordination_synopsis_content_immutable BEFORE UPDATE OF content,content_sha256 ON coordination_synopses
 WHEN OLD.content IS NOT NULL BEGIN SELECT RAISE(ABORT,'Report content is immutable'); END;
CREATE TRIGGER IF NOT EXISTS coordination_synopsis_source_immutable BEFORE UPDATE ON coordination_synopsis_sources
 BEGIN SELECT RAISE(ABORT,'Report sources are immutable'); END;
CREATE TRIGGER IF NOT EXISTS coordination_synopsis_source_closed BEFORE INSERT ON coordination_synopsis_sources
 WHEN (SELECT status FROM coordination_synopses WHERE id=NEW.report_id)!='capturing'
 BEGIN SELECT RAISE(ABORT,'Report sources are frozen'); END;
CREATE TRIGGER IF NOT EXISTS coordination_synopsis_source_no_delete BEFORE DELETE ON coordination_synopsis_sources
 WHEN EXISTS(SELECT 1 FROM users WHERE id=OLD.user_id)
 AND EXISTS(SELECT 1 FROM coordination_synopses r JOIN bots b ON b.id=r.bot_id WHERE r.id=OLD.report_id)
 BEGIN SELECT RAISE(ABORT,'Report sources are immutable'); END;
CREATE TRIGGER IF NOT EXISTS coordination_synopsis_page_immutable BEFORE UPDATE ON coordination_synopsis_pages
 BEGIN SELECT RAISE(ABORT,'Report pages are immutable'); END;
`);
const synopsisColumns = new Set((db.prepare('PRAGMA table_info(coordination_synopses)').all() as {name:string}[]).map(c=>c.name));
for (const name of ['next_attempt_at','failure_count']) if(!synopsisColumns.has(name))db.exec(`ALTER TABLE coordination_synopses ADD COLUMN ${name} INTEGER NOT NULL DEFAULT 0`);

// Existing send_to_bot requests keep their automatic return behavior.
try { db.exec('ALTER TABLE coordination_requests ADD COLUMN reply INTEGER NOT NULL DEFAULT 1'); }
catch (error) {
 if (!(db.prepare('PRAGMA table_info(coordination_requests)').all() as {name:string}[]).some(c=>c.name==='reply')) throw error;
}
