import {request as httpRequest} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {TenantNames} from './tenant-names.js';
import type {BeforeCreate, TenantMachine} from './fly-tenants.js';
import {pinnedImage} from '../runtime/container-policy.js';
import {tenantMeteringEnabled} from '../runtime/meter-contract.js';
import {usageCollectionEnabled} from '../runtime/host-usage.js';
import {sameGuest, validateGuest, type TenantGuest, type TenantCapacity} from './tenant-capacity.js';

const segment = encodeURIComponent;
const ownerLabel = 'swarm.tenant';
const label = (key:string) => `swarm.docker.${key}`;
const idPattern = /^[a-f0-9]{64}$/;
const bootstrapEntry = 'swarm-bootstrap';
// The pinned image supplies the executable. No host command, tenant command,
// provider secret or Docker socket is interpolated into this wrapper.
const entrypoint = ['/bin/sh', '-ec', `umask 077
mkdir -p /run/swarm-host
if [ -f /data/${bootstrapEntry} ]; then
  cp /data/${bootstrapEntry} /run/swarm-host/bootstrap
  rm /data/${bootstrapEntry}
fi
if [ -f /data/swarm-machine-id ]; then export FLY_MACHINE_ID="$(cat /data/swarm-machine-id)"; fi
exec "$@"`, 'swarm-docker-host'];
const tmpfs = {'/run':'rw,nosuid,nodev,noexec,size=16m,mode=700', '/tmp':'rw,nosuid,nodev,noexec,size=128m,mode=1777'};
const imageEnvironment = new Set(['PATH','LANG','LC_ALL','TZ','NODE_VERSION','YARN_VERSION','NODE_ENV']);
const tenantEnvironment = new Set([...imageEnvironment,'SWARM_TENANT_ID','SWARM_VOLUME_ID','SWARM_RUNTIME_GENERATION','PLATFORM_URL','COMPOSIO_GATEWAY_URL','TENANT_USAGE_COLLECTION','TENANT_METERING']);
const missing = (error:any) => {if (error.status === 404) return null; throw error;};

/** Docker is a development boundary, not Fly qualification. No implicit pull,
 * public ports, shared networks, bind mounts, privileged mode or seccomp override. */
export class DockerTenants extends TenantNames {
  private socketPath:string;
  constructor(host = process.env.DOCKER_HOST ?? 'unix:///var/run/docker.sock') {
    super();
    if (!/^unix:\/\/\/[A-Za-z0-9_./-]+$/.test(host) || host.split('/').includes('..')) throw new Error('DOCKER_HOST must be an absolute unix socket URL.');
    this.socketPath = host.slice('unix://'.length);
  }

  async request(method:string, route:string, body?:unknown):Promise<any> {
    if (!route.startsWith('/') || /[\r\n]/.test(route)) throw new Error('Invalid Docker route.');
    const bytes = Buffer.isBuffer(body) ? body : body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise((resolve,reject) => {
      const req = httpRequest({socketPath:this.socketPath, path:`/v1.44${route}`, method,
        headers:bytes ? {'content-type':Buffer.isBuffer(body) ? 'application/x-tar' : 'application/json', 'content-length':bytes.length} : {},
        signal:AbortSignal.timeout(45_000)}, res => {
        const chunks:Buffer[] = []; let size = 0;
        res.on('data', (chunk:Buffer) => {
          size += chunk.length;
          if (size > 8 * 1024 * 1024) {res.destroy(new Error('Docker response limit exceeded.')); return;}
          chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => {
          // Never echo Engine bodies: they may include environment or bootstrap data.
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(Object.assign(new Error(`Docker request failed (${res.statusCode}).`), {status:res.statusCode})); return;
          }
          try {const text = Buffer.concat(chunks).toString(); resolve(text ? JSON.parse(text) : {});} catch {reject(new Error('Invalid Docker response.'));}
        });
      });
      req.on('error', reject); req.end(bytes);
    });
  }

