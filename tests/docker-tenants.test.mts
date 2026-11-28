import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DockerTenants} from '../server/src/platform/docker-tenants.js';
import {FlyTenants} from '../server/src/platform/fly-tenants.js';
import {fakeDocker,image,foreignImage} from './fixtures/docker-engine.mts';

const a='usr_docker_tenant_a',b='usr_docker_tenant_b',region='local';
const effects=(engine:any)=>engine.calls.filter((c:any)=>c.method!=='GET');
async function fixture(t:any) {const engine=await fakeDocker();t.after(()=>engine.close());return {engine,driver:new DockerTenants(engine.host)};}
async function create(driver:DockerTenants,tenant=a) {
  const {app}=await driver.ensureApp(tenant),volume=await driver.ensureVolume(app,tenant,region);
  const machine=await driver.ensureMachine(app,tenant,volume.id,image,region,'1');return {app,volume,machine};
}

test('Docker shares deterministic tenant namespaces with Fly and only accepts Unix sockets',()=>{
  const driver=new DockerTenants(),fly=new FlyTenants('fixture','fixture');
  for(const tenant of [a,b])for(const method of ['name','network','volumeName'] as const)assert.equal(driver[method](tenant),fly[method](tenant));
  assert.equal(driver.deploymentVolumeName(a,'1'.repeat(32)),fly.deploymentVolumeName(a,'1'.repeat(32)));
  assert.throws(()=>driver.name('../foreign'));assert.throws(()=>driver.deploymentVolumeName(a,'../bad'));
  for(const host of ['tcp://localhost:2375','https://docker.example','unix://relative','unix:///tmp/../docker.sock'])assert.throws(()=>new DockerTenants(host));
});

test('create applies resource limits, private network, no published ports and a read-only root',async t=>{
  const {engine,driver}=await fixture(t),{app,volume,machine}=await create(driver);
  const container=engine.containers.get(machine.id),network=engine.networks.get(driver.network(a));
  assert.equal(volume.encrypted,false);assert.equal(volume.quota_enforced,false);
  assert.equal(network.Internal,true);assert.equal(network.EnableIPv6,false);assert.equal(network.Options['com.docker.network.bridge.enable_icc'],'false');
  assert.equal(container.Config.Labels['swarm.tenant'],app);assert.equal(JSON.stringify(container.Config.Labels).includes(a),false);
  assert.equal(container.HostConfig.Memory,4096*1024*1024);assert.equal(container.HostConfig.MemorySwap,container.HostConfig.Memory);assert.equal(container.HostConfig.NanoCpus,2e9);
  assert.equal(container.HostConfig.PidsLimit,512);assert.equal(container.HostConfig.ReadonlyRootfs,true);assert.equal(container.HostConfig.Privileged,false);
  assert.deepEqual(container.HostConfig.CapDrop,['ALL']);assert.deepEqual(container.HostConfig.SecurityOpt,['no-new-privileges:true']);
  assert.deepEqual(container.HostConfig.PortBindings,{});assert.equal(container.HostConfig.PublishAllPorts,false);assert.equal(container.Mounts.length,1);
  assert.deepEqual(container.Mounts[0],{Type:'volume',Name:volume.id,Destination:'/data',RW:true});
  assert.equal(container.Config.Image,image);assert.equal(engine.calls.some(c=>c.route.includes('/images/create')),false);
});

test('idempotent create reconciles an observed container without repeating creation intents',async t=>{
  const {engine,driver}=await fixture(t),first=await create(driver),count=effects(engine).length;
  const forbid=async()=>{throw new Error('duplicate intent');};
  await driver.ensureApp(a,forbid);await driver.ensureVolume(first.app,a,region,forbid);
  assert.equal((await driver.ensureMachine(first.app,a,first.volume.id,image,region,'1',forbid)).id,first.machine.id);
  assert.equal(effects(engine).length,count);
});

