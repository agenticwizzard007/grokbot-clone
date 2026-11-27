import { z } from 'zod';
import { recomputeVerdict } from './verdict.js';
import { db, now, newId, sha256, atomic, afterCommit, requireEnabled, targetBot, ownBot, ownJob, activeRequestJob, requestForRun, missing, emitEvent, events, ServiceError, cursor, pageSize, nextCursor } from './db.js';
import type { Loop, LoopSpec, LoopStatus, StopReason, HandoffContext, Verdict, CheckedVerdict } from './contracts.js';
import { getOutput, displayText } from './outputs.js';
import { parseRef, validateRoom } from './handoff-service.js';
import { coordinationRuntime } from '../coordination/requests.js';
export const exitSchema = z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('verdict') }).strict(), z.object({ mode: z.literal('manual') }).strict(),
    z.object({ mode: z.literal('judge'), judgeBotId: z.string().min(1).optional(), rubric: z.string().min(1).max(2000) }).strict(),
    z.object({ mode: z.literal('checklist'), items: z.array(z.object({ id: z.string().min(1).max(80), text: z.string().min(1).max(400), required: z.boolean() }).strict()).min(1).max(30), minScore: z.number().min(0).max(1).optional() }).strict()
]);
export const loopSpecSchema = z.object({ name: z.string().trim().min(1).max(80), goal: z.string().trim().min(1).max(2000), kind: z.enum(['pipeline', 'maker_checker']),
    steps: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), botId: z.string().min(1), role: z.enum(['step', 'maker', 'checker']), instruction: z.string().max(1500) }).strict()).min(2).max(6),
    seed: z.object({ outputRef: z.string().max(300).optional(), text: z.string().max(200000).optional() }).strict(), exit: exitSchema,
    limits: z.object({ maxIterations: z.number().int().min(1).max(10), maxMinutes: z.number().min(5).max(240), maxCostUsd: z.number().positive().optional(), maxTokens: z.number().int().positive().optional(), stepTimeoutMinutes: z.number().min(1).max(30) }).strict(),
    gate: z.object({ before: z.enum(['none', 'first', 'each']), onCap: z.enum(['stop', 'ask']) }).strict(), roomId: z.string().optional(), taskId: z.string().optional() }).strict();
