import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { serverFixture } from './server-fixture.mjs';

let server: Awaited<ReturnType<typeof serverFixture>>;
before(async () => { server = await serverFixture(); });
after(async () => { await server?.close(); });
const patch = (value: string) => [{ op: 'replace', path: '/theme/mode', value }];
const revision = async (account = server.a) => (await server.request(account, 'GET', '/config')).body.revision;
const request = (method: string, route: string, body?: unknown, rev?: number, account = server.a) => server.request(account, method, route, body, rev);

async function sse(account: { cookie: string }) {
  const abort = new AbortController(), events: any[] = [];
  const response = await fetch(`${server.base}/api/events`, { headers: { cookie: account.cookie }, signal: abort.signal });
  assert.equal(response.status, 200);
  const consume = (async () => {
    const reader = response.body!.getReader(), decoder = new TextDecoder(); let pending = '';
    try {
      for (;;) {
        const item = await reader.read(); if (item.done) break; pending += decoder.decode(item.value, { stream: true });
        let end: number;
        while ((end = pending.indexOf('\n\n')) >= 0) {
          const block = pending.slice(0, end); pending = pending.slice(end + 2);
          for (const line of block.split('\n')) if (line.startsWith('data:')) { try { events.push(JSON.parse(line.slice(5))); } catch {} }
        }
      }
    } catch (error: any) { if (error.name !== 'AbortError') throw error; }
    finally { reader.releaseLock(); }
  })();
  return { events, close: async () => { abort.abort(); await consume; } };
}

test('config GET is private, ETag revalidates, and unknown routes have structured errors', async () => {
  const get = await request('GET', '/config'); assert.equal(get.status, 200); assert.equal(get.headers.get('etag'), '"0"');
  assert.equal(get.body.flags.enabled, true); assert.equal(get.body.flags.agentApplyMode, 'ask');
  const cached = await server.request(server.a, 'GET', '/config', undefined, undefined, { 'If-None-Match': 'W/"0"' }); assert.equal(cached.status, 304);
  const missing = await request('GET', '/unknown'); assert.equal(missing.status, 404); assert.equal(missing.body.code, 'not_found');
  const unauthorized = await fetch(`${server.base}/api/ui/config`); assert.equal(unauthorized.status, 401);
});

test('JSON shape, JSON-only, streaming byte cap, patch count, and unknown keys reject before mutation', async () => {
  const rev = await revision();
  const send = (body: string, type = 'application/json') => fetch(`${server.base}/api/ui/config`, { method: 'PATCH', headers: { cookie: server.a.cookie, origin: server.base,
    'content-type': type, 'If-Match': `"${rev}"` }, body });
  for (const [input, status, code] of [['{', 400, 'invalid_value'], [JSON.stringify({ userId: server.b.userId, patch: patch('dark') }), 422, 'invalid_value'],
    [JSON.stringify(Array.from({ length: 101 }, () => patch('dark')[0])), 422, 'limit_exceeded']]) {
    const response = await send(String(input)); assert.equal(response.status, status); assert.equal((await response.json()).code, code);
  }
  assert.equal((await send('[]', 'text/plain')).status, 415);
  const oversized = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(256 * 1024 + 1))); controller.close(); } });
  const response = await fetch(`${server.base}/api/ui/import/preview`, { method: 'POST', headers: { cookie: server.a.cookie, origin: server.base, 'content-type': 'application/json', 'If-Match': `"${rev}"` }, body: oversized, duplex: 'half' } as any);
  assert.equal(response.status, 413); assert.equal((await response.json()).code, 'limit_exceeded');
  assert.equal(await revision(), rev);
});

test('If-Match is required and two simultaneous patches have exactly one winner', async () => {
  const rev = await revision();
  assert.equal((await request('PATCH', '/config', patch('dark'))).status, 409);
  const results = await Promise.all(['dark', 'light'].map(mode => request('PATCH', '/config', patch(mode), rev)));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const conflict = results.find(result => result.status === 409)!; assert.equal(conflict.body.code, 'stale_revision');
  const current = await request('GET', '/config'); assert.equal(current.body.revision, rev + 1);
  assert.deepEqual(current.body.doc, results.find(result => result.status === 200)!.body.doc);
});