test('opt-in metering reaches Docker hosts without exposing provisioner credentials',async t=>{
  const previous=process.env.TENANT_METERING;
  t.after(()=>{if(previous===undefined)delete process.env.TENANT_METERING;else process.env.TENANT_METERING=previous;});
  const {engine,driver}=await fixture(t);
  process.env.TENANT_METERING='0';
  const first=await create(driver,a);
  assert.equal(engine.containers.get(first.machine.id).Config.Env.some((v:string)=>v.startsWith('TENANT_METERING=')),false);
  process.env.TENANT_METERING='1';
  const second=await create(driver,b),env=engine.containers.get(second.machine.id).Config.Env;
  assert.ok(env.includes('TENANT_METERING=1'));
  assert.equal(env.some((v:string)=>/^(DATABASE_URL|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|FLY_API_TOKEN|DOCKER_HOST)=/.test(v)),false);
  assert.equal((await driver.machine(second.app,b,second.machine.id)).id,second.machine.id);
});

test('lost create response is recovered by inspection and API errors redact engine bodies',async t=>{
  const {engine,driver}=await fixture(t),{app}=await driver.ensureApp(a),volume=await driver.ensureVolume(app,a,region);
  engine.failAfter=(_m,r)=>r==='/containers/create';
  await assert.rejects(driver.ensureMachine(app,a,volume.id,image,region,'1'),{message:'Docker request failed (500).'});
  engine.failAfter=undefined;
  const machine=await driver.ensureMachine(app,a,volume.id,image,region,'1',async()=>{throw new Error('duplicate create');});
  assert.equal(machine.id,[...engine.containers.keys()][0]);assert.equal(engine.calls.filter(c=>c.route==='/containers/create').length,1);
});

test('wake, suspend and fresh bootstrap keep the same container and volume',async t=>{
  const {engine,driver}=await fixture(t),{app,machine}=await create(driver);
  await driver.configureBootstrap(app,machine.id,a,'x'.repeat(43),'1');
  const archive=engine.containers.get(machine.id).bootstrapArchive as Buffer;
  assert.equal(archive.subarray(0,100).toString().replaceAll('\0',''),'swarm-bootstrap');
  assert.equal(archive.subarray(100,108).toString(),'0000600\0');assert.equal(archive.subarray(512,555).toString(),'x'.repeat(43));
  await driver.action(app,machine.id,'start',a,'1');
  await assert.rejects(driver.configureBootstrap(app,machine.id,a,'y'.repeat(43),'1'),/stopped/);
  await driver.action(app,machine.id,'start',a,'1');
  assert.equal(engine.calls.filter(c=>c.route.endsWith('/start')).length,1);
  await driver.action(app,machine.id,'suspend',a,'1');assert.equal((await driver.waitStopped(app,a,machine.id,'1')).state,'stopped');
  await driver.configureBootstrap(app,machine.id,a,'y'.repeat(43),'1');await driver.action(app,machine.id,'start',a,'1');
  assert.equal((await driver.machine(app,a,machine.id)).state,'started');assert.equal(engine.containers.size,1);assert.equal(engine.volumes.size,1);
  assert.equal(engine.calls.some(c=>/pause/.test(c.route)),false);
});

test('delete removes only A and is idempotent while B stays intact',async t=>{
  const {engine,driver}=await fixture(t),aa=await create(driver),bb=await create(driver,b);
  await driver.action(aa.app,aa.machine.id,'start',a);
  await driver.destroy(aa.app,a);const count=effects(engine).length;await driver.destroy(aa.app,a);assert.equal(effects(engine).length,count);
  assert.deepEqual([...engine.containers.keys()],[bb.machine.id]);assert.deepEqual([...engine.volumes.keys()],[bb.volume.id]);
  assert.deepEqual([...engine.networks.keys()],[driver.network(b)]);
});

for(const kind of ['container','volume','network'])test(`foreign ${kind} label at A's deterministic name stops all lifecycle mutations`,async t=>{
  const {engine,driver}=await fixture(t),{app,volume,machine}=await create(driver);
  const resource=kind==='container'?engine.containers.get(machine.id).Config:kind==='volume'?engine.volumes.get(volume.id):engine.networks.get(driver.network(a));
  resource.Labels['swarm.tenant']=driver.name(b);const count=effects(engine).length;
  await assert.rejects(driver.destroy(app,a),/foreign/i);
  if(kind==='network')await assert.rejects(driver.ensureApp(a),/Foreign/);
  if(kind==='volume')await assert.rejects(driver.ensureVolume(app,a,region),/Foreign/);
  await assert.rejects(driver.ensureMachine(app,a,volume.id,image,region,'1'),/foreign/i);
  await assert.rejects(driver.action(app,machine.id,'start',a),/foreign/i);
  assert.equal(effects(engine).length,count);
});

