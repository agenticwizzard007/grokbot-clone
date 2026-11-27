import { db } from '../../server/src/db.js';
import { initSubagents } from '../../server/src/agent/subagents.js';
import { initRooms } from '../../server/src/agent/rooms.js';
import '../../server/src/deliverables/schema.js';
import '../../server/src/coordination/schema.js';
import { DDL } from '../../server/src/handoffs/schema.js';
import { saveMcpServer } from '../../server/src/mcp/store.js';
import { recordFlowConnections } from '../../server/src/flow/cache.js';
import { fixtures } from './fixtures.mjs';
initRooms(); initSubagents(); db.exec(DDL);
export function seedFlow(userId = 'flow-test') {
  db.prepare('INSERT OR IGNORE INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(userId, `${userId}@example.test`, 'Test account', Date.now());
  db.prepare('INSERT OR REPLACE INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(session_hash(?),?,?,?)').run('flow-test-token', userId, Date.now(), Date.now() + 3600000);
  const inputs = [...Object.values(fixtures), { ...structuredClone(fixtures.empty), bot: { ...fixtures.empty.bot, id: 'flow-checker', name: 'Review agent' } }];
  for (const input of inputs) {
    db.prepare('INSERT OR IGNORE INTO bots(id,user_id,name,instructions,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(input.bot.id, userId, input.bot.name, input.bot.instructions, Date.now(), Date.now());
    for (const s of input.skills) db.prepare('INSERT OR IGNORE INTO skills(id,bot_id,name,body,created_at) VALUES(?,?,?,?,?)').run(`${input.bot.id}-${s.id}`, input.bot.id, s.name, s.body, 1);
    for (const r of input.routines) db.prepare('INSERT OR IGNORE INTO routines(id,bot_id,name,prompt,schedule,enabled,created_at,trigger_id) VALUES(?,?,?,?,?,?,?,?)').run(`${input.bot.id}-${r.id}`, input.bot.id, r.name, 'Placeholder task', r.schedule, +r.enabled, r.createdAt, r.event ? 'fixture-event' : null);
    for (let n = 0; n < input.knowledge; n++) db.prepare('INSERT OR IGNORE INTO memories(id,bot_id,text,created_at) VALUES(?,?,?,?)').run(`${input.bot.id}-memory-${n}`, input.bot.id, 'Placeholder reference', 1);
    for (const m of input.mcp) saveMcpServer(userId, { name: m.name, transport: 'http', url: 'https://example.test/mcp', botIds: [input.bot.id], enabled: m.enabled });
    if (input.suggestions.length) db.prepare('UPDATE bots SET suggestions_snapshot=? WHERE id=?').run(JSON.stringify({ version: 1, filterVersion: 'purpose-2', computedAt: 1, hasContext: true, suggestions: input.suggestions.filter(s => s.kind === 'app').map(s => ({ slug: s.id, name: s.name, noAuth: false })) }), input.bot.id);
    for (let n = 0; n < input.outputs.tasks; n++) db.prepare('INSERT OR IGNORE INTO tasks(id,bot_id,title,state,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(`${input.bot.id}-task-${n}`, input.bot.id, 'Placeholder task', 'done', 1, 1);
  }
  for (const link of fixtures.rich.links) db.prepare('INSERT OR IGNORE INTO handoff_links(id,user_id,from_bot_id,to_bot_id,mode,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(link.id, userId, link.fromBotId, link.toBotId, link.mode, 1, 1);
  db.prepare('INSERT OR IGNORE INTO loops(id,user_id,owner_bot_id,name,spec,status,initiated_by,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run('lp_fixture', userId, 'flow-rich', 'Release review loop', JSON.stringify({ steps: [{ botId: 'flow-rich' }, { botId: 'flow-checker' }] }), 'running', 'user', 'fixture-loop', 1, 1);
  recordFlowConnections(userId, fixtures.many.apps.concat(fixtures.rich.apps));
  return { userId, inputs };
}
