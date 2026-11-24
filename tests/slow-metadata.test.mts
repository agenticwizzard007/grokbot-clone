import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { Hono } from 'hono';
const root = mkdtempSync(path.join(tmpdir(), 'metadata-qa-'));
let slow = false, requests = 0;
const upstream = http.createServer((_req, res) => {
  requests++;
  const reply = () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'local-model' }] })); };
  if (!slow) return reply();
  const timer = setTimeout(reply, 10_000); res.once('close', () => clearTimeout(timer));
}).listen(0, '127.0.0.1');
await once(upstream, 'listening');
Object.assign(process.env, {
  NODE_ENV: 'test', SWARM_ROLE: 'standalone', DB_PATH: path.join(root, 'db'), FILES_DIR: path.join(root, 'files'),
  SESSION_SECRET: 'local-only', COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '', OPENROUTER_API_KEY: '',
  LLM_PROVIDER: 'direct', DIRECT_API_KEY: 'fake', DIRECT_BASE_URL: `http://127.0.0.1:${(upstream.address() as any).port}`,
  DIRECT_MODEL: 'local-model', INKBOX_TUNNEL: '0',
});
const { db } = await import('../server/src/db.js');
const { modelsApi } = await import('../server/src/routes-models.js');
const app = new Hono().route('/api', modelsApi);
for (const id of ['fast', 'slow']) {
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(id, `${id}@example.test`, id, Date.now());
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(session_hash(?),?,?,?)').run(id, id, Date.now(), Date.now() + 3600000);
}
after(async () => { await new Promise<void>(resolve => upstream.close(() => resolve())); db.close(); rmSync(root, { recursive: true, force: true }); });
const request = (id: string) => app.request('/api/models', { headers: { cookie: `swarm_session=${id}` } });
test('model route caches direct metadata and resolves a slow fake upstream within four seconds', async () => {
  assert.equal((await (await request('fast')).json()).models[0].id, 'local-model');
  slow = true;
  let started = performance.now();
  const cached = await request('fast');
  assert.ok(performance.now() - started < 200);
  assert.equal((await cached.json()).models[0].id, 'local-model');
  assert.equal(requests, 1);
  started = performance.now();
  const unavailable = await request('slow');
  assert.ok(performance.now() - started < 4200);
  assert.match(unavailable.headers.get('server-timing')!, /models;dur=/);
  const body = await unavailable.json();
  assert.deepEqual(body.models, []);
  assert.match(body.error, /unavailable|reach direct provider/);
  assert.equal(requests, 2);
});