test('foreign IDs and application names are refused without mutation',async t=>{
  const {engine,driver}=await fixture(t),aa=await create(driver),bb=await create(driver,b),count=effects(engine).length;
  await assert.rejects(driver.machine(aa.app,a,bb.machine.id),/Foreign/);
  await assert.rejects(driver.action(aa.app,bb.machine.id,'stop',a),/Foreign/);
  await assert.rejects(driver.configureBootstrap(aa.app,bb.machine.id,a,'x'.repeat(43)),/Foreign/);
  await assert.rejects(driver.removeStoppedMachine(aa.app,a,bb.machine.id,'1'),/Foreign/);
  await assert.rejects(driver.removeRetiredVolume(aa.app,a,bb.volume.id,[]),/Foreign/);
  await assert.rejects(driver.destroy(bb.app,a),/Foreign/);
  await assert.rejects(driver.machine(aa.app,a,aa.machine.id.slice(0,12)),/immutable/);
  assert.equal(effects(engine).length,count);
});

for(const mutation of ['shared','external','wrong-name','wrong-driver','ipv6','masquerade','wrong-id'])test(`network verification stops provisioning: ${mutation}`,async t=>{
  const {engine,driver}=await fixture(t);
  engine.after=(method,route)=>{if(method!=='POST'||route!=='/networks/create')return;const n=engine.networks.get(driver.network(a));
    if(mutation==='shared')n.Containers['b'.repeat(64)]={Name:'foreign'};
    if(mutation==='external')n.Internal=false;if(mutation==='wrong-name')n.Name='other';if(mutation==='wrong-driver')n.Driver='host';
    if(mutation==='ipv6')n.EnableIPv6=true;if(mutation==='masquerade')n.Options['com.docker.network.bridge.enable_ip_masquerade']='true';if(mutation==='wrong-id')n.Id='c'.repeat(64);
  };
  await assert.rejects(driver.ensureApp(a));assert.equal(engine.volumes.size,0);assert.equal(engine.containers.size,0);
  assert.equal(effects(engine).length,1);
});

test('a foreign network peer added later stops provisioning and cleanup before effects',async t=>{
  const {engine,driver}=await fixture(t),aa=await create(driver),bb=await create(driver,b);
  engine.networks.get(driver.network(a)).Containers[bb.machine.id]={Name:bb.app};const count=effects(engine).length;
  await assert.rejects(driver.ensureApp(a),/Foreign/);await assert.rejects(driver.destroy(aa.app,a),/Foreign/);assert.equal(effects(engine).length,count);
});

test('generation, image and capacity changes require an explicit replacement',async t=>{
  const {engine,driver}=await fixture(t),{app,volume,machine}=await create(driver),count=effects(engine).length;
  await assert.rejects(driver.ensureMachine(app,a,volume.id,image,region,'2'),/Unsafe/);
  await assert.rejects(driver.ensureMachine(app,a,volume.id,foreignImage,region,'1'),/explicit/);
  await assert.rejects(driver.ensureMachine(app,a,volume.id,image,region,'1',undefined,{cpu_kind:'shared',cpus:4,memory_mb:8192}),/explicit/);
  await assert.rejects(driver.configureBootstrap(app,machine.id,a,'x'.repeat(43),'2'),/Unsafe/);
  assert.equal(effects(engine).length,count);
});

for(const mutation of ['socket','ports','root','privileged','seccomp','extra-network','cpu','memory'])test(`unsafe container inspection rejects ${mutation} before an action`,async t=>{
  const {engine,driver}=await fixture(t),{app,machine}=await create(driver),raw=engine.containers.get(machine.id),count=effects(engine).length;
  if(mutation==='socket')raw.Mounts.push({Type:'bind',Source:'/var/run/docker.sock',Destination:'/var/run/docker.sock'});
  if(mutation==='ports')raw.HostConfig.PortBindings={'8787/tcp':[{HostPort:'8787'}]};if(mutation==='root')raw.HostConfig.ReadonlyRootfs=false;
  if(mutation==='privileged')raw.HostConfig.Privileged=true;if(mutation==='seccomp')raw.HostConfig.SecurityOpt.push('seccomp=unconfined');
  if(mutation==='extra-network')raw.NetworkSettings.Networks.bridge={NetworkID:'c'.repeat(64)};
  if(mutation==='cpu')raw.HostConfig.NanoCpus=0;if(mutation==='memory')raw.HostConfig.Memory=0;
  await assert.rejects(driver.action(app,machine.id,'start',a),/Unsafe/);assert.equal(effects(engine).length,count);
});