test('preview API returns hash, result, and owner-only lifecycle; pending stale base is 409', async () => {
  const rev = await revision();
  const preview = await request('POST', '/patches/preview', { patch: patch('dark'), intent: 'Fixture preview' }, rev);
  assert.equal(preview.status, 200, JSON.stringify(preview.body)); assert.match(preview.body.resultHash, /^[a-f0-9]{64}$/);
  const id = preview.body.previewId;
  const stored = await request('GET', `/previews/${id}`); assert.equal(stored.body.result.theme.mode, 'dark'); assert.equal(stored.body.userId, undefined);
  for (const [method, suffix, body] of [['GET', '', undefined], ['POST', '/apply', {}], ['POST', '/discard', {}]] as const) {
    const other = await request(method, `/previews/${id}${suffix}`, body, 0, server.b); assert.equal(other.status, 404); assert.equal(other.body.code, 'not_found');
  }
  const applied = await request('POST', `/previews/${id}/apply`, {}, rev); assert.equal(applied.status, 200); assert.equal(applied.body.undoToken, rev);
  assert.equal((await request('POST', `/previews/${id}/apply`, {}, rev + 1)).body.code, 'stale_preview');
  const stale = await request('POST', '/patches/preview', { patch: patch('light'), intent: 'Fixture stale preview' }, rev + 1);
  assert.equal((await request('PATCH', '/config', patch('system'), rev + 1)).status, 200);
  const rejected = await request('POST', `/previews/${stale.body.previewId}/apply`, {}, rev + 2);
  assert.equal(rejected.status, 409); assert.equal(rejected.body.code, 'stale_preview');
  const discarded = await request('POST', '/patches/preview', { patch: patch('light'), intent: 'Fixture discard' }, rev + 2);
  assert.equal((await request('POST', `/previews/${discarded.body.previewId}/discard`, {}, rev + 2)).status, 200);
  assert.equal((await request('GET', `/previews/${discarded.body.previewId}`)).body.status, 'discarded');
});

test('undo, history restore, reset and PUT all enforce revision and keep an audit trail', async () => {
  let rev = await revision(); const before = (await request('GET', '/config')).body.doc;
  assert.equal((await request('PATCH', '/config', patch('dark'), rev++)).status, 200);
  const undo = await request('POST', '/undo', { steps: 1 }, rev++); assert.equal(undo.status, 200); assert.deepEqual(undo.body.doc, before);
  const history = await request('GET', '/history'); assert.ok(history.body.history.length >= 3); assert.equal(history.body.history[0].revision, rev);
  const restored = await request('POST', '/history/0/restore', {}, rev++); assert.equal(restored.status, 200); assert.equal(restored.body.doc.theme.mode, 'system');
  assert.equal((await request('POST', '/reset', { scope: 'theme' }, rev++)).status, 200);
  const file = (await request('GET', '/config')).body.doc; file.theme.mode = 'dark';
  assert.equal((await request('PUT', '/config', file, rev++)).status, 200);
  const otherHistory = await request('GET', '/history', undefined, undefined, server.b); assert.deepEqual(otherHistory.body.history, []);
  assert.equal((await request('POST', '/history/1/restore', {}, 0, server.b)).status, 404);
});

test('presets list, save, enforce limits and delete only for the session account', async () => {
  const rev = await revision();
  const saved = await request('POST', '/presets', { name: 'Fixture preset' }, rev); assert.equal(saved.status, 200);
  const listed = await request('GET', '/presets'); assert.equal(listed.body.user[0].id, saved.body.presetId);
  const foreign = await request('DELETE', `/presets/${saved.body.presetId}`, {}, 0, server.b); assert.equal(foreign.status, 404);
  assert.equal((await request('DELETE', `/presets/${saved.body.presetId}`, {}, rev)).status, 200);
});

test('export contains only document fields and time, import never writes until Apply', async () => {
  const rev = await revision(), doc = (await request('GET', '/config')).body.doc;
  const file = await request('GET', '/export'); assert.match(file.headers.get('content-disposition')!, /attachment/);
  assert.deepEqual(Object.keys(file.body).sort(), [...Object.keys(doc), 'exportedAt'].sort());
  const imported = await request('POST', '/import/preview', file.body, rev); assert.equal(imported.status, 200); assert.equal(imported.body.applied, false);
  assert.equal(await revision(), rev);
  const preview = await request('GET', `/previews/${imported.body.previewId}`); assert.deepEqual(preview.body.result, doc);
  const invalid = await request('POST', '/import/preview', { ...file.body, unknown: true }, rev);
  assert.equal(invalid.status, 422); assert.ok(invalid.body.details.length > 0);
  const older = structuredClone(file.body); older.version = 0;
  const migrated = await request('POST', '/import/preview', older, rev); assert.equal(migrated.status, 422); assert.equal(migrated.body.code, 'invalid_value'); // v1 is the first published format.
});

