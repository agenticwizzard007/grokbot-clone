import { db } from '../db.js';

db.exec(`CREATE TABLE IF NOT EXISTS coordination_requests (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 from_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
 to_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
 text TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('request','result')),
 status TEXT NOT NULL CHECK(status IN ('queued','deferred','admitted','completed','failed')),
 correlation_id TEXT NOT NULL,parent_request_id TEXT REFERENCES coordination_requests(id),depth INTEGER NOT NULL,
 audience TEXT NOT NULL DEFAULT 'internal' CHECK(audience='internal'),idempotency_key TEXT NOT NULL,
 job_id TEXT REFERENCES agent_jobs(id),result TEXT,reason TEXT NOT NULL DEFAULT '',revision INTEGER NOT NULL DEFAULT 1,
 claim_token TEXT,claim_until INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
 UNIQUE(user_id,idempotency_key));
 CREATE INDEX IF NOT EXISTS coordination_requests_pending ON coordination_requests(status,seq);
 CREATE TABLE IF NOT EXISTS coordination_admissions (
 request_id TEXT PRIMARY KEY REFERENCES coordination_requests(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 job_id TEXT NOT NULL UNIQUE REFERENCES agent_jobs(id),admitted_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS coordination_supervision (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 enabled INTEGER NOT NULL DEFAULT 1,authority_revision INTEGER NOT NULL DEFAULT 1,
 primary_bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL,source_cursor INTEGER NOT NULL DEFAULT 0,
 last_tick_at INTEGER,last_error TEXT,last_review_at INTEGER);
 CREATE TABLE IF NOT EXISTS coordination_wakes (
 id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 authority_revision INTEGER NOT NULL,source_cursor INTEGER NOT NULL,source_version TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','admitted','completed','superseded','failed')),
 job_id TEXT REFERENCES agent_jobs(id),reason TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
 UNIQUE(user_id,authority_revision,source_version));
 CREATE TABLE IF NOT EXISTS coordination_reports (
 id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 period TEXT NOT NULL,source_id TEXT NOT NULL,source_revision TEXT NOT NULL,
 report_job_id TEXT NOT NULL REFERENCES agent_jobs(id),delivery_id TEXT NOT NULL,
 covered_at INTEGER NOT NULL,UNIQUE(user_id,period,source_id,source_revision));`);
db.exec(`CREATE TABLE IF NOT EXISTS coordination_report_intents (
 job_id TEXT PRIMARY KEY REFERENCES agent_jobs(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 period TEXT NOT NULL,sources TEXT NOT NULL,created_at INTEGER NOT NULL,settled_at INTEGER);`);
