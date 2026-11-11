import { db, now } from '../db.js';
import { newId } from '../lib/ids.js';
import { assertTenant } from '../deployment.js';
import { selectedCli } from '../cli/store.js';
db.exec(`CREATE TABLE IF NOT EXISTS agent_jobs (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, trigger TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','running','completed','uncertain','cancelled')),
  created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER);
CREATE INDEX IF NOT EXISTS agent_jobs_pending ON agent_jobs(state,created_at);
CREATE INDEX IF NOT EXISTS agent_jobs_parent ON agent_jobs(json_extract(trigger,'$.parentJobId'));
CREATE TABLE IF NOT EXISTS tool_dispatches (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, call_id TEXT NOT NULL,
  tool TEXT NOT NULL, arguments_hash TEXT NOT NULL, state TEXT NOT NULL,
  created_at INTEGER NOT NULL, finished_at INTEGER, PRIMARY KEY(bot_id,call_id));`);
export function acceptJob(botId: string, trigger: unknown) {
  return db.transaction(() => {
    const bot = db.prepare('SELECT user_id FROM bots WHERE id=?').get(botId) as { user_id: string } | undefined;
    if (!bot) throw new Error('Agent not found.'); assertTenant(bot.user_id);
    if (!selectedCli(bot.user_id)) {
      const n = (db.prepare("SELECT count(*) n FROM agent_jobs WHERE user_id=? AND state IN ('queued','running')").get(bot.user_id) as { n: number }).n;
      if (n >= 64) throw new Error('Your task queue is full. Wait for running tasks to finish.');
    }
    const payload = JSON.stringify(trigger);
    if (Buffer.byteLength(payload) > 16 * 1024 * 1024) throw new Error('Task payload is too large.');
    const id = newId('job');
    db.prepare("INSERT INTO agent_jobs(id,user_id,bot_id,trigger,state,created_at) VALUES(?,?,?,?,'queued',?)").run(id, bot.user_id, botId, payload, now());
    return { id, userId: bot.user_id };
  })();
}
export function beginJob(id: string) { return db.prepare("UPDATE agent_jobs SET state='running',started_at=? WHERE id=? AND state='queued'").run(now(), id).changes === 1; }
export function finishJob(id: string, successful: boolean) { db.prepare("UPDATE agent_jobs SET state=?,finished_at=? WHERE id=? AND state='running'").run(successful ? 'completed' : 'uncertain', now(), id); }
export function recoverJobs() {
  // Running work may have issued an external write. Never silently re-execute it on restart.
  db.prepare("UPDATE agent_jobs SET state='uncertain',finished_at=? WHERE state='running'").run(now());
  db.prepare("UPDATE tool_dispatches SET state='uncertain' WHERE state='dispatching'").run();
  return db.prepare("SELECT id,user_id,bot_id,trigger FROM agent_jobs WHERE state='queued' ORDER BY created_at,id").all() as { id: string; user_id: string; bot_id: string; trigger: string }[];
}
export function beginTool(botId: string, callId: string, tool: string, binding: string) {
  return db.prepare("INSERT OR IGNORE INTO tool_dispatches(bot_id,call_id,tool,arguments_hash,state,created_at) VALUES(?,?,?,?,'dispatching',?)").run(botId, callId, tool, binding, now()).changes === 1;
}
export function finishTool(botId: string, callId: string, successful: boolean) {
  db.prepare("UPDATE tool_dispatches SET state=?,finished_at=? WHERE bot_id=? AND call_id=?").run(successful ? 'completed' : 'uncertain', now(), botId, callId);
}