test('bot and dashboard references cannot cross users in patches, reset or replacement', async () => {
  const rev = await revision();
  for (const [method, route, body] of [['PATCH', '/config', [{ op: 'add', path: '/layout/pinned/-', value: { type: 'bot', id: server.fixture.bot.id } }]],
    ['POST', '/reset', { scope: 'dashboard', dashboardId: 'd_aaaaaaaa' }]]) {
    const result = await request(String(method), String(route), body, rev); assert.equal(result.status, 404); assert.equal(result.body.code, 'not_found');
  }
});

test('real SSE connections deliver config and preview only to the session owner', async () => {
  const a = await sse(server.a), b = await sse(server.b);
  try {
    const rev = await revision(), preview = await request('POST', '/patches/preview', { patch: patch('light'), intent: 'Fixture live preview' }, rev);
    assert.equal(preview.status, 200); assert.equal((await request('POST', `/previews/${preview.body.previewId}/apply`, {}, rev)).status, 200);
    for (let i = 0; i < 100 && !a.events.some(event => event.type === 'ui_config'); i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(a.events.some(event => event.type === 'ui_config')); assert.ok(a.events.some(event => event.type === 'ui_preview'));
    assert.equal(b.events.filter(event => ['ui_config', 'ui_preview'].includes(event.type)).length, 0);
  } finally { await a.close(); await b.close(); }
});

test('schema publishes versioned registries, and corrupt storage does not crash sibling routes', async () => {
  const schema = await request('GET', '/schema'); assert.equal(schema.status, 200); assert.equal(schema.body.version, 1);
  assert.ok(schema.body.registries.tokens); assert.ok(schema.body.schema);
  const colors = schema.body.schema.properties.theme.properties.colors.properties.light;
  assert.match(JSON.stringify(colors), /pattern/); assert.match(JSON.stringify(colors), /\{6\}/);
  server.db.prepare('UPDATE ui_config SET doc=? WHERE user_id=?').run('{', server.a.userId);
  const get = await request('GET', '/config'); assert.equal(get.status, 200); assert.equal(get.body.status, 'invalid_stored');
  assert.equal((await request('GET', '/history')).status, 200);
  assert.equal((await request('POST', '/reset', { scope: 'all' }, get.body.revision)).status, 200);
});

test('account preference is isolated, and flag rollback makes every UI route disabled', async () => {
  const preferences = await fetch(`${server.base}/api/account/preferences`, { method: 'PATCH', headers: { cookie: server.a.cookie, origin: server.base, 'content-type': 'application/json' }, body: JSON.stringify({ uiAgentApply: 'auto' }) });
  assert.equal(preferences.status, 200); assert.equal((await preferences.json()).uiAgentApply, 'auto');
  assert.equal((await request('GET', '/config')).body.flags.agentApplyMode, 'auto');
  assert.equal((await request('GET', '/config', undefined, undefined, server.b)).body.flags.agentApplyMode, 'ask');
  server.db.prepare('UPDATE account_preferences SET ui_custom_enabled=0 WHERE user_id=?').run(server.a.userId);
  for (const [method, route] of [['GET', '/config'], ['PATCH', '/config'], ['PUT', '/config'], ['POST', '/patches/preview'], ['GET', '/previews/missing'], ['POST', '/previews/missing/apply'],
    ['POST', '/previews/missing/discard'], ['POST', '/undo'], ['POST', '/reset'], ['GET', '/history'], ['POST', '/history/0/restore'], ['GET', '/presets'], ['POST', '/presets'],
    ['DELETE', '/presets/missing'], ['GET', '/export'], ['POST', '/import/preview'], ['GET', '/schema'], ['POST', '/data']]) {
    const response = await request(method, route, method === 'GET' ? undefined : {}, 0); assert.equal(response.status, 404); assert.equal(response.body.code, 'disabled');
  }
  assert.equal((await request('GET', '/config', undefined, undefined, server.b)).status, 200);
});