test('environment replacement has an owned deployment volume and custom CPU/memory limits',async t=>{
  const {engine,driver}=await fixture(t),{app,machine,volume}=await create(driver),operation='1'.repeat(32);
  await assert.rejects(driver.removeRetiredVolume(app,a,volume.id,[]),/attached/);
  await driver.removeStoppedMachine(app,a,machine.id,'1');
  const next=await driver.ensureDeploymentVolume(app,a,operation,region,[operation],async()=>{},20);
  assert.equal(next.id,driver.deploymentVolumeName(a,operation));assert.equal(next.size_gb,20);assert.equal(next.quota_enforced,false);
  const replacement=await driver.ensureMachine(app,a,next.id,foreignImage,region,'2',undefined,{cpu_kind:'performance',cpus:4,memory_mb:8192});
  assert.equal(engine.containers.get(replacement.id).HostConfig.Memory,8192*1024*1024);assert.equal(engine.containers.get(replacement.id).HostConfig.NanoCpus,4e9);
  await assert.rejects(driver.inventory(app,a),/foreign/i);
  assert.equal((await driver.inventory(app,a,[operation])).volumes.length,2);
  await driver.removeRetiredVolume(app,a,volume.id,[operation]);assert.equal(engine.volumes.has(volume.id),false);
  await driver.destroy(app,a,[operation]);assert.equal(engine.volumes.size,0);
});

test('capacity preserves requested budgets without claiming disk quotas; disk growth is refused',async t=>{
  const {engine,driver}=await fixture(t),{app,machine,volume}=await create(driver),count=effects(engine).length;
  assert.deepEqual(await driver.capacity(app,a,machine.id,volume.id,'1',region),{guest:{cpu_kind:'shared',cpus:2,memory_mb:4096},volumeGb:10,volumeQuotaEnforced:false});
  await assert.rejects(driver.capacity(app,a,machine.id,volume.id,'1','other'),/identity/);
  await assert.rejects(driver.capacity(app,a,machine.id,volume.id,'1',region,[],foreignImage),/identity/);
  await assert.rejects(driver.extendVolume(app,a,volume.id,region,10,20,[],async()=>{throw new Error('must not dispatch');}),/verified disk growth/);
  assert.equal(effects(engine).length,count);
});

test('image anonymous volumes or embedded environment secrets stop container creation',async t=>{
  const {engine,driver}=await fixture(t),{app}=await driver.ensureApp(a),volume=await driver.ensureVolume(app,a,region);
  engine.imageConfig.Volumes={'/socket':{}};
  await assert.rejects(driver.ensureMachine(app,a,volume.id,image,region,'1'),/extra volumes/);
  delete engine.imageConfig.Volumes;engine.imageConfig.Env.push('AWS_SECRET_ACCESS_KEY=fixture');
  await assert.rejects(driver.ensureMachine(app,a,volume.id,image,region,'1'),/environment defaults/);
  assert.equal(engine.containers.size,0);
});

test('durable effect guards run before each external write',async t=>{
  const {engine,driver}=await fixture(t),guard=async()=>{throw new Error('lease revoked');};
  await assert.rejects(driver.ensureApp(a,guard),/lease/);assert.equal(effects(engine).length,0);
  const {app}=await driver.ensureApp(a);let count=effects(engine).length;
  await assert.rejects(driver.ensureVolume(app,a,region,guard),/lease/);assert.equal(effects(engine).length,count);
  const volume=await driver.ensureVolume(app,a,region);count=effects(engine).length;
  await assert.rejects(driver.ensureMachine(app,a,volume.id,image,region,'1',guard),/lease/);assert.equal(effects(engine).length,count);
  const machine=await driver.ensureMachine(app,a,volume.id,image,region,'1');count=effects(engine).length;
  await assert.rejects(driver.configureBootstrap(app,machine.id,a,'x'.repeat(43),'1',guard),/lease/);
  await assert.rejects(driver.action(app,machine.id,'start',a,'1',guard),/lease/);assert.equal(effects(engine).length,count);
});

