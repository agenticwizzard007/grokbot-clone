import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tsImport } from 'tsx/esm/api';
const { DEFAULT_CONFIG, previewPatch, checkAccessibility } = await tsImport('../../server/src/ui-config/index.ts', import.meta.url);
const dashboard = JSON.parse(fs.readFileSync(new URL('./unit/documents.json', import.meta.url), 'utf8')).dashboardPatch;
const scenarios = [
  { name: 'Theme', patch: [{ op: 'replace', path: '/theme/mode', value: 'dark' }, { op: 'add', path: '/theme/colors/light/primary', value: '#0F766E' }, { op: 'add', path: '/theme/colors/dark/primary', value: '#2DD4BF' }], expected: true },
  { name: 'Readability', patch: [{ op: 'replace', path: '/theme/font/scale', value: 'large' }, { op: 'replace', path: '/theme/density', value: 'comfortable' }], expected: true },
  { name: 'Low contrast with autofix', patch: [{ op: 'add', path: '/theme/colors/light/primary', value: '#FFFFFF' }], autofix: true, expected: true },
  { name: 'Hide Settings rejected', patch: [{ op: 'replace', path: '/layout/sidebar/hidden', value: ['settings'] }], expected: false, code: 'required_item' },
  { name: 'Unknown path hint', patch: [{ op: 'add', path: '/theme/accentColor', value: '#0F766E' }], expected: false, code: 'unknown_path' },
  { name: 'Dashboard with temporary ids', patch: dashboard, expected: true },
  { name: 'XSS string rejected', patch: [{ op: 'add', path: '/dashboards/-', value: { id: '$new1', name: '<img src=x onerror=alert(1)>', icon: 'layout-dashboard', widgets: [] } }], expected: false, code: 'invalid_value' },
];
const output = path.resolve('.context/ui-custom/demo-a'); fs.mkdirSync(output, { recursive: true });
const report = [], transcript = [];
for (const scenario of scenarios) {
  let counter = 0;
  const result = previewPatch(DEFAULT_CONFIG, scenario.patch, { autofix: scenario.autofix, ctx: { userId: 'QA-Temp-demo', generateId: kind => `${kind === 'dashboard' ? 'd' : 'w'}_${(++counter).toString(36).padStart(8, '0')}` } });
  assert.equal(result.ok, scenario.expected, scenario.name);
  if (result.ok) {
    assert.deepEqual(checkAccessibility(result.result), []);
    assert.ok(result.summary.length);
    if (scenario.autofix) assert.ok(result.warnings.some(w => w.code === 'accessibility'));
    if (scenario.patch === dashboard) { assert.equal(Object.keys(result.idMap).length, 6); assert.equal(result.result.layout.pinned[0].id, result.idMap.$new1); }
  } else {
    assert.ok(result.errors.some(e => e.code === scenario.code));
    if (scenario.code === 'unknown_path') assert.ok(result.errors[0].hint);
  }
  const printed = { scenario: scenario.name, patch: scenario.patch, ...(result.ok ? { summary: result.summary, warnings: result.warnings, idMap: result.idMap } : { errors: result.errors }), pass: true };
  report.push({ ...printed, result }); transcript.push(JSON.stringify(printed, null, 2)); console.log(transcript.at(-1));
}
fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
fs.writeFileSync(path.join(output, 'transcript.txt'), transcript.join('\n\n') + '\n');
console.log(`UC-A demo: ${report.length}/7 scenarios passed. Output: ${output}`);
