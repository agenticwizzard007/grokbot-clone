import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {RuntimeRefreshStore} from '../server/src/runtime/refresh-state.js';
const token=()=>randomBytes(32).toString('base64url');
function fixture(t:any){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-refresh-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'refresh'),binding={tenant:'usr_runtime_owner',machine:'machine-a',volume:'volume-a',generation:'1'};
  return {root,file,binding,store:()=>new RuntimeRefreshStore(file,binding)};
}
test('lost exchange response preserves both secrets across process restart',t=>{
  const f=fixture(t),bootstrap=token(),first=f.store().prepare(bootstrap);
  assert.deepEqual(f.store().prepare(bootstrap),first);
  f.store().commit(first,first.pending);
  const renewal=f.store().prepare();assert.equal(renewal.current,first.pending);assert.notEqual(renewal.pending,first.pending);
  assert.deepEqual(f.store().prepare(),renewal);
});
test('recreated consumed Fly bootstrap cannot replace a valid refresh',t=>{
  const f=fixture(t),bootstrap=token(),first=f.store().prepare(bootstrap);f.store().commit(first,first.pending);
  const replay=f.store().prepare(bootstrap);assert.equal(replay.current,first.pending);
  f.store().commit(replay,replay.pending);assert.equal(f.store().prepare(bootstrap).current,replay.pending);
});
test('new bootstrap replaces revoked refresh including an unfinished exchange',t=>{
  const f=fixture(t),first=f.store().prepare(token()),replacement=token();
  const next=f.store().prepare(replacement);assert.equal(next.current,replacement);assert.notEqual(next.pending,first.pending);
  assert.throws(()=>f.store().commit(first,first.pending),/completion changed/);
  assert.deepEqual(f.store().prepare(replacement),next);
});
test('changed machine, volume, generation or tenant requires a fresh bootstrap',t=>{
  const f=fixture(t),bootstrap=token(),first=f.store().prepare(bootstrap);f.store().commit(first,first.pending);
  const original=fs.readFileSync(f.file);
  for(const delta of [{machine:'machine-b'},{volume:'volume-b'},{generation:'2'},{tenant:'usr_another_owner'}]){
    fs.writeFileSync(f.file,original);
    const store=new RuntimeRefreshStore(f.file,{...f.binding,...delta});
    assert.throws(()=>store.prepare(),/Fresh runtime bootstrap/);
    assert.throws(()=>store.prepare(bootstrap),/Fresh runtime bootstrap/);
    const replacement=token();assert.equal(store.prepare(replacement).current,replacement);
  }
});
test('unknown or stale successor cannot overwrite pending registration',t=>{
  const f=fixture(t),attempt=f.store().prepare(token());
  assert.throws(()=>f.store().commit(attempt,token()),/completion changed/);
  assert.deepEqual(f.store().prepare(),attempt);
  f.store().commit(attempt,attempt.pending);assert.throws(()=>f.store().commit(attempt,attempt.pending),/completion changed/);
});
test('credential state rejects exposed files, symlinks, hardlinks and oversized records',t=>{
  const f=fixture(t);f.store().prepare(token());
  fs.chmodSync(f.file,0o644);assert.throws(()=>f.store().prepare(),/Unsafe runtime credential/);fs.chmodSync(f.file,0o600);
  fs.linkSync(f.file,path.join(f.root,'hardlink'));assert.throws(()=>f.store().prepare(),/Unsafe runtime credential/);fs.unlinkSync(path.join(f.root,'hardlink'));
  fs.renameSync(f.file,path.join(f.root,'real'));fs.symlinkSync(path.join(f.root,'real'),f.file);assert.throws(()=>f.store().prepare());fs.unlinkSync(f.file);
  fs.writeFileSync(f.file,'x'.repeat(4097),{mode:0o600});assert.throws(()=>f.store().prepare(),/Unsafe runtime credential/);
});
