import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { DEFAULT_CONFIG, uiConfigSchema, type UiConfig, type PatchOp, type Violation } from '../ui-config/index.js';
import { equal } from '../ui-config/summarize.js';
import { adaptFromRequirements, patchRequirements, requirementsProfileSchema, selectLens, type AdaptationState, type RequirementsProfile } from '../ui-config/adapt.js';
import { LENS_IDS, type LensId } from '../ui-config/adapt-keywords.js';
import { ADAPT_LENSES } from '../ui-config/adapt-lenses.js';
import { uiAdaptEnabled } from './flags.js';
import { canonical } from './store.js';
import type { SqliteUiConfigService } from './service.js';

interface Row { doc: string; revision: number; updated_at: number; updated_by: string; adaptation: string }
interface Pending { id: string; state?: AdaptationState; reset?: boolean }
interface Ledger { state?: AdaptationState; seenRevision?: number; pending?: Pending[]; undo?: { token: string; profile: RequirementsProfile | null; state?: AdaptationState; resetPreview: string; revision: number } }
export interface RequirementsOptions { clock?: () => number; flag?: () => string | undefined; staff?: () => string }
const fail = (code: Violation['code'], message: string) => ({ ok: false as const, errors: [{ code, message, path: '' }] });

/** One storage and preview path shared by REST and chat. No provider calls. */
export class RequirementsStore {
  private db: Database.Database;
  private clock: () => number;
  constructor(readonly ui: SqliteUiConfigService, private options: RequirementsOptions = {}) {
    this.db = ui.store.db; this.clock = options.clock ?? Date.now;
  }
  enabled(userId: string) { return this.ui.enabled(userId) && uiAdaptEnabled(this.db, userId, this.options.flag?.() ?? process.env.UI_ADAPT, this.options.staff?.()); }
  private row(userId: string) { return this.db.prepare('SELECT doc,revision,updated_at,updated_by,adaptation FROM ui_requirements WHERE user_id=?').get(userId) as Row | undefined; }
  private ledger(row?: Row): Ledger { try { return row ? JSON.parse(row.adaptation) : {}; } catch { return {}; } }
  private parse(row?: Row): RequirementsProfile | null { try { const result = requirementsProfileSchema.safeParse(JSON.parse(row?.doc ?? 'null')); return result.success ? result.data : null; } catch { return null; } }
  private write(userId: string, profile: RequirementsProfile | null, revision: number, actor: 'agent' | 'user' | 'reset', ledger: Ledger, diff: string[]) {
    const now = this.clock();
    this.db.prepare(`INSERT INTO ui_requirements(user_id,doc,revision,updated_at,updated_by,adaptation) VALUES(?,?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET doc=excluded.doc,revision=excluded.revision,updated_at=excluded.updated_at,updated_by=excluded.updated_by,adaptation=excluded.adaptation`)
      .run(userId, canonical(profile), revision, now, actor, canonical(ledger));
    this.db.prepare("INSERT INTO ui_config_history(id,user_id,kind,revision,doc,summary,actor,created_at) VALUES(?,?,'requirements',?,?,?,?,?)")
      .run(randomUUID(), userId, revision, canonical(profile), canonical(diff), actor, now);
    this.db.prepare(`DELETE FROM ui_config_history WHERE user_id=? AND kind='requirements' AND (created_at<? OR revision NOT IN
      (SELECT revision FROM ui_config_history WHERE user_id=? AND kind='requirements' ORDER BY revision DESC LIMIT 50))`).run(userId, now - 90 * 86400_000, userId);
  }
  /** Applied previews alone claim managed paths. Discarded or expired previews never do. */
  private reconcile(userId: string) {
    const row = this.row(userId); if (!row) return;
    const ledger = this.ledger(row);
    let changed = false;
    ledger.pending = (ledger.pending ?? []).filter(item => {
      const preview = this.ui.getPreview(userId, item.id);
      if (preview?.status === 'pending') return true;
      if (preview?.status === 'applied') { ledger.state = item.state; ledger.seenRevision = preview.revision; changed = true; }
      return false;
    });
    // An edit followed by a revert is still a hand edit. Replay retained config
    // revisions so equality with the last adaptation does not reclaim it.
    if (ledger.state && ledger.seenRevision !== undefined) {
      const state = ledger.state;
      const rows = this.db.prepare("SELECT revision,doc FROM ui_config_history WHERE user_id=? AND kind='config' AND revision>? ORDER BY revision")
        .all(userId, ledger.seenRevision) as { revision: number; doc: string }[];
      const value = (doc: UiConfig, path: string) => {
        if (path.startsWith('/dashboards/')) return doc.dashboards.find(d => d.id === state.dashboardId);
        return path.slice(1).split('/').reduce<unknown>((v, key) => v && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined, doc);
      };
      for (const history of rows) {
        if (history.revision !== ledger.seenRevision! + 1) state.managedPaths = []; // History expired: preserve rather than guess.
        let doc: UiConfig | null = null;
        try { const parsed = uiConfigSchema.safeParse(JSON.parse(history.doc)); if (parsed.success) doc = parsed.data; } catch { /* Preserve on corrupt history. */ }
        state.managedPaths = doc ? state.managedPaths.filter(path => equal(value(doc!, path), value(state.doc, path))) : [];
        ledger.seenRevision = history.revision; changed = true;
      }
    }
    const profile = this.parse(row);
    if (changed && profile && !equal(profile.managedPaths, ledger.state?.managedPaths ?? [])) {
      profile.managedPaths = ledger.state?.managedPaths ?? [];
      profile.revision = row.revision + 1; profile.updatedAt = this.clock();
      this.db.transaction(() => this.write(userId, profile, profile.revision, profile.updatedBy, ledger, ['Adaptation paths updated']))();
      return;
    }
    const doc = profile ? canonical(profile) : row.doc, adaptation = canonical(ledger);
    if (doc !== row.doc || adaptation !== row.adaptation)
      this.db.prepare('UPDATE ui_requirements SET doc=?,adaptation=? WHERE user_id=?').run(doc, adaptation, userId);
  }
  get(userId: string) {
    if (this.enabled(userId)) this.reconcile(userId);
    const row = this.row(userId), profile = this.parse(row);
    const selection = profile ? selectLens(profile) : null;
    const ledger = this.ledger(row), undo = ledger.undo;
    return { profile, revision: row?.revision ?? 0, enabled: this.enabled(userId), adapted: !!ledger.state,
      ...(undo && undo.revision === row?.revision ? { undoToken: undo.token } : {}),
      ...(row && row.doc !== 'null' && !profile ? { status: 'invalid_stored' as const } : {}),
      lens: selection?.lens ?? null, rationale: selection?.rationale ?? [], ...(selection?.question ? { question: selection.question } : {}),
      suggestions: selection ? { bots: ADAPT_LENSES[selection.lens].bots, templates: ADAPT_LENSES[selection.lens].templates, shortcuts: ADAPT_LENSES[selection.lens].shortcuts } : null };
  }
  update(userId: string, patch: unknown, expected: number, actor: 'agent' | 'user' = 'user') {
    if (!this.enabled(userId)) return fail('disabled', 'Requirements adaptation is disabled.');
    this.reconcile(userId);
    return this.db.transaction(() => {
      const row = this.row(userId); if ((row?.revision ?? 0) !== expected) return fail('stale_revision', 'Your requirements changed. Reload and try again.');
      const previous = this.parse(row), input = previous ? { role: previous.role, goals: previous.goals, workflows: previous.workflows, focus: previous.focus, ...(previous.lens ? { lens: previous.lens } : {}) } : null;
      const patched = patchRequirements(input, patch); if (!patched.ok) return patched;
      const profile: RequirementsProfile = { ...patched.fields, version: 1, updatedAt: this.clock(), updatedBy: actor, revision: expected + 1, managedPaths: previous?.managedPaths ?? [] };
      const ledger = this.ledger(row); delete ledger.undo;
      this.write(userId, profile, profile.revision, actor, ledger, patched.diff);
      return { ok: true as const, profile, revision: profile.revision, diff: patched.diff,
        remember: `I will remember: ${[profile.role, ...profile.goals, ...profile.workflows.map(w => `${w.cadence === 'ad_hoc' ? 'as needed' : w.cadence} ${w.name}`)].join(', ')}` };
    }).immediate();
  }
  preview(userId: string, expected: number, actor = 'user', lens?: LensId) {
    if (!this.enabled(userId)) return fail('disabled', 'Requirements adaptation is disabled.');
    if (lens !== undefined && !LENS_IDS.includes(lens)) return fail('invalid_value', 'Choose a registered lens.');
    const current = this.get(userId);
    if (current.revision !== expected) return fail('stale_revision', 'Your requirements changed. Reload and try again.');
    if (!current.profile) return fail('not_found', 'Save your requirements first.');
    const row = this.row(userId)!, ledger = this.ledger(row), before = this.ui.get(userId);
    const adapted = adaptFromRequirements(lens ? { ...current.profile, lens } : current.profile, before.doc, ledger.state);
    if (!adapted.ok) return adapted;
    const result = this.ui.preview(userId, adapted.patch, { intent: `Adapt for ${ADAPT_LENSES[adapted.lens].label}`, actor });
    if (!result.ok) return result;
    ledger.pending = [{ id: result.previewId, state: adapted.state }];
    this.db.prepare('UPDATE ui_requirements SET adaptation=? WHERE user_id=?').run(canonical(ledger), userId);
    // Rationale and kept values are part of the normal preview card as well as the detail response.
    const summary = [...result.summary, ...adapted.rationale, ...adapted.kept.map(k => k.message)];
    this.ui.store.previewSummary(userId, result.previewId, summary);
    return { ...result, summary, lens: adapted.lens, rationale: adapted.rationale, suggestions: adapted.suggestions, kept: adapted.kept,
      question: adapted.question, patch: adapted.patch, before: before.doc, after: adapted.result, viewports: [390, 1280] };
  }
  reset(userId: string, expected: number, actor = 'user') {
    if (!this.enabled(userId)) return fail('disabled', 'Requirements adaptation is disabled.');
    const current = this.get(userId); if (current.revision !== expected) return fail('stale_revision', 'Your requirements changed. Reload and try again.');
    const ledger = this.ledger(this.row(userId));
    // Restore arrangement in one preview. Keep user dashboards and all appearance tokens.
    const patch: PatchOp[] = [{ op: 'replace', path: '/layout', value: structuredClone(DEFAULT_CONFIG.layout) }];
    const preview = this.ui.preview(userId, patch, { intent: 'Reset requirements and arrangement', actor });
    if (!preview.ok) return preview;
    const undoToken = randomUUID();
    ledger.undo = { token: undoToken, profile: current.profile, ...(ledger.state ? { state: ledger.state } : {}), resetPreview: preview.previewId, revision: expected + 1 };
    ledger.pending = [{ id: preview.previewId, reset: true }];
    this.db.transaction(() => this.write(userId, null, expected + 1, 'reset', ledger, ['Requirements cleared']))();
    return { ...preview, profile: null, revision: expected + 1, undoToken };
  }
  undoReset(userId: string, expected: number, token: string) {
    if (!this.enabled(userId)) return fail('disabled', 'Requirements adaptation is disabled.');
    const current = this.get(userId), ledger = this.ledger(this.row(userId)), undo = ledger.undo;
    if (current.revision !== expected) return fail('stale_revision', 'Your requirements changed. Reload and try again.');
    if (!undo || undo.token !== token || undo.revision !== expected) return fail('not_found', 'Reset is no longer available to undo.');
    const preview = this.ui.getPreview(userId, undo.resetPreview);
    if (preview?.status === 'applied') {
      if (this.ui.get(userId).revision !== preview.revision) return fail('stale_revision', 'Your appearance changed after Reset.');
      const result = this.ui.undo(userId, 1, 'user'); if (!result.ok) return result;
    } else if (preview?.status === 'pending') this.ui.discardPreview(userId, preview.id);
    const profile = undo.profile ? { ...undo.profile, revision: expected + 1, updatedAt: this.clock(), updatedBy: 'user' as const } : null;
    const restored: Ledger = undo.state ? { state: undo.state } : {};
    this.db.transaction(() => this.write(userId, profile, expected + 1, 'user', restored, ['Reset undone']))();
    return { ok: true as const, profile, revision: expected + 1, diff: ['Reset undone'] };
  }
}