  private labels(tenant:string, kind:string) {return {[ownerLabel]:this.name(tenant), [label('driver')]:'docker', [label('kind')]:kind};}
  private owned(labels:any, tenant:string, kind:string) {
    if (Object.entries(this.labels(tenant,kind)).some(([k,v]) => labels?.[k] !== v)) throw new Error('Foreign Docker resource; reconciliation required.');
  }
  private app(app:string, tenant:string) {if (app !== this.name(tenant)) throw new Error('Foreign tenant application.');}
  private checkId(id:string) {if (!idPattern.test(id)) throw new Error('Docker requires a full immutable container ID.');}
  private async rawContainer(id:string) {this.checkId(id); const raw = await this.request('GET',`/containers/${id}/json`); if (raw.Id !== id) throw new Error('Docker container identity changed.'); return raw;}

  private checkContainer(raw:any, tenant:string, volume?:string, generation?:string):TenantMachine {
    this.owned(raw.Config?.Labels,tenant,'container');
    const c = raw.Config, h = raw.HostConfig, labels = c.Labels;
    const env:Record<string,string> = {};
    for (const item of c.Env ?? []) {
      const n = typeof item === 'string' ? item.indexOf('=') : -1, key = item.slice(0,n);
      if (n < 1 || !tenantEnvironment.has(key) || Object.hasOwn(env,key)) throw new Error('Unsafe Docker tenant environment.');
      env[key] = item.slice(n+1);
    }
    const guest:TenantGuest = {cpu_kind:labels[label('cpu-kind')], cpus:Number(labels[label('cpus')]), memory_mb:Number(labels[label('memory-mb')])};
    validateGuest(guest); pinnedImage(c.Image); this.checkId(raw.Id);
    const mount = raw.Mounts?.[0], networks = Object.keys(raw.NetworkSettings?.Networks ?? {});
    if (raw.Name !== `/${this.name(tenant)}` || !/^[1-9]\d*$/.test(labels[label('generation')])
      || env.SWARM_TENANT_ID !== tenant || env.SWARM_VOLUME_ID !== mount?.Name || env.SWARM_RUNTIME_GENERATION !== labels[label('generation')]
      || volume && mount?.Name !== volume || generation && labels[label('generation')] !== generation
      || raw.Mounts?.length !== 1 || mount.Type !== 'volume' || mount.Destination !== '/data' || mount.RW !== true
      || h?.NetworkMode !== this.network(tenant) || networks.some(n => n !== this.network(tenant)) || networks.length > 1
      || raw.State?.Running && networks.length !== 1
      || h.Privileged !== false || h.ReadonlyRootfs !== true || h.PublishAllPorts !== false || Object.keys(h.PortBindings ?? {}).length
      || Object.keys(raw.NetworkSettings?.Ports ?? {}).some(k => raw.NetworkSettings.Ports[k]?.length)
      || h.Binds?.length || h.VolumesFrom?.length || h.Links?.length || h.ExtraHosts?.length || h.Devices?.length || h.DeviceRequests?.length || h.DeviceCgroupRules?.length
      || h.CapAdd?.length || h.CapDrop?.length !== 1 || h.CapDrop[0] !== 'ALL'
      || h.SecurityOpt?.length !== 1 || !['no-new-privileges:true','no-new-privileges'].includes(h.SecurityOpt[0])
      || h.PidMode || h.IpcMode !== 'private' || h.UTSMode || h.UsernsMode || h.CgroupnsMode !== 'private'
      || h.Memory !== guest.memory_mb*1024*1024 || h.MemorySwap !== h.Memory || h.NanoCpus !== guest.cpus*1e9 || h.PidsLimit !== 512
      || JSON.stringify(h.Tmpfs) !== JSON.stringify(tmpfs) || c.User !== '0:0'
      || JSON.stringify(c.Entrypoint) !== JSON.stringify(entrypoint) || h.RestartPolicy?.Name !== 'no'
      || h.LogConfig?.Type !== 'none') throw new Error('Unsafe or foreign Docker tenant container.');
    const state = raw.State?.Paused ? 'suspended' : raw.State?.Running ? 'started' : raw.State?.Status === 'created' ? 'created' : raw.State?.Status === 'exited' ? 'stopped' : 'unknown';
    return {id:raw.Id,state,region:labels[label('region')],config:{image:c.Image,guest,services:[],mounts:[{volume:mount.Name,path:'/data'}],
      metadata:{swarm_tenant:tenant,swarm_generation:labels[label('generation')]},env}};
  }

