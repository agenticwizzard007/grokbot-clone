/** Trusted operator tool; no route is mounted in the platform or tenant apps.
 * Usage must come from the trusted host/provider collector, not tenant input.
 * Installing a policy permits planning only; queueing is a separate command. */
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Directory} from './directory.js';
import {FlyTenants} from './fly-tenants.js';
import {recommendCapacity,setCapacityPolicy,type CapacityChange,type CapacitySample} from './tenant-capacity.js';
import {planEnvironmentOperation} from './environment-operations.js';

function readJson(file:string){
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{const s=fs.fstatSync(fd);if(!s.isFile()||s.size>65536)throw new Error('Input file is invalid or oversized.');return JSON.parse(fs.readFileSync(fd,'utf8'));}finally{fs.closeSync(fd);}
}
export async function capacityCommand(args:string[],directory:Directory,fly?:Pick<FlyTenants,'capacity'>){
  const [command,...rest]=args,options:Record<string,string>={};
  for(let n=0;n<rest.length;n+=2){const flag=rest[n];if(!/^--[a-z][a-z0-9-]*$/.test(flag)||!rest[n+1]||rest[n+1].startsWith('--')||Object.hasOwn(options,flag.slice(2)))throw new Error('Invalid capacity command options.');options[flag.slice(2)]=rest[n+1];}
  const only=(allowed:string[])=>{if(Object.keys(options).some(k=>!allowed.includes(k)))throw new Error('Unknown capacity command option.');};
  if(!/^usr_[A-Za-z0-9_-]{8,100}$/.test(options.tenant??''))throw new Error('A tenant identity is required.');
  if(command==='set-policy'){
    only(['tenant','file']);if(!options.file)throw new Error('An approved policy file is required.');
    const policy=readJson(options.file),revision=await directory.transaction(client=>setCapacityPolicy(client,options.tenant,policy));return {tenant:options.tenant,revision,queued:false};
  }
  if(command==='plan'){
    only(['tenant','usage','evidence-uri','evidence-sha256','reviewer','acknowledge-maintenance','output']);
    if(!options.usage||!options.output||options['acknowledge-maintenance']!=='yes')throw new Error('Usage evidence, output and maintenance acknowledgement are required.');
    const tenant=(await directory.pool.query("SELECT * FROM tenants WHERE id=$1 AND state IN ('active','suspended')",[options.tenant])).rows[0];
    if(!tenant?.fly_app||!tenant.machine_id||!tenant.volume_id||!tenant.region||!tenant.image_digest)throw new Error('An isolated environment is required.');
    const policy=(await directory.pool.query('SELECT revision,policy FROM tenant_capacity_policies WHERE tenant_id=$1',[options.tenant])).rows[0];
    if(!policy)throw new Error('An approved capacity policy is required.');
    const operations=(await directory.pool.query('SELECT id FROM environment_operations WHERE tenant_id=$1',[options.tenant])).rows.map(r=>r.id);
    const source=await (fly??new FlyTenants()).capacity(tenant.fly_app,tenant.id,tenant.machine_id,tenant.volume_id,String(tenant.generation),tenant.region,operations,tenant.image_digest);
    const samples=readJson(options.usage) as CapacitySample[],owner={tenant:tenant.id,generation:String(tenant.generation),machine:tenant.machine_id,volume:tenant.volume_id};
    const capacity:CapacityChange={policyRevision:String(policy.revision),source,target:recommendCapacity(policy.policy,source,samples,owner),samples,
      evidence:{uri:options['evidence-uri'],sha256:options['evidence-sha256'],reviewer:options.reviewer},maintenanceAcknowledged:true};
    const plan=await planEnvironmentOperation(directory,{tenant:tenant.id,kind:'update',image:tenant.image_digest,capacity});
    fs.writeFileSync(options.output,JSON.stringify(plan,null,2)+'\n',{flag:'wx',mode:0o600});
    return {tenant:tenant.id,planFile:options.output,source,target:capacity.target,queued:false};
  }
  throw new Error('Use set-policy or plan; queue a reviewed plan with environment-cli.');
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  const directory=new Directory();
  try{console.log(JSON.stringify(await capacityCommand(process.argv.slice(2),directory),null,2));}
  catch{console.error('Capacity operation refused. Check owner, usage, policy, qualification and maintenance authorization.');process.exitCode=1;}
  finally{await directory.pool.end();}
}
