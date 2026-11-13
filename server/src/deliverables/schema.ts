import { db } from '../db.js';
import '../agent/jobs.js';

// Translated claim/outcome separation from NousResearch/hermes-agent (MIT),
// f0e7b68e439f8c1962fcf9dcb0341aadf1e2a898: cron/executions.py and
// cron/delivery_queue.py:165-355. Swarm keeps its own Cron and agent_jobs authority.
db.exec(`
CREATE TABLE IF NOT EXISTS routine_executions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  routine_id TEXT NOT NULL, routine_name TEXT NOT NULL, fire_key TEXT NOT NULL,
  kind TEXT NOT NULL, job_id TEXT UNIQUE REFERENCES agent_jobs(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','waiting','completed','failed','unknown','cancelled')),
  error TEXT, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
  owner_pid INTEGER, owner_birth TEXT, UNIQUE(routine_id,fire_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS routine_execution_active ON routine_executions(routine_id)
  WHERE status IN ('queued','running','waiting');
CREATE INDEX IF NOT EXISTS routine_execution_owner ON routine_executions(user_id,bot_id,created_at);
CREATE TABLE IF NOT EXISTS routine_execution_jobs (
  job_id TEXT PRIMARY KEY REFERENCES agent_jobs(id) ON DELETE CASCADE, run_id TEXT NOT NULL REFERENCES routine_executions(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS output_artifacts (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES routine_executions(id) ON DELETE SET NULL, job_id TEXT REFERENCES agent_jobs(id) ON DELETE SET NULL,
  filename TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL,
  sha256 TEXT NOT NULL, source_key TEXT NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE(bot_id,source_key)
);
CREATE INDEX IF NOT EXISTS artifact_owner ON output_artifacts(user_id,bot_id,created_at);
CREATE TABLE IF NOT EXISTS artifact_deliveries (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL REFERENCES output_artifacts(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK(channel IN ('library','imessage','sms','whatsapp')),
  target_json TEXT NOT NULL, idempotency_key TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','sending','delivered','failed','unknown')),
  error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(user_id,idempotency_key)
);
CREATE TABLE IF NOT EXISTS artifact_delivery_attempts (
  id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL REFERENCES artifact_deliveries(id) ON DELETE CASCADE,
  number INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('sending','delivered','failed','unknown')),
  error TEXT, external_id TEXT, started_at INTEGER NOT NULL, finished_at INTEGER,
  owner_pid INTEGER NOT NULL, owner_birth TEXT NOT NULL, UNIQUE(delivery_id,number)
);
CREATE INDEX IF NOT EXISTS artifact_delivery_pending ON artifact_deliveries(status,created_at);
`);

// Account-owned durable approval key and idempotent HTTP command receipts.
db.exec(`
CREATE TABLE IF NOT EXISTS artifact_delivery_keys (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, secret TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS artifact_delivery_commands (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, key TEXT NOT NULL,
 delivery_id TEXT NOT NULL REFERENCES artifact_deliveries(id) ON DELETE CASCADE,
 fingerprint TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(user_id,key)
);
CREATE TABLE IF NOT EXISTS artifact_delivery_reconciliations (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 delivery_id TEXT NOT NULL REFERENCES artifact_deliveries(id) ON DELETE CASCADE,
 attempt_id TEXT NOT NULL REFERENCES artifact_delivery_attempts(id) ON DELETE CASCADE,
 outcome TEXT NOT NULL CHECK(outcome IN ('delivered','not_sent')), evidence TEXT NOT NULL,
 created_at INTEGER NOT NULL, UNIQUE(delivery_id,attempt_id)
);`);

const deliveryColumns=new Set((db.prepare('PRAGMA table_info(artifact_deliveries)').all() as {name:string}[]).map(c=>c.name));
if(!deliveryColumns.has('next_attempt_at'))db.exec('ALTER TABLE artifact_deliveries ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0');
if(!deliveryColumns.has('drain_failures'))db.exec('ALTER TABLE artifact_deliveries ADD COLUMN drain_failures INTEGER NOT NULL DEFAULT 0');
