import type { UiConfig } from './schema.js';
import type { PatchContext, PatchOp, PatchResult } from './service.js';
export function previewPatch(_current: UiConfig, _ops: PatchOp[], _opts: { autofix?: boolean; ctx: PatchContext }): PatchResult {
  return { ok: false, errors: [{ path: '', code: 'disabled', message: 'Customization engine is not ready.' }] };
}
