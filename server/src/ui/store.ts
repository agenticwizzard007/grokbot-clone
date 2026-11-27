import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { StoredPreview, UiConfig } from '../ui-config/index.js';

export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}

export interface ConfigRow { doc: string; revision: number; updated_at: number; updated_by: string }
interface PreviewRow {
  id: string; user_id: string; base_revision: number; patch: string; result_doc: string;
  summary: string; violations: string; id_map: string; intent: string; actor: string;
  status: StoredPreview['status']; created_at: number; expires_at: number; applied_revision: number | null;
}
export interface HistoryRow { id: string; revision: number; doc: string; summary: string; actor: string; created_at: number }
export interface UserPreset { id: string; name: string; doc: UiConfig; createdAt: number }

/** All data statements explicitly bind user_id, including cleanup and lookups by random id. */
export class UiStore {
  constructor(readonly db: Database.Database) {}

  config(userId: string): ConfigRow | undefined {
    return this.db.prepare('SELECT doc,revision,updated_at,updated_by FROM ui_config WHERE user_id=?').get(userId) as ConfigRow | undefined;
  }
  write(userId: string, doc: UiConfig, revision: number, actor: string, time: number): void {
    this.db.prepare(`INSERT INTO ui_config(user_id,doc,schema_version,revision,updated_at,updated_by) VALUES(?,?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET doc=excluded.doc,schema_version=excluded.schema_version,revision=excluded.revision,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
      .run(userId, canonical(doc), doc.version, revision, time, actor);
  }
  history(userId: string): HistoryRow[] {
    return this.db.prepare('SELECT id,revision,doc,summary,actor,created_at FROM ui_config_history WHERE user_id=? ORDER BY revision DESC LIMIT 50').all(userId) as HistoryRow[];
  }
  revision(userId: string, revision: number): HistoryRow | undefined {
    return this.db.prepare('SELECT id,revision,doc,summary,actor,created_at FROM ui_config_history WHERE user_id=? AND revision=?').get(userId, revision) as HistoryRow | undefined;
  }
  record(userId: string, revision: number, doc: string, summary: string[], actor: string, time: number): void {
    this.db.prepare('INSERT OR IGNORE INTO ui_config_history(id,user_id,revision,doc,summary,actor,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(randomUUID(), userId, revision, doc, canonical(summary), actor, time);
  }
  prune(userId: string, time: number): void {
    this.db.prepare(`DELETE FROM ui_config_history WHERE user_id=? AND (created_at<? OR revision NOT IN
      (SELECT revision FROM ui_config_history WHERE user_id=? ORDER BY revision DESC LIMIT 50))`).run(userId, time - 90 * 86400_000, userId);
    // Keep terminal preview records for their TTL so cards can observe their final state.
    this.db.prepare("DELETE FROM ui_previews WHERE user_id=? AND status!='pending' AND expires_at<?").run(userId, time - 86400_000);
  }
  preview(userId: string, id: string): StoredPreview | null {
    const row = this.db.prepare('SELECT * FROM ui_previews WHERE user_id=? AND id=?').get(userId, id) as PreviewRow | undefined;
    return row ? { id: row.id, userId, baseRevision: row.base_revision, patch: JSON.parse(row.patch), result: JSON.parse(row.result_doc),
      summary: JSON.parse(row.summary), warnings: JSON.parse(row.violations), idMap: JSON.parse(row.id_map), intent: row.intent,
      actor: row.actor, status: row.status, createdAt: row.created_at, expiresAt: row.expires_at,
      ...(row.applied_revision === null ? {} : { revision: row.applied_revision }) } : null;
  }
  pending(userId: string): { id: string; actor: string; expires_at: number }[] {
    return this.db.prepare("SELECT id,actor,expires_at FROM ui_previews WHERE user_id=? AND status='pending'").all(userId) as { id: string; actor: string; expires_at: number }[];
  }
  addPreview(userId: string, preview: StoredPreview): void {
    this.db.prepare(`INSERT INTO ui_previews(id,user_id,base_revision,patch,result_doc,summary,violations,id_map,intent,actor,status,created_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(preview.id, userId, preview.baseRevision, canonical(preview.patch), canonical(preview.result),
      canonical(preview.summary), canonical(preview.warnings), canonical(preview.idMap), preview.intent, preview.actor, preview.status, preview.createdAt, preview.expiresAt);
  }
  previewStatus(userId: string, id: string, status: StoredPreview['status'], revision?: number): void {
    this.db.prepare('UPDATE ui_previews SET status=?,applied_revision=? WHERE user_id=? AND id=?').run(status, revision ?? null, userId, id);
  }
  bots(userId: string): { id: string; name: string }[] {
    return this.db.prepare('SELECT id,name FROM bots WHERE user_id=?').all(userId) as { id: string; name: string }[];
  }
  presets(userId: string): UserPreset[] {
    return (this.db.prepare('SELECT id,name,doc,created_at FROM ui_user_presets WHERE user_id=? ORDER BY created_at,id').all(userId) as { id: string; name: string; doc: string; created_at: number }[])
      .flatMap(row => { try { return [{ id: row.id, name: row.name, doc: JSON.parse(row.doc), createdAt: row.created_at }]; } catch { return []; } });
  }
  addPreset(userId: string, name: string, doc: UiConfig, time: number): string {
    const id = `p_${randomUUID().replaceAll('-', '')}`;
    this.db.prepare('INSERT INTO ui_user_presets(id,user_id,name,doc,created_at) VALUES(?,?,?,?,?)').run(id, userId, name, canonical(doc), time);
    return id;
  }
  deletePreset(userId: string, id: string): boolean {
    return this.db.prepare('DELETE FROM ui_user_presets WHERE user_id=? AND id=?').run(userId, id).changes > 0;
  }
}
