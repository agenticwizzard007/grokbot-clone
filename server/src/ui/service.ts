import type Database from 'better-sqlite3';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DEFAULT_CONFIG, checkAccessibility, migrate, previewPatch, uiConfigSchema,
  type ApplyResult, type ErrorCode, type PatchOp, type PreviewResult, type ResetScope,
  type StoredPreview, type UiConfig, type UiConfigService, type Violation } from '../ui-config/index.js';
import { initUiDatabase, initUiPreferences } from './db.js';
import { uiAgentApplyMode, uiEnabled } from './flags.js';
import { previewEvent, type UiEvent, type UiEventSink } from './events.js';
import { createUiMetrics, type UiMetricSink } from './metrics.js';
import { canonical, UiStore } from './store.js';

const fail = (code: ErrorCode, message: string, path = ''): { ok: false; errors: Violation[] } => ({ ok: false, errors: [{ path, code, message }] });
const intentSchema = z.string().min(1).max(200).regex(/^[^<>\u0000-\u001f\u007f\u2013\u2014]+$/u);
const nameSchema = z.string().min(1).max(40).regex(/^[^<>\u0000-\u001f\u007f\u2013\u2014]+$/u);
const resetScopes = new Set(['all', 'appearance', 'theme', 'layout', 'components', 'dashboards', 'dashboard']);
export const resultHash = (doc: UiConfig) => createHash('sha256').update(canonical(doc)).digest('hex');
export interface UiSnapshot { doc: UiConfig; revision: number; status: 'ready' | 'invalid_stored'; updatedAt?: number; updatedBy?: string }
export interface ServiceOptions { clock?: () => number; flag?: () => string | undefined; emit?: UiEventSink; metrics?: UiMetricSink }

