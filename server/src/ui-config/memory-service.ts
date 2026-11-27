import { DEFAULT_CONFIG, LIMITS, type UiConfig } from './schema.js';
import { plainText } from './registry-widgets.js';
import { previewPatch } from './patch.js';
import { summarize } from './summarize.js';
import { violation } from './errors.js';
import type { ApplyResult, PatchContext, PatchOp, PreviewResult, ResetScope, StoredPreview, UiConfigService } from './service.js';
export interface HistoryEntry { doc: UiConfig; revision: number; summary: string[]; actor: string; createdAt: number }
export interface MemoryServiceOptions { now?: () => number; enabled?: boolean | ((userId: string) => boolean); agentApplyMode?: 'ask' | 'auto' | ((userId: string) => 'ask' | 'auto'); context?: (userId: string) => PatchContext }
const failure = (code: Parameters<typeof violation>[1], message: string): ApplyResult & PreviewResult => ({ ok: false, errors: [violation('', code, message)] });
export class MemoryUiConfigService implements UiConfigService {
  private users = new Map<string, { doc: UiConfig; revision: number }>();
  private previews = new Map<string, StoredPreview>();
  private history = new Map<string, HistoryEntry[]>();
  private now: () => number;
  constructor(private options: MemoryServiceOptions = {}) { this.now = options.now ?? Date.now; }
  get(userId: string) { return structuredClone(this.users.get(userId) ?? { doc: DEFAULT_CONFIG, revision: 0 }); }
  agentApplyMode(userId: string): 'ask' | 'auto' { return typeof this.options.agentApplyMode === 'function' ? this.options.agentApplyMode(userId) : this.options.agentApplyMode ?? 'ask'; }
  enabled(userId: string): boolean { return typeof this.options.enabled === 'function' ? this.options.enabled(userId) : this.options.enabled ?? true; }
  private context(userId: string): PatchContext { return { ...this.options.context?.(userId), userId }; }
  preview(userId: string, ops: PatchOp[], opts: { intent: string; actor: string; autofix?: boolean }): PreviewResult {
    if (!this.enabled(userId)) return failure('disabled', 'Customization is disabled.');
    if (!plainText(200, 1).safeParse(opts.intent).success) return failure('invalid_value', 'Use a short plain-text intent.');
    const current = this.get(userId), result = previewPatch(current.doc, ops, { ctx: this.context(userId), autofix: opts.autofix });
    if (!result.ok) return result;
    const now = this.now(), id = `p_${globalThis.crypto.randomUUID()}`;
    for (const preview of this.previews.values()) if (preview.userId === userId && preview.status === 'pending') preview.status = preview.expiresAt <= now ? 'expired' : 'superseded';
    // The resolved root replacement also captures autofix and removed dangling Bot pins.
    this.previews.set(id, { id, userId, baseRevision: current.revision, patch: [{ op: 'replace', path: '', value: structuredClone(result.result) }], result: structuredClone(result.result), summary: result.summary, warnings: result.warnings, idMap: result.idMap, intent: opts.intent, actor: opts.actor, status: 'pending', createdAt: now, expiresAt: now + LIMITS.previewTtlMs });
    return structuredClone({ ok: true, previewId: id, baseRevision: current.revision, summary: result.summary, warnings: result.warnings, idMap: result.idMap, applied: false });
  }
  getPreview(userId: string, id: string): StoredPreview | null {
    if (!this.enabled(userId)) return null;
    const preview = this.previews.get(id);
    if (!preview || preview.userId !== userId) return null;
    if (preview.status === 'pending' && preview.expiresAt <= this.now()) preview.status = 'expired';
    return structuredClone(preview);
  }
  applyPreview(userId: string, id: string, actor: string): ApplyResult {
    if (!this.enabled(userId)) return failure('disabled', 'Customization is disabled.');
    const preview = this.getPreview(userId, id);
    if (!preview) return failure('not_found', 'Preview does not exist.');
    if (preview.status === 'expired') return failure('preview_expired', 'Preview expired. Create a new preview.');
    if (preview.status !== 'pending' || preview.baseRevision !== this.get(userId).revision) return failure('stale_preview', 'The appearance changed. Create a new preview.');
    const checked = previewPatch(this.get(userId).doc, preview.patch, { ctx: this.context(userId) });
    if (!checked.ok) return checked;
    const result = this.commit(userId, checked.result, actor, preview.summary);
    const stored = this.previews.get(id)!; stored.status = 'applied'; stored.revision = result.revision;
    return result;
  }
  discardPreview(userId: string, id: string): void {
    const preview = this.getPreview(userId, id);
    if (preview?.status === 'pending') this.previews.get(id)!.status = 'discarded';
  }
  patch(userId: string, ops: PatchOp[], expectedRevision: number, actor: string): ApplyResult {
    if (!this.enabled(userId)) return failure('disabled', 'Customization is disabled.');
    const current = this.get(userId);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== current.revision) return failure('stale_revision', 'The appearance changed. Reload before applying.');
    const result = previewPatch(current.doc, ops, { ctx: this.context(userId) });
    return result.ok ? this.commit(userId, result.result, actor, result.summary) : result;
  }
  private commit(userId: string, doc: UiConfig, actor: string, summary: string[]): Extract<ApplyResult, { ok: true }> {
    const previous = this.get(userId), now = this.now(), revision = previous.revision + 1;
    const history = this.prune(userId);
    history.push({ ...previous, actor, summary, createdAt: now });
    this.history.set(userId, history.slice(-LIMITS.history));
    this.users.set(userId, { doc: structuredClone(doc), revision });
    return structuredClone({ ok: true, doc, revision, summary });
  }
  private prune(userId: string): HistoryEntry[] {
    const history = (this.history.get(userId) ?? []).filter(h => h.createdAt > this.now() - LIMITS.historyDays * 86400000).slice(-LIMITS.history);
    this.history.set(userId, history); return history;
  }
  getHistory(userId: string): HistoryEntry[] { return this.enabled(userId) ? structuredClone(this.prune(userId)).reverse() : []; }
  undo(userId: string, steps: number, actor: string): ApplyResult {
    if (!this.enabled(userId)) return failure('disabled', 'Customization is disabled.');
    if (!Number.isInteger(steps) || steps < 1 || steps > 10) return failure('invalid_value', 'Choose 1 to 10 steps.');
    const history = this.prune(userId), target = history[history.length - steps];
    if (!target) return failure('not_found', 'No earlier revision is available.');
    const checked = previewPatch(this.get(userId).doc, [{ op: 'replace', path: '', value: target.doc }], { ctx: this.context(userId) });
    return checked.ok ? this.commit(userId, checked.result, actor, summarize(this.get(userId).doc, checked.result)) : checked;
  }
  reset(userId: string, scope: ResetScope, dashboardId?: string): PreviewResult {
    const current = this.get(userId).doc, doc = structuredClone(current);
    if (!['all', 'appearance', 'theme', 'layout', 'components', 'dashboards', 'dashboard'].includes(scope)) return failure('invalid_value', 'Unknown reset scope.');
    if (scope === 'dashboard' && !current.dashboards.some(d => d.id === dashboardId)) return failure('not_found', 'Dashboard does not exist.');
    let result = doc;
    if (scope === 'all') result = structuredClone(DEFAULT_CONFIG);
    else if (scope === 'appearance') result = { ...structuredClone(DEFAULT_CONFIG), dashboards: doc.dashboards };
    else if (scope === 'theme') { result.theme = structuredClone(DEFAULT_CONFIG.theme); result.preset = 'swarm'; result.device = structuredClone(DEFAULT_CONFIG.device); }
    else if (scope === 'layout') result.layout = structuredClone(DEFAULT_CONFIG.layout);
    else if (scope === 'components') result.components = {};
    else {
      result.dashboards = scope === 'dashboards' ? [] : result.dashboards.filter(d => d.id !== dashboardId);
      const ids = new Set(result.dashboards.map(d => d.id));
      if (result.layout.home.kind === 'dashboard' && !ids.has(result.layout.home.dashboardId)) result.layout.home = { kind: 'default' };
      result.layout.pinned = result.layout.pinned.filter(p => p.type !== 'dashboard' || ids.has(p.id));
      result.layout.phoneTabs = result.layout.phoneTabs.filter(t => !t.startsWith('dashboard:') || ids.has(t.slice(10)));
      for (const tab of DEFAULT_CONFIG.layout.phoneTabs) if (result.layout.phoneTabs.length < 3 && !result.layout.phoneTabs.includes(tab)) result.layout.phoneTabs.push(tab);
      for (const d of result.dashboards) for (const w of d.widgets) if (w.type === 'shortcuts' && Array.isArray(w.options.items)) {
        const items = w.options.items.filter(item => !item.target.startsWith('dashboard:') || ids.has(item.target.slice(10)));
        w.options.items = items.length ? items : [{ label: 'Bots', target: 'bots' }];
      }
    }
    const preview = this.preview(userId, [{ op: 'replace', path: '', value: result }], { intent: 'Reset appearance', actor: 'reset' });
    if (preview.ok && !preview.summary.some(line => line.startsWith('Removes '))) { const line = 'Removes 0 dashboards'; preview.summary.push(line); this.previews.get(preview.previewId)!.summary.push(line); }
    return preview;
  }
}
