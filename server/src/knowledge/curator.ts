import { db, now } from '../db.js';
import { assertWritable } from './access.js';
import { ownedBot } from './common.js';
import { learningSettings } from './settings.js';
import { deleteSkill, listSkills } from './skills.js';
/** Protect even paused/rare routines: usage counters alone miss these dependencies. */
export function routineProtectsSkill(botId: string, id: string, name: string): boolean {
    const bot = db.prepare('SELECT user_id FROM bots WHERE id=?').get(botId) as any;
    const routines = db.prepare('SELECT r.* FROM routines r JOIN bots b ON b.id=r.bot_id WHERE b.user_id=?').all(bot?.user_id ?? '');
    return name.toLowerCase() === 'plan' || routines.some(r => { const text = JSON.stringify(r).toLowerCase(); return text.includes(id.toLowerCase()) || text.includes(name.toLowerCase()); });
}
export function curatorProtected(botId: string, skill: {
    id: string;
    name: string;
    locked: boolean;
    pinned: boolean;
    managed: boolean;
}) { return !skill.managed || skill.locked || skill.pinned || routineProtectsSkill(botId, skill.id, skill.name); }
export function curateSkills(userId: string, botId: string, at = now()) {
    return db.transaction(() => {
        assertWritable(userId, botId);
        ownedBot(userId, botId);
        const settings = learningSettings(userId, botId).settings;
        const result = { archived: [] as string[], stale: [] as string[], deferred: true };
        if (!settings.enabled || !settings.curatorEnabled)
            return result;
        db.prepare('INSERT OR IGNORE INTO knowledge_learning_state(bot_id,user_id) VALUES(?,?)').run(botId, userId);
        const state = db.prepare('SELECT * FROM knowledge_learning_state WHERE bot_id=?').get(botId) as any;
        const skills = listSkills(userId, botId);
        // First observation anchors a full interval. No immediate archive of imported
        // skills, regardless of their historical creation timestamps.
        for (const s of skills)
            db.prepare('UPDATE skills SET curator_seen_at=? WHERE id=? AND curator_seen_at IS NULL').run(at, s.id);
        if (state.curator_last_at === null) {
            db.prepare('UPDATE knowledge_learning_state SET curator_last_at=? WHERE bot_id=?').run(at, botId);
            return result;
        }
        const lastMessage = (db.prepare('SELECT max(created_at) at FROM rows WHERE bot_id=?').get(botId) as any)?.at ?? 0;
        if (at - state.curator_last_at < settings.curatorIntervalHours * 3600000 || at - Math.max(lastMessage, state.last_foreground_at) < settings.curatorMinIdleHours * 3600000 || db.prepare("SELECT 1 FROM agent_jobs WHERE bot_id=? AND state IN ('queued','running')").get(botId) || db.prepare('SELECT 1 FROM pending_turns WHERE bot_id=?').get(botId))
            return result;
        result.deferred = false;
        for (const s of skills) {
            if (curatorProtected(botId, s))
                continue;
            const row = db.prepare('SELECT * FROM skills WHERE id=?').get(s.id) as any;
            const anchor = s.lastUsedAt ?? Math.max(s.createdAt, row.curator_seen_at ?? at);
            const days = (at - anchor) / 86400000;
            if (days >= settings.curatorArchiveDays) {
                deleteSkill(userId, s.id, s.revision);
                result.archived.push(s.id);
            }
            else if (days >= settings.curatorStaleDays) {
                db.prepare("UPDATE skills SET lifecycle='stale' WHERE id=?").run(s.id);
                result.stale.push(s.id);
            }
            else
                db.prepare("UPDATE skills SET lifecycle='active' WHERE id=?").run(s.id);
        }
        db.prepare('UPDATE knowledge_learning_state SET curator_last_at=? WHERE bot_id=?').run(at, botId);
        return result;
    })();
}
