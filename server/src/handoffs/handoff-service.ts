import { randomBytes } from 'node:crypto';
import { buildPacket } from './packet.js';
import { z } from 'zod';
import { db, now, newId, sha256, atomic, afterCommit, ownBot, targetBot, ownJob, activeRequestJob, requestForRun, requireEnabled, enabled, settings, missing, emitEvent, events, ServiceError, cursor, pageSize, nextCursor } from './db.js';
import { getOutput, saveOutput, submitOutput, fromTask, fromMessage, rawBody, readPart, materialize, displayText } from './outputs.js';
import { enqueueInternalMessage, drainInternalRequests, coordinationRuntime } from '../coordination/requests.js';
import { appendRow, updateRow } from '../store.js';
import type { RowBody } from '../types.js';
import type { RunOutput, Handoff, HandoffContext, AgentHandoffInput, ReadHandoffInput, ListHandoffsInput, HandoffService } from './contracts.js';
export const messageRefSchema = z.object({ botId: z.string().min(1), generation: z.number().int().nonnegative(), seq: z.number().int().positive() }).strict();
export const sourceSchema = z.union([z.object({ outputId: z.string().min(1) }).strict(), z.object({ messageRef: messageRefSchema }).strict(), z.object({ taskId: z.string().min(1) }).strict()]);
export const handoffInputSchema = z.object({ source: sourceSchema, toBotId: z.string().min(1), instruction: z.string().trim().min(1).max(1000), returnResult: z.boolean().default(true), createTask: z.boolean().default(true), includeSensitive: z.boolean().default(false), idempotencyKey: z.string().min(1).max(200), roomId: z.string().min(1).optional(), priority: z.enum(['normal', 'high']).default('normal') }).strict();
export type CreateHandoffInput = z.input<typeof handoffInputSchema>;
export function handoffView(r: any): Handoff { return { id: r.id, userId: r.user_id, fromBotId: r.from_bot_id, toBotId: r.to_bot_id, sourceOutputId: r.source_output_id, resultOutputId: r.result_output_id, initiatedBy: r.initiated_by, instruction: r.instruction, priority: r.priority, returnResult: !!r.return_result, createTask: !!r.create_task, status: r.status, reason: r.reason, requestId: r.request_id, jobId: r.job_id, loopId: r.loop_id, iteration: r.iteration, stepId: r.step_id, roomId: r.room_id, chainDepth: r.chain_depth, parentHandoffId: r.parent_handoff_id, idempotencyKey: r.idempotency_key, fingerprint: r.fingerprint, revision: r.revision, createdAt: r.created_at, updatedAt: r.updated_at }; }
export function getHandoff(userId: string, id: string) { requireEnabled(userId); const row = db.prepare('SELECT * FROM handoffs WHERE id=? AND user_id=?').get(id, userId); return row ? handoffView(row) : missing(); }
export function handoffDetail(userId: string, id: string) { const handoff = getHandoff(userId, id); return { ...handoff, events: events(userId, { handoffId: id }), sourceOutput: getOutput(userId, handoff.sourceOutputId), resultOutput: handoff.resultOutputId ? getOutput(userId, handoff.resultOutputId) : null }; }
export function listHandoffs(userId: string, opts: {
    botId?: string;
    direction?: 'sent' | 'received' | 'all';
    status?: string;
    after?: string;
    limit?: number;
} = {}) {
    requireEnabled(userId);
    if (opts.botId)
        ownBot(userId, opts.botId);
    const c = cursor(opts.after), limit = pageSize(opts.limit);
    const filter = opts.botId ? (opts.direction === 'sent' ? 'AND from_bot_id=?' : opts.direction === 'received' ? 'AND to_bot_id=?' : 'AND (from_bot_id=? OR to_bot_id=?)') : '';
    const rows = (db.prepare(`SELECT * FROM handoffs WHERE user_id=? ${filter} ${opts.status ? 'AND status=?' : ''} ${c ? 'AND (created_at,id)<(?,?)' : ''} ORDER BY created_at DESC,id DESC LIMIT ?`)
        .all(userId, ...(opts.botId ? (opts.direction && opts.direction !== 'all' ? [opts.botId] : [opts.botId, opts.botId]) : []), ...(opts.status ? [opts.status] : []), ...(c ?? []), limit + 1) as any[]).map(handoffView);
    return { handoffs: rows.slice(0, limit), next: rows.length > limit ? nextCursor(rows[limit - 1]) : null };
}
export function validateRoom(userId: string, roomId: string | undefined, botIds: string[]) {
    if (!roomId)
        return;
    const room = ownBot(userId, roomId);
    if (room.kind !== 'room')
        missing();
    const members: string[] = JSON.parse(room.members ?? '[]');
    if (botIds.some(id => !members.includes(id)))
        throw new ServiceError('target_not_allowed', 'Choose agents in this group.', 422);
}
function checkChain(userId: string, output: RunOutput, target: string) {
    let depth = 1;
    const seen = new Set<string>(), queue = [{ output, n: 1 }];
    while (queue.length) {
        const entry = queue.shift()!;
        if (seen.has(entry.output.id))
            continue;
        seen.add(entry.output.id);
        depth = Math.max(depth, entry.n);
        if (entry.output.botId === target)
            throw new ServiceError('cycle_detected', 'That would send the work back. Use a loop instead.', 422);
        if (entry.n > 5)
            throw new ServiceError('chain_too_long', 'This chain has reached its limit. Use a loop.', 422);
        for (const id of entry.output.provenance.consumed)
            queue.push({ output: getOutput(userId, id), n: entry.n + 1 });
    }
    return depth;
}
/** Compact reference packet. Content never occupies the instruction section. */
export function packet(userId: string, output: RunOutput, instruction: string, header: string, includeSensitive = false, answer = 'Reply as usual. Your final reply becomes your output.') {
    const id = /\b(ho_[A-Za-z0-9_-]+)/.exec(header)?.[1] ?? `ho_${sha256(header).slice(0, 24)}`;
    const names = /from ("(?:[^"\\]|\\.)*") to ("(?:[^"\\]|\\.)*")/.exec(header);
    const loop = /iteration (\d+) of (\d+)/.exec(answer);
    return buildPacket({ handoffId: id, fromName: names ? JSON.parse(names[1]) : output.provenance.producer.botName, toName: names ? JSON.parse(names[2]) : 'Receiving agent', instruction, output, nonce: randomBytes(12).toString('hex'),
        bodies: Object.fromEntries(output.parts.filter(p => p.kind === 'text' || p.kind === 'data').map(p => [p.id, rawBody(userId, output.id, p.id, includeSensitive)])), includeSensitive,
        chainDepth: Number(/chain (\d+)/.exec(header)?.[1] ?? 1), priority: header.includes('priority high') ? 'high' : 'normal', returnResult: !answer.includes('Do not send'),
        ...(loop ? { loop: { iteration: Number(loop[1]), maxIterations: Number(loop[2]), goal: instruction.match(/^Goal: ([^\n]+)/)?.[1] ?? '', role: answer.includes('submit_verdict') ? 'checker' as const : 'maker' as const } } : {}) });
}
export function syncHandoffRows(h: Handoff) {
    for (const [botId, otherBotId, direction] of [[h.fromBotId, h.toBotId, 'sent'], [h.toBotId, h.fromBotId, 'received']] as const) {
        const body = { type: 'handoff', handoffId: h.id, direction, otherBotId, status: h.status, title: displayText(h.instruction).slice(0, 120), ...(h.loopId ? { loopId: h.loopId, iteration: h.iteration } : {}) } as unknown as RowBody;
        const row = db.prepare("SELECT r.seq FROM rows r JOIN bots b ON b.id=r.bot_id AND b.generation=r.generation WHERE r.bot_id=? AND r.kind='handoff' AND json_extract(r.body,'$.handoffId')=? LIMIT 1").get(botId, h.id) as any;
        if (row)
            updateRow(botId, row.seq, body);
        else
            appendRow(botId, 'handoff', body);
    }
}
export function createHandoff(userId: string, input: CreateHandoffInput, initiatedBy: Handoff['initiatedBy'] = 'user', includeFiles?: string[]) {
    requireEnabled(userId);
    const parsed = handoffInputSchema.safeParse(input);
    if (!parsed.success)
        throw new ServiceError('invalid_input', 'Check the handoff fields.');
    const i = parsed.data;
    const fingerprint = sha256(JSON.stringify({ ...i, initiatedBy, ...(includeFiles ? { includeFiles: [...includeFiles].sort() } : {}) }));
    return atomic(() => {
        const prior = db.prepare('SELECT * FROM handoffs WHERE user_id=? AND idempotency_key=?').get(userId, i.idempotencyKey) as any;
        if (prior) {
            if (prior.fingerprint !== fingerprint)
                throw new ServiceError('idempotency_conflict', 'This key was used for another handoff.', 409);
            return { handoff: handoffView(prior), replayed: true };
        }
        const output = 'outputId' in i.source ? getOutput(userId, i.source.outputId) : 'messageRef' in i.source ? fromMessage(userId, i.source.messageRef) : fromTask(userId, i.source.taskId);
        const from = ownBot(userId, output.botId), to = targetBot(userId, i.toBotId, from.id);
        if (from.id === to.id)
            throw new ServiceError('cycle_detected', 'Use a loop to repeat work.', 422);
        validateRoom(userId, i.roomId, [from.id, to.id]);
        const depth = checkChain(userId, output, to.id);
        if (initiatedBy === 'agent') {
            if (output.provenance.loopId)
                throw new ServiceError('policy_denied', 'Loop steps cannot start handoffs.', 422);
            const policy = settings(userId).agentHandoffs;
            if (policy === 'off' || policy === 'links_only' && !db.prepare("SELECT 1 FROM handoff_links WHERE user_id=? AND from_bot_id=? AND to_bot_id=? AND mode!='off'").get(userId, from.id, to.id))
                throw new ServiceError('policy_denied', 'Agent handoffs are restricted by your settings.', 422);
            const botCount = (db.prepare("SELECT count(*) n FROM handoffs WHERE user_id=? AND from_bot_id=? AND initiated_by='agent' AND created_at>?").get(userId, from.id, now() - 3600000) as any).n;
            const userCount = (db.prepare("SELECT count(*) n FROM handoffs WHERE user_id=? AND initiated_by='agent' AND created_at>?").get(userId, now() - 86400000) as any).n;
            if (botCount >= 20 || userCount >= 100)
                throw new ServiceError('rate_limited', 'Agent handoff limit reached. Try later.', 429);
        }
        const id = newId('ho');
        db.prepare(`INSERT INTO handoffs(id,user_id,from_bot_id,to_bot_id,source_output_id,initiated_by,instruction,priority,return_result,create_task,status,room_id,chain_depth,parent_handoff_id,idempotency_key,fingerprint,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,'queued',?,?,?,?,?,?,?)`).run(id, userId, from.id, to.id, output.id, initiatedBy, i.instruction, i.priority, Number(i.returnResult), Number(i.createTask), i.roomId ?? null, depth, output.provenance.handoffId, i.idempotencyKey, fingerprint, now(), now());
        const selected = includeFiles?.map(file => {
            const part = output.parts.find(p => p.kind === 'file' && (p.id === file || p.artifactId === file || p.filename === file));
            if (!part)
                missing();
            return part.id;
        });
        if (selected)
            db.prepare('INSERT INTO handoff_file_selections VALUES(?,?)').run(id, JSON.stringify(selected));
        const packetOutput = selected ? { ...output, parts: output.parts.filter(p => p.kind !== 'file' || selected.includes(p.id)) } : output;
        const text = packet(userId, packetOutput, i.instruction, `[handoff ${id} from ${JSON.stringify(from.name)} to ${JSON.stringify(to.name)} | chain ${depth} of 5 | priority ${i.priority}]`, i.includeSensitive);
        db.prepare('INSERT INTO handoff_payloads VALUES(?,?,?)').run(id, text, Number(i.includeSensitive));
        // Suppress the transport's prose return; reconciliation creates one result packet.
        const requestId = enqueueInternalMessage(from.id, to.id, text, 0, { idempotencyKey: `ho:${id}` });
        db.prepare('UPDATE coordination_requests SET reply=0 WHERE id=? AND user_id=?').run(requestId, userId);
        db.prepare('UPDATE handoffs SET request_id=? WHERE id=? AND user_id=?').run(requestId, id, userId);
        emitEvent(userId, 'handoff.created', { fromBotId: from.id, toBotId: to.id, outputId: output.id }, { handoffId: id }, { type: 'handoff', id, status: 'queued' });
        if (i.createTask) {
            const taskId = newId('task');
            db.prepare("INSERT INTO tasks(id,bot_id,title,state,note,created_at,updated_at) VALUES(?,?,?,'working','',?,?)").run(taskId, to.id, `From ${displayText(from.name)}: ${displayText(i.instruction).slice(0, 60)}`, now(), now());
            db.prepare("INSERT INTO handoff_task_links VALUES(?,?,NULL,'receiver')").run(taskId, id);
        }
        const handoff = getHandoff(userId, id);
        syncHandoffRows(handoff);
        afterCommit(() => queueMicrotask(() => {
            if (db.open)
                void import('./reconcile.js').then(m => m.scheduleReconciliation(userId));
        }));
        return { handoff, replayed: false };
    });
}
export function controlHandoff(userId: string, id: string, action: 'approve' | 'decline' | 'cancel') {
    const h = getHandoff(userId, id);
    if (['completed', 'failed', 'declined', 'cancelled', 'expired'].includes(h.status))
        return h;
    if (action !== 'cancel' && h.status !== 'pending_approval')
        return h;
    return atomic(() => {
        const status = action === 'approve' ? 'queued' : action === 'decline' ? 'declined' : 'cancelled';
        db.prepare('UPDATE handoffs SET status=?,revision=revision+1,updated_at=? WHERE id=? AND user_id=?').run(status, now(), id, userId);
        if (status !== 'queued' && h.requestId) {
            db.prepare("UPDATE coordination_requests SET status='failed',reply=0,reason=?,updated_at=? WHERE id=? AND user_id=? AND status NOT IN ('completed','failed')").run(status, now(), h.requestId, userId);
            const activeJob = activeRequestJob(userId, h.requestId);
            if (activeJob)
                afterCommit(() => coordinationRuntime()?.interrupt(h.toBotId, activeJob));
        }
        emitEvent(userId, `handoff.${action === 'approve' ? 'approved' : status}`, { actor: userId }, { handoffId: id }, { type: 'handoff', id, status });
        const result = getHandoff(userId, id);
        syncHandoffRows(result);
        return result;
    });
}
export function parseRef(ref: string) {
    const match = /^swarm:\/\/output\/([A-Za-z0-9_-]+)(?:#([A-Za-z0-9_-]+))?(?:\?o=(\d+)&l=(\d+))?$/.exec(ref);
    if (!match)
        throw new ServiceError('invalid_ref', 'Use an output reference.');
    return { outputId: match[1], partId: match[2], offset: match[3] ? Number(match[3]) : undefined, limit: match[4] ? Number(match[4]) : undefined };
}
export function canReadOutput(ctx: HandoffContext, id: string) {
    const output = getOutput(ctx.userId, id);
    ownJob(ctx.userId, ctx.botId, ctx.jobId);
    if (output.botId === ctx.botId)
        return output;
    const addressed = db.prepare('SELECT 1 FROM handoffs WHERE user_id=? AND (source_output_id=? OR result_output_id=?) AND (to_bot_id=? OR from_bot_id=?)').get(ctx.userId, id, id, ctx.botId, ctx.botId);
    const inLoop = output.provenance.loopId && db.prepare('SELECT 1 FROM loop_steps WHERE user_id=? AND loop_id=? AND bot_id=?').get(ctx.userId, output.provenance.loopId, ctx.botId);
    const seeded = db.prepare("SELECT 1 FROM loops WHERE user_id=? AND json_extract(spec,'$.seed.outputRef')=? AND EXISTS (SELECT 1 FROM json_each(json_extract(spec,'$.steps')) WHERE json_extract(value,'$.botId')=?)").get(ctx.userId, `swarm://output/${id}`, ctx.botId);
    if (!addressed && !inLoop && !seeded)
        missing();
    if (inLoop || seeded)
        return output;
    const grants = db.prepare(`SELECT s.part_ids FROM handoffs h LEFT JOIN handoff_file_selections s ON s.handoff_id=h.id
  WHERE h.user_id=? AND (h.source_output_id=? OR h.result_output_id=?) AND (h.from_bot_id=? OR h.to_bot_id=?)`).all(ctx.userId, id, id, ctx.botId, ctx.botId) as {
        part_ids: string | null;
    }[];
    if (grants.some(g => g.part_ids === null))
        return output;
    const allowed = new Set(grants.flatMap(g => JSON.parse(g.part_ids!)));
    return { ...output, parts: output.parts.filter(p => p.kind !== 'file' || allowed.has(p.id)) };
}
export function readHandoff(ctx: HandoffContext, input: ReadHandoffInput) {
    requireEnabled(ctx.userId);
    let handoffId = input.handoffId, ref = input.ref;
    if (ref?.startsWith('swarm://handoff/')) {
        handoffId = ref.slice(16);
        ref = undefined;
    }
    let outputId: string, partId = input.partId, offset = input.offset, limit = input.limit;
    if (handoffId) {
        const h = getHandoff(ctx.userId, handoffId);
        if (h.toBotId !== ctx.botId && h.fromBotId !== ctx.botId)
            missing();
        outputId = h.sourceOutputId;
    }
    else {
        if (!ref)
            throw new ServiceError('invalid_ref', 'Choose a handoff or output.');
        const r = parseRef(ref);
        outputId = r.outputId;
        partId ??= r.partId;
        offset ??= r.offset;
        limit ??= r.limit;
    }
    const output = canReadOutput(ctx, outputId);
    const sensitive = !!db.prepare('SELECT 1 FROM handoff_payloads p JOIN handoffs h ON h.id=p.handoff_id WHERE h.user_id=? AND h.source_output_id=? AND h.to_bot_id=? AND p.include_sensitive=1').get(ctx.userId, outputId, ctx.botId);
    if (partId && !output.parts.some(p => p.id === partId))
        missing();
    const result = partId ? { ...readPart(ctx.userId, outputId, partId, offset, limit, sensitive), output } : { output, next: null };
    if (input.materialize && 'part' in result && result.part)
        Object.assign(result, { sandboxPath: materialize(ctx.userId, ctx.botId, result.part) });
    atomic(() => emitEvent(ctx.userId, 'handoff.read', { outputId, partId: partId ?? null, bytes: 'text' in result ? Buffer.byteLength(result.text ?? '') : 0 }, { handoffId, loopId: output.provenance.loopId }));
    return result;
}
export function assertNotLoopStep(ctx: HandoffContext) {
    const job = ownJob(ctx.userId, ctx.botId, ctx.jobId), trigger = JSON.parse(job.trigger);
    if (db.prepare('SELECT 1 FROM handoff_loop_dispatches d JOIN loops l ON l.id=d.loop_id JOIN coordination_requests r ON r.id=d.request_id WHERE l.user_id=? AND (d.job_id=? OR r.job_id=? OR r.id=?)').get(ctx.userId, ctx.jobId, ctx.jobId, requestForRun(ctx.userId, ctx.botId, ctx.jobId) ?? ''))
        throw new ServiceError('policy_denied', 'Loop steps cannot start handoffs or loops.', 422);
}
export const handoffService: HandoffService = {
    enabled, async submitOutput(ctx, input) { return submitOutput(ctx, input); },
    async handoffToAgent(ctx, input: AgentHandoffInput) {
        requireEnabled(ctx.userId);
        assertNotLoopStep(ctx);
        return atomic(() => {
            const fingerprint = sha256(JSON.stringify(input));
            const receipt = db.prepare('SELECT * FROM handoff_agent_commands WHERE user_id=? AND job_id=? AND call_id=?').get(ctx.userId, ctx.jobId, ctx.toolCallId) as any;
            if (receipt) {
                if (receipt.fingerprint !== fingerprint)
                    throw new ServiceError('idempotency_conflict', 'This call was used for another handoff.', 409);
                return getHandoff(ctx.userId, receipt.handoff_id);
            }
            const output = input.outputRef ? canReadOutput(ctx, parseRef(input.outputRef).outputId) : saveOutput({ ...ctx, declared: { summary: input.summary ?? input.instruction } });
            if (output.botId !== ctx.botId)
                throw new ServiceError('policy_denied', 'Hand off an output from this agent.', 422);
            const handoff = createHandoff(ctx.userId, { source: { outputId: output.id }, toBotId: input.toBotId, instruction: input.instruction, returnResult: input.returnResult, priority: input.priority, idempotencyKey: sha256(`${ctx.jobId}:${ctx.toolCallId}`) }, 'agent', input.includeFiles).handoff;
            db.prepare('INSERT INTO handoff_agent_commands VALUES(?,?,?,?,?)').run(ctx.userId, ctx.jobId, ctx.toolCallId, fingerprint, handoff.id);
            return handoff;
        });
    },
    async readHandoff(ctx, input) { return readHandoff(ctx, input); },
    async listHandoffs(ctx, input: ListHandoffsInput) { ownJob(ctx.userId, ctx.botId, ctx.jobId); return listHandoffs(ctx.userId, { ...input, botId: ctx.botId, limit: Math.min(20, input.limit ?? 20) }).handoffs; },
    async submitVerdict(ctx, input) { return (await import('./loop-service.js')).submitVerdict(ctx, input); },
    async startLoop(ctx, input) { assertNotLoopStep(ctx); return (await import('./loop-service.js')).createLoop(ctx.userId, { spec: { name: input.name ?? 'Agent loop', kind: input.kind ?? 'maker_checker', seed: input.seed ?? {}, ...input, gate: { before: 'first', onCap: 'stop' } }, idempotencyKey: sha256(`${ctx.jobId}:${ctx.toolCallId}`), start: true }, 'agent', ctx.botId).loop; }
};
