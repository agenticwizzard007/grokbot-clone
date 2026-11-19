/** Trusted VM host only. Never expose the host token or these inputs to a workload. */
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';

export const usageIntervalMs=30_000;
export function usageCollectionEnabled(value:string|undefined){
  if(value===undefined||value==='0')return false;
  if(value==='1')return true;
  throw new Error('TENANT_USAGE_COLLECTION must be unset, 0 or 1.');
}
export interface UsageSnapshot {at:number;monotonic:number;cpu:number[];memory:number;usedBytes:number}
export interface HostUsageReport {
  version:1;volume:string;stream:string;sequence:number;at:number;intervalMs:number;
  cpu:number;memory:number;usedBytes:number;
}
const natural=(v:number)=>Number.isSafeInteger(v)&&v>=0;
export function cpuCounters(text:string){
  const line=text.split('\n').find(line=>/^cpu\s/.test(line));
  const fields=line?.trim().split(/\s+/).slice(1);
  if(!fields||fields.length<8||fields.some(v=>!/^\d+$/.test(v)))throw new Error('Invalid host CPU counters.');
  // Linux guest/guest_nice are already counted in user/nice. Do not add them twice.
  const counters=fields.slice(0,8).map(Number);
  if(!counters.every(natural)||!natural(counters.reduce((a,b)=>a+b,0)))throw new Error('Invalid host CPU counters.');
  return counters;
}
export function memoryPressure(text:string){
  const read=(key:string)=>{
    const rows=text.split('\n').filter(line=>line.startsWith(`${key}:`));
    const match=rows.length===1&&rows[0].match(new RegExp(`^${key}:\\s+(\\d+) kB\\s*$`));
    if(!match)throw new Error('Invalid host memory counters.');
    return Number(match[1]);
  };
  const total=read('MemTotal'),available=read('MemAvailable');
  if(!natural(total)||!total||!natural(available)||available>total)throw new Error('Invalid host memory counters.');
  return (total-available)/total;
}
export function volumeUsedBytes(s:{blocks:number;bavail:number;bfree:number;bsize:number}){
  if(!Object.values(s).every(natural)||!s.blocks||!s.bsize||s.bavail>s.bfree||s.bfree>s.blocks)throw new Error('Invalid host volume counters.');
  // Count reserved blocks as unavailable to the unprivileged tenant too.
  const bytes=(s.blocks-s.bavail)*s.bsize;
  if(!natural(bytes)||!natural(s.blocks*s.bsize))throw new Error('Invalid host volume counters.');
  return bytes;
}
export async function readHostUsage():Promise<UsageSnapshot>{
  const [cpu,memory,volume,root,disk]=await Promise.all([
    fs.readFile('/proc/stat','utf8'),fs.readFile('/proc/meminfo','utf8'),fs.lstat('/data'),fs.stat('/'),fs.statfs('/data'),
  ]);
  if(!volume.isDirectory()||volume.isSymbolicLink()||volume.dev===root.dev)throw new Error('Usage requires the mounted tenant volume.');
  return {at:Date.now(),monotonic:performance.now(),cpu:cpuCounters(cpu),memory:memoryPressure(memory),usedBytes:volumeUsedBytes({blocks:disk.blocks,bavail:disk.bavail,bfree:disk.bfree,bsize:disk.bsize})};
}
export function intervalUsage(previous:UsageSnapshot,current:UsageSnapshot){
  const intervalMs=current.at-previous.at,elapsed=current.monotonic-previous.monotonic;
  if(intervalMs<15_000||intervalMs>60_000||elapsed<15_000||elapsed>60_000||Math.abs(intervalMs-elapsed)>2000)throw new Error('Host usage clock or interval changed.');
  if(previous.cpu.length!==8||current.cpu.length!==8)throw new Error('Invalid host CPU counters.');
  const delta=current.cpu.map((v,i)=>v-previous.cpu[i]);
  if(!delta.every(natural))throw new Error('Host CPU counters reset.');
  const total=delta.reduce((a,b)=>a+b,0);
  if(!natural(total)||!total)throw new Error('Host CPU interval is empty.');
  // idle and iowait are not CPU work. Steal remains pressure on the allocated VM.
  return {intervalMs,cpu:(total-delta[3]-delta[4])/total};
}
/** Serial, bounded sampling. A pause, failed delivery or epoch change starts a new
 * window; no backlog or extrapolation across backups, holds, suspend or restarts. */
export class HostUsageCollector {
  private busy=false;
  private previous?:UsageSnapshot;
  private epoch?:number;
  private stream=randomUUID();
  private sequence=0;
  constructor(private volume:string,private currentEpoch:()=>number|undefined,
    private send:(report:HostUsageReport)=>Promise<void>,private snapshot=readHostUsage){}
  private reset(){this.previous=undefined;this.epoch=undefined;this.stream=randomUUID();this.sequence=0;}
  async tick(){
    if(this.busy)return;
    this.busy=true;
    try{
      const epoch=this.currentEpoch();
      if(epoch===undefined){this.reset();return;}
      const current=await this.snapshot();
      if(this.currentEpoch()!==epoch){this.reset();return;}
      if(this.epoch!==epoch){this.reset();this.epoch=epoch;}
      const previous=this.previous;this.previous=current;
      if(!previous)return;
      const interval=intervalUsage(previous,current);
      await this.send({version:1,volume:this.volume,stream:this.stream,sequence:++this.sequence,
        at:current.at,...interval,memory:current.memory,usedBytes:current.usedBytes});
      if(this.currentEpoch()!==epoch)this.reset();
    }catch{this.reset();throw new Error('Host usage unavailable; a fresh window is required.');}
    finally{this.busy=false;}
  }
}
export function hostUsageTransport(origin:string,tokenFile:string,request=fetch,readToken=async(file:string)=>(await fs.readFile(file,'utf8')).trim()){
  const url=new URL('/internal/host/usage',origin);
  if(url.protocol!=='https:'||url.username||url.password||tokenFile!=='/run/swarm-host/host-token')throw new Error('Invalid host usage transport.');
  return async(report:HostUsageReport)=>{
    const token=await readToken(tokenFile);
    const response=await request(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),
      headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(report)});
    // No response body is needed; an unbounded or stalled body cannot delay sampling.
    void response.body?.cancel().catch(()=>{});
    if(response.status!==204)throw new Error('Host usage was not accepted.');
  };
}
