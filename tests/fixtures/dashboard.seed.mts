import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const dashboardUsers = [
  { id: 'qa-temp-dashboard-a', name: 'QA-Temp-Dashboard-A', token: 'qa-temp-dashboard-session-a', marker: 'Fixture A' },
  { id: 'qa-temp-dashboard-b', name: 'QA-Temp-Dashboard-B', token: 'qa-temp-dashboard-session-b', marker: 'Fixture B' },
] as const;

export function dashboardParams(source: string): Record<string, unknown> {
  return {
    ...(['tasks.series', 'usage.summary', 'usage.series', 'runs.counts', 'runs.series'].includes(source) ? { range: '7d' } : {}),
    ...(source === 'usage.series' ? { metric: 'cost' } : {}), ...(source === 'runs.series' ? { group: 'day' } : {}),
  };
}

/** Only disposable test databases. Deliberately distinguish every foreign aggregate. */
export async function seedDashboard({ performance = false } = {}) {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.ok(process.env.DB_PATH && process.env.DB_PATH !== ':memory:');
  const { db } = await import('../../server/src/db.js');
  await import('../../server/src/accounts.js');
  await import('../../server/src/usage.js');
  await import('../../server/src/deliverables/schema.js');
  await import('../../server/src/agent/subagents.js');
  await import('../../server/src/bot-setup.js');
  const { initRooms } = await import('../../server/src/agent/rooms.js'); initRooms();
  const at = Date.now(), start = Date.UTC(new Date(at).getUTCFullYear(), new Date(at).getUTCMonth(), new Date(at).getUTCDate());
  const botCount = performance ? 100 : 30, taskCount = performance ? 10_000 : 33;
  db.transaction(() => {
    for (const [index, user] of dashboardUsers.entries()) {
      db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(user.id, `${user.id}@example.test`, user.name, at);
      db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(session_hash(?),?,?,?)').run(user.token, user.id, at, at + 3600_000);
      for (let n = 0; n < (index ? 3 : botCount); n++) {
        const id = `${user.id}-bot-${n}`;
        db.prepare('INSERT INTO bots(id,user_id,name,instructions,created_at,updated_at) VALUES(?,?,?,?,?,?)')
          .run(id, user.id, `${user.marker} Bot ${n}`, 'FORBIDDEN_INSTRUCTIONS', at, at - n);
      }
      const botId = `${user.id}-bot-0`;
      for (let n = 0; n < (index ? 7 : taskCount); n++) {
        db.prepare('INSERT INTO tasks(id,bot_id,title,state,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
          .run(`${user.id}-task-${n}`, `${user.id}-bot-${n % (index ? 3 : botCount)}`, `${user.marker} Task ${n}`, ['working', 'needs_input', 'done'][n % 3], 'FORBIDDEN_NOTE', at - 1000, at);
      }
      db.prepare('INSERT INTO memories(id,bot_id,text,created_at) VALUES(?,?,?,?)').run(`${user.id}-memory`, botId, 'FORBIDDEN_MEMORY', at);
      for (let n = 0; n < (index ? 2 : 28); n++) {
        db.prepare('INSERT INTO routines(id,bot_id,name,prompt,schedule,timezone,enabled,created_at) VALUES(?,?,?,?,?,?,?,?)')
          .run(`${user.id}-routine-${n}`, botId, `${user.marker} Routine ${n}`, 'FORBIDDEN_PROMPT', '0 9 * * *', 'UTC', 1, at);
      }
      for (let n = 0; n < (index ? 4 : 28); n++) {
        db.prepare('INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES(?,?,?,?,?,?,?)')
          .run(botId, 1, n + 1, n + 1, 'card', JSON.stringify({ card: 'question', status: 'pending', question: `${user.marker} Question ${n}`, private: 'FORBIDDEN_CARD_DETAIL' }), at - n);
      }
      for (let n = 0; n < (index ? 5 : 32); n++) {
        const state = ['completed', 'uncertain', 'running', 'queued'][n % 4];
        db.prepare('INSERT INTO agent_jobs(id,user_id,bot_id,trigger,state,created_at,started_at,finished_at) VALUES(?,?,?,?,?,?,?,?)')
          .run(`${user.id}-job-${n}`, user.id, botId, JSON.stringify({ type: 'user', text: 'FORBIDDEN_MESSAGE', key: 'FORBIDDEN_KEY' }), state, at - 1000, state === 'queued' ? null : at - 900, ['completed', 'uncertain'].includes(state) ? at - 100 : null);
      }
      // One receipt replaces an existing job; one independent receipt adds one run.
      for (let n = 0; n < 2; n++) {
        db.prepare('INSERT INTO routine_executions(id,user_id,bot_id,routine_id,routine_name,fire_key,kind,job_id,status,created_at,started_at,finished_at,error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(`${user.id}-run-${n}`, user.id, botId, `${user.id}-routine-0`, `${user.marker} Routine 0`, `fixture-${n}`, 'manual', n ? null : `${user.id}-job-0`, n ? 'failed' : 'completed', at - 1000, at - 900, at - 100, 'FORBIDDEN_RUN_ERROR');
      }
      for (let day = 0; day < (performance ? 90 : 30); day++) {
        db.prepare('INSERT INTO usage_events(user_id,bot_id,kind,provider,model,input_tokens,output_tokens,cost_usd,cost_source,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(user.id, botId, 'chat', 'direct', 'fixture-model', index ? 9000 : 100, index ? 1000 : 20, index ? 99 : 0.25, 'provider', start - day * 86400_000);
      }
    }
  })();
  return { users: dashboardUsers, at, botCount, taskCount };
}

export async function dashboardServer({ performance = false, compiled = false } = {}) {
  const root = path.resolve(import.meta.dirname, '../..'), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-dashboard-'));
  const socket = net.createServer().listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = (socket.address() as net.AddressInfo).port; await new Promise<void>(resolve => socket.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  // Same disposable, offline server pattern as layout-fixture.mjs, with the feature enabled.
  const env = { PATH: process.env.PATH, NODE_ENV: 'test', DB_PATH: path.join(temp, 'app.db'), FILES_DIR: path.join(temp, 'files'),
    CLI_PROFILES_DIR: path.join(temp, 'profiles'), SWARM_ROLE: 'standalone', SWARM_NO_SCHEDULER: '1', SESSION_SECRET: 'dashboard-test',
    COMPUTER_PROVIDER: 'local', INKBOX_TUNNEL: '0', DEV_LOGIN: '1', PORT: String(port), APP_URL: base, SERVER_URL: base,
    WHATSAPP_DISABLED: '1', UI_CUSTOMIZATION: 'on', DASHBOARD_PERFORMANCE: performance ? '1' : '0' };
  const preload = path.join(temp, 'offline.mjs');
  fs.writeFileSync(preload, `globalThis.fetch = async () => { throw new Error('Provider network disabled in dashboard fixture'); };`);
  let logs = '';
  const start = (args: string[]) => {
    const child = spawn(process.execPath, ['--import', preload, '--import', 'tsx', ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { logs += String(data); });
    return child;
  };
  const seed = start(['tests/fixtures/dashboard.seed.mts']);
  assert.equal((await once(seed, 'exit'))[0], 0, logs);
  const server = start([compiled ? 'server/dist/index.js' : 'server/src/index.ts']);
  const close = async () => { if (server.exitCode === null) { server.kill(); await once(server, 'exit'); } fs.rmSync(temp, { recursive: true, force: true }); };
  try {
    for (let n = 0; n < 300; n++) {
      assert.equal(server.exitCode, null, logs);
      if (await fetch(`${base}/api/health`).then(response => response.ok).catch(() => false)) return { base, users: dashboardUsers, close, dbPath: env.DB_PATH };
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Dashboard server did not start: ${logs}`);
  } catch (error) { await close(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const fixture = await seedDashboard({ performance: process.env.DASHBOARD_PERFORMANCE === '1' });
  console.log(JSON.stringify(fixture));
  const { db } = await import('../../server/src/db.js'); db.close();
}
