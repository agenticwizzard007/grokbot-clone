import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CONFIG, previewPatch, type PatchOp, type StoredPreview } from '../../../server/src/ui-config/index.ts';
import { useCustomization, handleUiEvent, clearPreview } from '../../../web/src/customization/store.ts';

test('a delayed pending event does not clear a manually opened Settings preview', async () => {
  const patch: PatchOp[] = [{ op: 'add', path: '/layout/home', value: { kind: 'tasks' } }];
  const proposed = previewPatch(DEFAULT_CONFIG, patch, { ctx: {} });
  assert.equal(proposed.ok, true);
  if (!proposed.ok) return;
  const preview: StoredPreview = { id: 'QA-Temp-Preview', userId: 'QA-Temp-User', baseRevision: 0, patch, result: proposed.result, summary: proposed.summary, warnings: proposed.warnings, idMap: proposed.idMap, intent: 'Open Tasks at home', actor: 'user', status: 'pending', createdAt: Date.now(), expiresAt: Date.now() + 900000 };
  useCustomization.setState({ userId: preview.userId, saved: DEFAULT_CONFIG, effective: preview.result, revision: 0, status: 'ready', preview, showBefore: false, safe: false });
  try {
    await handleUiEvent({ type: 'ui_preview', previewId: preview.id, botId: '', state: 'pending' }, null);
    assert.equal(useCustomization.getState().preview?.id, preview.id);
    assert.equal(useCustomization.getState().effective.layout.home.kind, 'tasks');
    assert.equal(useCustomization.getState().saved.layout.home.kind, 'default');
    await handleUiEvent({ type: 'ui_preview', previewId: preview.id, botId: '', state: 'discarded' }, null);
    assert.equal(useCustomization.getState().preview, null);
    assert.equal(useCustomization.getState().effective.layout.home.kind, 'default');
  } finally { clearPreview(); useCustomization.setState({ userId: null }); }
});
