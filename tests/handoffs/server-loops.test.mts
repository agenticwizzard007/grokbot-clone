import assert from 'node:assert/strict';
import { after,test } from 'node:test';
import { fixture,makeLoop,runLoop,loops,runner,db,flush,finish,reconcile,hdb,interrupted,cleanup } from './server-fixture.test.mts';
after(cleanup);
test('two Bot loop converges at pass three with durable outputs, suppressed replies and complete events',async()=>{
 const f=fixture(),l=makeLoop(f);const done=await runLoop(f,l.id);assert.equal(done.status,'succeeded');assert.equal(done.iteration,3);
 assert.equal(loops.resultText(done),'Done in 3 passes: all checks passed.');const steps=loops.loopSteps(f.userId,l.id);assert.equal(steps.length,6);assert.equal(done.bestOutputId,steps[4].outputId);
 assert.equal((db.prepare("SELECT count(*) n FROM coordination_requests WHERE user_id=? AND kind='result'").get(f.userId) as any).n,0);
 assert.ok((db.prepare('SELECT depth,reply,from_bot_id,to_bot_id FROM coordination_requests WHERE user_id=?').all(f.userId) as any[]).every(r=>r.depth===0&&r.reply===0&&r.from_bot_id===r.to_bot_id));
 const sequence=hdb.events(f.userId,{loopId:l.id}).map(e=>e.type);assert.equal(sequence.filter(t=>t==='loop.step_dispatched').length,6);assert.equal(sequence.filter(t=>t==='loop.step_completed').length,6);assert.equal(sequence.filter(t=>t==='loop.verdict').length,3);assert.equal(sequence.at(-1),'loop.finished');
 const before=(db.prepare('SELECT count(*) n FROM run_outputs WHERE user_id=?').get(f.userId) as any).n;for(let i=0;i<4;i++)reconcile.recoverHandoffs();assert.equal((db.prepare('SELECT count(*) n FROM run_outputs WHERE user_id=?').get(f.userId) as any).n,before);
});
test('capped loop selects the latest equally good output and extends only once',async()=>{
 const f=fixture(),l=makeLoop(f);const capped=await runLoop(f,l.id,'cap');assert.equal(capped.status,'capped');assert.equal(capped.stopReason,'max_iterations');assert.equal(capped.iteration,3);assert.match(loops.resultText(capped),/^Stopped after 3 passes \(limit\)/);
 assert.equal(loops.controlLoop(f.userId,l.id,'extend').spec.limits.maxIterations,5);assert.equal(loops.controlLoop(f.userId,l.id,'extend').spec.limits.maxIterations,5);assert.equal((await runLoop(f,l.id,'cap')).iteration,5);
});
test('identical maker output stalls at pass two',async()=>{const f=fixture(),l=makeLoop(f);const done=await runLoop(f,l.id,'stall');assert.equal(done.status,'stalled');assert.equal(done.iteration,2);});
test('missing verdict nudges once then stops without guessing prose',async()=>{const f=fixture(),l=makeLoop(f);const done=await runLoop(f,l.id,'no-verdict');assert.equal(done.stopReason,'no_verdict');assert.equal((db.prepare('SELECT count(*) n FROM handoff_loop_dispatches WHERE loop_id=?').get(l.id) as any).n,3);});
test('failed step retries once then fails',async()=>{const f=fixture(),l=makeLoop(f);assert.equal((await runLoop(f,l.id,'fail')).stopReason,'step_failed');assert.equal((db.prepare('SELECT count(*) n FROM handoff_loop_dispatches WHERE loop_id=?').get(l.id) as any).n,2);});
test('step timeout interrupts the exact job and prevents further dispatch',async()=>{const f=fixture(),l=makeLoop(f);await flush(f);const step=loops.loopSteps(f.userId,l.id)[0];db.prepare('UPDATE loop_steps SET started_at=? WHERE id=?').run(Date.now()-700000,step.id);runner.driveLoop(f.userId,l.id);assert.equal(loops.getLoop(f.userId,l.id).stopReason,'step_failed');assert.ok(interrupted.includes(step.jobId!));});
test('first, each, cap, decline and expired gate paths are durable',async()=>{
 const f=fixture(),l=makeLoop(f,{gate:{before:'each',onCap:'ask'}});assert.equal(l.status,'awaiting_approval');assert.equal(loops.loopSteps(f.userId,l.id).length,0);
 loops.controlLoop(f.userId,l.id,'approve');let state=await runLoop(f,l.id,'cap');assert.equal(state.status,'awaiting_approval');assert.equal(state.iteration,1);
 loops.controlLoop(f.userId,l.id,'approve');state=await runLoop(f,l.id,'cap');assert.equal(state.iteration,2);loops.controlLoop(f.userId,l.id,'approve');state=await runLoop(f,l.id,'cap');assert.equal(state.status,'awaiting_approval');assert.equal(state.iteration,3);
 loops.controlLoop(f.userId,l.id,'extend');assert.equal(loops.getLoop(f.userId,l.id).spec.limits.maxIterations,5);loops.controlLoop(f.userId,l.id,'stop');
 const decline=makeLoop(f,{gate:{before:'first',onCap:'stop'}});assert.equal(loops.controlLoop(f.userId,decline.id,'decline').stopReason,'declined');
 const expiry=makeLoop(f,{gate:{before:'first',onCap:'stop'}});db.prepare('UPDATE handoff_loop_controls SET gate_at=? WHERE loop_id=?').run(Date.now()-86400001,expiry.id);runner.driveLoop(f.userId,expiry.id);assert.equal(loops.getLoop(f.userId,expiry.id).stopReason,'gate_expired');
});
test('pause lets the current job finish but starts no next job until resume',async()=>{const f=fixture(),l=makeLoop(f);await flush(f);const step=loops.loopSteps(f.userId,l.id)[0];loops.controlLoop(f.userId,l.id,'pause');finish(f,step.jobId!,'Paused fixture draft.');assert.equal(loops.loopSteps(f.userId,l.id).length,1);loops.controlLoop(f.userId,l.id,'resume');assert.equal((await runLoop(f,l.id)).status,'succeeded');});
test('expired lease recovery dispatches once and live lease blocks another driver',async()=>{const f=fixture(),l=makeLoop(f,{},false);db.prepare("UPDATE loops SET status='running',started_at=?,claim_token='crashed',claim_until=? WHERE id=?").run(Date.now(),Date.now()+10000,l.id);runner.driveLoop(f.userId,l.id);assert.equal(loops.loopSteps(f.userId,l.id).length,0);db.prepare('UPDATE loops SET claim_until=0 WHERE id=?').run(l.id);reconcile.recoverHandoffs();reconcile.recoverHandoffs();await flush(f);assert.equal(loops.loopSteps(f.userId,l.id).length,1);assert.equal((await runLoop(f,l.id)).status,'succeeded');});
test('measured cost and token caps stop before a second step and wall clock is bounded',async()=>{
 for(const kind of ['maxCostUsd','maxTokens'] as const){const f=fixture(),l=makeLoop(f,{limits:{maxIterations:3,maxMinutes:30,stepTimeoutMinutes:10,[kind]:1}});await flush(f);const step=loops.loopSteps(f.userId,l.id)[0];db.prepare("INSERT INTO usage_events(user_id,bot_id,job_id,kind,provider,model,input_tokens,output_tokens,cost_usd,created_at) VALUES(?,?,?,'chat','fixture','fixture',2,2,2,?)").run(f.userId,f.maker.id,step.jobId,Date.now());finish(f,step.jobId!,'Budget fixture.');assert.equal(loops.getLoop(f.userId,l.id).stopReason,kind==='maxCostUsd'?'max_cost':'max_tokens');assert.equal(loops.loopSteps(f.userId,l.id).length,1);}
 const f=fixture(),l=makeLoop(f);db.prepare('UPDATE loops SET started_at=? WHERE id=?').run(Date.now()-31*60000,l.id);runner.driveLoop(f.userId,l.id);assert.equal(loops.getLoop(f.userId,l.id).stopReason,'max_minutes');
});
test('concurrency cap holds at gates',()=>{const f=fixture();for(let i=0;i<3;i++)makeLoop(f,{gate:{before:'first',onCap:'stop'}});assert.throws(()=>makeLoop(f),/Three loops/);});
