import type {Pool,PoolClient} from 'pg';
import {pinnedImage} from '../runtime/container-policy.js';
export const infrastructureGates=['fly-network-isolation','nested-container-containment','signed-runtime-image','provider-hosted-login','provider-quotas'];
export async function assertQualifiedImage(database:Pool|PoolClient,image:string){
  pinnedImage(image);
  const verified=(await database.query("SELECT name FROM release_gates WHERE image_digest=$1 AND name=ANY($2::text[]) AND evidence_uri!='' AND approved_at<=now()",[image,infrastructureGates])).rows.map(r=>r.name);
  if(infrastructureGates.some(g=>!verified.includes(g)))throw new Error('Runtime image lacks infrastructure or provider qualification evidence.');
}