/** The engine owns validation. This service owns isolation, transactions and lifetime. */
export class SqliteUiConfigService implements UiConfigService {
  readonly store: UiStore;
  private clock: () => number;
  private metric: ReturnType<typeof createUiMetrics>;
  private effects: (() => void)[] | undefined;
  constructor(db: Database.Database, private options: ServiceOptions = {}) {
    initUiDatabase(db); initUiPreferences(db);
    this.store = new UiStore(db); this.clock = options.clock ?? Date.now;
    this.metric = createUiMetrics(options.metrics);
  }
  enabled(userId: string) { return uiEnabled(this.store.db, userId, this.options.flag?.() ?? process.env.UI_CUSTOMIZATION); }
  agentApplyMode(userId: string) { return uiAgentApplyMode(this.store.db, userId); }
  private emit(userId: string, event: UiEvent) {
    const effect = () => this.options.emit?.(userId, event);
    if (this.effects) this.effects.push(effect); else effect();
  }
  private atomic<T>(action: () => T): T {
    // Publishing under an unmanaged outer transaction could announce a rollback.
    if (this.store.db.inTransaction) throw new Error('UI changes must own their transaction.');
    const effects: (() => void)[] = [];
    this.effects = effects;
    let result: T;
    try { result = this.store.db.transaction(action).immediate(); }
    finally { this.effects = undefined; }
    for (const effect of effects) { try { effect(); } catch { /* A committed write stays committed. */ } }
    return result;
  }
  private reject(result: { ok: false; errors: Violation[] }) {
    this.metric('ui_patch_rejected', 1, result.errors[0]?.code);
    return result;
  }
  private unavailable() { return fail('disabled', 'Appearance customization is disabled.'); }
  private parse(raw: string): UiConfig | null {
    try {
      const parsed = migrate(JSON.parse(raw));
      return 'doc' in parsed && !checkAccessibility(parsed.doc).length ? parsed.doc : null;
    } catch { return null; }
  }
  get(userId: string): UiSnapshot {
    const row = this.store.config(userId);
    if (!row) return { doc: structuredClone(DEFAULT_CONFIG), revision: 0, status: 'ready' };
    const doc = this.parse(row.doc);
    return { doc: doc ?? structuredClone(DEFAULT_CONFIG), revision: row.revision,
      status: doc ? 'ready' : 'invalid_stored', updatedAt: row.updated_at, updatedBy: row.updated_by };
  }
  private ctx(userId: string) {
    return { userId, botIds: this.store.bots(userId).map(bot => bot.id),
      generateId: (kind: 'dashboard' | 'widget') => `${kind === 'dashboard' ? 'd' : 'w'}_${randomBytes(8).toString('hex').slice(0, 8)}` };
  }
  private actorError(userId: string, actor: string) {
    return /^(user|import|migration|reset)$/.test(actor) || (actor.startsWith('agent:') && this.store.bots(userId).some(bot => bot.id === actor.slice(6)))
      ? null : fail('not_found', 'Item not found.');
  }
  private references(userId: string, doc: UiConfig): Violation[] {
    const bots = new Set(this.store.bots(userId).map(bot => bot.id));
    const valid = (id: unknown) => typeof id === 'string' && bots.has(id);
    const missing = (): Violation[] => [{ path: '', code: 'not_found', message: 'Item not found.' }];
    for (const pin of doc.layout.pinned) if (pin.type === 'bot' && !valid(pin.id)) return missing();
    for (const dashboard of doc.dashboards) for (const widget of dashboard.widgets) {
      for (const params of [widget.source?.params, widget.options]) if (params?.botId !== undefined && !valid(params.botId)) return missing();
      if (widget.type === 'shortcuts' && Array.isArray(widget.options.items)) for (const item of widget.options.items) {
        const target = (item as { target?: unknown }).target;
        if (typeof target === 'string' && /^(bot|ask):/.test(target) && !valid(target.split(':')[1])) return missing();
      }
    }
    return [];
  }
  private validated(userId: string, doc: UiConfig, ops: PatchOp[], autofix?: boolean) {
    const result = previewPatch(doc, ops, { autofix, ctx: this.ctx(userId) });
    if (!result.ok) return this.reject(result);
    const errors = this.references(userId, result.result);
    return errors.length ? this.reject({ ok: false, errors }) : result;
  }
  private expire(userId: string) {
    for (const row of this.store.pending(userId)) if (row.expires_at <= this.clock()) {
      this.store.previewStatus(userId, row.id, 'expired');
      this.emit(userId, previewEvent(row.id, row.actor, 'expired'));
    }
  }
  private createPreview(userId: string, ops: PatchOp[], opts: { intent: string; actor: string; autofix?: boolean }, extraWarnings: Violation[] = []): PreviewResult {
    const actorError = this.actorError(userId, opts.actor); if (actorError) return actorError;
    if (!intentSchema.safeParse(opts.intent).success) return fail('invalid_value', 'Use a plain description up to 200 characters.', '/intent');
    const current = this.get(userId), result = this.validated(userId, current.doc, ops, opts.autofix);
    if (!result.ok) return result;
    this.expire(userId);
    for (const older of this.store.pending(userId)) {
      this.store.previewStatus(userId, older.id, 'superseded');
      // The frozen SSE union has no superseded state. Refetch reveals that state.
      this.emit(userId, previewEvent(older.id, older.actor, 'discarded'));
    }
    const now = this.clock();
    const resolved = JSON.parse(JSON.stringify(ops, (_key, value) => typeof value === 'string' && Object.hasOwn(result.idMap, value) ? result.idMap[value] : value)) as PatchOp[];
    const preview: StoredPreview = { id: randomUUID(), userId, baseRevision: current.revision, patch: resolved,
      result: result.result, summary: result.summary, warnings: [...result.warnings, ...extraWarnings], idMap: result.idMap,
      intent: opts.intent, actor: opts.actor, status: 'pending', createdAt: now, expiresAt: now + 15 * 60_000 };
    this.store.addPreview(userId, preview);
    this.emit(userId, previewEvent(preview.id, preview.actor, 'pending'));
    this.metric('ui_preview_created');
    return { ok: true, previewId: preview.id, baseRevision: preview.baseRevision, summary: preview.summary,
      warnings: preview.warnings, idMap: preview.idMap, applied: false };
  }
  preview(userId: string, ops: PatchOp[], opts: { intent: string; actor: string; autofix?: boolean }): PreviewResult {
    if (!this.enabled(userId)) return this.unavailable();
    return this.atomic(() => this.createPreview(userId, ops, opts));
  }
  getPreview(userId: string, id: string): StoredPreview | null {
    if (!this.enabled(userId)) return null;
    return this.atomic(() => { this.expire(userId); return this.store.preview(userId, id); });
  }
  private commit(userId: string, doc: UiConfig, summary: string[], actor: string): ApplyResult {
    const before = this.get(userId), row = this.store.config(userId), time = this.clock(), revision = before.revision + 1;
    // Preserve the original bytes, even when recovery replaces a corrupt document.
    this.store.record(userId, before.revision, row?.doc ?? canonical(before.doc), ['Previous appearance'], row?.updated_by ?? 'user', row?.updated_at ?? time);
    this.store.write(userId, doc, revision, actor, time);
    this.store.record(userId, revision, canonical(doc), summary, actor, time);
    this.store.prune(userId, time);
    this.emit(userId, { type: 'ui_config', revision });
    this.metric('ui_config_bytes', Buffer.byteLength(canonical(doc)));
    this.metric('ui_dashboard_count', doc.dashboards.length);
    return { ok: true, doc, revision, summary };
  }
  applyPreview(userId: string, id: string, actor: string): ApplyResult {
    if (!this.enabled(userId)) return this.unavailable();
    return this.atomic(() => {
      this.expire(userId);
      const preview = this.store.preview(userId, id);
      if (!preview) return fail('not_found', 'Preview not found.');
      if (preview.status === 'expired') return fail('preview_expired', 'This preview has expired.');
      if (preview.status !== 'pending' || preview.baseRevision !== this.get(userId).revision) return fail('stale_preview', 'Create a new preview from your current appearance.');
      const actorError = this.actorError(userId, actor); if (actorError) return actorError;
      const validated = this.validated(userId, preview.result, []); if (!validated.ok) return validated;
      const result = this.commit(userId, validated.result, preview.summary, actor);
      if (result.ok) {
        this.store.previewStatus(userId, id, 'applied', result.revision);
        this.emit(userId, previewEvent(id, preview.actor, 'applied')); this.metric('ui_preview_applied');
      }
      return result;
    });
  }
  discardPreview(userId: string, id: string): void {
    if (!this.enabled(userId)) return;
    this.atomic(() => {
      this.expire(userId); const preview = this.store.preview(userId, id);
      if (!preview || preview.status !== 'pending') return;
      this.store.previewStatus(userId, id, 'discarded');
      this.emit(userId, previewEvent(id, preview.actor, 'discarded')); this.metric('ui_preview_discarded');
    });
  }
  patch(userId: string, ops: PatchOp[], expectedRevision: number, actor: string): ApplyResult {
    if (!this.enabled(userId)) return this.unavailable();
    return this.atomic(() => {
      const current = this.get(userId);
      if (current.revision !== expectedRevision) return fail('stale_revision', 'Your appearance changed. Reload and try again.');
      const actorError = this.actorError(userId, actor); if (actorError) return actorError;
      const result = this.validated(userId, current.doc, ops);
      return result.ok ? this.commit(userId, result.result, result.summary, actor) : result;
    });
  }
  private replacement(before: UiConfig, after: UiConfig): PatchOp[] {
    const ops: PatchOp[] = Object.entries(after).map(([key, value]) => ({ op: Object.hasOwn(before, key) ? 'replace' : 'add', path: `/${key}`, value }));
    for (const key of Object.keys(before)) if (!Object.hasOwn(after, key)) ops.push({ op: 'remove', path: `/${key}` });
    return ops;
  }
  replace(userId: string, raw: unknown, expectedRevision: number, actor = 'import'): ApplyResult {
    const parsed = this.importDocument(userId, raw); if (!parsed.ok) return parsed;
    return this.patch(userId, this.replacement(this.get(userId).doc, parsed.doc), expectedRevision, actor);
  }
  history(userId: string) {
    this.store.prune(userId, this.clock());
    return this.store.history(userId).map(row => ({ id: row.id, revision: row.revision, summary: JSON.parse(row.summary) as string[], actor: row.actor, createdAt: row.created_at }));
  }
  private restoreInTransaction(userId: string, revision: number, actor: string): ApplyResult {
    this.store.prune(userId, this.clock());
    const row = this.store.revision(userId, revision);
    if (!row) return fail('not_found', 'Revision not found.');
    const doc = this.parse(row.doc); if (!doc) return fail('invalid_value', 'This revision cannot be restored.');
    const result = this.validated(userId, this.get(userId).doc, this.replacement(this.get(userId).doc, doc));
    return result.ok ? this.commit(userId, result.result, [`Restored revision ${revision}`], actor) : result;
  }
  restore(userId: string, revision: number, expectedRevision: number, actor = 'user'): ApplyResult {
    if (!this.enabled(userId)) return this.unavailable();
    return this.atomic(() => this.get(userId).revision !== expectedRevision
      ? fail('stale_revision', 'Your appearance changed. Reload and try again.') : this.restoreInTransaction(userId, revision, actor));
  }
  undo(userId: string, steps: number, actor: string): ApplyResult {
    if (!this.enabled(userId)) return this.unavailable();
    if (!Number.isInteger(steps) || steps < 1 || steps > 10) return fail('invalid_value', 'Choose between 1 and 10 steps.', '/steps');
    return this.atomic(() => {
      const actorError = this.actorError(userId, actor); if (actorError) return actorError;
      const result = this.restoreInTransaction(userId, this.get(userId).revision - steps, actor);
      if (result.ok) this.metric('ui_undo'); return result;
    });
  }
  reset(userId: string, scope: ResetScope, dashboardId?: string): PreviewResult {
    if (!this.enabled(userId)) return this.unavailable();
    if (!resetScopes.has(scope)) return fail('invalid_value', 'Choose a reset scope.', '/scope');
    return this.atomic(() => {
      const before = this.get(userId).doc, after = structuredClone(before), defaults = structuredClone(DEFAULT_CONFIG);
      if (scope === 'dashboard' && !before.dashboards.some(d => d.id === dashboardId)) return fail('not_found', 'Dashboard not found.');
      if (scope === 'all') Object.assign(after, defaults);
      if (scope === 'appearance') Object.assign(after, defaults, { dashboards: before.dashboards });
      if (scope === 'theme' || scope === 'layout' || scope === 'components') after[scope] = defaults[scope] as never;
      if (scope === 'dashboards' || scope === 'dashboard') {
        const removed = new Set(before.dashboards.filter(d => scope === 'dashboards' || d.id === dashboardId).map(d => d.id));
        after.dashboards = before.dashboards.filter(d => !removed.has(d.id));
        if (after.layout.home.kind === 'dashboard' && removed.has(after.layout.home.dashboardId)) after.layout.home = { kind: 'default' };
        after.layout.pinned = after.layout.pinned.filter(pin => pin.type !== 'dashboard' || !removed.has(pin.id));
        after.layout.phoneTabs = after.layout.phoneTabs.filter(tab => !removed.has(tab.replace(/^dashboard:/, '')));
        for (const tab of defaults.layout.phoneTabs) if (after.layout.phoneTabs.length < 3 && !after.layout.phoneTabs.includes(tab)) after.layout.phoneTabs.push(tab);
        for (const dashboard of after.dashboards) for (const widget of dashboard.widgets) if (widget.type === 'shortcuts' && Array.isArray(widget.options.items))
          widget.options.items = widget.options.items.filter(item => !removed.has(String((item as { target: string }).target).replace(/^dashboard:/, '')));
      }
      const removedCount = before.dashboards.length - after.dashboards.length;
      const result = this.createPreview(userId, this.replacement(before, after), { intent: `Reset ${scope}. Removes ${removedCount} dashboards`, actor: 'reset' });
      if (result.ok) this.metric('ui_reset', 1, scope); return result;
    });
  }
  private importDocument(userId: string, raw: unknown): { ok: true; doc: UiConfig; warnings: Violation[] } | { ok: false; errors: Violation[] } {
    if (Buffer.byteLength(JSON.stringify(raw) ?? '') > 256 * 1024) return fail('limit_exceeded', 'Appearance files must be 256 KB or smaller.');
    const copy = structuredClone(raw);
    if (!copy || typeof copy !== 'object' || Array.isArray(copy)) return fail('invalid_value', 'Use an appearance document.');
    const exportedAt = (copy as Record<string, unknown>).exportedAt;
    if (exportedAt !== undefined) {
      if (typeof exportedAt !== 'string' || !Number.isFinite(Date.parse(exportedAt))) return fail('invalid_value', 'Invalid export time.', '/exportedAt');
      delete (copy as Record<string, unknown>).exportedAt;
    }
    const warnings: Violation[] = [];
    this.translateBots(userId, copy, 'import', warnings);
    const parsed = migrate(copy);
    if ('error' in parsed) {
      const shape = uiConfigSchema.safeParse(copy);
      return { ok: false, errors: shape.success ? [{ path: '', code: 'invalid_value', message: parsed.error }] : shape.error.issues.map(issue => ({ path: `/${issue.path.join('/')}`, code: 'invalid_value', message: issue.message })) };
    }
    return { ok: true, doc: parsed.doc, warnings };
  }
  importPreview(userId: string, raw: unknown): PreviewResult {
    if (!this.enabled(userId)) return this.unavailable();
    const parsed = this.importDocument(userId, raw); if (!parsed.ok) return parsed;
    return this.atomic(() => this.createPreview(userId, this.replacement(this.get(userId).doc, parsed.doc), { intent: 'Import appearance', actor: 'import' }, parsed.warnings));
  }
  /** Translate only registered bot reference fields, never arbitrary note text. */
  private translateBots(userId: string, raw: object, direction: 'import' | 'export', warnings: Violation[]) {
    const bots = this.store.bots(userId), doc = raw as Record<string, any>;
    const resolve = (value: unknown): string | null => {
      if (typeof value !== 'string') return null;
      if (direction === 'export') return bots.find(bot => bot.id === value)?.name ?? null;
      const direct = bots.find(bot => bot.id === value); if (direct) return direct.id;
      const named = bots.filter(bot => bot.name === value); return named.length === 1 ? named[0].id : null;
    };
    const missing = () => warnings.push({ path: '', code: 'not_found', message: 'Removed a reference to an unavailable Bot.' });
    if (Array.isArray(doc.layout?.pinned)) doc.layout.pinned = doc.layout.pinned.filter((pin: any) => {
      if (pin?.type !== 'bot') return true;
      const id = resolve(pin.id); if (!id) { missing(); return false; } pin.id = id; return true;
    });
    if (!Array.isArray(doc.dashboards)) return;
    for (const dashboard of doc.dashboards) if (Array.isArray(dashboard?.widgets)) dashboard.widgets = dashboard.widgets.filter((widget: any) => {
      if (!widget || typeof widget !== 'object') return true;
      for (const params of [widget.source?.params, widget.options]) if (params && typeof params === 'object' && Object.hasOwn(params, 'botId')) {
        const id = resolve(params.botId); if (!id) { missing(); return false; } params.botId = id;
      }
      if (widget.type === 'shortcuts' && Array.isArray(widget.options?.items)) widget.options.items = widget.options.items.filter((item: any) => {
        if (typeof item?.target !== 'string') return true;
        const match = /^(bot|ask):([^:]+)(.*)$/.exec(item.target); if (!match) return true;
        let value = match[2]; if (direction === 'import') { try { value = decodeURIComponent(value); } catch { return true; } }
        const id = resolve(value); if (!id) { missing(); return false; }
        item.target = `${match[1]}:${direction === 'export' ? encodeURIComponent(id) : id}${match[3]}`; return true;
      });
      return true;
    });
  }
  export(userId: string) {
    const doc = structuredClone(this.get(userId).doc);
    this.translateBots(userId, doc, 'export', []);
    return { ...doc, exportedAt: new Date(this.clock()).toISOString() };
  }
  presets(userId: string) { return this.store.presets(userId); }
  savePreset(userId: string, name: string, includeDashboards = false): { ok: true; presetId: string } | { ok: false; errors: Violation[] } {
    if (!this.enabled(userId)) return this.unavailable();
    if (!nameSchema.safeParse(name).success) return fail('invalid_value', 'Use a plain name up to 40 characters.', '/name');
    return this.atomic(() => {
      if (this.store.presets(userId).length >= 20) return fail('limit_exceeded', 'You can save up to 20 presets.');
      const doc = this.get(userId).doc;
      // A preset without dashboards must not contain dangling dashboard references.
      if (!includeDashboards) {
        doc.dashboards = []; if (doc.layout.home.kind === 'dashboard') doc.layout.home = { kind: 'default' };
        doc.layout.pinned = doc.layout.pinned.filter(pin => pin.type !== 'dashboard');
        doc.layout.phoneTabs = [...DEFAULT_CONFIG.layout.phoneTabs];
      }
      return { ok: true, presetId: this.store.addPreset(userId, name, doc, this.clock()) };
    });
  }
  deletePreset(userId: string, id: string) { return this.enabled(userId) && this.store.deletePreset(userId, id); }
}
