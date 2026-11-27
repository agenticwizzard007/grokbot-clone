// Mandatory real HTTP integration checks for the merged UC-B service.
// Client-only journeys remain in journeys-ui.mjs and do not substitute for these checks.
import assert from 'node:assert/strict';
import { runSuite, fixtureContext, configAvailable, api, put } from '../fixtures/harness.mjs';
import { MATRIX, MODES, matrixDocument, THEME_PATCH } from '../fixtures/matrix.mjs';
import { contracts, presetDocument } from '../fixtures/presets.mjs';

async function withAccount(args, run) {
  const { context } = await fixtureContext(args.browser, args.server);
  try {
    const current = await configAvailable(context.request, args.server.base);
    await api(context.request, args.server.base, '/reset', 'POST', { scope: 'all' }, 200, current.revision);
    await run({ ...args, context, current: await configAvailable(context.request, args.server.base) });
  } finally { await context.close(); }
}
const cases = MATRIX.flatMap(fixture => MODES.map(mode => ({ name: `matrix PUT persists ${fixture} ${mode}`, run: args => withAccount(args, async ({ context, server, current }) => {
  const { DEFAULT_CONFIG } = await contracts();
  const doc = matrixDocument(DEFAULT_CONFIG, fixture, mode, await presetDocument(fixture === 'hostile' ? 'swarm' : fixture));
  const written = await put(context, server.base, doc);
  assert.equal(written.revision, current.revision + 1);
  assert.deepEqual((await configAvailable(context.request, server.base)).doc, doc);
}) })));
cases.push(
  { name: 'ETag cache and concurrent If-Match writes', run: args => withAccount(args, async ({ context, server, current }) => {
    const response = await context.request.get(`${server.base}/api/ui/config`);
    assert.equal(response.status(), 200); assert.equal(response.headers().etag, `"${current.revision}"`);
    const cached = await context.request.get(`${server.base}/api/ui/config`, { headers: { 'If-None-Match': response.headers().etag } });
    assert.equal(cached.status(), 304);
    const missing = await context.request.patch(`${server.base}/api/ui/config`, { data: { patch: THEME_PATCH }, headers: { Origin: server.base } });
    assert.equal(missing.status(), 409);
    const responses = await Promise.all(['dark', 'light'].map(mode => context.request.patch(`${server.base}/api/ui/config`, {
      data: { patch: [{ op: 'replace', path: '/theme/mode', value: mode }] }, headers: { Origin: server.base, 'If-Match': `"${current.revision}"` },
    })));
    assert.deepEqual(responses.map(item => item.status()).sort(), [200, 409]);
    assert.equal((await responses.find(item => item.status() === 409).json()).code, 'stale_revision');
    const winner = await responses.find(item => item.status() === 200).json();
    const after = await configAvailable(context.request, server.base);
    assert.equal(after.revision, current.revision + 1); assert.deepEqual(after.doc, winner.doc);
  }) },
  { name: 'preview, apply, Undo and history restore use real revisions', run: args => withAccount(args, async ({ context, server, current }) => {
    const preview = await api(context.request, server.base, '/patches/preview', 'POST', { intent: 'Fixture teal preview', patch: THEME_PATCH, autofix: true });
    assert.match(preview.resultHash, /^[a-f0-9]{64}$/);
    const stored = await api(context.request, server.base, `/previews/${preview.previewId}`);
    assert.equal(stored.status, 'pending'); assert.equal(stored.result.theme.mode, 'dark');
    assert.equal((await configAvailable(context.request, server.base)).revision, current.revision, 'Preview must not save');
    const applied = await api(context.request, server.base, `/previews/${preview.previewId}/apply`, 'POST', {});
    assert.equal(applied.revision, current.revision + 1); assert.equal(applied.undoToken, current.revision);
    assert.equal((await api(context.request, server.base, `/previews/${preview.previewId}`)).status, 'applied');
    const undone = await api(context.request, server.base, '/undo', 'POST', { steps: 1 });
    assert.deepEqual(undone.doc, current.doc); assert.equal(undone.revision, applied.revision + 1);
    const history = await api(context.request, server.base, '/history');
    assert.ok(history.history.some(row => row.revision === applied.revision));
    const restored = await api(context.request, server.base, `/history/${applied.revision}/restore`, 'POST', {});
    assert.deepEqual(restored.doc, applied.doc); assert.equal(restored.revision, undone.revision + 1);
  }) },
  { name: 'preset and portable import preview round trip', run: args => withAccount(args, async ({ context, server, current }) => {
    const preset = await api(context.request, server.base, '/presets', 'POST', { name: 'Fixture saved look' });
    try {
      const list = await api(context.request, server.base, '/presets');
      assert.equal(list.builtin.length, 8); assert.ok(list.user.some(item => item.id === preset.presetId));
      const response = await context.request.get(`${server.base}/api/ui/export`);
      assert.equal(response.status(), 200); assert.match(response.headers()['content-disposition'], /attachment/);
      const doc = await response.json(); doc.theme.mode = 'dark';
      const preview = await api(context.request, server.base, '/import/preview', 'POST', doc);
      assert.equal((await configAvailable(context.request, server.base)).revision, current.revision);
      assert.equal((await api(context.request, server.base, `/previews/${preview.previewId}`)).result.theme.mode, 'dark');
      await api(context.request, server.base, `/previews/${preview.previewId}/discard`, 'POST', {});
      assert.equal((await api(context.request, server.base, `/previews/${preview.previewId}`)).status, 'discarded');
      assert.deepEqual((await configAvailable(context.request, server.base)).doc, current.doc);
    } finally { await api(context.request, server.base, `/presets/${preset.presetId}`, 'DELETE', {}); }
  }) },
  { name: 'published schema and explicit account flag rollback', run: args => withAccount(args, async ({ context, server, current }) => {
    const schema = await api(context.request, server.base, '/schema');
    assert.equal(schema.version, 1); assert.equal(schema.registries.widgets.length, 10); assert.ok(schema.schema.properties.theme);
    const setFlag = flag => server.withDb(db => db.prepare('INSERT INTO account_preferences(user_id,ui_custom_enabled,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET ui_custom_enabled=excluded.ui_custom_enabled,updated_at=excluded.updated_at').run(server.fixture.userId, flag, Date.now()));
    try {
      setFlag(0);
      const disabled = await api(context.request, server.base, '/config', 'GET', undefined, 404);
      assert.equal(disabled.code, 'disabled');
      await assert.rejects(configAvailable(context.request, server.base), { name: 'AssertionError' }, 'The normal fixture probe must fail rather than skip a disabled merged endpoint');
      setFlag(1);
      assert.deepEqual((await configAvailable(context.request, server.base)).doc, current.doc);
    } finally { setFlag(null); }
  }) },
);
await runSuite('service', cases);
