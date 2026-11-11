import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {prepareEventInbox,deliverRuntimeEvents} from '../server/src/runtime/event-inbox.js';

test('encrypted event inbox survives lost acknowledgements and retries only transient authorization',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'swarm-events-')),file=path.join(root,'private.db');
  let db=new Database(file);prepareEventInbox(db);db.exec('CREATE TABLE accepted(id TEXT PRIMARY KEY,body TEXT)');
  t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
  let unavailable=true,authorizations=0,applied=0;
  const events=[{id:'provider-down',ciphertext:'ciphertext-a'},{id:'valid',ciphertext:'ciphertext-b'},{id:'revoked',ciphertext:'ciphertext-c'},{id:'broken',ciphertext:'ciphertext-d'}];
  const delivery={
    open:(event:any)=>({id:event.id}),
    async authorize(payload:any){authorizations++;if(payload.id==='provider-down'&&unavailable)throw Object.assign(new Error('unavailable'),{retryable:true});if(payload.id==='revoked')throw new Error('revoked');},
    apply(payload:any){applied++;db.prepare('INSERT INTO accepted VALUES(?,?)').run(payload.id,'private body');if(payload.id==='broken')throw new Error('transaction failed');},
    retryable:(error:any)=>!!error.retryable,
  };
  assert.deepEqual(await deliverRuntimeEvents(db,events,delivery),['valid','revoked','broken']);
  assert.deepEqual(db.prepare('SELECT id FROM accepted').all(),[{id:'valid'}]);
  assert.deepEqual(db.prepare('SELECT ciphertext FROM runtime_event_failures ORDER BY id').all(),[{ciphertext:'ciphertext-d'},{ciphertext:'ciphertext-c'}]);
  // Simulate termination after committing work but before the platform sees ack.
  db.close();db=new Database(file);prepareEventInbox(db);unavailable=false;
  const before=applied,authBefore=authorizations;
  assert.deepEqual(await deliverRuntimeEvents(db,events,delivery),events.map(e=>e.id));
  assert.equal(applied,before+1);assert.equal(authorizations,authBefore+1);
  assert.deepEqual(db.prepare('SELECT id FROM accepted ORDER BY id').all(),[{id:'provider-down'},{id:'valid'}]);
  await assert.rejects(deliverRuntimeEvents(db,Array(21).fill(events[0]),delivery));
  await assert.rejects(deliverRuntimeEvents(db,[{id:'too-large',ciphertext:'x'.repeat(1048577)}],delivery));
});
