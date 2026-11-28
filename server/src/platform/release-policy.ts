import type {Pool,PoolClient} from 'pg';
import {pinnedImage} from '../runtime/container-policy.js';
export const infrastructureGates=['fly-network-isolation','nested-container-containment','signed-runtime-image','provider-hosted-login','provider-quotas'];
export async function assertQualifiedImage(database:Pool|PoolClient,image:string){
  pinnedImage(image);
  const verified=(await database.query("SELECT name FROM release_gates WHERE image_digest=$1 AND name=ANY($2::text[]) AND evidence_uri!='' AND approved_at<=now()",[image,infrastructureGates])).rows.map(r=>r.name);
  if(infrastructureGates.some(g=>!verified.includes(g)))throw new Error('Runtime image lacks infrastructure or provider qualification evidence.');
}

/** Docker is an explicit local/self-hosted opt-in. It never supplies Fly evidence. */
export function tenantDriver(env:NodeJS.ProcessEnv=process.env):'fly'|'docker' {
  const driver=env.TENANT_DRIVER ?? 'fly';
  if(driver!=='fly'&&driver!=='docker')throw new Error('TENANT_DRIVER must be fly or docker.');
  if(driver==='docker'&&env.NODE_ENV==='production'&&env.SWARM_ALLOW_DOCKER_TENANTS!=='1') {
    throw new Error('Production Docker tenants require SWARM_ALLOW_DOCKER_TENANTS=1 and operator acceptance of the shared-kernel risk.');
  }
  return driver;
}

export async function assertProvisioningImage(database:Pool|PoolClient,image:string,env:NodeJS.ProcessEnv=process.env) {
  if(tenantDriver(env)==='fly')return assertQualifiedImage(database,image);
  // This accepts a local Docker experiment, not a qualified Fly release. Do not
  // write gate rows or call this from the Fly release evidence verifier.
  pinnedImage(image);
}