for(const control of ['MemoryLimit','SwapLimit','CpuCfsQuota','PidsLimit','SecurityOptions'])test(`missing host enforcement stops before creating a container: ${control}`,async t=>{
  const {engine,driver}=await fixture(t),{app}=await driver.ensureApp(a),volume=await driver.ensureVolume(app,a,region),count=effects(engine).length;
  engine.after=(_m,r,result)=>{if(r==='/info')result[control]=control==='SecurityOptions'?[]:false;};
  await assert.rejects(driver.ensureMachine(app,a,volume.id,image,region,'1'),/cannot enforce/);
  assert.equal(effects(engine).length,count);assert.equal(engine.containers.size,0);
});

test('a running owned tenant can be inspected and re-created idempotently',async t=>{
  const {engine,driver}=await fixture(t),{app,volume,machine}=await create(driver);
  await driver.action(app,machine.id,'start',a);const count=effects(engine).length;
  await driver.ensureApp(a);assert.equal((await driver.ensureMachine(app,a,volume.id,image,region,'1')).id,machine.id);
  assert.equal((await driver.inventory(app,a)).machines[0].state,'started');assert.equal(effects(engine).length,count);
});

test('lost delete response is not retried as another tenant and is reconciled on the next call',async t=>{
  const {engine,driver}=await fixture(t),{app}=await create(driver);
  engine.failAfter=(m,r)=>m==='DELETE'&&r.startsWith('/containers/');
  await assert.rejects(driver.destroy(app,a),/Docker request failed/);assert.equal(engine.containers.size,0);assert.equal(engine.volumes.size,1);
  engine.failAfter=undefined;await driver.destroy(app,a);assert.equal(engine.volumes.size,0);assert.equal(engine.networks.size,0);
});

test('a stopped foreign container attached to A network cannot escape the live endpoint check',async t=>{
  const {engine,driver}=await fixture(t),aa=await create(driver),bb=await create(driver,b),count=effects(engine).length;
  engine.containers.get(bb.machine.id).HostConfig.NetworkMode=driver.network(a);
  await assert.rejects(driver.ensureApp(a),/shared/);await assert.rejects(driver.action(aa.app,aa.machine.id,'start',a),/shared/);
  assert.equal(effects(engine).length,count);
});

test('a foreign container mounting A volume stops wake before effects',async t=>{
  const {engine,driver}=await fixture(t),aa=await create(driver),bb=await create(driver,b),count=effects(engine).length;
  engine.containers.get(bb.machine.id).Mounts[0].Name=aa.volume.id;
  await assert.rejects(driver.action(aa.app,aa.machine.id,'start',a),/another writer/);
  await assert.rejects(driver.destroy(aa.app,a),/Multiple/);assert.equal(effects(engine).length,count);
});

test('duplicate identity env or unexpected platform secrets are refused on inspection',async t=>{
  const {engine,driver}=await fixture(t),{app,machine}=await create(driver),env=engine.containers.get(machine.id).Config.Env,count=effects(engine).length;
  env.unshift(`SWARM_TENANT_ID=${b}`);await assert.rejects(driver.action(app,machine.id,'start',a),/environment/);env.shift();
  env.push('FLY_API_TOKEN=fixture');await assert.rejects(driver.action(app,machine.id,'start',a),/environment/);
  assert.equal(effects(engine).length,count);
});

test('service URL credentials are never copied into a tenant',async t=>{
  const {engine,driver}=await fixture(t),{app}=await driver.ensureApp(a),volume=await driver.ensureVolume(app,a,region),saved=process.env.PLATFORM_URL;
  try {
    process.env.PLATFORM_URL='https://operator:fixture@platform.example.test';
    await assert.rejects(driver.ensureMachine(app,a,volume.id,image,region,'1'),/credential-free/);assert.equal(engine.containers.size,0);
  }finally{if(saved===undefined)delete process.env.PLATFORM_URL;else process.env.PLATFORM_URL=saved;}
});
