// Scale only the temporary layout fixture database. No provider calls or production DB access.
import assert from 'node:assert/strict';
export function seedLoad(server) {
  return server.withDb(db => {
    const source = db.prepare('SELECT * FROM bots WHERE id=? AND user_id=?').get(server.fixture.bot.id, server.fixture.userId);
    assert.ok(source);
    const columns = Object.keys(source), insertBot = db.prepare(`INSERT INTO bots (${columns.map(c => `"${c}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
    const insertTask = db.prepare('INSERT INTO tasks(id,bot_id,title,state,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?)');
    const insertUsage = db.prepare("INSERT INTO usage_events(user_id,bot_id,kind,provider,model,input_tokens,output_tokens,cost_usd,cost_source,created_at) VALUES(?,?,'llm','direct','mock',100,20,0.001,'reported',?)");
    const now = Date.now();
    db.transaction(() => {
      // Existing layout fixtures include two Bots. Normalize the load to exactly 100 owned Bots.
      const existing = db.prepare('SELECT id FROM bots WHERE user_id=?').all(server.fixture.userId);
      for (let i = existing.length; i < 100; i++) {
        const record = { ...source, id: `bot_uc_perf_${i}`, name: `Fixture Bot ${i}`, is_primary: 0, slug: `fixture-bot-${i}` };
        insertBot.run(...columns.map(column => record[column]));
      }
      const bots = db.prepare('SELECT id FROM bots WHERE user_id=? ORDER BY id').all(server.fixture.userId);
      const old = db.prepare('SELECT count(*) n FROM tasks WHERE bot_id IN (SELECT id FROM bots WHERE user_id=?)').get(server.fixture.userId).n;
      for (let i = old; i < 10000; i++) insertTask.run(`task_uc_perf_${i}`, bots[i % bots.length].id, `Fixture task ${i}`, ['working', 'needs_input', 'done'][i % 3], 'PRIVATE_PERF_FIXTURE', now - i * 1000, now - i * 1000);
      for (let day = 0; day < 90; day++) insertUsage.run(server.fixture.userId, bots[day % bots.length].id, now - day * 86400000);
    })();
    const counts = { bots: db.prepare('SELECT count(*) n FROM bots WHERE user_id=?').get(server.fixture.userId).n,
      tasks: db.prepare('SELECT count(*) n FROM tasks WHERE bot_id IN (SELECT id FROM bots WHERE user_id=?)').get(server.fixture.userId).n, usageDays: 90 };
    assert.equal(counts.bots, 100); assert.equal(counts.tasks, 10000); return counts;
  });
}