  private async networkState(tenant:string) {
    const network = await this.request('GET',`/networks/${segment(this.network(tenant))}`).catch(missing);
    if (!network) return null;
    this.owned(network.Labels,tenant,'network');
    if (!idPattern.test(network.Id) || network.Name !== this.network(tenant) || network.Driver !== 'bridge' || network.Scope !== 'local'
      || network.Internal !== true || network.EnableIPv6 !== false || network.Attachable !== false || network.Ingress !== false
      || network.Options?.['com.docker.network.bridge.enable_icc'] !== 'false'
      || network.Options?.['com.docker.network.bridge.enable_ip_masquerade'] !== 'false'
      || !network.Containers || Object.keys(network.Containers).length > 1) throw new Error('Docker network isolation could not be verified. Provisioning stopped.');
    for (const id of Object.keys(network.Containers)) {
      const raw = await this.rawContainer(id); this.checkContainer(raw,tenant);
      if (raw.NetworkSettings.Networks[this.network(tenant)]?.NetworkID !== network.Id) throw new Error('Docker network membership is unverified.');
    }
    // Network inspect lists live endpoints only. Include stopped/created peers
    // so an inactive foreign container cannot be silently adopted on wake.
    const attached = await this.request('GET',`/containers/json?all=true&filters=${segment(JSON.stringify({network:[network.Name]}))}`);
    if (!Array.isArray(attached) || attached.length > 1) throw new Error('Docker tenant network is shared.');
    for (const peer of attached) this.checkContainer(await this.rawContainer(peer.Id),tenant);
    return network;
  }

  async ensureApp(tenant:string, beforeCreate?:BeforeCreate) {
    let network = await this.networkState(tenant);
    if (!network) {
      await beforeCreate?.();
      const created = await this.request('POST','/networks/create',{Name:this.network(tenant),CheckDuplicate:true,Driver:'bridge',Internal:true,EnableIPv6:false,Attachable:false,Ingress:false,
        Labels:this.labels(tenant,'network'),Options:{'com.docker.network.bridge.enable_icc':'false','com.docker.network.bridge.enable_ip_masquerade':'false'}});
      network = await this.networkState(tenant);
      if (!network || network.Id !== created.Id || Object.keys(network.Containers).length) throw new Error('Created Docker network isolation is unverified.');
    }
    return {app:this.name(tenant),network:this.network(tenant)};
  }

