import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {pinnedImage} from './container-policy.js';
const exec=promisify(execFile);
type Execute=(file:string,args:string[],options:{timeout:number;maxBuffer:number})=>Promise<{stdout:string}>;
/** Docker can warn and ignore unavailable controls. Require actual kernel evidence
 * before renewing credentials or starting a tenant workload. No network or secrets
 * are attached to this short-lived canary. Failure is fatal to host readiness. */
export async function verifyHostContainment(image:string,execute:Execute=exec){
  pinnedImage(image);
  const limits={timeout:30000,maxBuffer:65536};
  const info=JSON.parse((await execute('docker',['info','--format','{{json .}}'],limits)).stdout);
  if(info.CgroupVersion!=='2'||['MemoryLimit','SwapLimit','PidsLimit','CPUCfsQuota'].some(k=>info[k]!==true)||!info.SecurityOptions?.some((s:string)=>s.includes('seccomp')))throw new Error('Required host isolation controls are unavailable.');
  const name=`swarm-preflight-${randomUUID()}`;
  const probe=`const fs=require('node:fs');const read=p=>fs.readFileSync(p,'utf8').trim();const status=read('/proc/self/status');const field=n=>status.match(new RegExp('^'+n+':\\\\s*(.+)$','m'))?.[1];console.log(JSON.stringify({uid:process.getuid(),capabilities:field('CapEff'),noNewPrivileges:field('NoNewPrivs'),seccomp:field('Seccomp'),memory:read('/sys/fs/cgroup/memory.max'),swap:read('/sys/fs/cgroup/memory.swap.max'),pids:read('/sys/fs/cgroup/pids.max'),cpu:read('/sys/fs/cgroup/cpu.max'),readOnly:(()=>{try{fs.writeFileSync('/etc/swarm-preflight','probe');return false;}catch(e){return e.code==='EROFS';}})()}));`;
  try{
    const result=JSON.parse((await execute('docker',['run','--rm','--pull=never','--name',name,'--network=none','--log-driver=none','--read-only','--user=10001:10001','--cap-drop=ALL','--security-opt=no-new-privileges:true','--memory=64m','--memory-swap=64m','--pids-limit=32','--cpus=0.1',image,'node','-e',probe],limits)).stdout);
    if(result.uid!==10001||!/^0+$/.test(result.capabilities??'')||result.noNewPrivileges!=='1'||result.seccomp!=='2'||result.memory!=='67108864'||result.swap!=='0'||result.pids!=='32'||result.cpu!=='10000 100000'||result.readOnly!==true)throw new Error('Kernel did not enforce the required workload boundary.');
  }finally{
    try{await execute('docker',['rm','-f',name],limits);}catch{
      if((await execute('docker',['container','ls','-aq','--filter',`name=^/${name}$`],limits)).stdout.trim())throw new Error('Host containment canary cleanup requires reconciliation.');
    }
  }
}
