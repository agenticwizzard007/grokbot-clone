import assert from 'node:assert/strict';
import test from 'node:test';
import { qualityServer } from '../fixtures/server.mjs';
import { seedLoad } from './load.mjs';

test('performance seed creates the stated load only in its disposable database', async () => {
  const server = await qualityServer();
  try {
    const counts = seedLoad(server);
    assert.deepEqual(counts, { bots: 100, tasks: 10000, usageDays: 90 });
    server.withDb(db => {
      const usage = db.prepare('SELECT count(*) n, min(created_at) first, max(created_at) last FROM usage_events WHERE user_id=?').get(server.fixture.userId);
      assert.equal(usage.n, 90);
      assert.equal(usage.last - usage.first, 89 * 86400000);
      const outsiders = db.prepare('SELECT count(*) n FROM tasks WHERE bot_id NOT IN (SELECT id FROM bots WHERE user_id=?)').get(server.fixture.userId);
      assert.equal(outsiders.n, 0);
    });
    assert.equal(server.blockedRequests().some(request => /openai|anthropic|openrouter/.test(request.origin)), false, 'No live provider was attempted');
  } finally { await server.close(); }
});