  private checkVolume(raw:any, tenant:string, operations?:string[]) {
    this.owned(raw.Labels,tenant,'volume');
    const operation = raw.Labels[label('operation')], name = operation ? this.deploymentVolumeName(tenant,operation) : this.volumeName(tenant);
    const size = Number(raw.Labels[label('size-gb')]), region = raw.Labels[label('region')];
    if (raw.Name !== name || raw.Driver !== 'local' || raw.Scope !== 'local' || Object.keys(raw.Options ?? {}).length
      || operation && operations && !operations.includes(operation) || !Number.isSafeInteger(size) || size < 10 || size > 10000 || !/^[a-z0-9]{3,10}$/.test(region)) throw new Error('Unsafe or foreign Docker tenant volume.');
    // size_gb is a requested capacity hint, not an enforced local-volume quota.
    return {id:name,name,state:'created',region,size_gb:size,driver:'docker',encrypted:false,quota_enforced:false};
  }
  private async volume(tenant:string, name:string) {
    if (!/^[a-zA-Z0-9_-]{1,120}$/.test(name)) throw new Error('Invalid Docker volume.');
    return this.checkVolume(await this.request('GET',`/volumes/${segment(name)}`),tenant);
  }
  private async createVolume(tenant:string, region:string, operation:string|undefined, beforeCreate?:BeforeCreate, sizeGb=10) {
    if (!/^[a-z0-9]{3,10}$/.test(region) || !Number.isSafeInteger(sizeGb) || sizeGb < 10 || sizeGb > 10000) throw new Error('Invalid Docker volume capacity or region.');
    if (!await this.networkState(tenant)) throw new Error('Tenant Docker network is missing.');
    const name = operation ? this.deploymentVolumeName(tenant,operation) : this.volumeName(tenant);
    let raw = await this.request('GET',`/volumes/${name}`).catch(missing);
    if (!raw) {
      await beforeCreate?.();
      await this.request('POST','/volumes/create',{Name:name,Driver:'local',Labels:{...this.labels(tenant,'volume'),[label('region')]:region,[label('size-gb')]:String(sizeGb),...(operation?{[label('operation')]:operation}:{})}});
      raw = await this.request('GET',`/volumes/${name}`);
    }
    const result = this.checkVolume(raw,tenant);
    if (result.id !== name || result.region !== region || result.size_gb !== sizeGb) throw new Error('Docker volume identity, capacity or region differs.');
    return result;
  }
  async ensureVolume(app:string, tenant:string, region:string, beforeCreate?:BeforeCreate) {this.app(app,tenant); return this.createVolume(tenant,region,undefined,beforeCreate);}
  async ensureDeploymentVolume(app:string, tenant:string, operation:string, region:string, operations:string[], beforeCreate:BeforeCreate, sizeGb=10) {
    if (!operations.includes(operation)) throw new Error('Unadmitted Docker deployment operation.');
    await this.inventory(app,tenant,operations); return this.createVolume(tenant,region,operation,beforeCreate,sizeGb);
  }

