import { DEFAULT_CONFIG } from './schema.js';
import type { ApplyResult, PatchOp, PreviewResult, ResetScope, StoredPreview, UiConfigService } from './service.js';
const unavailable = (): ApplyResult & PreviewResult => ({ ok: false, errors: [{ path: '', code: 'disabled', message: 'Customization engine is not ready.' }] });
export class MemoryUiConfigService implements UiConfigService {
  get(_userId: string) { return { doc: structuredClone(DEFAULT_CONFIG), revision: 0 }; }
  preview(_userId: string, _ops: PatchOp[], _opts: { intent: string; actor: string; autofix?: boolean }): PreviewResult { return unavailable(); }
  getPreview(_userId: string, _id: string): StoredPreview | null { return null; }
  applyPreview(_userId: string, _id: string, _actor: string): ApplyResult { return unavailable(); }
  discardPreview(_userId: string, _id: string): void {}
  patch(_userId: string, _ops: PatchOp[], _expectedRevision: number, _actor: string): ApplyResult { return unavailable(); }
  undo(_userId: string, _steps: number, _actor: string): ApplyResult { return unavailable(); }
  reset(_userId: string, _scope: ResetScope, _dashboardId?: string): PreviewResult { return unavailable(); }
  agentApplyMode(_userId: string): 'ask' | 'auto' { return 'ask'; }
  enabled(_userId: string): boolean { return false; }
}
