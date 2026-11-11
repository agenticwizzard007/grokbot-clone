import { Directory } from './directory.js';
import {fileURLToPath} from 'node:url';
/** A separate release command uses a schema-owner credential. Runtime services
 * never run DDL at boot and tenant processes cannot invoke this entrypoint. */
export async function migrateDirectory(env:NodeJS.ProcessEnv=process.env){
  if(!['platform','provisioner','composio-gateway'].includes(env.SWARM_ROLE??''))throw new Error('Directory migration requires an explicit platform service role.');
  if(!env.MIGRATION_DATABASE_URL)throw new Error('MIGRATION_DATABASE_URL is required; runtime DATABASE_URL is not a schema migration credential.');
  const directory=new Directory(env.MIGRATION_DATABASE_URL);
  try{await directory.migrate();return {migrated:true};}finally{await directory.pool.end();}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  try{if(process.argv.length!==2)throw new Error('No migration options are supported.');console.log(JSON.stringify(await migrateDirectory()));}
  catch{console.error('Directory migration failed. Verify role, schema-owner credential, TLS and database availability.');process.exitCode=1;}
}