  async machine(app:string, tenant:string, id:string, volume?:string, generation?:string):Promise<TenantMachine> {
    this.app(app,tenant);
    const result = this.checkContainer(await this.rawContainer(id),tenant,volume,generation);
    if (!await this.networkState(tenant)) throw new Error('Tenant Docker network is missing.');
    await this.volume(tenant,result.config.mounts[0].volume);
    const users = await this.request('GET',`/containers/json?all=true&filters=${segment(JSON.stringify({volume:[result.config.mounts[0].volume]}))}`);
    if (!Array.isArray(users) || users.length !== 1 || users[0].Id !== id) throw new Error('Docker tenant volume has another writer.');
    return result;
  }
  async ensureMachine(app:string, tenant:string, volume:string, image:string, region:string, generation:string, beforeCreate?:BeforeCreate, guest:TenantGuest={cpu_kind:'shared',cpus:2,memory_mb:4096}) {
    this.app(app,tenant); pinnedImage(image); validateGuest(guest);
    if (!/^[1-9]\d*$/.test(generation)) throw new Error('Invalid tenant generation.');
    if (!await this.networkState(tenant)) throw new Error('Tenant Docker network is missing.');
    const disk = await this.volume(tenant,volume);
    if (disk.region !== region) throw new Error('Docker volume region differs.');
    const existing = await this.request('GET',`/containers/${segment(app)}/json`).catch(missing);
    if (existing) {
      const current = await this.machine(app,tenant,existing.Id,volume,generation);
      if (current.config.image !== image || current.region !== region || !sameGuest(current.config.guest,guest)) throw new Error('Docker image or capacity change requires an explicit environment operation.');
      return current;
    }
    const info = await this.request('GET','/info');
    if (info.MemoryLimit !== true || info.SwapLimit !== true || info.CpuCfsQuota !== true || info.PidsLimit !== true
      || !info.SecurityOptions?.some((v:string)=>v === 'name=seccomp,profile=builtin')) {
      throw new Error('Docker host cannot enforce required memory, swap, CPU, PID or default seccomp controls.');
    }
    // A pinned, preloaded image only. Refuse implicit anonymous volumes and image
    // environment secrets; Docker otherwise inherits those at container creation.
    const source = await this.request('GET',`/images/${segment(image)}/json`);
    if (Object.keys(source.Config?.Volumes ?? {}).length) throw new Error('Docker host image declares extra volumes.');
    if (source.Id !== image && !source.RepoDigests?.includes(image)) throw new Error('Docker host image digest is unverified.');
    const command = [...(source.Config?.Entrypoint ?? []),...(source.Config?.Cmd ?? [])];
    if (!command.length || command.some(v=>typeof v !== 'string')) throw new Error('Docker host image command is missing.');
    if ((source.Config?.Env ?? []).some((v:string)=>!imageEnvironment.has(v.split('=')[0]))) throw new Error('Docker host image has unreviewed environment defaults.');
    for (const origin of [process.env.PLATFORM_URL,process.env.COMPOSIO_GATEWAY_URL]) {
      if (!origin) continue;
      const url = new URL(origin);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Docker host service origins require credential-free HTTPS.');
    }
    const env = {SWARM_TENANT_ID:tenant,SWARM_VOLUME_ID:volume,SWARM_RUNTIME_GENERATION:generation,
      ...(process.env.PLATFORM_URL ? {PLATFORM_URL:process.env.PLATFORM_URL}:{}),
      ...(process.env.COMPOSIO_GATEWAY_URL ? {COMPOSIO_GATEWAY_URL:process.env.COMPOSIO_GATEWAY_URL}:{}),
      ...(usageCollectionEnabled(process.env.TENANT_USAGE_COLLECTION) ? {TENANT_USAGE_COLLECTION:'1'}:{}),
      ...(tenantMeteringEnabled() ? {TENANT_METERING:'1'}:{})};
    // Check all resources using the volume, including foreign containers. Never
    // attach a second writer just because it has a different name or label.
    const users = await this.request('GET',`/containers/json?all=true&filters=${segment(JSON.stringify({volume:[volume]}))}`);
    if (!Array.isArray(users) || users.length) throw new Error('Docker tenant volume is already attached.');
    await beforeCreate?.();
    const created = await this.request('POST',`/containers/create?name=${segment(app)}`,{Image:image,User:'0:0',Entrypoint:entrypoint,Cmd:command,Env:Object.entries(env).map(([k,v])=>`${k}=${v}`),ExposedPorts:{},
      Labels:{...this.labels(tenant,'container'),[label('generation')]:generation,[label('region')]:region,[label('cpu-kind')]:guest.cpu_kind,[label('cpus')]:String(guest.cpus),[label('memory-mb')]:String(guest.memory_mb)},
      HostConfig:{NetworkMode:this.network(tenant),Mounts:[{Type:'volume',Source:volume,Target:'/data',ReadOnly:false,VolumeOptions:{NoCopy:true}}],
        Privileged:false,ReadonlyRootfs:true,PublishAllPorts:false,PortBindings:{},CapDrop:['ALL'],SecurityOpt:['no-new-privileges:true'],
        Memory:guest.memory_mb*1024*1024,MemorySwap:guest.memory_mb*1024*1024,NanoCpus:guest.cpus*1e9,PidsLimit:512,
        IpcMode:'private',CgroupnsMode:'private',Tmpfs:tmpfs,RestartPolicy:{Name:'no'},LogConfig:{Type:'none'}},
      NetworkingConfig:{EndpointsConfig:{[this.network(tenant)]:{}}}});
    const result = await this.machine(app,tenant,created.Id,volume,generation);
    if (result.config.image !== image || result.region !== region || !sameGuest(result.config.guest,guest)) throw new Error('Created Docker image or capacity is unverified.');
    return result;
  }

