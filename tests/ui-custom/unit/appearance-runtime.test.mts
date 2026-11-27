import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CONFIG, type StoredPreview } from '../../../server/src/ui-config/index.ts';
import { useCustomization, handleUiEvent, clearPreview } from '../../../web/src/customization/store.ts';

test('a delayed pending event does not clear a manually opened Settings preview', async () => {
  const preview: StoredPreview = { id: 'QA-Temp-Preview', userId: 'QA-Temp-User', baseRevision: 0, patch: [], result: structuredClone(DEFAULT_CONFIG), summary: [], warnings: [], idMap: {}, intent: 'QA-Temp layout', actor: 'user', status: 'pending', createdAt: Date.now(), expiresAt: Date.now() + 900000 };
  useCustomization.setState({ userId: preview.userId, saved: DEFAULT_CONFIG, effective: preview.result, revision: 0, status: 'ready', preview, showBefore: false, safe: false });
  try {
    await handleUiEvent({ type: 'ui_preview', previewId: preview.id, botId: '', state: 'pending' }, null);
    assert.equal(useCustomization.getState().preview?.id, preview.id);
  } finally { clearPreview(); useCustomization.setState({ userId: null }); }
});
