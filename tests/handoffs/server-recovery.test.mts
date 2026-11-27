import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { fixture, makeLoop, db, loops, runLoop, cleanup } from './server-fixture.test.mts';
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