  async configureBootstrap(app:string, machine:string, tenant:string, bootstrap:string, generation?:string, beforeEffect?:BeforeCreate) {
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(bootstrap)) throw new Error('Invalid bootstrap credential.');
    const current = await this.machine(app,tenant,machine,undefined,generation);
    if (!['created','stopped'].includes(current.state)) throw new Error('Bootstrap changes require a stopped container.');
    await beforeEffect?.();
    await this.request('PUT',`/containers/${machine}/archive?path=/data&noOverwriteDirNonDir=1`,tarFiles({[bootstrapEntry]:bootstrap,'swarm-machine-id':machine}));
  }
  async action(app:string, machine:string, operation:'start'|'suspend'|'stop', tenant:string, generation?:string, beforeEffect?:BeforeCreate) {
    if (!['start','suspend','stop'].includes(operation)) throw new Error('Invalid Docker action.');
    const current = await this.machine(app,tenant,machine,undefined,generation);
    if (operation === 'start' && current.state === 'started' || operation !== 'start' && ['created','stopped'].includes(current.state)) return;
    if (current.state === 'suspended') throw new Error('Paused Docker containers require operator reconciliation.');
    await beforeEffect?.();
    // Suspension stops the writer. Freezing and later resuming stale tokens is unsafe.
    await this.request('POST',`/containers/${machine}/${operation === 'start' ? 'start':'stop?t=10'}`);
    await this.machine(app,tenant,machine,undefined,generation);
  }
  async waitStopped(app:string, tenant:string, machine:string, generation?:string, wait=(ms:number)=>delay(ms)) {
    for (let n=0;n<30;n++) {const current=await this.machine(app,tenant,machine,undefined,generation); if (['stopped','created'].includes(current.state)) return current; await wait(1000);}
    throw new Error('Docker stop outcome requires reconciliation.');
  }
  async removeStoppedMachine(app:string, tenant:string, id:string, generation:string) {
    const current = await this.machine(app,tenant,id,undefined,generation).catch(missing);
    if (!current) return;
    if (!['stopped','created'].includes(current.state)) throw new Error('Container removal requires a stopped writer.');
    await this.request('DELETE',`/containers/${id}`).catch(missing);
    if (await this.rawContainer(id).catch(missing)) throw new Error('Docker container deletion is unconfirmed.');
  }

  async inventory(app:string, tenant:string, operations:string[]=[]):Promise<{present:boolean;machines:TenantMachine[];volumes:any[]}> {
    this.app(app,tenant);
    const network = await this.networkState(tenant), names = new Set([this.volumeName(tenant),...operations.map(op=>this.deploymentVolumeName(tenant,op))]);
    const allVolumes = await this.request('GET','/volumes'), allContainers = await this.request('GET','/containers/json?all=true');
    // Engine encodes an empty volume inventory as null on some versions.
    if (allVolumes.Volumes !== null && !Array.isArray(allVolumes.Volumes) || !Array.isArray(allContainers) || allVolumes.Warnings?.length) throw new Error('Invalid Docker inventory.');
    const volumes = ((allVolumes.Volumes ?? []) as any[]).filter((v:any)=>names.has(v.Name) || v.Labels?.[ownerLabel] === app).map((v:any)=>this.checkVolume(v,tenant,operations));
    const candidates = allContainers.filter((c:any)=>c.Names?.includes(`/${app}`) || c.Labels?.[ownerLabel] === app
      || c.Mounts?.some((m:any)=>names.has(m.Name)) || Object.hasOwn(c.NetworkSettings?.Networks ?? {},this.network(tenant)));
    if (candidates.length > 1) throw new Error('Multiple Docker tenant writers require reconciliation.');
    const machines:TenantMachine[] = [];
    for (const candidate of candidates) {
      const machine = this.checkContainer(await this.rawContainer(candidate.Id),tenant);
      if (!volumes.some(v=>v.id === machine.config.mounts[0].volume)) throw new Error('Docker container volume ownership is unverified.');
      machines.push(machine);
    }
    return {present:!!network || !!machines.length || !!volumes.length,machines,volumes};
  }
  async removeRetiredVolume(app:string, tenant:string, id:string, operations:string[]) {
    const inventory = await this.inventory(app,tenant,operations);
    if (!inventory.volumes.some(v=>v.id === id)) {
      // A supplied foreign ID is an error, even if it is outside our inventory.
      await this.volume(tenant,id).catch(missing); return;
    }
    if (inventory.machines.some(m=>m.config.mounts[0].volume === id)) throw new Error('Retired Docker volume remains attached.');
    await this.request('DELETE',`/volumes/${segment(id)}`).catch(missing);
    if (await this.request('GET',`/volumes/${segment(id)}`).catch(missing)) throw new Error('Docker volume deletion is unconfirmed.');
  }
  async destroy(app:string, tenant:string, operations:string[]=[]) {
    const inventory = await this.inventory(app,tenant,operations);
    // Validate the entire inventory before the first effect. Delete by immutable
    // container/network ID, and never force a volume/network detach.
    for (const machine of inventory.machines) {
      await this.machine(app,tenant,machine.id);
      await this.request('DELETE',`/containers/${machine.id}?force=true`).catch(missing);
      if (await this.rawContainer(machine.id).catch(missing)) throw new Error('Docker container deletion is unconfirmed.');
    }
    for (const volume of inventory.volumes) await this.removeRetiredVolume(app,tenant,volume.id,operations);
    const network = await this.networkState(tenant);
    if (network) await this.request('DELETE',`/networks/${network.Id}`).catch(missing);
    if ((await this.inventory(app,tenant,operations)).present) throw new Error('Docker tenant deletion is unconfirmed.');
  }
  async capacity(app:string, tenant:string, machine:string, volume:string, generation:string, region:string, operations:string[]=[], image?:string):Promise<TenantCapacity & {volumeQuotaEnforced:false}> {
    const inventory = await this.inventory(app,tenant,operations);
    const current = await this.machine(app,tenant,machine,volume,generation);
    const disk = inventory.volumes.find(v=>v.id === volume);
    if (current.region !== region || image && current.config.image !== image || !disk || disk.region !== region) throw new Error('Docker capacity identity differs.');
    // Preserve the requested disk budget across image/restore replacement. This
    // is not a measured/enforced disk quota; local volumes cannot attest one.
    return {guest:{...current.config.guest},volumeGb:disk.size_gb,volumeQuotaEnforced:false};
  }
  async extendVolume(app:string, tenant:string, volume:string, region:string, sourceGb:number, targetGb:number, operations:string[], _beforeEffect:BeforeCreate):Promise<any> {
    await this.inventory(app,tenant,operations); await this.volume(tenant,volume);
    throw new Error('Docker local volumes do not support verified disk growth.');
  }
}

/** Minimal ustar: fixed regular filenames, root ownership, mode 0600. */
function tarFiles(files:Record<string,string>):Buffer {
  const parts:Buffer[] = [];
  for (const [name,value] of Object.entries(files)) {
    const content = Buffer.from(value), header = Buffer.alloc(512);
    header.write(name,0,100); header.write('0000600\0',100); header.write('0000000\0',108); header.write('0000000\0',116);
    header.write(`${content.length.toString(8).padStart(11,'0')}\0`,124); header.write('00000000000\0',136); header.fill(32,148,156);
    header.write('0',156); header.write('ustar\0',257); header.write('00',263);
    header.write(`${header.reduce((a,b)=>a+b,0).toString(8).padStart(6,'0')}\0 `,148);
    parts.push(header,content,Buffer.alloc((512-content.length%512)%512));
  }
  return Buffer.concat([...parts,Buffer.alloc(1024)]);
}
