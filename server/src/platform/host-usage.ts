import {Hono} from 'hono';
import type {Directory} from './directory.js';
import type {RuntimeIdentity} from './runtime-identity.js';
import type {HostUsageReport} from '../runtime/host-usage.js';
import {validateFilesystems} from '../runtime/host-usage.js';
import type {PoolClient} from 'pg';
import type {CapacitySample} from './tenant-capacity.js';

function validateReport(value:unknown):asserts value is HostUsageReport {
  const keys=['version','volume','stream','sequence','at','intervalMs','cpu','memory','usedBytes'];
  if(value&&typeof value==='object'&&(value as {version?:unknown}).version===2)keys.push('filesystems');
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||Object.keys(value).some(k=>!keys.includes(k)))throw new Error('Invalid usage report fields.');
  const v=value as HostUsageReport;
  const integer=(n:number,min:number,max:number)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
  if(![1,2].includes(v.version)||typeof v.volume!=='string'||!/^vol_[A-Za-z0-9]{1,100}$/.test(v.volume)
    ||typeof v.stream!=='string'||!/^([a-f0-9]{8}-){1}[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v.stream)
    ||!integer(v.sequence,1,Number.MAX_SAFE_INTEGER)||!integer(v.at,1,Number.MAX_SAFE_INTEGER)||!integer(v.intervalMs,15000,60000)
    ||![v.cpu,v.memory].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1)||!integer(v.usedBytes,0,10000*1024**3))throw new Error('Invalid usage report values.');
  if(v.version===2){
    validateFilesystems(v.filesystems);
    if(v.usedBytes!==v.filesystems.data.totalBytes-v.filesystems.data.availableBytes)throw new Error('Inconsistent tenant volume usage.');
  }
}

