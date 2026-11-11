/** Trusted operator entrypoint. Planning is read-only; queue explicitly starts
 * maintenance through the separately running qualified provisioner. */
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Directory} from './directory.js';
import {planEnvironmentOperation,queueEnvironmentOperation,requestEnvironmentRollback} from './environment-operations.js';
export async function environmentCommand(args:string[],directory:Directory){
  const [command,...rest]=args,options:Record<string,string>={};
  for(let i=0;i<rest.length;i+=2){const flag=rest[i];if(!/^--[a-z-]+$/.test(flag)||!rest[i+1]||rest[i+1].startsWith('--')||Object.hasOwn(options,flag.slice(2)))throw new Error('Invalid command options.');options[flag.slice(2)]=rest[i+1];}
  const only=(allowed:string[])=>{if(Object.keys(options).some(key=>!allowed.includes(key)))throw new Error('Unknown command option.');};
  if(command==='plan'){
    only(['tenant','kind','image','full-backup','database-backup','output']);
    if(!options.output)throw new Error('An output plan file is required.');
    const plan=await planEnvironmentOperation(directory,{tenant:options.tenant,kind:options.kind as 'restore'|'update',image:options.image,fullBackup:options['full-backup'],databaseBackup:options['database-backup']});
    fs.writeFileSync(options.output,JSON.stringify(plan,null,2)+'\n',{flag:'wx',mode:0o600});return {planFile:options.output,tenant:plan.tenant,kind:plan.kind,queued:false};
  }
  if(command==='queue'){
    only(['plan']);if(!options.plan)throw new Error('A reviewed plan file is required.');
    const fd=fs.openSync(options.plan,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    let plan;try{const info=fs.fstatSync(fd);if(!info.isFile()||info.size>65536)throw new Error('Invalid plan file.');plan=JSON.parse(fs.readFileSync(fd,'utf8'));}finally{fs.closeSync(fd);}
    return queueEnvironmentOperation(directory,plan);
  }
  if(command==='status'){
    only(['id']);if(!/^[a-f0-9]{32}$/.test(options.id??''))throw new Error('A valid operation ID is required.');
    const row=(await directory.pool.query(`SELECT id,tenant_id,kind,phase,target_generation,target_machine,target_volume,attempts,error_code,retry_at,created_at,completed_at,run_authorized_at,rollback_operation,capacity_change
      FROM environment_operations WHERE id=$1`,[options.id])).rows[0];if(!row)throw new Error('Operation not found.');return row;
  }
  if(command==='rollback-before-activation'){only(['id']);return requestEnvironmentRollback(directory,options.id);}
  throw new Error('Use plan, queue, status or rollback-before-activation. No force or implicit rollback command exists.');
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  const directory=new Directory();
  try{console.log(JSON.stringify(await environmentCommand(process.argv.slice(2),directory),null,2));}
  catch{console.error('Environment operation refused. Verify the reviewed source, backup ownership, qualification evidence and directory status.');process.exitCode=1;}
  finally{await directory.pool.end();}
}
