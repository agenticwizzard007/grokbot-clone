import assert from 'node:assert/strict';
import test from 'node:test';
import { XSS, cssFuzz, HOSTILE_PATCHES, INJECTION_DOCUMENTS } from './corpus.mjs';
import { MATRIX, matrixDocument, widgets, DASHBOARD_EDITS, dashboardPatch, REQUIREMENTS } from '../fixtures/matrix.mjs';
import { requireFeature, requireModules, MissingFeature } from '../fixtures/harness.mjs';

test('50 distinct XSS cases cover active HTML and network asset sinks', () => {
  assert.equal(XSS.length, 50); assert.equal(new Set(XSS).size, 50);
  for (const sink of ['script', 'img', 'svg', 'iframe', 'style', 'form', 'template', '__proto__']) assert.ok(XSS.some(value => value.includes(sink)), sink);
  for (const value of XSS) assert.match(value, /[<>]/);
});
test('CSS fuzz is reproducible, distinct and cannot accidentally be a valid enum', () => {
  const values = cssFuzz(); assert.equal(values.length, 5000); assert.equal(new Set(values).size, 5000);
  assert.deepEqual(values, cssFuzz()); assert.notDeepEqual(values, cssFuzz(5000, 42));
  for (const value of values) { assert.ok(value.includes('!')); }
});
test('hostile fixtures exercise recovery and resource limits', () => {
  assert.equal(INJECTION_DOCUMENTS.length, 10); assert.equal(HOSTILE_PATCHES.length, 10);
  assert.equal(HOSTILE_PATCHES.find(p => p.name === 'patch storm').patch.length, 101);
});
test('matrix covers all widget types without cosmetic overrides or mutation', async () => {
  const { contracts } = await import('../fixtures/contracts.mjs');
  const { DEFAULT_CONFIG, uiConfigSchema } = await contracts();
  assert.equal(new Set(widgets().map(w => w.type)).size, 10);
  assert.deepEqual(MATRIX, ['default', 'navigation', 'dashboard-seeded', 'dashboard-empty']);
  const before = structuredClone(DEFAULT_CONFIG);
  for (const fixture of MATRIX) {
    const doc = matrixDocument(DEFAULT_CONFIG, fixture);
    assert.equal(uiConfigSchema.safeParse(doc).success, true, fixture);
    assert.deepEqual(doc.theme, DEFAULT_CONFIG.theme, 'No cosmetic overrides');
    assert.equal(doc.preset, DEFAULT_CONFIG.preset);
    assert.deepEqual(doc.device, DEFAULT_CONFIG.device);
  }
  assert.deepEqual(DEFAULT_CONFIG, before);
});
test('development absence skips but full gate fails; available feature always runs', () => {
  const previous = process.env.UC_REQUIRE_FULL;
  try {
    delete process.env.UC_REQUIRE_FULL; assert.throws(() => requireFeature(false, 'fixture absent'), MissingFeature);
    process.env.UC_REQUIRE_FULL = '1'; assert.throws(() => requireFeature(false, 'fixture absent'), error => !(error instanceof MissingFeature) && /Required feature/.test(error.message));
    assert.doesNotThrow(() => requireFeature(true, 'fixture present'));
  } finally { if (previous === undefined) delete process.env.UC_REQUIRE_FULL; else process.env.UC_REQUIRE_FULL = previous; }
});

test('chat action sequence validates and leaves every widget type represented', async () => {
  const { contracts } = await import('../fixtures/contracts.mjs');
  const { DEFAULT_CONFIG, previewPatch } = await contracts();
  let doc = structuredClone(DEFAULT_CONFIG);
  for (const patch of [dashboardPatch(), ...DASHBOARD_EDITS.map(edit => edit.patch)]) {
    const result = previewPatch(doc, patch, { ctx: { userId: 'qa-temp-corpus', botIds: [] } });
    assert.equal(result.ok, true, JSON.stringify(result));
    doc = result.result;
  }
  assert.equal(doc.dashboards[0].widgets.length, 12);
  assert.equal(new Set(doc.dashboards[0].widgets.map(w => w.type)).size, 10);
  assert.equal(doc.dashboards[0].widgets[1].span, 6);
  assert.equal(doc.dashboards[0].widgets[1].rows, 2);
  assert.deepEqual(doc.theme, DEFAULT_CONFIG.theme);
});
test('requirements fixtures distinguish use cases and include hostile profile instructions', () => {
  assert.equal(new Set(Object.values(REQUIREMENTS).map(p => p.lens)).size, 3);
  assert.notDeepEqual(REQUIREMENTS.sales.focus, REQUIREMENTS.operations.focus);
  assert.ok(INJECTION_DOCUMENTS.some(value => value.includes('update_requirements')));
  assert.ok(INJECTION_DOCUMENTS.some(value => value.includes('preview_adaptation')));
});

test('merged API probes never skip missing routes, authentication failures or server errors', async () => {
  const { configAvailable } = await import('../fixtures/harness.mjs');
  for (const status of [401, 403, 404, 500]) {
    const request = { get: async () => ({ status: () => status, text: async () => 'fixture failure' }) };
    await assert.rejects(configAvailable(request, 'http://127.0.0.1:1234'), error => !(error instanceof MissingFeature));
  }
  await assert.rejects(configAvailable({ get: async () => { throw new Error('Must not request a remote host'); } }, 'https://example.invalid'), /loopback/);
});

test('merged modules are mandatory without the full gate flag', () => {
  assert.doesNotThrow(() => requireModules('server/src/agent/ui-requirements-tools.ts', 'web/src/components/AllSections.tsx'));
  assert.throws(() => requireModules('tests/ui-custom/absent-module.ts'), error => !(error instanceof MissingFeature) && /Merged feature module unavailable/.test(error.message));
});