export const createLoopSchema = z.object({ spec: loopSpecSchema, idempotencyKey: z.string().min(1).max(200), start: z.boolean().default(false), allowSelfCheck: z.boolean().default(false) }).strict();
export const verdictSchema = z.object({ pass: z.boolean(), score: z.number().min(0).max(1).optional(), checklist: z.array(z.object({ id: z.string().min(1).max(80), pass: z.boolean(), note: z.string().max(400) }).strict()).max(30), feedback: z.string().max(2000) }).strict();
export const terminal = (s: string) => ['succeeded', 'capped', 'stalled', 'failed', 'cancelled'].includes(s);
export function loopView(r: any): Loop { return { id: r.id, userId: r.user_id, ownerBotId: r.owner_bot_id, spec: JSON.parse(r.spec), status: r.status, stopReason: r.stop_reason, iteration: r.iteration, bestOutputId: r.best_output_id, initiatedBy: r.initiated_by, idempotencyKey: r.idempotency_key, revision: r.revision, startedAt: r.started_at, finishedAt: r.finished_at, createdAt: r.created_at, updatedAt: r.updated_at }; }
export function getLoop(userId: string, id: string): Loop { requireEnabled(userId); const r = db.prepare('SELECT * FROM loops WHERE id=? AND user_id=?').get(id, userId); return r ? loopView(r) : missing(); }
export function listLoops(userId: string, opts: {
    status?: string;
    after?: string;
    limit?: number;
} = {}) {
    requireEnabled(userId);
    const c = cursor(opts.after), limit = pageSize(opts.limit);
    const rows = (db.prepare(`SELECT * FROM loops WHERE user_id=? ${opts.status ? 'AND status=?' : ''} ${c ? 'AND (created_at,id)<(?,?)' : ''} ORDER BY created_at DESC,id DESC LIMIT ?`).all(userId, ...(opts.status ? [opts.status] : []), ...(c ?? []), limit + 1) as any[]).map(loopView);
    return { loops: rows.slice(0, limit), next: rows.length > limit ? nextCursor(rows[limit - 1]) : null };
}
export function loopSteps(userId: string, id: string) { getLoop(userId, id); return (db.prepare('SELECT * FROM loop_steps WHERE user_id=? AND loop_id=? ORDER BY iteration,rowid').all(userId, id) as any[]).map(r => ({ id: r.id, loopId: r.loop_id, userId: r.user_id, iteration: r.iteration, stepId: r.step_id, botId: r.bot_id, role: r.role, status: r.status, handoffId: r.handoff_id, jobId: r.job_id, outputId: r.output_id, nudged: !!r.nudged, tokens: r.tokens, costUsd: r.cost_usd, startedAt: r.started_at, finishedAt: r.finished_at })); }
export function loopVerdicts(userId: string, id: string) { getLoop(userId, id); return (db.prepare('SELECT * FROM loop_verdicts WHERE loop_id=? AND user_id=? ORDER BY iteration').all(id, userId) as any[]).map(r => ({ loopId: r.loop_id, iteration: r.iteration, checkerStepId: r.checker_step_id, outputId: r.output_id, pass: !!r.pass, claimedPass: !!r.claimed_pass, score: r.score ?? undefined, checklist: JSON.parse(r.checklist) as Verdict['checklist'], feedback: r.feedback, feedbackHash: r.feedback_hash, createdAt: r.created_at })); }
export function loopDetail(userId: string, id: string) {
    const loop = getLoop(userId, id), steps = loopSteps(userId, id), verdicts = loopVerdicts(userId, id);
    return { ...loop, steps, verdicts, iterations: Array.from({ length: loop.iteration }, (_, i) => ({ iteration: i + 1, steps: steps.filter(s => s.iteration === i + 1), verdict: verdicts.find(v => v.iteration === i + 1) ?? null })), bestOutput: loop.bestOutputId ? getOutput(userId, loop.bestOutputId) : null, events: events(userId, { loopId: id }), resultText: resultText(loop), usage: loopUsage(userId, id), gate: db.prepare('SELECT gate_kind AS kind,gate_at AS requestedAt,extended FROM handoff_loop_controls WHERE loop_id=?').get(id) };
}
export function loopUsage(userId: string, id: string) {
    getLoop(userId, id);
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='usage_events'").get())
        return { tokens: null, costUsd: null, tracked: false };
    const u = db.prepare(`WITH RECURSIVE step_jobs(id) AS (
 SELECT r.job_id FROM coordination_requests r JOIN handoff_loop_dispatches d ON d.request_id=r.id WHERE d.loop_id=? AND r.user_id=?
 UNION SELECT j.id FROM agent_jobs j JOIN step_jobs p ON json_extract(j.trigger,'$.parentJobId')=p.id WHERE j.user_id=?)
 SELECT SUM(u.input_tokens+u.output_tokens) tokens,SUM(u.cost_usd) cost,COUNT(*) n FROM usage_events u WHERE u.user_id=? AND u.job_id IN (SELECT id FROM step_jobs)`)
        .get(id, userId, userId, userId) as any;
    return { tokens: u.tokens ?? null, costUsd: u.cost ?? null, tracked: u.n > 0 };
}
export function resultText(loop: Loop) {
    if (loop.status === 'succeeded')
        return `Done in ${loop.iteration} passes: all checks passed.`;
    if (loop.stopReason === 'max_iterations') {
        const v = loopVerdicts(loop.userId, loop.id).at(-1);
        const failures = v?.checklist.filter(c => !c.pass).length ?? 0;
        return `Stopped after ${loop.iteration} passes (limit).${v?.checklist.length ? ` ${failures} of ${v.checklist.length} checks still fail.` : ''}`;
    }
    if (loop.stopReason === 'stalled')
        return `Stopped: no progress between passes ${loop.iteration - 1} and ${loop.iteration}.`;
    if (loop.stopReason === 'user_stopped')
        return 'Stopped by you.';
    if (['max_cost', 'max_tokens', 'max_minutes'].includes(loop.stopReason ?? ''))
        return 'Stopped: budget reached.';
    return loop.stopReason ? `Stopped: ${loop.stopReason.replaceAll('_', ' ')}.` : loop.status === 'awaiting_approval' ? 'Waiting for your approval.' : loop.status === 'paused' ? 'Paused.' : 'Working.';
}
export function requestDrive(userId: string, id: string) {
    afterCommit(() => queueMicrotask(() => {
        if (db.open)
            void import('./loop-runner.js').then(m => m.driveLoop(userId, id)).catch(() => console.error('[handoff] loop recovery deferred'));
    }));
}
function admission(userId: string, id?: string) {
    const active = (db.prepare("SELECT count(*) n FROM loops WHERE user_id=? AND status IN ('running','paused','awaiting_approval') AND id!=?").get(userId, id ?? '') as any).n;
    if (active >= 3)
        throw new ServiceError('rate_limited', 'Three loops are already active.', 429);
}
export function createLoop(userId: string, input: z.input<typeof createLoopSchema>, initiatedBy: 'user' | 'agent' = 'user', ownerBotId?: string) {
    requireEnabled(userId);
    const parsed = createLoopSchema.safeParse(input);
    if (!parsed.success)
        throw new ServiceError('invalid_input', 'Check the loop fields.');
    const i = parsed.data;
    return atomic(() => {
        const fingerprint = sha256(JSON.stringify({ ...i, initiatedBy, ownerBotId: ownerBotId ?? i.spec.steps[0].botId }));
        const old = db.prepare('SELECT l.*,c.fingerprint FROM loops l JOIN handoff_loop_controls c ON c.loop_id=l.id WHERE l.user_id=? AND l.idempotency_key=?').get(userId, i.idempotencyKey) as any;
        if (old) {
            if (old.fingerprint !== fingerprint)
                throw new ServiceError('idempotency_conflict', 'This key was used for another loop.', 409);
            return { loop: loopView(old), replayed: true };
        }
        const spec = i.spec as LoopSpec, owner = targetBot(userId, ownerBotId ?? spec.steps[0].botId);
        if (spec.steps.some(s => s.id === '__judge') || new Set(spec.steps.map(s => s.id)).size !== spec.steps.length)
            throw new ServiceError('invalid_input', 'Step ids must be unique.');
        if (spec.kind === 'maker_checker' && (spec.steps.length !== 2 || spec.steps[0].role !== 'maker' || spec.steps[1].role !== 'checker'))
            throw new ServiceError('invalid_input', 'Choose a maker and a checker.');
        if (spec.exit.mode !== 'manual' && spec.steps.at(-1)?.role !== 'checker')
            throw new ServiceError('invalid_input', 'The final step must be a checker.');
        if (spec.steps.filter(s => s.role === 'checker').length > 1)
            throw new ServiceError('invalid_input', 'Choose one final checker.');
        if (!i.allowSelfCheck && spec.steps.at(-1)?.role === 'checker' && spec.steps.some(s => s.role !== 'checker' && s.botId === spec.steps.at(-1)!.botId))
            throw new ServiceError('same_bot_roles', 'Choose different agents to make and check.', 422);
        for (const s of spec.steps)
            targetBot(userId, s.botId, owner.id);
        if (spec.exit.mode === 'judge' && spec.exit.judgeBotId) {
            targetBot(userId, spec.exit.judgeBotId, owner.id);
            if (!i.allowSelfCheck && spec.steps.some(s => s.role === 'maker' && s.botId === (spec.exit as any).judgeBotId))
                throw new ServiceError('same_bot_roles', 'Choose a separate judge.', 422);
        }
        if (spec.exit.mode === 'checklist' && new Set(spec.exit.items.map(c => c.id)).size !== spec.exit.items.length)
            throw new ServiceError('invalid_input', 'Checklist ids must be unique.');
        if (spec.seed.outputRef)
            getOutput(userId, parseRef(spec.seed.outputRef).outputId);
        validateRoom(userId, spec.roomId, [...spec.steps.map(s => s.botId), ...(spec.exit.mode === 'judge' && spec.exit.judgeBotId ? [spec.exit.judgeBotId] : [])]);
        if (spec.taskId && !db.prepare('SELECT 1 FROM tasks t JOIN bots b ON b.id=t.bot_id WHERE t.id=? AND b.user_id=?').get(spec.taskId, userId))
            missing();
        if ((db.prepare('SELECT count(*) n FROM loops WHERE user_id=? AND created_at>?').get(userId, now() - 86400000) as any).n >= 20)
            throw new ServiceError('rate_limited', 'Daily loop limit reached.', 429);
        if (initiatedBy === 'agent') {
            const approved = spec.steps.length === 2 && db.prepare('SELECT 1 FROM handoff_links WHERE user_id=? AND from_bot_id=? AND to_bot_id=? AND auto_approve_loops=1').get(userId, spec.steps[0].botId, spec.steps[1].botId);
            spec.gate.before = approved ? 'none' : 'first';
        }
        const id = newId('lp');
        db.prepare(`INSERT INTO loops(id,user_id,owner_bot_id,room_id,task_id,name,spec,status,initiated_by,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'draft',?,?,?,?)`).run(id, userId, owner.id, spec.roomId ?? null, spec.taskId ?? null, spec.name, JSON.stringify(spec), initiatedBy, i.idempotencyKey, now(), now());
        db.prepare('INSERT INTO handoff_loop_controls(loop_id,fingerprint,allow_self_check) VALUES(?,?,?)').run(id, fingerprint, Number(i.allowSelfCheck));
        if (spec.taskId)
            db.prepare("INSERT OR IGNORE INTO handoff_task_links VALUES(?,NULL,?,'loop')").run(spec.taskId, id);
        emitEvent(userId, 'loop.created', { ownerBotId: owner.id }, { loopId: id }, { type: 'loop', id, status: 'draft', iteration: 0 });
        return { loop: i.start ? controlLoop(userId, id, 'start') : getLoop(userId, id), replayed: false };
    });
}
export function updateLoop(loop: Loop, status: LoopStatus, type: string, extra: Record<string, unknown> = {}) {
    db.prepare('UPDATE loops SET status=?,revision=revision+1,updated_at=? WHERE id=? AND user_id=?').run(status, now(), loop.id, loop.userId);
    emitEvent(loop.userId, type, { iteration: loop.iteration, ...extra }, { loopId: loop.id }, { type: 'loop', id: loop.id, status, iteration: loop.iteration });
    const state = status === 'succeeded' ? 'done' : status === 'running' || status === 'paused' ? 'working' : 'needs_input';
    db.prepare('UPDATE tasks SET state=?,updated_at=? WHERE id IN (SELECT task_id FROM handoff_task_links WHERE loop_id=?)').run(state, now(), loop.id);
}
export function waitGate(loop: Loop, kind: 'first' | 'each' | 'cap' | 'manual') {
    db.prepare('UPDATE handoff_loop_controls SET gate_kind=?,gate_at=? WHERE loop_id=?').run(kind, now(), loop.id);
    updateLoop(loop, 'awaiting_approval', 'loop.approval_requested', { kind });
    const prior = db.prepare("SELECT 1 FROM handoff_task_links WHERE loop_id=? AND kind='gate'").get(loop.id);
    if (!prior) {
        const id = newId('task');
        db.prepare("INSERT INTO tasks(id,bot_id,title,state,note,created_at,updated_at) VALUES(?,?,?,'needs_input','',?,?)").run(id, loop.ownerBotId, `Approve loop: ${displayText(loop.spec.name)}`, now(), now());
        db.prepare("INSERT INTO handoff_task_links VALUES(?,NULL,?,'gate')").run(id, loop.id);
    }
}
export function finishLoop(loop: Loop, reason: StopReason) {
    if (terminal(loop.status))
        return;
    const status: LoopStatus = reason === 'passed' ? 'succeeded' : ['max_iterations', 'max_minutes', 'max_tokens', 'max_cost'].includes(reason) ? 'capped' : reason === 'stalled' ? 'stalled' : ['user_stopped', 'declined', 'gate_expired'].includes(reason) ? 'cancelled' : 'failed';
    db.prepare('UPDATE loops SET stop_reason=?,finished_at=? WHERE id=? AND user_id=?').run(reason, now(), loop.id, loop.userId);
    updateLoop(loop, status, 'loop.finished', { reason, bestOutputId: loop.bestOutputId });
    cancelLoopWork(loop);
}
export function cancelLoopWork(loop: Loop) {
    const pending = db.prepare("SELECT r.* FROM coordination_requests r JOIN handoff_loop_dispatches d ON d.request_id=r.id WHERE d.loop_id=? AND r.user_id=? AND r.status NOT IN ('completed','failed')").all(loop.id, loop.userId) as any[];
    for (const r of pending) {
        db.prepare("UPDATE coordination_requests SET status='failed',reply=0,reason='loop_stopped',updated_at=? WHERE id=? AND user_id=?").run(now(), r.id, loop.userId);
        const activeJob = activeRequestJob(loop.userId, r.id);
        if (activeJob)
            afterCommit(() => coordinationRuntime()?.interrupt(r.to_bot_id, activeJob));
    }
}
export function controlLoop(userId: string, id: string, action: 'start' | 'pause' | 'resume' | 'stop' | 'approve' | 'decline' | 'extend' | 'done') {
    requireEnabled(userId);
    return atomic(() => {
        let loop = getLoop(userId, id);
        const control = db.prepare('SELECT * FROM handoff_loop_controls WHERE loop_id=?').get(id) as any;
        if (action === 'extend') {
            if (control.extended)
                return loop;
            if (!(loop.status === 'capped' && loop.stopReason === 'max_iterations' || loop.status === 'awaiting_approval' && control.gate_kind === 'cap'))
                throw new ServiceError('invalid_state', 'This loop cannot be extended.', 409);
            if (loop.spec.limits.maxIterations >= 10)
                throw new ServiceError('limit_exceeded', 'Ten passes is the maximum.', 422);
            admission(userId, id);
            loop.spec.limits.maxIterations = Math.min(10, loop.spec.limits.maxIterations + 2);
            db.prepare('UPDATE loops SET spec=?,stop_reason=NULL,finished_at=NULL WHERE id=? AND user_id=?').run(JSON.stringify(loop.spec), id, userId);
            db.prepare('UPDATE handoff_loop_controls SET extended=1,gate_kind=NULL,gate_at=NULL WHERE loop_id=?').run(id);
            updateLoop(loop, 'running', 'loop.extended', { actor: userId, maxIterations: loop.spec.limits.maxIterations });
            requestDrive(userId, id);
            return getLoop(userId, id);
        }
        if (terminal(loop.status))
            return loop;
        if (action === 'stop') {
            finishLoop(loop, 'user_stopped');
            return getLoop(userId, id);
        }
        if (action === 'decline' && loop.status === 'awaiting_approval') {
            emitEvent(userId, 'loop.declined', { actor: userId }, { loopId: id });
            finishLoop(loop, 'declined');
            return getLoop(userId, id);
        }
        if (action === 'done' && loop.status === 'awaiting_approval' && control.gate_kind === 'manual') {
            finishLoop(loop, 'passed');
            return getLoop(userId, id);
        }
        if (action === 'pause' && loop.status === 'running') {
            updateLoop(loop, 'paused', 'loop.paused', { actor: userId });
            return getLoop(userId, id);
        }
        if (action === 'start' && loop.status === 'draft') {
            admission(userId, id);
            db.prepare('UPDATE loops SET started_at=? WHERE id=? AND user_id=?').run(now(), id, userId);
            if (loop.spec.gate.before !== 'none')
                waitGate(loop, 'first');
            else
                updateLoop(loop, 'running', 'loop.started', { actor: userId });
        }
        else if (action === 'resume' && loop.status === 'paused') {
            admission(userId, id);
            updateLoop(loop, 'running', 'loop.resumed', { actor: userId });
        }
        else if (action === 'approve' && loop.status === 'awaiting_approval') {
            if (control.gate_kind === 'cap')
                throw new ServiceError('invalid_state', 'Extend or decline this loop.', 409);
            if (control.gate_at + 86400000 <= now()) {
                finishLoop(loop, 'gate_expired');
                return getLoop(userId, id);
            }
            admission(userId, id);
            db.prepare('UPDATE handoff_loop_controls SET gate_kind=NULL,gate_at=NULL WHERE loop_id=?').run(id);
            updateLoop(loop, 'running', 'loop.approved', { actor: userId });
            if (loop.iteration === 0)
                emitEvent(userId, 'loop.started', { iteration: 0 }, { loopId: id });
        }
        else
            return loop;
        requestDrive(userId, id);
        return getLoop(userId, id);
    });
}
export function submitVerdict(ctx: HandoffContext, input: Verdict): CheckedVerdict {
    requireEnabled(ctx.userId);
    const parsed = verdictSchema.safeParse(input);
    if (!parsed.success)
        throw new ServiceError('invalid_verdict', 'Check the verdict fields.');
    ownJob(ctx.userId, ctx.botId, ctx.jobId);
    return atomic(() => {
        const requestId = requestForRun(ctx.userId, ctx.botId, ctx.jobId);
        const row = db.prepare(`SELECT s.* FROM loop_steps s JOIN handoff_loop_dispatches d ON d.loop_id=s.loop_id AND d.iteration=s.iteration AND d.step_id=s.step_id
 WHERE s.user_id=? AND s.bot_id=? AND d.request_id=? AND s.role IN ('checker','judge') AND d.attempt=(SELECT MAX(attempt) FROM handoff_loop_dispatches WHERE loop_id=s.loop_id AND iteration=s.iteration AND step_id=s.step_id)`)
            .get(ctx.userId, ctx.botId, requestId ?? '') as any;
        if (!row)
            throw new ServiceError('not_in_loop', 'No review is waiting for you.', 422);
        const loop = getLoop(ctx.userId, row.loop_id);
        const judge = loop.spec.exit.mode === 'judge' ? loop.spec.exit.judgeBotId : undefined;
        if (judge && judge !== ctx.botId)
            throw new ServiceError('not_in_loop', 'The separate judge submits this verdict.', 422);
        if (!['running', 'paused'].includes(loop.status) || row.iteration !== loop.iteration)
            throw new ServiceError('invalid_state', 'This review has finished.', 409);
        if (new Set(parsed.data.checklist.map(c => c.id)).size !== parsed.data.checklist.length)
            throw new ServiceError('invalid_verdict', 'Answer each checklist item once.');
        const checked = recomputeVerdict(parsed.data, loop.spec.exit), pass = checked.pass;
        const verdict: CheckedVerdict = { ...checked, feedback: displayText(input.feedback), checklist: input.checklist.map(c => ({ ...c, note: displayText(c.note) })) };
        const old = db.prepare('SELECT * FROM loop_verdicts WHERE loop_id=? AND iteration=? AND user_id=?').get(loop.id, row.iteration, ctx.userId) as any;
        if (old) {
            if (old.pass !== Number(pass) || old.claimed_pass !== Number(input.pass) || old.feedback !== verdict.feedback || old.checklist !== JSON.stringify(verdict.checklist) || (old.score ?? undefined) !== input.score)
                throw new ServiceError('invalid_state', 'A submitted verdict cannot change.', 409);
            return verdict;
        }
        db.prepare('INSERT INTO loop_verdicts(loop_id,iteration,user_id,checker_step_id,pass,claimed_pass,score,checklist,feedback,feedback_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(loop.id, row.iteration, ctx.userId, row.step_id, Number(pass), Number(input.pass), input.score ?? null, JSON.stringify(verdict.checklist), verdict.feedback, sha256(verdict.feedback), now());
        if (verdict.corrected)
            emitEvent(ctx.userId, 'verdict.corrected', { iteration: row.iteration, pass, claimedPass: input.pass }, { loopId: loop.id });
        emitEvent(ctx.userId, 'loop.verdict', { iteration: row.iteration, stepId: row.step_id, pass, score: input.score ?? null, checks: input.checklist.length }, { loopId: loop.id }, { type: 'loop', id: loop.id, status: loop.status, iteration: loop.iteration });
        return verdict;
    });
}
