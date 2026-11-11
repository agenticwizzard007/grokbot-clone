import assert from 'node:assert/strict';
import {test} from 'node:test';
import vm from 'node:vm';
import {verifyHostContainment} from '../server/src/runtime/host-preflight.js';
const image='sha256:'+'1'.repeat(64);
function fixture(overrides:Record<string,unknown>={},memory='67108864'){
  const calls:string[][]=[];
  const execute=async(_file:string,args:string[])=>{
    calls.push(args);
    if(args[0]==='info')return {stdout:JSON.stringify({CgroupVersion:'2',MemoryLimit:true,SwapLimit:true,PidsLimit:true,CPUCfsQuota:true,SecurityOptions:['name=seccomp,profile=builtin'],...overrides})};
    if(args[0]==='run'){
      let stdout='';
      const reads:Record<string,string>={'/proc/self/status':'CapEff:\t0000000000000000\nNoNewPrivs:\t1\nSeccomp:\t2','/sys/fs/cgroup/memory.max':memory,'/sys/fs/cgroup/memory.swap.max':'0','/sys/fs/cgroup/pids.max':'32','/sys/fs/cgroup/cpu.max':'10000 100000'};
      vm.runInNewContext(args.at(-1)!,{require:()=>({readFileSync:(file:string)=>{assert.ok(file in reads);return reads[file];},writeFileSync:()=>{throw Object.assign(new Error('read only'),{code:'EROFS'});}}),console:{log:(s:string)=>{stdout=s;}},process:{getuid:()=>10001}});
      return {stdout};
    }
    return {stdout:''};
  };
  return {execute,calls};
}
test('host readiness requires kernel canary evidence before user workloads',async()=>{
  const f=fixture();await verifyHostContainment(image,f.execute);
  const run=f.calls.find(a=>a[0]==='run')!;
  for(const flag of ['--network=none','--read-only','--cap-drop=ALL','--user=10001:10001','--memory-swap=64m'])assert.ok(run.includes(flag));
  assert.equal(f.calls.at(-1)![0],'rm');
});
test('ignored resource flags or unavailable Docker controls fail readiness',async()=>{
  for(const field of ['MemoryLimit','SwapLimit','PidsLimit','CPUCfsQuota']){
    const f=fixture({[field]:false});await assert.rejects(verifyHostContainment(image,f.execute),/unavailable/);assert.equal(f.calls.length,1);
  }
  const f=fixture({},'max');await assert.rejects(verifyHostContainment(image,f.execute),/Kernel/);assert.equal(f.calls.at(-1)![0],'rm');
});
