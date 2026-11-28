import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-team-'));
Object.assign(process.env, { DB_PATH: path.join(temp, 'app.db'), FILES_DIR: path.join(temp, 'files'), SWARM_ROLE: 'standalone',
  SESSION_SECRET: 'artifact-team-test', COMPUTER_PROVIDER: 'local', APP_URL: 'http://localhost:3000', SERVER_URL: 'http://localhost:3000',
  COMPOSIO_API_KEY: '', OPENROUTER_API_KEY: '', DIRECT_API_KEY: '', INKBOX_TUNNEL: '0' });
const { db } = await import('../server/src/db.js');
const { recordArtifact } = await import('../server/src/deliverables/artifacts.js');
const { deliverablesApi } = await import('../server/src/routes-deliverables.js');
const { Hono } = await import('hono');
const app = new Hono(); app.route('/api/deliverables', deliverablesApi);
for (const id of ['owner', 'teammate', 'stranger']) {
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(id, `${id}@example.test`, id, Date.now());
  db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(`bot_${id}`, id, `${id} Bot`, Date.now(), Date.now());
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(session_hash(?),?,?,?)').run(`session-${id}`, id, Date.now(), Date.now() + 3600000);
}
const artifact = recordArtifact({ userId: 'owner', botId: 'bot_owner', filename: 'strategy.html', content: '<h1>Strategy</h1><script>window.parent.unsafe=true</script>' });
const otherArtifact = recordArtifact({ userId: 'owner', botId: 'bot_owner', filename: 'private.txt', content: 'Private' });
function request(user: string | null, suffix = '', body?: unknown, id = artifact.id) {
  return app.request(`/api/deliverables/artifacts/${id}${suffix}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...(user ? { cookie: `swarm_session=session-${user}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
}
after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

test('private artifacts require auth, and guessing an ID reveals no artifact or content', async () => {
  for (const suffix of ['', '/content', '/download']) {
    assert.equal((await request(null, suffix)).status, 401);
    assert.equal((await request('stranger', suffix)).status, 404);
    assert.equal((await request('owner', suffix)).status, 200);
  }
});
test('explicit view access exposes only the shared artifact and cannot grant access, comment or deliver', async () => {
  assert.equal((await request('owner', '/members', { email: 'TEAMMATE@example.test', role: 'viewer' })).status, 200);
  const response = await request('teammate'); assert.equal(response.status, 200);
  const detail = await response.json(); assert.equal(detail.artifact.role, 'viewer');
  assert.ok(detail.members.every((member: any) => member.email === ''), 'collaborators do not see account email addresses');
  assert.equal((await request('teammate', '/content')).status, 200);
  const download = await request('teammate', '/download'); assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition')!, /attachment/);
  assert.equal(download.headers.get('content-type'), 'application/octet-stream');
  assert.equal((await request('teammate', '', undefined, otherArtifact.id)).status, 404);
  assert.equal((await request('teammate', '/comments', { body: 'Denied', requestId: randomUUID() })).status, 409);
  assert.equal((await request('teammate', '/members', { email: 'stranger@example.test', role: 'commenter' })).status, 404);
  assert.equal((await request('teammate', '/deliveries', { channel: 'library' })).status, 404);
  assert.equal((await request('teammate', '/delivery-history')).status, 404);
  const library = await (await app.request('/api/deliverables/library', { headers: { cookie: 'swarm_session=session-teammate' } })).json();
  assert.deepEqual(library.artifacts.map((item: any) => item.id), [artifact.id]);
  assert.equal((await app.request('/api/deliverables/bots/bot_owner', { headers: { cookie: 'swarm_session=session-teammate' } })).status, 404);
});
test('comment access persists discussions, deduplicates retries and validates input', async () => {
  assert.equal((await request('owner', '/members', { email: 'teammate@example.test', role: 'commenter' })).status, 200);
  const body = { body: 'Please add a launch timeline.', requestId: randomUUID() };
  for (let i = 0; i < 2; i++) {
    const response = await request('teammate', '/comments', body);
    assert.equal(response.status, 200); assert.equal((await response.json()).comments.length, 1);
  }
  assert.equal((await request('teammate', '/comments', { ...body, body: 'Changed body' })).status, 409);
  assert.equal((await request('teammate', '/comments', { body: '  ', requestId: randomUUID() })).status, 400);
  assert.equal((await request('teammate', '/comments', { body: 'x'.repeat(4001), requestId: randomUUID() })).status, 400);
  const detail = await (await request('owner')).json();
  assert.equal(detail.comments[0].authorName, 'teammate');
  assert.equal(detail.comments[0].body, body.body);
  assert.equal(detail.artifact.commentCount, 1);
});
test('removing access revokes every shared read and mutation without deleting discussion history', async () => {
  assert.equal((await request('owner', '/members', { email: 'teammate@example.test', role: 'remove' })).status, 200);
  for (const suffix of ['', '/content', '/download']) assert.equal((await request('teammate', suffix)).status, 404);
  assert.equal((await request('teammate', '/comments', { body: 'No access', requestId: randomUUID() })).status, 404);
  const library = await (await app.request('/api/deliverables/library', { headers: { cookie: 'swarm_session=session-teammate' } })).json();
  assert.equal(library.total, 0);
  assert.equal((await (await request('owner')).json()).comments.length, 1);
});
test('sharing validates permission, membership and owner access', async () => {
  assert.equal((await request('owner', '/members', { email: 'missing@example.test', role: 'viewer' })).status, 400);
  assert.equal((await request('owner', '/members', { email: 'owner@example.test', role: 'remove' })).status, 400);
  assert.equal((await request('owner', '/members', { email: 'teammate@example.test', role: 'owner' })).status, 400);
  assert.equal((await request('owner', '/members', { email: 'invalid', role: 'viewer' })).status, 400);
  assert.equal((await app.request('/api/deliverables/library?offset=-1', { headers: { cookie: 'swarm_session=session-owner' } })).status, 400);
});
