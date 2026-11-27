import { z } from 'zod';
import { db, now, newId, atomic, ownBot, targetBot, requireEnabled, settings, emitEvent, ServiceError } from './db.js';
import type { HandoffLink, HandoffSettings } from './contracts.js';
export const linkInputSchema = z.object({ toBotId: z.string().min(1), mode: z.enum(['off', 'suggest', 'auto']), trigger: z.string().regex(/^(any_run|task_done|routine:[A-Za-z0-9_-]+)$/).default('any_run'), template: z.string().max(500).default(''), autoApproveLoops: z.boolean().default(false) }).strict();
export function listLinks(userId: string, botId: string): HandoffLink[] {
    requireEnabled(userId);
    ownBot(userId, botId);
    return (db.prepare('SELECT * FROM handoff_links WHERE user_id=? AND from_bot_id=? ORDER BY created_at,id').all(userId, botId) as any[]).map(r => ({ id: r.id, userId: r.user_id, fromBotId: r.from_bot_id, toBotId: r.to_bot_id, mode: r.mode, trigger: r.trigger, template: r.template, autoApproveLoops: !!r.auto_approve_loops, createdAt: r.created_at, updatedAt: r.updated_at }));
}
export function replaceLinks(userId: string, botId: string, input: unknown) {
    requireEnabled(userId);
    targetBot(userId, botId);
    const parsed = z.array(linkInputSchema).max(5).safeParse(input);
    if (!parsed.success)
        throw new ServiceError('invalid_input', 'Use up to five valid links.');
    const links = parsed.data;
    if (new Set(links.map(l => l.toBotId)).size !== links.length)
        throw new ServiceError('invalid_input', 'Use each target once.');
    return atomic(() => {
        for (const link of links) {
            targetBot(userId, link.toBotId, botId);
            if (link.toBotId === botId)
                throw new ServiceError('cycle_detected', 'Use a loop to repeat work.', 422);
            if (/\{(?!title\}|summary\})[^}]*\}/.test(link.template))
                throw new ServiceError('invalid_input', 'Use title and summary placeholders only.');
            if (link.trigger.startsWith('routine:') && !db.prepare('SELECT 1 FROM routines WHERE id=? AND bot_id=?').get(link.trigger.slice(8), botId))
                throw new ServiceError('not_found', 'Not found.', 404);
        }
        const edges = (db.prepare("SELECT from_bot_id f,to_bot_id t FROM handoff_links WHERE user_id=? AND from_bot_id!=? AND mode='auto'").all(userId, botId) as {
            f: string;
            t: string;
        }[]).concat(links.filter(l => l.mode === 'auto').map(l => ({ f: botId, t: l.toBotId })));
        const visit = (id: string, path: Set<string>): boolean => path.has(id) || edges.filter(e => e.f === id).some(e => visit(e.t, new Set([...path, id])));
        if (edges.some(e => visit(e.f, new Set())))
            throw new ServiceError('cycle_detected', 'Automatic links cannot form a cycle. Use a loop.', 422);
        const old = listLinks(userId, botId);
        db.prepare('DELETE FROM handoff_links WHERE user_id=? AND from_bot_id=?').run(userId, botId);
        for (const link of links) {
            const previous = old.find(l => l.toBotId === link.toBotId);
            db.prepare('INSERT INTO handoff_links(id,user_id,from_bot_id,to_bot_id,mode,trigger,template,auto_approve_loops,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(previous?.id ?? newId('hl'), userId, botId, link.toBotId, link.mode, link.trigger, link.template, Number(link.autoApproveLoops), previous?.createdAt ?? now(), now());
        }
        emitEvent(userId, 'handoff.links_changed', { botId, count: links.length });
        return listLinks(userId, botId);
    });
}
export const settingsSchema = z.object({ enabled: z.boolean(), agentHandoffs: z.enum(['team', 'links_only', 'off']) }).strict();
export function updateSettings(userId: string, input: HandoffSettings) {
    requireEnabled(userId, true);
    const parsed = settingsSchema.safeParse(input);
    if (!parsed.success)
        throw new ServiceError('invalid_input', 'Check the settings.');
    atomic(() => { db.prepare('INSERT INTO handoff_user_settings VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled,agent_handoffs=excluded.agent_handoffs,updated_at=excluded.updated_at').run(userId, Number(input.enabled), input.agentHandoffs, now()); emitEvent(userId, 'handoff.settings_changed', { enabled: input.enabled }); });
    return settings(userId);
}
