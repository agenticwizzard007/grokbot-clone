import assert from 'node:assert/strict';
import test from 'node:test';
import { XSS, cssFuzz, HOSTILE_PATCHES, INJECTION_DOCUMENTS } from './corpus.mjs';
import { MATRIX, matrixDocument, widgets } from '../fixtures/matrix.mjs';
import { requireFeature, MissingFeature } from '../fixtures/harness.mjs';

test('50 distinct XSS cases cover active HTML and network asset sinks', () => {
  assert.equal(XSS.length, 50); assert.equal(new Set(XSS).size, 50);
  for (const sink of ['script', 'img', 'svg', 'iframe', 'style', 'form', 'template', '__proto__']) assert.ok(XSS.some(value => value.includes(sink)), sink);
  for (const value of XSS) assert.match(value, /[<>]/);
});
test('CSS fuzz is reproducible, distinct and cannot accidentally be a valid enum or hex', () => {
  const values = cssFuzz(); assert.equal(values.length, 5000); assert.equal(new Set(values).size, 5000);
  assert.deepEqual(values, cssFuzz()); assert.notDeepEqual(values, cssFuzz(5000, 42));
  for (const value of values) { assert.ok(value.includes('!')); assert.doesNotMatch(value, /^#[0-9a-f]{6}$/i); }
});
test('hostile fixtures exercise recovery and resource limits', () => {
  assert.equal(INJECTION_DOCUMENTS.length, 10); assert.equal(HOSTILE_PATCHES.length, 10);
  assert.equal(HOSTILE_PATCHES.find(p => p.name === 'patch storm').patch.length, 101);
});
test('matrix covers all widget types and long labels without mutating defaults', () => {
  assert.equal(new Set(widgets().map(w => w.type)).size, 10);
  assert.equal(MATRIX.length, 7);
  const defaults = { theme: { font: {} }, dashboards: [] };
  const doc = matrixDocument(defaults, 'hostile', 'dark');
  assert.equal(doc.dashboards.length, 12); assert.deepEqual(defaults, { theme: { font: {} }, dashboards: [] });
  assert.equal(new Set(doc.dashboards.flatMap(d => d.widgets.map(w => w.id))).size, 144);
  for (const d of doc.dashboards) { assert.ok(d.name.length <= 40); for (const w of d.widgets) assert.ok(w.title.length <= 60); }
});
test('development absence skips but full gate fails; available feature always runs', () => {
  const previous = process.env.UC_REQUIRE_FULL;
  try {
    delete process.env.UC_REQUIRE_FULL; assert.throws(() => requireFeature(false, 'fixture absent'), MissingFeature);
    process.env.UC_REQUIRE_FULL = '1'; assert.throws(() => requireFeature(false, 'fixture absent'), error => !(error instanceof MissingFeature) && /Required feature/.test(error.message));
    assert.doesNotThrow(() => requireFeature(true, 'fixture present'));
  } finally { if (previous === undefined) delete process.env.UC_REQUIRE_FULL; else process.env.UC_REQUIRE_FULL = previous; }
});
