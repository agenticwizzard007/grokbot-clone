import { after } from 'node:test';
import Database from 'better-sqlite3';
import { SqliteUiConfigService } from '../../server/src/ui/service.js';
import { serviceContract } from './unit/service-contract.mts';

const databases: Database.Database[] = [];
after(() => { for (const db of databases) db.close(); });
serviceContract('SqliteUiConfigService', options => {
  const db = new Database(':memory:'); databases.push(db); db.pragma('foreign_keys=ON');
  db.exec("CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES('QA-Temp-a'),('QA-Temp-b'); CREATE TABLE bots(id TEXT PRIMARY KEY,user_id TEXT,name TEXT);");
  const service = new SqliteUiConfigService(db, { clock: options?.now ?? Date.now,
    flag: () => options?.enabled === false ? 'off' : 'on', metrics: () => {} });
  for (const userId of ['QA-Temp-a', 'QA-Temp-b']) {
    const enabled = typeof options?.enabled === 'function' ? Number(options.enabled(userId)) : null;
    const mode = typeof options?.agentApplyMode === 'function' ? options.agentApplyMode(userId) : options?.agentApplyMode ?? 'ask';
    db.prepare('INSERT INTO account_preferences(user_id,ui_custom_enabled,ui_agent_apply,updated_at) VALUES(?,?,?,?)').run(userId, enabled, mode, Date.now());
  }
  return service;
});
