import { recordContextReceipt } from '../native/events.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { db, now } from '../db.js';
import { KnowledgeError, ownedBot } from './common.js';
import { legacyWritableRows } from '../platform/legacy-database-fence.js';
export interface ManagementContext {
    userId: string;
    botId: string;
    jobId?: string;
    unattended: boolean;
    actor: string;
    reads: Map<string, string>;
    guard?: () => void;
    iteration?: number;
}
const management = new AsyncLocalStorage<ManagementContext>();
export const managementContext = () => management.getStore();
export const withManagement = <T>(ctx: ManagementContext, fn: () => T): T => management.run(ctx, fn);
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function assertWritable(userId: string, botId: string) {
    ownedBot(userId, botId);
    if (!db.prepare(`SELECT 1 FROM bots WHERE id=? AND user_id=? AND (${legacyWritableRows(db, 'bots')})`).get(botId, userId))
        throw new KnowledgeError('Account is held for migration', 409);
    const ctx = managementContext();
    if (ctx && (ctx.userId !== userId || ctx.botId !== botId))
        throw new KnowledgeError('Management actor does not own this agent', 409);
    ctx?.guard?.();
}
export function recordRead(userId: string, botId: string, kind: string, id: string, revision: number, value: string, jobId?: string, resource = '') {
    const ctx = managementContext();
    const digest = hash(value);
    ctx?.reads.set(`${kind}:${id}:${resource}`, `${revision}:${digest}`);
    const runId = jobId ?? ctx?.jobId;
    if (runId && db.prepare('SELECT 1 FROM agent_jobs WHERE id=? AND bot_id=? AND user_id=?').get(runId, botId, userId))
        recordContextReceipt({ userId, botId, jobId: runId, kind, sourceId: id, revision, hash: digest });
    if (runId)
        db.prepare('INSERT OR IGNORE INTO knowledge_use_receipts(user_id,bot_id,job_id,kind,source_id,revision,resource,hash,actor,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(userId, botId, runId, kind, id, revision, resource, digest, ctx?.actor ?? 'foreground', now());
}
export function requireRead(kind: string, id: string, revision: number, value: string, resource = '') {
    const ctx = managementContext();
    if (!ctx || ctx.reads.get(`${kind}:${id}:${resource}`) !== `${revision}:${hash(value)}`)
        throw new KnowledgeError('Read the current target during this operation before modifying it', 409);
}
export type Scope = 'private' | 'project' | 'account';
export function canRead(userId: string, botId: string, kind: 'skills' | 'memories', row: any): boolean {
    ownedBot(userId, botId);
    if (!db.prepare('SELECT 1 FROM bots WHERE id=? AND user_id=?').get(row.bot_id, userId))
        return false;
    return row.bot_id === botId || row.scope === 'account' || row.scope === 'project' && !!db.prepare('SELECT 1 FROM knowledge_grants WHERE user_id=? AND bot_id=? AND kind=? AND source_id=? AND project_id=?').get(userId, botId, kind, row.id, row.project_id);
}
export function setGrants(userId: string, sourceBotId: string, kind: string, id: string, scope: Scope, projectId?: string, botIds: string[] = []) {
    assertWritable(userId, sourceBotId);
    if (!['private', 'project', 'account'].includes(scope))
        throw new KnowledgeError('Invalid scope');
    if (scope === 'project' && (typeof projectId !== 'string' || !projectId.trim() || projectId.length > 100 || !Array.isArray(botIds) || !botIds.length || botIds.length > 200))
        throw new KnowledgeError('Project sharing requires projectId and explicit botIds');
    for (const bot of botIds)
        ownedBot(userId, bot);
    db.prepare('DELETE FROM knowledge_grants WHERE kind=? AND source_id=? AND user_id=?').run(kind, id, userId);
    if (scope === 'project')
        for (const bot of new Set(botIds))
            db.prepare('INSERT INTO knowledge_grants(user_id,bot_id,source_bot_id,kind,source_id,project_id) VALUES(?,?,?,?,?,?)').run(userId, bot, sourceBotId, kind, id, projectId);
}
// A foreground job's fresh reads survive tool calls but never grant authority
// across jobs. Content + revision comparison invalidates a read after any edit.
const foregroundReads = new Map<string, Map<string, string>>();
function unattendedJob(userId: string, botId: string, jobId: string): boolean {
    const seen = new Set<string>();
    while (seen.size < 256) {
        if (seen.has(jobId))
            return true;
        seen.add(jobId);
        const row = db.prepare('SELECT j.trigger FROM agent_jobs j JOIN bots b ON b.id=j.bot_id AND b.user_id=j.user_id WHERE j.id=? AND j.user_id=? AND j.bot_id=?').get(jobId, userId, botId) as { trigger: string } | undefined;
        if (!row)
            return true;
        let trigger: any;
        try { trigger = JSON.parse(row.trigger); }
        catch { return true; }
        if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger))
            return true;
        if (trigger.type === 'user')
            return false;
        if (trigger.audience === 'internal' || trigger.workflowId || trigger.taskId || trigger.goalId || trigger.proactiveSlotKey || trigger.coordinationRequestId || trigger.coordinationWakeId)
            return true;
        if (typeof trigger.parentJobId !== 'string' || !trigger.parentJobId)
            return true;
        if (trigger.type === 'system') {
            // A system job may also be independent goal/workflow work. Only a
            // persisted connection answer inherits the original job's attendance.
            const seq = trigger.connectionCardSeq;
            if (seq !== undefined && (!Number.isSafeInteger(seq) || seq < 1))
                return true;
            if (!db.prepare(`SELECT 1 FROM rows WHERE bot_id=? AND kind='card'
                AND json_extract(body,'$.card')='connect'
                AND json_extract(body,'$.status') IN ('connected','skipped')
                AND json_extract(body,'$.jobId')=? AND json_extract(body,'$.answerJobId')=?
                AND (? IS NULL OR seq=?) LIMIT 1`).get(botId, trigger.parentJobId, jobId, seq ?? null, seq ?? null))
                return true;
        }
        else if (trigger.type !== 'resume')
            return true;
        jobId = trigger.parentJobId;
    }
    // Invalid, foreign, cyclic or excessively long ancestry cannot authorize a
    // direct destructive write. The owner can still review the staged change.
    return true;
}
export function toolManagement(input: {
    userId: string;
    botId: string;
    jobId?: string;
    depth: number;
    learningIteration?: number;
}): ManagementContext {
    const current = managementContext();
    if (current)
        return current;
    const key = `${input.userId}:${input.botId}:${input.jobId ?? 'no-job'}`;
    let reads = foregroundReads.get(key);
    if (!reads) {
        reads = new Map();
        if (foregroundReads.size >= 256)
            foregroundReads.delete(foregroundReads.keys().next().value!);
        foregroundReads.set(key, reads);
    }
    // Calls without a durable job cannot borrow prior reads.
    if (!input.jobId)
        reads = new Map();
    return { ...input, iteration: input.learningIteration, unattended: input.jobId ? unattendedJob(input.userId, input.botId, input.jobId) : input.depth > 0, actor: 'foreground', reads };
}
