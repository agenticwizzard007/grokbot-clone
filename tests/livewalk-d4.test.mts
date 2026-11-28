import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Hono } from 'hono';
import { fixture, output, app, db, jobs, cleanup } from './handoffs/server-fixture.test.mts';
import { SqliteUiConfigService } from '../server/src/ui/service.js';
import { createUiApi } from '../server/src/ui/routes.js';

after(cleanup);

test('D4 disabled customization is a quiet authenticated read and still rejects writes', async () => {
  const f = fixture();
  const ui = new Hono().route('/api/ui', createUiApi(new SqliteUiConfigService(db, { flag: () => 'off' })));
  const response = await ui.request('/api/ui/config', { headers: f.headers });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).code, 'disabled');
  assert.match(response.headers.get('cache-control')!, /no-store/);
  assert.equal((await ui.request('/api/ui/config')).status, 401);
  assert.equal((await ui.request('/api/ui/config', { method: 'PATCH', headers: f.headers, body: '[]' })).status, 404);
});

test('D4 empty job output is successful and identifies every terminal state', async () => {
  const f = fixture(), other = fixture(), job = jobs.acceptJob(f.maker.id, { type: 'user' });
  for (const state of ['queued', 'running', 'completed', 'uncertain', 'cancelled']) {
    db.prepare('UPDATE agent_jobs SET state=? WHERE id=?').run(state, job.id);
    const response = await app.request(`/api/outputs/by-job/${job.id}`, { headers: f.headers });
    assert.equal(response.status, 200, state);
    assert.deepEqual(await response.json(), { output: null, terminal: !['queued', 'running'].includes(state) });
  }
  assert.equal((await app.request(`/api/outputs/by-job/${job.id}`, { headers: other.headers })).status, 404);
  assert.equal((await app.request(`/api/outputs/by-job/${job.id}`)).status, 401);
});

test('D4 completed output matches the chat response contract', async () => {
  const f = fixture(), saved = output(f);
  const response = await app.request(`/api/outputs/by-job/${saved.jobId}`, { headers: f.headers });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.output?.id, saved.id);
  assert.equal(body.terminal, true);
});
