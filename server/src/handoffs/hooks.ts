import { db, enabled, atomic, requestForRun } from './db.js';
import { saveOutput } from './outputs.js';
import type { CoordinationFinish } from '../coordination/requests.js';
/** Called in the settlement transaction, before the final text can be lost. */
export function onJobFinished(input: CoordinationFinish) {
    if (!enabled(input.userId))
        return;
    const job = db.prepare('SELECT * FROM agent_jobs WHERE id=? AND user_id=? AND bot_id=?').get(input.jobId, input.userId, input.botId) as any;
    if (!job)
        return;
    atomic(() => {
        const trigger = JSON.parse(job.trigger);
        const requestId = requestForRun(input.userId, input.botId, input.jobId);
        if (requestId)
            db.prepare(`UPDATE handoff_loop_dispatches SET job_id=? WHERE request_id=? AND loop_id IN (SELECT id FROM loops WHERE user_id=?)`).run(input.jobId, requestId, input.userId);
        if (input.status === 'completed' && job.state === 'completed') {
            const output = saveOutput({ userId: input.userId, botId: input.botId, jobId: input.jobId, body: input.finalText ?? '', final: true });
            const task = trigger.taskId ?? (db.prepare(`SELECT json_extract(r.body,'$.args.task_id') id FROM rows r JOIN tasks t ON t.id=json_extract(r.body,'$.args.task_id')
    WHERE r.bot_id=? AND t.bot_id=r.bot_id AND t.state='done' AND r.kind='tool-call' AND json_extract(r.body,'$.name')='update_task'
    AND json_extract(r.body,'$.status')='done' AND json_extract(r.body,'$.jobId')=? ORDER BY r.seq DESC LIMIT 1`).get(input.botId, input.jobId) as any)?.id;
            if (task && db.prepare('SELECT 1 FROM tasks WHERE id=? AND bot_id=?').get(task, input.botId))
                db.prepare('UPDATE run_outputs SET task_id=? WHERE id=? AND user_id=?').run(task, output.id, input.userId);
        }
    });
    queueMicrotask(() => {
        if (db.open)
            void import('./reconcile.js').then(m => { m.watchHandoffs(input.userId); m.scheduleReconciliation(input.userId); }).catch(() => console.error('[handoff] completion deferred for recovery'));
    });
}
