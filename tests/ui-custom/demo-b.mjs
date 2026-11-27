import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { serverFixture } from './server-fixture.mjs';

const output = path.resolve('.context/ui-custom/b/demo.json'); fs.mkdirSync(path.dirname(output), { recursive: true });
const server = await serverFixture(), transcript = [];
async function step(name, method, route, body, revision, status = 200, account = server.a) {
  const result = await server.request(account, method, route, body, revision);
  assert.equal(result.status, status, `${name}: ${JSON.stringify(result.body)}`);
  transcript.push({ name, method, route, status: result.status, response: result.body });
  console.log(`PASS ${name}: ${result.status}${result.body?.code ? ` ${result.body.code}` : ''}`);
  return result.body;
}
try {
  const current = await step('get', 'GET', '/config');
  const preview = await step('preview', 'POST', '/patches/preview', { intent: 'Fixture dark theme', patch: [{ op: 'replace', path: '/theme/mode', value: 'dark' }] }, current.revision);
  await step('get preview', 'GET', `/previews/${preview.previewId}`);
  const applied = await step('apply', 'POST', `/previews/${preview.previewId}/apply`, {}, 0);
  assert.equal(applied.doc.theme.mode, 'dark');
  const conflict = await step('patch conflict', 'PATCH', '/config', [{ op: 'replace', path: '/theme/mode', value: 'light' }], 0, 409);
  assert.equal(conflict.code, 'stale_revision');
  const undone = await step('undo', 'POST', '/undo', { steps: 1 }, 1); assert.equal(undone.doc.theme.mode, 'system');
  const exported = await step('export', 'GET', '/export');
  const imported = await step('import preview', 'POST', '/import/preview', exported, 2); assert.equal(imported.applied, false);
  for (const [method, route, body] of [['GET', `/previews/${imported.previewId}`], ['POST', `/previews/${imported.previewId}/apply`, {}], ['POST', `/previews/${imported.previewId}/discard`, {}],
    ['POST', '/reset', { scope: 'dashboard', dashboardId: 'd_aaaaaaaa' }], ['PATCH', '/config', [{ op: 'add', path: '/layout/pinned/-', value: { type: 'bot', id: server.fixture.bot.id } }]]]) {
    const result = await step(`cross-user ${method} ${route}`, method, route, body, 0, 404, server.b); assert.equal(result.code, 'not_found');
  }
  server.db.prepare('INSERT INTO account_preferences(user_id,ui_custom_enabled,updated_at) VALUES(?,0,?) ON CONFLICT(user_id) DO UPDATE SET ui_custom_enabled=0').run(server.a.userId, Date.now());
  const disabled = await step('flag off', 'GET', '/config', undefined, undefined, 404); assert.equal(disabled.code, 'disabled');
  await step('other account remains enabled', 'GET', '/config', undefined, undefined, 200, server.b);
  await server.setGlobalFlag('off');
  const globallyDisabled = await step('deployment flag off', 'GET', '/config', undefined, undefined, 404, server.b);
  assert.equal(globallyDisabled.code, 'disabled');
  fs.writeFileSync(output, JSON.stringify({ passed: transcript.length, failed: 0, transcript }, null, 2));
  console.log(`PASS ${transcript.length} demo steps. Transcript: ${output}`);
} finally { await server.close(); }
