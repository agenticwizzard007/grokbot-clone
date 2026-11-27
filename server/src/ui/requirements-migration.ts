import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { DEFAULT_CONFIG } from '../ui-config/schema.js';
import { equal } from '../ui-config/summarize.js';
import { canonical } from './store.js';

// Never expand this allowlist to parent objects: unrelated hand edits must survive.
const pointers = ['/layout/sidebar/order', '/layout/sidebar/hidden', '/layout/phoneTabs', '/layout/home'] as const;
const read = (doc: any, pointer: string): unknown => pointer.slice(1).split('/').reduce((value, key) => value?.[key], doc);

/** Retire UC-I ownership once, before the config service reads any documents. */
export function migrateRequirementsLayout(db: Database.Database): void {
  const users = db.prepare('SELECT user_id FROM ui_requirements').all() as { user_id: string }[];
  for (const { user_id: userId } of users) db.transaction(() => {
    const row = db.prepare('SELECT doc,adaptation FROM ui_requirements WHERE user_id=?').get(userId) as { doc: string; adaptation: string };
    let profile: any, ledger: any;
    try { profile = JSON.parse(row.doc); ledger = JSON.parse(row.adaptation); } catch { return; }
    if (!ledger || typeof ledger !== 'object' || ledger.retired) return;
    // An old pending preview must never reintroduce adaptation after deployment.
    for (const pending of Array.isArray(ledger.pending) ? ledger.pending : []) {
      if (typeof pending?.id === 'string') db.prepare("UPDATE ui_previews SET status='superseded' WHERE user_id=? AND id=? AND status='pending'").run(userId, pending.id);
    }
    if (!Array.isArray(profile?.managedPaths) || !profile.managedPaths.length) return;
    const stored = db.prepare('SELECT doc,revision,updated_at,updated_by FROM ui_config WHERE user_id=?').get(userId) as { doc: string; revision: number; updated_at: number; updated_by: string } | undefined;
    if (!stored || !ledger.state?.doc) return;
    let current: any;
    try { current = JSON.parse(stored.doc); } catch { return; }
    if (current?.version !== 1 || !current.layout) return;
    const history = Number.isInteger(ledger.seenRevision) ? db.prepare("SELECT revision,doc FROM ui_config_history WHERE user_id=? AND kind='config' AND revision>? ORDER BY revision").all(userId, ledger.seenRevision) as { revision: number; doc: string }[] : [];
    let managed = pointers.filter(pointer => profile.managedPaths.includes(pointer) && equal(read(current, pointer), read(ledger.state.doc, pointer)) && read(ledger.state.doc, pointer) !== undefined);
    // Preserve an edit followed by a revert, and preserve when its history is missing.
    if (Number.isInteger(ledger.seenRevision)) {
      let revision = ledger.seenRevision;
      for (const item of history) {
        if (item.revision !== ++revision) { managed = []; break; }
        try { const doc = JSON.parse(item.doc); managed = managed.filter(pointer => equal(read(doc, pointer), read(ledger.state.doc, pointer))); }
        catch { managed = []; break; }
      }
      if (revision !== stored.revision) managed = [];
    }
    const restored = managed.filter(pointer => !equal(read(current, pointer), read(DEFAULT_CONFIG, pointer)));
    for (const pointer of restored) {
      const keys = pointer.slice(1).split('/'), key = keys.pop()!;
      const parent = keys.reduce((value, part) => value[part], current);
      parent[key] = structuredClone(read(DEFAULT_CONFIG, pointer));
    }
    if (restored.length) {
      const now = Date.now(), revision = stored.revision + 1, doc = canonical(current);
      db.prepare("INSERT OR IGNORE INTO ui_config_history(id,user_id,kind,revision,doc,summary,actor,created_at) VALUES(?,?,'config',?,?,?,?,?)")
        .run(randomUUID(), userId, stored.revision, stored.doc, '[]', stored.updated_by, stored.updated_at);
      db.prepare("UPDATE ui_config SET doc=?,revision=?,updated_at=?,updated_by='migration' WHERE user_id=?").run(doc, revision, now, userId);
      db.prepare("INSERT INTO ui_config_history(id,user_id,kind,revision,doc,summary,actor,created_at) VALUES(?,?,'config',?,?,?,'migration',?)")
        .run(randomUUID(), userId, revision, doc, canonical(['Restored default navigation']), now);
    }
    profile.managedPaths = [];
    db.prepare('UPDATE ui_requirements SET doc=?,adaptation=? WHERE user_id=?').run(canonical(profile), canonical({ retired: true }), userId);
  }).immediate();
}
