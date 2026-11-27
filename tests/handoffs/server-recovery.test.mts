import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { after, test } from 'node:test';
import { fixture, makeLoop, db, loops, runLoop, cleanup, jobs, recordArtifact, finish, outputs, handoffs, flush } from './server-fixture.test.mts';
after(cleanup);
test('process death after intent and after admission recovers without duplicate jobs', async () => {
    const f = fixture(), l = makeLoop(f, {}, false);
    const script = `
 const {db}=await import('./server/src/db.ts');
 const {configureCoordinationRuntime}=await import('./server/src/coordination/requests.ts');
 const {acceptJob}=await import('./server/src/agent/jobs.ts');
 const {recoverHandoffs}=await import('./server/src/handoffs/reconcile.ts');
 configureCoordinationRuntime({enqueue:(botId,trigger)=>acceptJob(botId,trigger).id,interrupt:()=>{}});
 const loopId=${JSON.stringify(l.id)},userId=${JSON.stringify(f.userId)};
 if(process.env.RECOVERY_PHASE==='intent'){
  db.prepare("UPDATE loops SET status='running',iteration=1,started_at=?,claim_token='crashed',claim_until=0 WHERE id=?").run(Date.now(),loopId);
  db.prepare("INSERT INTO loop_steps(id,loop_id,user_id,iteration,step_id,bot_id,role,status,started_at) VALUES('fixture-intent',?,?,1,'maker',?,'maker','dispatching',?)").run(loopId,userId,${JSON.stringify(f.maker.id)},Date.now());
 }else{recoverHandoffs();recoverHandoffs();}
 process.kill(process.pid,'SIGKILL');`;
    for (const phase of ['intent', 'admission', 'replay']) {
        const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { env: { ...process.env, RECOVERY_PHASE: phase }, encoding: 'utf8' });
        assert.equal(child.signal, 'SIGKILL', child.stderr);
    }
    assert.equal((db.prepare('SELECT count(*) n FROM handoff_loop_dispatches WHERE loop_id=?').get(l.id) as any).n, 1);
    assert.equal((db.prepare('SELECT count(*) n FROM agent_jobs WHERE user_id=?').get(f.userId) as any).n, 1);
    assert.equal((await runLoop(f, l.id)).status, 'succeeded');
    assert.equal(loops.loopSteps(f.userId, l.id).length, 6);
});

test('payload migration preserves selected, empty and unrestricted file grants across restarts', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-grants-migration-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const cases = [];
    for (const selection of [undefined, [], ['included.txt']]) {
        const f = fixture(), job = jobs.acceptJob(f.maker.id, { type: 'user' });
        for (const filename of ['included.txt', 'excluded.txt'])
            recordArtifact({ userId: f.userId, botId: f.maker.id, jobId: job.id, filename, content: 'Placeholder file.' });
        finish(f, job.id, 'Placeholder output.');
        const output = outputs.outputByJob(f.userId, job.id);
        const handoff = handoffs.createHandoff(f.userId, { source: { outputId: output.id }, toBotId: f.checker.id, instruction: 'Read the allowed files.', idempotencyKey: 'migration-grants', includeSensitive: true }, 'user', selection).handoff;
        const receiver = jobs.acceptJob(f.checker.id, { type: 'user' });
        cases.push({ ctx: { userId: f.userId, botId: f.checker.id, jobId: receiver.id, toolCallId: 'read' }, handoffId: handoff.id, expected: selection ?? ['included.txt', 'excluded.txt'] });
        await flush(f);
    }
    const snapshot = path.join(root, 'previous-schema.db');
    await db.backup(snapshot);
    const old = new Database(snapshot);
    try {
        old.exec(`CREATE TABLE handoff_file_selections(handoff_id TEXT PRIMARY KEY REFERENCES handoffs(id) ON DELETE CASCADE,part_ids TEXT NOT NULL);
            INSERT INTO handoff_file_selections SELECT handoff_id,part_ids FROM handoff_payloads WHERE part_ids IS NOT NULL;
            ALTER TABLE handoff_payloads DROP COLUMN part_ids;`);
    } finally { old.close(); }
    const script = `
        import assert from 'node:assert/strict';
        const {db}=await import('./server/src/handoffs/db.ts');
        const {readHandoff}=await import('./server/src/handoffs/handoff-service.ts');
        assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='handoff_file_selections'").get(),undefined);
        for(const entry of ${JSON.stringify(cases)}) {
            const result=readHandoff(entry.ctx,{handoffId:entry.handoffId});
            assert.deepEqual(result.output.parts.filter(p=>p.kind==='file').map(p=>p.filename).sort(),entry.expected.sort());
            assert.equal(db.prepare('SELECT include_sensitive FROM handoff_payloads WHERE handoff_id=?').get(entry.handoffId).include_sensitive,1);
        }
        db.close();`;
    for (let restart = 0; restart < 2; restart++) {
        const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { env: { ...process.env, DB_PATH: snapshot }, encoding: 'utf8' });
        assert.equal(child.status, 0, child.stderr || child.stdout);
    }
});
