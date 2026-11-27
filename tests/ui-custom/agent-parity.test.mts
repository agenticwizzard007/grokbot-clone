import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { DEFAULT_CONFIG, REGISTRY, accentPair, presetConfig, previewPatch, type PatchOp } from '../../server/src/ui-config/index.js';
import { buildUiPatch } from '../../server/src/agent/ui-tools.js';

// UC-G owns the source fixture. Use its checked-in version after it lands, and
// its recorded branch snapshot while these independent workstreams are in flight.
const shared = new URL('./fixtures/parity.json', import.meta.url);
const snapshot = new URL('./agent/parity-snapshot.json', import.meta.url);
const fixture = JSON.parse(fs.readFileSync(fs.existsSync(shared) ? shared : snapshot, 'utf8'));
for (const entry of fixture.cases) test(`Settings parity: ${entry.id}`, () => {
  const before = entry.base ?? structuredClone(DEFAULT_CONFIG);
  let patch: PatchOp[];
  switch (entry.builder) {
    case 'choosePreset': patch = buildUiPatch('apply_preset', { presetId: entry.value }, before, { accentPair }, REGISTRY.presets.map(p => ({ id: p.id, doc: presetConfig(p.id) }))).patch; break;
    case 'createDashboard': patch = buildUiPatch('create_dashboard', { name: entry.value }, before, { accentPair }).patch; break;
    case 'renameDashboard': patch = buildUiPatch('rename_dashboard', { dashboardId: entry.idValue, name: entry.value }, before, { accentPair }).patch; break;
    case 'deleteDashboard': patch = buildUiPatch('delete_dashboard', { dashboardId: entry.idValue }, before, { accentPair }).patch; break;
    case 'setAccent': patch = buildUiPatch('set_accent', { color: entry.value }, before, { accentPair }).patch.filter(op => op.path.includes(`/${entry.mode}/`)); break;
    case 'setValue': patch = buildUiPatch('preview_ui_patch', { intent: 'Update appearance', patch: [{ op: 'add', path: entry.path, value: entry.value }] }, before, { accentPair }).patch; break;
    case 'sidebarVisibility': patch = buildUiPatch('preview_ui_patch', { intent: 'Change sidebar visibility', patch: [{ op: 'add', path: '/layout/sidebar/hidden', value: [...before.layout.sidebar.hidden.filter((id: string) => id !== entry.idValue), ...(entry.value ? [] : [entry.idValue])] }] }, before, { accentPair }).patch; break;
    case 'moveSidebar': patch = buildUiPatch('preview_ui_patch', { intent: 'Reorder the sidebar', patch: [{ op: 'move', from: `/layout/sidebar/order/${entry.from}`, path: `/layout/sidebar/order/${entry.from + entry.direction}` }] }, before, { accentPair }).patch; break;
    default: throw new Error(`Add a parity case for ${entry.builder}`);
  }
  assert.deepEqual(patch, entry.patch);
  const context = () => { let id = 0; return { generateId: (kind: 'dashboard' | 'widget') => `${kind === 'dashboard' ? 'd' : 'w'}_${String(++id).padStart(8, '0')}` }; };
  const agent = previewPatch(before, patch, { ctx: context() });
  const settings = previewPatch(before, entry.patch, { ctx: context() });
  assert.equal(agent.ok, true, JSON.stringify(agent));
  assert.deepEqual(agent, settings);
});
