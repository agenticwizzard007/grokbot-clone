import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'adapt-api-'));
Object.assign(process.env, { DB_PATH: path.join(temp, 'app.db'), FILES_DIR: path.join(temp, 'files'), SWARM_ROLE: 'standalone', SWARM_NO_SCHEDULER: '1', SESSION_SECRET: 'fixture', APP_URL: 'http://localhost:3080', SERVER_URL: 'http://localhost:3080', COMPUTER_PROVIDER: 'local', INKBOX_TUNNEL: '0' });
const { db } = await import('../../server/src/db.js');
const { sessionHash } = await import('../../server/src/lib/auth.js');
const { SqliteUiConfigService } = await import('../../server/src/ui/service.js');
const { RequirementsStore } = await import('../../server/src/ui/requirements-store.js');
const { createRequirementsApi } = await import('../../server/src/ui/requirements-routes.js');
const now = Date.now();
for (const id of ['a', 'b']) {
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(id, `qa-temp-${id}@example.test`, `QA-Temp-${id}`, now);
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at,last_seen_at,authenticated_at) VALUES(?,?,?,?,?,?)').run(sessionHash(`fixture-${id}`), id, now, now + 86400000, now, now);
}
const ui = new SqliteUiConfigService(db, { flag: () => 'on', clock: () => 1000000, metrics: () => {} });
let flag = '100'; const store = new RequirementsStore(ui, { flag: () => flag, clock: () => 1000000 });
const app = new Hono().route('/api/ui/requirements', createRequirementsApi(store));
after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });
const call = async (method = 'GET', input?: unknown, revision?: number, account = 'a', suffix = '', headers = {}) => {
  const response = await app.request(`http://localhost:3080/api/ui/requirements${suffix}`, { method,
    headers: { cookie: `swarm_session=fixture-${account}`, origin: 'http://localhost:3080', ...(input === undefined ? {} : { 'content-type': 'application/json' }), ...(revision === undefined ? {} : { 'If-Match': `"${revision}"` }), ...headers },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  return { status: response.status, headers: response.headers, body: response.status === 304 ? null : await response.json() };
};
const patch = [{ op: 'replace', path: '/role', value: 'Operations' }, { op: 'replace', path: '/focus', value: ['routines', 'usage'] }];

test('GET is authenticated, private, conditional and isolated', async () => {
  assert.equal((await call('GET', undefined, undefined, 'missing')).status, 401);
  const initial = await call(); assert.equal(initial.status, 200); assert.equal(initial.body.profile, null); assert.equal(initial.headers.get('etag'), '"0"');
  assert.match(initial.headers.get('cache-control')!, /no-store/);
  assert.equal((await call('GET', undefined, undefined, 'a', '', { 'If-None-Match': '"0"' })).status, 304);
});

test('PUT matches service values, requires revision, and does not mutate appearance', async () => {
  assert.equal((await call('PUT', { patch })).status, 409);
  const results = await Promise.all([call('PUT', { patch }, 0), call('PUT', { patch }, 0)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.deepEqual((await call()).body, store.get('a'));
  assert.equal(ui.get('a').revision, 0); assert.equal((await call('GET', undefined, undefined, 'b')).body.profile, null);
  const direct = store.update('b', patch, 0); assert.ok(direct.ok);
  assert.deepEqual(results.find(r => r.status === 200)!.body.profile, direct.profile);
});

test('input limits, metadata, cross-account fields, XSS and personal identifiers reject', async () => {
  for (const body of [{ patch, userId: 'b' }, { profile: {} }, { patch: [{ op: 'replace', path: '/role', value: '<script>' }] }, { patch: [{ op: 'replace', path: '/role', value: 'qa@example.test' }] }, { patch: [{ op: 'replace', path: '/managedPaths', value: [] }] }]) {
    assert.equal((await call('PUT', body, 1)).status, 422);
  }
  assert.equal((await call('PUT', { patch: [{ op: 'replace', path: '/role', value: 'x'.repeat(9000) }] }, 1)).status, 413);
  assert.equal((await call('PUT', { patch }, 1, 'a', '', { origin: 'https://outside.example.test' })).status, 403);
  assert.equal(store.get('a').revision, 1);
});

test('adapt is a normal owner-only preview with before, after, rationale and suggestions', async () => {
  const result = await call('POST', {}, 1, 'a', '/adapt'); assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.applied, false); assert.deepEqual(result.body.viewports, [390, 1280]); assert.equal(result.body.lens, 'operations');
  assert.equal(result.body.suggestions.bots.length, 3); assert.equal(result.body.suggestions.templates.length, 2);
  assert.deepEqual(result.body.before, ui.get('a').doc); assert.deepEqual(result.body.after, ui.getPreview('a', result.body.previewId)!.result);
  assert.equal(ui.getPreview('b', result.body.previewId), null); assert.equal(ui.get('a').revision, 0);
  assert.equal((await call('POST', { lens: 'unknown' }, 1, 'a', '/adapt')).status, 422);
});

test('DELETE previews default arrangement and provides a per-user reset Undo', async () => {
  const reset = await call('DELETE', {}, 1); assert.equal(reset.status, 200); assert.equal(reset.body.profile, null);
  assert.equal(ui.get('a').revision, 0);
  assert.equal((await call('PUT', { undoReset: reset.body.undoToken }, 1, 'b')).status, 404);
  assert.equal((await call('PUT', { undoReset: reset.body.undoToken }, 2)).status, 200);
  assert.equal(store.get('a').profile!.role, 'Operations');
});

test('dark launch disables every requirements endpoint', async () => {
  flag = 'off';
  for (const [method, input, suffix] of [['GET', undefined, ''], ['PUT', { patch }, ''], ['DELETE', {}, ''], ['POST', {}, '/adapt']] as const)
    assert.equal((await call(method, input, 3, 'a', suffix)).status, 404);
});
