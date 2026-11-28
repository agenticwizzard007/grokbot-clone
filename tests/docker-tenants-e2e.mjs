// Real Docker, local disposable tenants, preloaded stand-in image only.
// Build: docker build -f tests/fixtures/docker-tenant.Dockerfile -t mt-b-standin tests/fixtures
// Run: DOCKER_E2E_IMAGE=$(docker image inspect --format '{{.Id}}' mt-b-standin) node tests/docker-tenants-e2e.mjs
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {register} from 'tsx/esm/api';
register();
const {DockerTenants}=await import('../server/src/platform/docker-tenants.ts');
const {pinnedImage}=await import('../server/src/runtime/container-policy.ts');
const image=pinnedImage(process.env.DOCKER_E2E_IMAGE ?? '');
const driver=new DockerTenants(),run=randomBytes(8).toString('hex');
const info=await driver.request('GET','/info');
const missing=['MemoryLimit','SwapLimit','CpuCfsQuota','PidsLimit'].filter(key=>info[key]!==true);
if(!info.SecurityOptions?.includes('name=seccomp,profile=builtin'))missing.push('default seccomp');
if(missing.length) {
  console.log(JSON.stringify({result:'NOT RUN',reason:`Docker cannot enforce: ${missing.join(', ')}`,image}));
  process.exit(2);
}
const tenants=[`usr_docker_e2e_a_${run}`,`usr_docker_e2e_b_${run}`],created=[];
let assertions=0;
async function exec(id,command,expected=0) {
  const job=await driver.request('POST',`/containers/${id}/exec`,{Cmd:command,AttachStdout:false,AttachStderr:false,User:'0:0'});
  await driver.request('POST',`/exec/${job.Id}/start`,{Detach:true,Tty:false});
  for(let i=0;i<150;i++) {
    const result=await driver.request('GET',`/exec/${job.Id}/json`);
    if(!result.Running) {assert.equal(result.ExitCode,expected,`probe exit status: ${command[0]}`); assertions++;return;}
    await delay(100);
  }
  throw new Error('Docker isolation probe timed out.');
}
try {
  for(const tenant of tenants) {
    const {app}=await driver.ensureApp(tenant);created.push({tenant,app});
    const volume=await driver.ensureVolume(app,tenant,'local');
    const machine=await driver.ensureMachine(app,tenant,volume.id,image,'local','1',undefined,{cpu_kind:'shared',cpus:1,memory_mb:1024});
    await driver.configureBootstrap(app,machine.id,tenant,randomBytes(32).toString('base64url'),'1');
    await driver.action(app,machine.id,'start',tenant,'1');
    Object.assign(created.at(-1),{volume,machine});
    // Positive control: each server is reachable from its own network namespace.
    await exec(machine.id,['sh','-ec','for n in 1 2 3 4 5; do wget -q -T 1 -O /tmp/owner http://127.0.0.1:8080/owner && break; sleep 1; done; test "$(cat /tmp/owner)" = "$SWARM_TENANT_ID"']);
    await exec(machine.id,['sh','-ec','test -f /run/swarm-host/bootstrap; test ! -e /data/swarm-bootstrap; test "$FLY_MACHINE_ID" = ""; test -f /data/swarm-machine-id']);
    // Exec does not inherit wrapper exports; the main process gets the identity.
    await exec(machine.id,['sh','-ec',String.raw`tr "\000" "\n" < /proc/1/environ | grep -q "^FLY_MACHINE_ID="`]);
    await exec(machine.id,['sh','-ec','grep -q "^Seccomp:[[:space:]]*2$" /proc/self/status; grep -q "^NoNewPrivs:[[:space:]]*1$" /proc/self/status; grep -q "^CapEff:[[:space:]]*0000000000000000$" /proc/self/status; test ! -S /var/run/docker.sock; test ! -S /run/docker.sock; ! touch /root-write-probe']);
  }
  const [a,b]=created;
  for(const [source,target] of [[a,b],[b,a]]) {
    const raw=await driver.request('GET',`/containers/${target.machine.id}/json`);
    const ip=raw.NetworkSettings.Networks[driver.network(target.tenant)].IPAddress;
    assert.match(ip,/^\d+\.\d+\.\d+\.\d+$/);
    // The positive controls above ensure denial is not merely an absent server.
    await exec(source.machine.id,['wget','-q','-T','2','-O','/tmp/foreign',`http://${ip}:8080/owner`],1);
    await exec(source.machine.id,['sh','-ec','test -f "/data/$SWARM_TENANT_ID"; test ! -e "$1"; test "$(cat /data/www/owner)" = "$SWARM_TENANT_ID"','probe',`/data/${target.tenant}`]);
    const own=await driver.request('GET',`/containers/${source.machine.id}/json`);
    assert.deepEqual(own.Mounts.filter(m=>m.Type==='volume').map(m=>m.Name),[source.volume.id]);assertions++;
    assert.equal(Object.values(own.NetworkSettings.Ports ?? {}).some(v=>v?.length),false);assertions++;
  }
  await driver.action(a.app,a.machine.id,'suspend',a.tenant,'1');
  assert.equal((await driver.waitStopped(a.app,a.tenant,a.machine.id,'1')).state,'stopped');assertions++;
  await driver.configureBootstrap(a.app,a.machine.id,a.tenant,randomBytes(32).toString('base64url'),'1');
  await driver.action(a.app,a.machine.id,'start',a.tenant,'1');
  await exec(a.machine.id,['sh','-ec','test -f "/data/$SWARM_TENANT_ID"; test -f /run/swarm-host/bootstrap']);
  console.log(JSON.stringify({result:'PASS',assertions,image,boundary:'local Docker stand-in only; no Fly or production qualification'}));
} finally {
  // Preserve the original failure as well as any resources needing reconciliation.
  const cleanup=await Promise.allSettled(created.reverse().map(({tenant,app})=>driver.destroy(app,tenant)));
  for(const result of cleanup)if(result.status==='rejected'){console.error('Docker e2e cleanup requires reconciliation:',result.reason);process.exitCode=1;}
}