export class HostUsage {
  constructor(readonly directory:Directory,private runtime:RuntimeIdentity){}
  async accept(token:string,value:unknown){
    validateReport(value);
    // Copy before any await; a caller cannot mutate the admitted sample during a lock wait.
    const input=structuredClone(value);
    return this.directory.transaction(async client=>{
      const owner=await this.runtime.verify(token,'swarm-host',client);
      // All lifecycle writers lock tenants first. Lock policy separately, then
      // read it in a fresh statement: a locking WHERE can be evaluated before a wait.
      await client.query('SELECT tenant_id FROM host_policies WHERE tenant_id=$1 FOR UPDATE',[owner.tenant]);
      await this.runtime.verify(token,'swarm-host',client);
      const current=(await client.query(`SELECT t.volume_id,p.revision,extract(epoch FROM clock_timestamp())*1000 AS now
        FROM tenants t JOIN host_policies p ON p.tenant_id=t.id WHERE t.id=$1 AND t.state='active'
        AND p.generation=t.generation AND p.machine_id=t.machine_id AND p.desired='run' AND p.observed='running'
        AND p.acknowledged_revision=p.revision AND p.error_code IS NULL AND p.reported_at>clock_timestamp()-interval '4 minutes'`,[owner.tenant])).rows[0];
      const now=Number(current?.now);
      if(!current||current.volume_id!==input.volume||input.at>now||now-input.at>15000)throw new Error('Usage ownership, readiness or freshness changed.');
      const last=(await client.query('SELECT * FROM host_usage_samples WHERE tenant_id=$1 ORDER BY at DESC LIMIT 1',[owner.tenant])).rows[0];
      const continuation=last&&last.stream===input.stream&&String(last.generation)===owner.generation&&last.machine_id===owner.machine&&last.volume_id===input.volume&&String(last.host_revision)===String(current.revision);
      if(last&&(input.at<=Number(last.at)||now-new Date(last.received_at).getTime()<15000))throw new Error('Usage is duplicate, out of order or too frequent.');
      if(continuation){
        if(input.sequence!==Number(last.sequence)+1||input.at-Number(last.at)!==input.intervalMs)throw new Error('Usage window is incomplete.');
      }else{
        if(input.sequence!==1)throw new Error('A fresh host usage window is required.');
        await client.query('DELETE FROM host_usage_samples WHERE tenant_id=$1',[owner.tenant]);
      }
      await client.query(`INSERT INTO host_usage_samples(tenant_id,generation,machine_id,volume_id,host_revision,stream,sequence,at,interval_ms,cpu,memory,used_bytes,filesystems)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[owner.tenant,owner.generation,owner.machine,input.volume,current.revision,input.stream,input.sequence,input.at,input.intervalMs,input.cpu,input.memory,input.usedBytes,input.version===2?input.filesystems:null]);
      await client.query(`DELETE FROM host_usage_samples WHERE tenant_id=$1 AND (at<$2 OR at NOT IN
        (SELECT at FROM host_usage_samples WHERE tenant_id=$1 ORDER BY at DESC LIMIT 120))`,[owner.tenant,Math.floor(now)-3600000]);
    });
  }
}

/** Trusted operator export only; no browser/tenant route. No reviewer or gate is fabricated. */
async function currentHostUsage(client:PoolClient,tenant:string){
  await client.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE',[tenant]);
  await client.query('SELECT tenant_id FROM host_policies WHERE tenant_id=$1 FOR UPDATE',[tenant]);
  const rows=(await client.query(`SELECT s.*,extract(epoch FROM clock_timestamp())*1000 AS now FROM host_usage_samples s
    JOIN tenants t ON t.id=s.tenant_id JOIN host_policies p ON p.tenant_id=t.id
    WHERE t.id=$1 AND t.state='active' AND s.generation=t.generation AND s.machine_id=t.machine_id AND s.volume_id=t.volume_id
    AND p.generation=t.generation AND p.machine_id=t.machine_id AND s.host_revision=p.revision AND p.desired='run'
    AND p.observed='running' AND p.acknowledged_revision=p.revision AND p.error_code IS NULL AND p.reported_at>clock_timestamp()-interval '4 minutes'
    AND s.at>=extract(epoch FROM clock_timestamp())*1000-3600000 ORDER BY s.at DESC LIMIT 120`,[tenant])).rows.reverse();
  if(rows.length<3||Number(rows.at(-1).now)-Number(rows.at(-1).at)>60000)throw new Error('No fresh complete host usage window.');
  if(rows.some((r,i)=>r.stream!==rows[0].stream||i&&(Number(r.sequence)!==Number(rows[i-1].sequence)+1||Number(r.at)-Number(rows[i-1].at)!==r.interval_ms)))throw new Error('Host usage window is incomplete.');
  return rows;
}
const capacitySample=(r:any):CapacitySample=>({tenant:r.tenant_id,generation:String(r.generation),machine:r.machine_id,volume:r.volume_id,at:Number(r.at),cpu:r.cpu,memory:r.memory,usedBytes:Number(r.used_bytes)});
export async function exportHostUsage(directory:Directory,tenant:string):Promise<CapacitySample[]>{
  return directory.transaction(async client=>(await currentHostUsage(client,tenant)).map(capacitySample));
}
/** Diagnostic window only. Root disk/inodes never become tenant-volume growth input. */
export async function exportHostPressure(directory:Directory,tenant:string){
  return directory.transaction(async client=>(await currentHostUsage(client,tenant)).map(row=>{
    if(row.filesystems===null)throw new Error('Host filesystem measurements are unavailable; upgrade the host and collect a new window.');
    validateFilesystems(row.filesystems);
    if(Number(row.used_bytes)!==row.filesystems.data.totalBytes-row.filesystems.data.availableBytes)throw new Error('Inconsistent stored filesystem usage.');
    return {...capacitySample(row),filesystems:row.filesystems};
  }));
}
export async function pruneHostUsage(directory:Directory){
  await directory.pool.query(`DELETE FROM host_usage_samples s USING tenants t WHERE s.tenant_id=t.id
    AND (s.received_at<clock_timestamp()-interval '1 hour' OR t.state IN ('deleting','deleted') OR s.generation!=t.generation OR s.machine_id IS DISTINCT FROM t.machine_id OR s.volume_id IS DISTINCT FROM t.volume_id)`);
}
async function readReport(request:Request){
  if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')throw new Error('Usage requires JSON.');
  const reader=request.body?.getReader();if(!reader)throw new Error('Missing usage body.');
  let timer:ReturnType<typeof setTimeout>|undefined;
  const timeout=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Usage body timed out.')),2000);});
  try{
    let bytes=0;const chunks:Uint8Array[]=[];
    for(;;){const next=await Promise.race([reader.read(),timeout]);if(next.done)break;bytes+=next.value.length;if(bytes>2048)throw new Error('Usage body is oversized.');chunks.push(next.value);}
    return JSON.parse(Buffer.concat(chunks).toString());
  }finally{clearTimeout(timer);void reader.cancel().catch(()=>{});}
}
export function hostUsageRoutes(usage:HostUsage,runtime:RuntimeIdentity,enabled:boolean){
  const app=new Hono();
  let pending=0;
  app.post('/',async c=>{
    if(!enabled)return c.json({error:'Host usage collection is disabled.'},404);
    // Bound telemetry work before authentication/body/DB awaits. Hosts discard a
    // refused window and wait for their next tick; never build a shared backlog.
    if(pending>=32)return c.json({error:'Host usage collector is busy.'},503);
    pending++;
    try{
    const token=(c.req.header('authorization')??'').replace(/^Bearer /,'');
    try{await runtime.verify(token,'swarm-host');}catch{return c.json({error:'Host authorization required.'},401);}
    let body;try{body=await readReport(c.req.raw);}catch{return c.json({error:'Invalid bounded usage report.'},400);}
    try{await usage.accept(token,body);return c.body(null,204);}catch{return c.json({error:'Host usage changed or requires a fresh window.'},409);}
    }finally{pending--;}
  });
  return app;
}
