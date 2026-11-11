// Trusted microVM host entrypoint, never imported by an application role.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startSupervisor } from './supervisor.js';
import { pinnedImage } from './container-policy.js';
import { HostBackups, hostBackupTransport } from './backups.js';
import { verifyHostContainment } from './host-preflight.js';
import { HostActivation } from './host-activation.js';
import { RuntimeRefreshStore } from './refresh-state.js';
import {HostInstaller,hostInstallTransport} from './install-environment.js';
import {HostCheckpoint,hostCheckpointTransport} from './checkpoints.js';
import path from 'node:path';
import Database from 'better-sqlite3';
import {setTimeout as delay} from 'node:timers/promises';
const exec=promisify(execFile);
const tenant=process.env.SWARM_TENANT_ID!,machine=process.env.FLY_MACHINE_ID!,volume=process.env.SWARM_VOLUME_ID!,generation=process.env.SWARM_RUNTIME_GENERATION!;
if(!/^usr_[A-Za-z0-9_-]{8,100}$/.test(tenant)||!machine||!volume||!generation)throw new Error('Missing immutable machine identity.');
const release=JSON.parse(await fs.readFile('/opt/swarm/release.json','utf8'));
for(const key of ['appImage','runnerImage','mcpImage','desktopImage']){
  pinnedImage(release[key]);
  const localId=release.imageIds?.[key];
  if(typeof localId!=='string'||!/^sha256:[a-f0-9]{64}$/.test(localId))throw new Error('Release image config digest missing.');
  const info=JSON.parse((await exec('docker',['image','inspect',localId])).stdout)[0];
  if(info.Id!==localId)throw new Error('Loaded runtime image does not match signed release.');
  // docker save/load does not retain registry RepoDigests. The signed host release
  // binds each verified registry digest to its immutable local image config digest.
  release[key]=localId;
}
await verifyHostContainment(release.mcpImage);
const stale=(await exec('docker',['ps','-aq','--filter',`label=swarm.tenant=${tenant}`])).stdout.trim().split(/\s+/).filter(Boolean);
for(const id of stale)await exec('docker',['rm','-f',id]);
const persistentManifest='/data/tenant-manifest.json';
let previous;try{previous=JSON.parse(await fs.readFile(persistentManifest,'utf8'));}catch(e:any){if(e.code!=='ENOENT')throw e;}
if(previous&&(previous.tenantId!==tenant||previous.volumeId!==volume))throw new Error('Attached volume has a different owner.');
await fs.writeFile(persistentManifest,JSON.stringify({tenantId:tenant,volumeId:volume}),{mode:0o400});
await fs.copyFile(persistentManifest,'/run/swarm/tenant-manifest.json');
await fs.writeFile('/run/swarm/platform-public.pem',release.platformPublicKey,{mode:0o444});
await fs.writeFile('/run/swarm/session-secret',randomBytes(32).toString('base64url'),{mode:0o400});
const atomic=async(path:string,value:string,uid=10001)=>{await fs.writeFile(`${path}.new`,value,{mode:0o400});await fs.chown(`${path}.new`,uid,uid);await fs.rename(`${path}.new`,path);};
const refreshStore=new RuntimeRefreshStore('/data/runtime-refresh',{tenant,machine,volume,generation});
async function renew(){
  let bootstrap:string|undefined;
  try{bootstrap=(await fs.readFile('/run/swarm-host/bootstrap','utf8')).trim();}catch(error:any){if(error.code!=='ENOENT')throw error;}
  const attempt=refreshStore.prepare(bootstrap);
  const endpoint=new URL('/internal/runtime/exchange',process.env.PLATFORM_URL!);if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password)throw new Error('Runtime identity exchange must use TLS.');
  const response=await fetch(endpoint,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify({tenant,machine,credential:attempt.current,nextRefresh:attempt.pending}),signal:AbortSignal.timeout(15_000)});
  if(!response.ok){await response.body?.cancel();throw new Error('Runtime registration was refused.');}
  const reader=response.body?.getReader();if(!reader)throw new Error('Runtime registration response missing.');
  const chunks:Uint8Array[]=[];let bytes=0;
  try{for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.length;if(bytes>65536)throw new Error('Runtime registration response too large.');chunks.push(next.value);}}finally{await reader.cancel();}
  const value=JSON.parse(Buffer.concat(chunks).toString());
  if(value.tenant?.id!==tenant||value.tenant?.volume_id!==volume||String(value.tenant.generation)!==generation||typeof value.dataKey!=='string'||Buffer.from(value.dataKey,'base64').length!==32)throw new Error('Runtime registration identity mismatch.');
  if(typeof value.token!=='string'||typeof value.hostToken!=='string')throw new Error('Host authorization missing.');
  refreshStore.commit(attempt,value.refresh);await atomic('/run/swarm/runtime-token',value.token);
  await atomic('/run/swarm-host/host-token',value.hostToken,0);
  await atomic('/run/swarm/data-key',value.dataKey);await atomic('/run/swarm/profile.json',JSON.stringify(value.tenant));
  await fs.rm('/run/swarm-host/bootstrap',{force:true});
}
await renew();
let renewing=false,stopping=false;
let workloadsStarted=false;
const activation=new HostActivation(process.env.PLATFORM_URL!,'/run/swarm-host/host-token',{tenant,generation,machine});
const installer=new HostInstaller('/data',{tenant,generation,machine,volume},()=>requireBackupKey(),hostInstallTransport(process.env.PLATFORM_URL!,'/run/swarm-host/host-token'));
let supervisor:Awaited<ReturnType<typeof startSupervisor>>|undefined;
async function failClosed(){
  if(stopping)return;stopping=true;
  const deadline=setTimeout(()=>process.exit(1),30000).unref();
  // Exit the microVM host on renewal loss. Leaving an interval alive after only
  // stopping the app would strand the environment and leave runners active.
  try{
    await supervisor?.close();
    await exec('docker',['stop','--time=10','swarm-app','swarm-desktop'],{timeout:15000});
  }finally{clearTimeout(deadline);process.exit(1);}
}
setInterval(()=>{if(renewing)return;renewing=true;void renew().then(async()=>{
  if(!workloadsStarted)return;
  const policy=await activation.policy();
  if(policy.desired!=='run')throw new Error('Tenant workload authorization revoked.');
  await activation.report(policy,'running');
}).catch(async()=>{
  await failClosed();
}).finally(()=>{renewing=false;});},180_000);
// A migration/recovery VM can authenticate and wait without creating an empty
// application database or starting imported routines before source quiescence.
for(;;){
  const policy=await activation.policy();
  if(policy.desired==='run')break;
  if(policy.revision!=='0')await activation.report(policy,'held');
  try{
    await installer.tick();
    const checkpoints=new HostCheckpoint(installer.activeRoot(),'/data/host-checkpoints',{tenant,generation,machine,volume},()=>requireBackupKey(),hostCheckpointTransport(process.env.PLATFORM_URL!,'/run/swarm-host/host-token'),async plan=>{
      const current=await activation.policy();
      if(current.desired!=='hold'||current.revision!==plan.revision)throw new Error('Checkpoint hold changed.');
      // This path runs only on a held boot before supervisor/application startup.
      // Verify actual absence, not just a successful stop request or stale report.
      if((await exec('docker',['ps','-q'])).stdout.trim())throw new Error('Checkpoint workloads are not stopped.');
      await activation.report(current,'held');
    });
    await checkpoints.tick();
  }catch{
    try{if(policy.revision!=='0')await activation.report(policy,'held','host_requires_reconciliation');}finally{await failClosed();}
  }
  await delay(5000);
}
const environmentRoot=installer.activeRoot();
async function restoredOwnership(directory:string){
  const info=await fs.lstat(directory);if(info.isSymbolicLink()||!info.isFile()&&!info.isDirectory())throw new Error('Unsafe restored workload file.');
  await fs.chown(directory,10001,10001);
  if(info.isDirectory())for(const entry of await fs.readdir(directory))await restoredOwnership(path.join(directory,entry));
}
for(const name of ['app','files','desktop','subscriptions']){
  const dir=path.join(environmentRoot,name);await fs.mkdir(dir,{recursive:true,mode:0o700});if(await fs.realpath(dir)!==dir)throw new Error('Unsafe tenant mount.');
  if(environmentRoot!=='/data')await restoredOwnership(dir);else await fs.chown(dir,10001,10001);
}
await atomic('/run/swarm/desktop-token',randomBytes(32).toString('base64url'));
await fs.chown('/run/swarm',0,10001);await fs.chmod('/run/swarm',0o750);
const supervisorPolicy={tenantId:tenant,root:environmentRoot,runnerImage:release.runnerImage,mcpImage:release.mcpImage,network:'swarm-public'};
supervisor=await startSupervisor(supervisorPolicy,'/run/swarm/runner.sock',()=>{void failClosed();});
const basic=['run','--detach','--pull=never',`--label=swarm.tenant=${tenant}`,'--read-only','--user=10001:10001','--cap-drop=ALL','--security-opt=no-new-privileges:true','--pids-limit=512','--memory-swap=1536m','--memory=1536m','--cpus=2','--log-driver=none','--tmpfs=/tmp:rw,nosuid,nodev,size=256m,mode=1777'];
const appEnv={NODE_ENV:'production',SWARM_ROLE:'tenant',SWARM_TENANT_ID:tenant,SWARM_VOLUME_ID:volume,SWARM_RUNTIME_GENERATION:generation,
  PLATFORM_URL:process.env.PLATFORM_URL!,APP_URL:process.env.PLATFORM_URL!,SERVER_URL:process.env.PLATFORM_URL!,COMPOSIO_GATEWAY_URL:process.env.COMPOSIO_GATEWAY_URL!,
  COMPUTER_PROVIDER:'local',DB_PATH:'/data/swarm.db',FILES_DIR:'/files',PORT:'8787',TENANT_DATA_KEY_FILE:'/run/swarm/data-key',TENANT_MANIFEST_FILE:'/run/swarm/tenant-manifest.json',
  RUNTIME_TOKEN_FILE:'/run/swarm/runtime-token',PLATFORM_PUBLIC_KEY_FILE:'/run/swarm/platform-public.pem',SWARM_RUNNER_SOCKET:'/run/swarm/runner.sock',
  SESSION_SECRET:(await fs.readFile('/run/swarm/session-secret','utf8')).trim()};
