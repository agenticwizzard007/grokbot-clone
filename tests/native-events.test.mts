import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';

const storage=fs.mkdtempSync(path.join(os.tmpdir(),'swarm-native-events-'));
Object.assign(process.env,{DB_PATH:path.join(storage,'test.db'),FILES_DIR:path.join(storage,'files'),SESSION_SECRET:'native-event-isolated-tests',COMPUTER_PROVIDER:'local',COMPOSIO_API_KEY:'',INKBOX_TUNNEL:'0',SERVER_URL:'http://localhost:1',APP_URL:'http://localhost:1'});
const {db}=await import('../server/src/db.js');
const jobs=await import('../server/src/agent/jobs.js');
const events=await import('../server/src/native/events.js');
const fences=await import('../server/src/platform/legacy-database-fence.js');
after(()=>{db.close();fs.rmSync(storage,{recursive:true,force:true});});
let sequence=0;
function fixture(userId=`usr_event_test_${++sequence}`) {
 const botId='bot_event_'+(++sequence);db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(userId,userId+'@example.test',userId,Date.now());
 db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(botId,userId,botId,Date.now(),Date.now());
 const jobId=jobs.acceptJob(botId,{type:'system',text:'Event fixture'}).id;return {userId,botId,jobId};
}
function publish(f:ReturnType<typeof fixture>,revision=1) {return events.publishNativeEvent({...f,kind:'fixture.changed',sourceType:'bot',sourceId:f.botId,sourceRevision:revision,correlationId:'fixture-'+f.jobId,audience:'internal',data:{revision}});}
function receipt(f:ReturnType<typeof fixture>,revision=1,hash='a'.repeat(64)) {events.recordContextReceipt({...f,kind:'coordination',sourceId:'board',revision,hash});}

