import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { type Violation } from '../ui-config/index.js';
import { suggestDashboardFromRequirements, patchRequirements, requirementsProfileSchema, type RequirementsProfile } from '../ui-config/adapt.js';
import { uiAdaptEnabled } from './flags.js';
import { canonical } from './store.js';
import type { SqliteUiConfigService } from './service.js';

interface Row { doc: string; revision: number; updated_at: number; updated_by: string; adaptation: string }
interface Ledger { undo?: { token: string; profile: RequirementsProfile | null; revision: number } }
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
  get(userId: string) {
    const row = this.row(userId), profile = this.parse(row), undo = this.ledger(row).undo;
    return { profile, revision: row?.revision ?? 0, enabled: this.enabled(userId),
      ...(undo && undo.revision === row?.revision ? { undoToken: undo.token } : {}),
      ...(row && row.doc !== 'null' && !profile ? { status: 'invalid_stored' as const } : {}) };
  }
  update(userId: string, patch: unknown, expected: number, actor: 'agent' | 'user' = 'user') {
    if (!this.enabled(userId)) return fail('disabled', 'Dashboard suggestions are unavailable.');
    return this.db.transaction(() => {
      const row = this.row(userId); if ((row?.revision ?? 0) !== expected) return fail('stale_revision', 'Your requirements changed. Reload and try again.');
      const previous = this.parse(row), input = previous ? { role: previous.role, goals: previous.goals, workflows: previous.workflows, focus: previous.focus, ...(previous.lens ? { lens: previous.lens } : {}) } : null;
      const patched = patchRequirements(input, patch); if (!patched.ok) return patched;
      const profile: RequirementsProfile = { ...patched.fields, version: 1, updatedAt: this.clock(), updatedBy: actor, revision: expected + 1, managedPaths: [] };
      const ledger: Ledger = {};
      this.write(userId, profile, profile.revision, actor, ledger, patched.diff);
      return { ok: true as const, profile, revision: profile.revision, diff: patched.diff,
        remember: `I will remember: ${[profile.role, ...profile.goals, ...profile.workflows.map(w => `${w.cadence === 'ad_hoc' ? 'as needed' : w.cadence} ${w.name}`)].join(', ')}` };
    }).immediate();
  }
  preview(userId: string, expected: number, actor = 'user') {
    if (!this.enabled(userId)) return fail('disabled', 'Dashboard suggestions are unavailable.');
    const current = this.get(userId);
    if (current.revision !== expected) return fail('stale_revision', 'Your profile changed. Reload and try again.');
    if (!current.profile) return fail('not_found', 'Save your profile first.');
    const suggested = suggestDashboardFromRequirements(current.profile);
    if (!suggested.ok) return suggested;
    const result = this.ui.preview(userId, suggested.patch, { intent: suggested.title, actor });
    if (!result.ok) return result;
    // Widget titles are the entire card body; the title already names the dashboard.
    this.ui.store.previewSummary(userId, result.previewId, suggested.widgets);
    return { ...result, title: suggested.title, summary: suggested.widgets, patch: suggested.patch };
  }
  reset(userId: string, expected: number, _actor = 'user') {
    if (!this.enabled(userId)) return fail('disabled', 'Dashboard suggestions are unavailable.');
    return this.db.transaction(() => {
      const current = this.get(userId);
      if (current.revision !== expected) return fail('stale_revision', 'Your profile changed. Reload and try again.');
      const undoToken = randomUUID();
      this.write(userId, null, expected + 1, 'reset', { undo: { token: undoToken, profile: current.profile, revision: expected + 1 } }, ['Profile cleared']);
      return { ok: true as const, profile: null, revision: expected + 1, undoToken };
    }).immediate();
  }
  undoReset(userId: string, expected: number, token: string) {
    if (!this.enabled(userId)) return fail('disabled', 'Dashboard suggestions are unavailable.');
    return this.db.transaction(() => {
      const current = this.get(userId), undo = this.ledger(this.row(userId)).undo;
      if (current.revision !== expected) return fail('stale_revision', 'Your profile changed. Reload and try again.');
      if (!undo || undo.token !== token || undo.revision !== expected) return fail('not_found', 'Reset is no longer available to undo.');
      const profile = undo.profile ? { ...undo.profile, managedPaths: [], revision: expected + 1, updatedAt: this.clock(), updatedBy: 'user' as const } : null;
      this.write(userId, profile, expected + 1, 'user', {}, ['Reset undone']);
      return { ok: true as const, profile, revision: expected + 1, diff: ['Reset undone'] };
    }).immediate();
  }
}
