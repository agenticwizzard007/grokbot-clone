import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';

// An isolated seeded HTTP server with the production routes and agent runtime.
// Only the model provider is substituted; no handoff service or dispatcher is mocked.
export async function realAgentFixture(providerBaseUrl = 'http://127.0.0.1:9/v1') {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-agent-'));
  Object.assign(process.env, {
    SWARM_ROLE: 'standalone', SWARM_NO_SCHEDULER: '1', NODE_ENV: 'test',
    DB_PATH: path.join(storage, 'test.db'), FILES_DIR: path.join(storage, 'files'),
    SESSION_SECRET: 'handoff-agent-test', COMPUTER_PROVIDER: 'local', INKBOX_TUNNEL: '0',
    DIRECT_API_KEY: 'fixture', DIRECT_BASE_URL: providerBaseUrl, LLM_PROVIDER: 'direct',
    COMPOSIO_API_KEY: '', ADMIN_EMAILS: '', HANDOFFS_DISABLED: '0',
  });
  const { db } = await import('../../../server/src/db.js');
  (await import('../../../server/src/agent/subagents.js')).initSubagents();
  (await import('../../../server/src/agent/rooms.js')).initRooms();
  const { createBot } = await import('../../../server/src/bots.js');
  const agent = await import('../../../server/src/agent/loop.js');
  const { api } = await import('../../../server/src/routes.js');
  const { stopLoopDeadlines } = await import('../../../server/src/handoffs/loop-runner.js');
  const { stopHandoffRecovery } = await import('../../../server/src/handoffs/reconcile.js');
  const app = new Hono().route('/api', api);
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  let sequence = 0;
  return {
    db, agent,
    seed() {
      const userId = `handoff-agent-${++sequence}`, at = Date.now();
      db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)')
        .run(userId, `${userId}@example.test`, 'Handoff fixture', at);
      const maker = createBot(userId, { name: 'Maker fixture' });
      const checker = createBot(userId, { name: 'Checker fixture' });
      db.prepare("UPDATE bot_setups SET onboarding_status='active' WHERE bot_id IN (?,?)").run(maker.id, checker.id);
      const token = `session-${userId}`;
      db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(session_hash(?),?,?,?)')
        .run(token, userId, at, at + 60000);
      return {
        userId, maker, checker,
        async request(route, body) {
          const response = await fetch(`${base}/api${route}`, {
            headers: { cookie: `swarm_session=${token}`, 'content-type': 'application/json' },
            ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(5000),
          });
          const data = await response.json();
          assert.ok(response.ok, `${route}: ${response.status} ${JSON.stringify(data)}`);
          return data;
        },
      };
    },
    async close() {
      await agent.settleAgentJobs();
      stopLoopDeadlines();
      stopHandoffRecovery();
      await new Promise(resolve => server.close(resolve));
      db.close();
      fs.rmSync(storage, { recursive: true, force: true });
    },
  };
}

export function loopSpec(fixture, goal) {
  return {
    name: 'Real agent release review', kind: 'maker_checker', goal,
    steps: [
      { id: 'maker', botId: fixture.maker.id, role: 'maker', instruction: 'Draft the release notes.' },
      { id: 'checker', botId: fixture.checker.id, role: 'checker', instruction: 'Check every required item.' },
    ],
    seed: { text: 'Release notes fixture.' },
    exit: { mode: 'checklist', items: [
      { id: 'version', text: 'Mentions a version', required: true },
      { id: 'short', text: 'Fewer than 60 words', required: true },
      { id: 'action', text: 'Ends with a call to action', required: true },
    ] },
    limits: { maxIterations: 3, maxMinutes: 5, stepTimeoutMinutes: 1 },
    gate: { before: 'none', onCap: 'stop' },
  };
}

export async function pollLoop(fixture, id, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let detail;
  do {
    detail = await fixture.request(`/loops/${id}`);
    if (['succeeded', 'capped', 'stalled', 'failed', 'cancelled'].includes(detail.status)) return detail;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  assert.fail(`Loop timed out: ${JSON.stringify(detail)}`);
}
