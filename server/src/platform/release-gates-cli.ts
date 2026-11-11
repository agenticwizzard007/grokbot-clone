/** Trusted operator entrypoint for release-gate evidence. It records, lists and
 * verifies release_gates rows for one digest-pinned image using the same
 * predicate the provisioner and recovery commands enforce (assertQualifiedImage).
 * It never fabricates evidence: a row exists only when an operator names an
 * archived result, and it counts only after explicit approval. Tenant processes
 * are refused and the platform PostgreSQL (DATABASE_URL) is required. */
import {fileURLToPath} from 'node:url';
import {isTenant,tenantId} from '../deployment.js';
import {pinnedImage} from '../runtime/container-policy.js';
import {Directory} from './directory.js';
import {assertQualifiedImage,infrastructureGates} from './release-policy.js';

export type ReleaseGate={name:string;image_digest:string;evidence_uri:string;evidence_sha256:string|null;reviewer:string|null;approved_at:Date|null;approved:boolean};
export type ReleaseGateStatus={image:string;qualified:boolean;required:string[];missing:string[];incomplete:string[];gates:ReleaseGate[]};
export const usage=`Usage:
  release-gates-cli record <image@sha256:...> <gate> <evidence-uri> <evidence-sha256> <reviewer> [--approve]
  release-gates-cli list <image@sha256:...>
  release-gates-cli verify <image@sha256:...>
Required gates: ${infrastructureGates.join(', ')}
Optional gates (recorded, never required for provisioning): tenant-capacity-resize
Evidence is an absolute https:, s3: or file: URI naming the archived result (no credentials in the URI), the
SHA-256 of that artifact as the operator computed it, and the reviewer who approved it. Nothing is fetched or verified.
Without --approve the row is recorded but not approved (approved_at is 'infinity').
Recording the same gate and image again replaces the row, so omitting --approve withdraws approval.`;
// Unapproved evidence keeps approved_at='infinity' so assertQualifiedImage's approved_at<=now() stays false.
const columns="name,image_digest,evidence_uri,evidence_sha256,reviewer,CASE WHEN isfinite(approved_at) THEN approved_at END AS approved_at,approved_at<=now() AS approved";

function refuseTenant(){if(isTenant||tenantId)throw new Error('Release gate commands are refused in a tenant process.');}
/** Optional gates record qualification that does not block ordinary provisioning. tenant-capacity-resize
 * attests actual Fly machine resize, volume extend and guest filesystem growth behaviour in staging. */
export const optionalGates=['tenant-capacity-resize'];
function gateName(value:string){
  if(!infrastructureGates.includes(value)&&!optionalGates.includes(value))throw new Error(`Unknown gate. Required gates: ${infrastructureGates.join(', ')}. Optional gates: ${optionalGates.join(', ')}`);
  return value;
}
function evidenceUri(value:string){
  let url:URL|undefined;try{url=new URL(value);}catch{/* rejected below */}
  if(!url||!['https:','s3:','file:'].includes(url.protocol)||value.length>2048||/[\s\u0000-\u001f\u007f]/.test(value))throw new Error('Evidence must be an absolute https:, s3: or file: URI without whitespace.');
  if(url.username||url.password||/@/.test(url.host))throw new Error('Evidence URIs must not carry credentials.');
  return value;
}
function evidenceDigest(value:string){
  if(!/^[a-f0-9]{64}$/i.test(value))throw new Error('Evidence SHA-256 must be 64 hexadecimal characters.');
  return value.toLowerCase();
}
function reviewerName(value:string){
  if(!/^[\x21-\x7e][\x20-\x7e]{0,118}[\x21-\x7e]$|^[\x21-\x7e]$/.test(value))throw new Error('Reviewer must be 1-120 printable characters.');
  return value;
}
export async function releaseGateStatus(directory:Directory,image:string):Promise<ReleaseGateStatus>{
  pinnedImage(image);
  const gates=(await directory.pool.query<ReleaseGate>(`SELECT ${columns} FROM release_gates WHERE image_digest=$1 ORDER BY name`,[image])).rows;
  const missing=infrastructureGates.filter(name=>!gates.some(gate=>gate.name===name&&gate.approved&&gate.evidence_uri!==''));
  // Rows recorded before provenance was required (or by other tools) are reported, never silently trusted.
  const incomplete=gates.filter(gate=>!gate.evidence_sha256||!gate.reviewer).map(gate=>gate.name);
  return {image,qualified:missing.length===0,required:infrastructureGates,missing,incomplete,gates};
}
export async function releaseGatesCommand(args:string[],directory:Directory){
  refuseTenant();
  const flags=args.filter(a=>a.startsWith('--')),positional=args.filter(a=>!a.startsWith('--'));
  if(flags.some(flag=>flag!=='--approve'))throw new Error(`Unknown option.\n${usage}`);
  const [command,image='',...rest]=positional;
  if(command==='record'){
    if(rest.length!==4)throw new Error(usage);
    pinnedImage(image);const gate=gateName(rest[0]),evidence=evidenceUri(rest[1]),digest=evidenceDigest(rest[2]),reviewer=reviewerName(rest[3]),approve=flags.includes('--approve');
    return directory.transaction(async client=>{
      const previous=(await client.query<ReleaseGate>(`SELECT ${columns} FROM release_gates WHERE name=$1 AND image_digest=$2 FOR UPDATE`,[gate,image])).rows[0]??null;
      const current=(await client.query<ReleaseGate>(`INSERT INTO release_gates(name,image_digest,evidence_uri,evidence_sha256,reviewer,approved_at)
        VALUES($1,$2,$3,$4,$5,CASE WHEN $6::boolean THEN now() ELSE 'infinity'::timestamptz END)
        ON CONFLICT(name,image_digest) DO UPDATE SET evidence_uri=EXCLUDED.evidence_uri,evidence_sha256=EXCLUDED.evidence_sha256,reviewer=EXCLUDED.reviewer,approved_at=EXCLUDED.approved_at
        RETURNING ${columns}`,[gate,image,evidence,digest,reviewer,approve])).rows[0];
      return {image,gate:current,previous};
    });
  }
  if(flags.length||rest.length)throw new Error(usage);
  if(command==='list')return releaseGateStatus(directory,image);
  if(command==='verify'){
    try{await assertQualifiedImage(directory.pool,image);}
    catch(error){
      const status=await releaseGateStatus(directory,image).catch(()=>null);
      const detail=status?` Missing or unapproved: ${status.missing.join(', ')||'none (check evidence_uri and approved_at)'}.`:'';
      throw new Error(`${error instanceof Error?error.message:'Verification failed.'}${detail}`);
    }
    return {image,qualified:true,required:infrastructureGates};
  }
  throw new Error(usage);
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  try{
    refuseTenant();
    if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL is required.');
    const directory=new Directory();
    try{console.log(JSON.stringify(await releaseGatesCommand(process.argv.slice(2),directory),null,2));}
    finally{await directory.pool.end();}
  }catch(error){
    const message=error instanceof Error?error.message:'Release gate command failed.';
    console.error((error as {code?:string})?.code==='42P01'?`${message} The release_gates table is missing; run the directory migration first.`:message);
    process.exitCode=1;
  }
}