test('canonical mutation, outbox event and context receipts roll back together',()=>{
 const f=fixture(),before=(db.prepare('SELECT name FROM bots WHERE id=?').get(f.botId) as any).name;
 assert.throws(()=>db.transaction(()=>{db.prepare('UPDATE bots SET name=? WHERE id=?').run('Uncommitted state',f.botId);publish(f);receipt(f);throw new Error('Injected storage rollback');})(),/Injected/);
 assert.equal((db.prepare('SELECT name FROM bots WHERE id=?').get(f.botId) as any).name,before);assert.equal(events.latestNativeEventSeq(f.userId),0);assert.equal(events.listNativeEvents(f.userId).length,0);assert.equal((db.prepare('SELECT COUNT(*) n FROM native_context_receipts WHERE user_id=?').get(f.userId) as any).n,0);
 db.transaction(()=>{db.prepare('UPDATE bots SET name=? WHERE id=?').run('Committed state',f.botId);publish(f);receipt(f);})();assert.equal(events.listNativeEvents(f.userId).length,1);
});
test('global event sequence is monotonic while pagination remains account scoped',()=>{
 const f=fixture(),other=fixture(),first=publish(f),foreign=publish(other),second=publish(f,2);assert.ok(first<foreign&&foreign<second);
 const page=events.listNativeEvents(f.userId,0,1);assert.equal(page.length,1);assert.equal(page[0].seq,first);assert.equal(page[0].sourceRevision,'1');assert.equal(page[0].audience,'internal');assert.deepEqual(page[0].data,{revision:1});
 assert.deepEqual(events.listNativeEvents(f.userId,first,1).map(e=>e.seq),[second]);assert.deepEqual(events.listNativeEvents(f.userId,second),[]);assert.equal(events.latestNativeEventSeq(f.userId),second);assert.equal(events.latestNativeEventSeq(other.userId),foreign);
});
test('independent consumers use compare-and-swap and cannot skip future state or regress',()=>{
 const f=fixture(),first=publish(f),second=publish(f,2);
 assert.equal(events.readNativeCursor(f.userId,'coordination'),0);assert.equal(events.advanceNativeCursor(f.userId,'coordination',0,first),true);assert.equal(events.readNativeCursor(f.userId,'learning'),0);
 assert.equal(events.advanceNativeCursor(f.userId,'coordination',0,second),false);assert.equal(events.readNativeCursor(f.userId,'coordination'),first);
 assert.throws(()=>events.advanceNativeCursor(f.userId,'coordination',first,first-1),/Invalid/);assert.throws(()=>events.advanceNativeCursor(f.userId,'coordination',first,second+1),/Invalid/);
 assert.equal(events.advanceNativeCursor(f.userId,'learning',0,second),true);assert.equal(events.advanceNativeCursor(f.userId,'coordination',first,second),true);assert.equal(events.readNativeCursor(f.userId,'learning'),second);
});
test('consumer work and checkpoint are atomic and replay after fresh-process recovery',()=>{
 const f=fixture(),first=publish(f),second=publish(f,2);const originalName=(db.prepare('SELECT name FROM bots WHERE id=?').get(f.botId) as any).name;
 assert.throws(()=>db.transaction(()=>{db.prepare('UPDATE bots SET name=? WHERE id=?').run('Partial consumer effect',f.botId);assert.equal(events.advanceNativeCursor(f.userId,'replay',0,first),true);throw new Error('Consumer crash');})(),/crash/);
 assert.equal(events.readNativeCursor(f.userId,'replay'),0);assert.equal((db.prepare('SELECT name FROM bots WHERE id=?').get(f.botId) as any).name,originalName);
 const program=`const {db}=await import('./server/src/db.ts');await import('./server/src/agent/jobs.ts');const e=await import('./server/src/native/events.ts');const user=${JSON.stringify(f.userId)};const pending=e.listNativeEvents(user,e.readNativeCursor(user,'replay'));if(pending.length!==2)throw Error('Missing replay sources');db.transaction(()=>{db.prepare('UPDATE bots SET name=? WHERE id=?').run('Recovered consumer state',${JSON.stringify(f.botId)});if(!e.advanceNativeCursor(user,'replay',0,pending.at(-1).seq))throw Error('Lost checkpoint CAS');})();db.close();`;
 const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',program],{cwd:process.cwd(),env:process.env,encoding:'utf8'});assert.equal(child.status,0,child.stderr);assert.equal(events.readNativeCursor(f.userId,'replay'),second);assert.equal(events.listNativeEvents(f.userId,second).length,0);
});
test('producer and context receipt guards reject foreign owners and mismatched owned jobs',()=>{
 const f=fixture(),other=fixture(),secondBot='bot_event_sibling_'+(++sequence);db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(secondBot,f.userId,'Sibling',Date.now(),Date.now());
 const base={kind:'changed',sourceType:'bot',sourceId:f.botId};
 assert.throws(()=>events.publishNativeEvent({...base,userId:f.userId,botId:other.botId}),/Agent not found/);assert.throws(()=>events.publishNativeEvent({...base,userId:f.userId,jobId:other.jobId}),/Job not found/);assert.throws(()=>events.publishNativeEvent({...base,...f,botId:secondBot}),/Job not found/);
 assert.throws(()=>events.recordContextReceipt({...f,botId:secondBot,kind:'knowledge',sourceId:'private'}),/Job not found/);assert.throws(()=>events.recordContextReceipt({...f,userId:other.userId,kind:'knowledge',sourceId:'private'}),/Agent not found/);assert.throws(()=>events.listNativeEvents('usr_missing_account_1'),/Account not found/);
 assert.equal(events.listNativeEvents(f.userId).length,0);assert.equal(events.listNativeEvents(other.userId).length,0);assert.equal((db.prepare('SELECT COUNT(*) n FROM native_context_receipts WHERE job_id=?').get(f.jobId) as any).n,0);
});
test('context receipts preserve each loaded revision and exact repeats are idempotent',()=>{
 const f=fixture();receipt(f,1);receipt(f,1);receipt(f,2,'b'.repeat(64));const secondJob=jobs.acceptJob(f.botId,{type:'system',text:'Fresh task'}).id;receipt({...f,jobId:secondJob},2,'b'.repeat(64));
 const rows=db.prepare('SELECT job_id,revision,hash FROM native_context_receipts WHERE user_id=? ORDER BY created_at,revision').all(f.userId) as any[];assert.equal(rows.length,3);assert.equal(rows.filter(r=>r.job_id===f.jobId&&r.revision==='1').length,1);assert.deepEqual(rows.filter(r=>r.job_id===f.jobId).map(r=>r.revision),['1','2']);assert.ok(rows.every(r=>r.hash.length===64));
});
test('migration holds preserve events, cursors and receipts while writable owners recover',()=>{
 const held=fixture('usr_native_events_held_0001'),free=fixture(),heldSeq=publish(held),freeSeq=publish(free);receipt(held);events.advanceNativeCursor(held.userId,'recovery',0,heldSeq);const heldBefore=JSON.stringify({events:events.listNativeEvents(held.userId),receipts:db.prepare('SELECT * FROM native_context_receipts WHERE user_id=?').all(held.userId),cursor:events.readNativeCursor(held.userId,'recovery')});
 fences.holdLegacyDatabase(db,held.userId,'native-events-migration-test','1');assert.throws(()=>publish(held,2),/migrat/);assert.throws(()=>receipt(held,2),/migrat/);assert.throws(()=>events.advanceNativeCursor(held.userId,'recovery',heldSeq,heldSeq),/migrat/);
 const writable=fences.legacyWritableRows(db,'native_events');assert.ok((db.prepare(`SELECT DISTINCT user_id FROM native_events WHERE (${writable})`).all() as any[]).every(r=>r.user_id!==held.userId));
 const program=`const {db}=await import('./server/src/db.ts');await import('./server/src/agent/jobs.ts');const e=await import('./server/src/native/events.ts');const f=await import('./server/src/platform/legacy-database-fence.ts');f.assertLegacyDatabaseFences(db);if(!e.advanceNativeCursor(${JSON.stringify(free.userId)},'recovery',0,${freeSeq}))throw Error('Free owner failed recovery');e.recordContextReceipt(${JSON.stringify({...free,kind:'coordination',sourceId:'recovered',revision:2,hash:'c'.repeat(64)})});db.close();`;
 const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',program],{cwd:process.cwd(),env:process.env,encoding:'utf8'});assert.equal(child.status,0,child.stderr);assert.equal(events.readNativeCursor(free.userId,'recovery'),freeSeq);
 assert.equal(JSON.stringify({events:events.listNativeEvents(held.userId),receipts:db.prepare('SELECT * FROM native_context_receipts WHERE user_id=?').all(held.userId),cursor:events.readNativeCursor(held.userId,'recovery')}),heldBefore);fences.assertLegacyDatabaseFences(db);
});
