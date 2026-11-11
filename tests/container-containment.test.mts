import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { containerArguments } from '../server/src/runtime/container-policy.js';
import { McpFolderLease } from '../server/src/runtime/mcp-folders.js';
const exec=promisify(execFile);
const enabled=process.env.RUN_CONTAINER_TESTS==='1';
test('real workload containers enforce credentials, mounts, process, seccomp and resource boundaries',{skip:!enabled},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'swarm-container-'));
  const network=`swarm-check-${randomUUID().slice(0,8)}`,names:string[]=[];
  const docker=(args:string[])=>exec('docker',args,{timeout:30000,maxBuffer:1024*1024});
  try{
    // The test caller must supply an already-pulled immutable image. No test pulls execute in CI by default.
    const image=process.env.CONTAINMENT_TEST_IMAGE!;assert.match(image,/^sha256:[a-f0-9]{64}$/);
    fs.chmodSync(root,0o755);
    for(const p of ['claude','codex']){const home=path.join(root,'subscriptions',p);fs.mkdirSync(home,{recursive:true});fs.chownSync(home,10001,10001);fs.chmodSync(home,0o700);fs.writeFileSync(path.join(home,'credential'),`${p}-private`,{mode:0o644});}
    fs.mkdirSync(path.join(root,'app'));fs.writeFileSync(path.join(root,'app/database'),'private database');
    await docker(['network','create','--internal',network]);
    const policy={tenantId:'usr_containment',root,runnerImage:image,mcpImage:image,network};
    async function run(workload:any,script:string){
      const name=`swarm-${randomUUID()}`;names.push(name);const args=containerArguments(policy,workload,name);
      args.splice(args.indexOf(image)+1,3,'/bin/sh','-ec',script);return (await docker(args)).stdout.trim();
    }
    await t.test('MCP gets no subscription credentials, database, Docker socket or host process',async()=>{
      const out=await run({kind:'mcp',id:'mcp_containment'},`test ! -e /home/runner/credential; test ! -e ${root}; test ! -e /data; test ! -e /var/run/docker.sock; test ! -e /run/docker.sock; test ! -e /proc/${process.pid}/cmdline; echo isolated`);
      assert.equal(out,'isolated');
    });
    await t.test('each subscription container mounts only its provider home',async()=>{
      for(const provider of ['claude','codex'])assert.equal(await run({kind:'cli',provider},'cat /home/runner/credential; test ! -e /subscriptions; test ! -e /data/app'),`${provider}-private`);
    });
    await t.test('selected MCP folder is read-only and cannot expose adjacent storage or followed symlinks',async()=>{
      assert.equal(process.getuid!(),0,'Run host mount qualification as root on the disposable qualified host.');
      const folder=path.join(root,'files/bot/documents');fs.mkdirSync(folder,{recursive:true,mode:0o755});
      fs.writeFileSync(path.join(folder,'chosen'),'selected-content',{mode:0o644});
      fs.symlinkSync(path.join(root,'subscriptions/claude'),path.join(folder,'escape'));
      const name=`swarm-${randomUUID()}`;names.push(name);
      const lease=new McpFolderLease(path.join(root,'files'),['bot/documents'],name);
      try{
        await lease.prepare();
        const args=containerArguments(policy,{kind:'mcp',id:'mcp_containment',folderCount:1},name);
        args.splice(args.indexOf(image)+1,3,'/bin/sh','-ec',`test "$(cat /workspace/folders/1/chosen)" = selected-content; ! touch /workspace/folders/1/write 2>/dev/null; test ! -e /workspace/folders/1/escape/credential; test ! -e /data; test ! -e /subscriptions; echo selected-only`);
        assert.equal((await docker(args)).stdout.trim(),'selected-only');
      }finally{
        await docker(['rm','-f',name]).catch(()=>{});
        assert.equal((await docker(['container','ls','-aq','--filter',`name=^/${name}$`])).stdout.trim(),'','Do not unmount a folder before proving container removal.');
        await lease.close();
      }
    });
    await t.test('nonroot, read-only root, capabilities, no-new-privileges and seccomp are effective',async()=>{
      const out=await run({kind:'mcp',id:'mcp_containment'},`test "$(id -u)" = 10001; ! touch /etc/escape 2>/dev/null; touch /workspace/allowed; grep '^CapEff:' /proc/self/status; grep '^NoNewPrivs:' /proc/self/status; grep '^Seccomp:' /proc/self/status; ! mount -t tmpfs none /mnt 2>/dev/null`);
      assert.match(out,/CapEff:\s+0+/);assert.match(out,/NoNewPrivs:\s+1/);assert.match(out,/Seccomp:\s+2/);
    });
    await t.test('kernel cgroups enforce process, memory and CPU ceilings',async()=>{
      const out=await run({kind:'mcp',id:'mcp_containment'},'cat /sys/fs/cgroup/pids.max /sys/fs/cgroup/memory.max /sys/fs/cgroup/cpu.max');
      assert.equal(out,'128\n805306368\n100000 100000');
    });
  }finally{
    for(const n of names)await docker(['rm','-f',n]).catch(()=>{});
    await docker(['network','rm',network]).catch(()=>{});fs.rmSync(root,{recursive:true,force:true});
  }
});