await fs.writeFile('/run/swarm-host/app.env',Object.entries(appEnv).map(([k,v])=>{if(/[\r\n]/.test(v))throw new Error('Invalid environment.');return `${k}=${v}`;}).join('\n'),{mode:0o600});
await exec('docker',[...basic,'--name=swarm-app','--network=swarm-app','--ip=172.30.0.2','--env-file=/run/swarm-host/app.env',
  `--mount=type=bind,src=${environmentRoot}/app,dst=/data`,`--mount=type=bind,src=${environmentRoot}/files,dst=/files`,'--mount=type=bind,src=/run/swarm,dst=/run/swarm,readonly',release.appImage]);
await exec('docker',[...basic,'--name=swarm-desktop','--network=swarm-desktop','--ip=172.31.0.2','--tmpfs=/dev/shm:rw,nosuid,nodev,size=256m',
  '--security-opt=seccomp=/opt/swarm/chromium-seccomp.json',
  `--mount=type=bind,src=${environmentRoot}/desktop,dst=/home/agent`,'--mount=type=bind,src=/run/swarm/desktop-token,dst=/run/desktop-token,readonly',
  release.desktopImage,'node','/opt/swarm/companion.mjs','--server','http://172.30.0.2:8787','--token-file','/run/desktop-token','--multi','--agent-home','/home/agent','--data-dir','/home/agent/.swarm']);
async function confirmApplicationReady(){
  let ready=false;
  for(let attempt=0;attempt<30;attempt++){
    try{const response=await fetch('http://172.30.0.2:8787/api/health',{redirect:'error',signal:AbortSignal.timeout(2000)});ready=response.ok;await response.body?.cancel();}catch{/* Startup is bounded below. */}
    if(ready)break;await delay(1000);
  }
  if(!ready)throw new Error('Tenant application readiness failed.');
  const database=new Database(path.join(environmentRoot,'app/swarm.db'),{readonly:true,fileMustExist:true});
  try{if((database.prepare('SELECT tenant_id FROM tenant_identity WHERE singleton=1').get() as any)?.tenant_id!==tenant)throw new Error('Tenant database owner mismatch.');}finally{database.close();}
  const policy=await activation.policy();if(policy.desired!=='run')throw new Error('Workload authorization changed during startup.');
  await activation.report(policy,'running');workloadsStarted=true;
}
try{await confirmApplicationReady();}catch{await failClosed();}
let checkingActivation=false;
setInterval(()=>{
  if(stopping||checkingActivation)return;checkingActivation=true;
  void activation.policy().then(policy=>{if(policy.desired!=='run')throw new Error('Workload authorization revoked.');}).catch(()=>failClosed()).finally(()=>{checkingActivation=false;});
},5000);
const backups=new HostBackups(environmentRoot,tenant,()=>requireBackupKey(),hostBackupTransport('/run/swarm-host/host-token',process.env.PLATFORM_URL!),async()=>{
  if(stopping)throw new Error('Host is stopping.');
  try{
    workloadsStarted=false;await activation.report(await activation.policy(),'held');
    await supervisor!.close();
    await exec('docker',['stop','--time=10','swarm-app','swarm-desktop'],{timeout:30000});
    const state=JSON.parse((await exec('docker',['inspect','swarm-app','swarm-desktop'])).stdout);
    if(state.some((c:any)=>c.State.Running))throw new Error('Backup quiescence could not be verified.');
  }catch(error){await failClosed();throw error;}
  return async()=>{
    if(stopping)throw new Error('Host is stopping.');
    supervisor=await startSupervisor(supervisorPolicy,'/run/swarm/runner.sock',()=>{void failClosed();});
    await exec('docker',['start','swarm-app','swarm-desktop']).then(()=>confirmApplicationReady()).catch(async()=>{await failClosed();});
  };
});
function requireBackupKey(){const key=Buffer.from(requireHostFile('/run/swarm/data-key'),'base64');if(key.length!==32)throw new Error('Invalid backup key.');return key;}
function requireHostFile(file:string){return fsSync.readFileSync(file,'utf8').trim();}
setInterval(()=>{if(!stopping)void backups.tick();},60000);
