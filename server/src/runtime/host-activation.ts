import fs from 'node:fs/promises';
import type {HostOwner,HostPolicy} from '../platform/host-control.js';
export class HostActivation {
  constructor(private origin:string,private tokenFile:string,private owner:HostOwner,private request=fetch){
    const url=new URL(origin);if(url.protocol!=='https:'||url.username||url.password||!tokenFile.startsWith('/run/swarm-host/'))throw new Error('Invalid host control transport.');
  }
  private async call(path:string,body?:unknown){
    const token=(await fs.readFile(this.tokenFile,'utf8')).trim();
    const response=await this.request(new URL(`/internal/host/${path}`,this.origin),{method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    if(!response.ok){await response.body?.cancel();throw new Error('Host control authorization unavailable.');}
    const reader=response.body?.getReader();if(!reader)throw new Error('Missing host control response.');
    let bytes=0;const chunks:Uint8Array[]=[];
    try{while(true){const next=await reader.read();if(next.done)break;bytes+=next.value.length;if(bytes>16384)throw new Error('Host control response too large.');chunks.push(next.value);}}
    finally{await reader.cancel();}
    return JSON.parse(Buffer.concat(chunks).toString());
  }
  async policy():Promise<HostPolicy>{
    const policy=await this.call('policy');
    if(policy.tenant!==this.owner.tenant||policy.generation!==this.owner.generation||policy.machine!==this.owner.machine||!/^\d+$/.test(policy.revision)||!['hold','run'].includes(policy.desired))throw new Error('Host policy identity mismatch.');
    return policy;
  }
  async report(policy:HostPolicy,state:'held'|'running',error?:'host_requires_reconciliation'){
    if(policy.tenant!==this.owner.tenant||policy.generation!==this.owner.generation||policy.machine!==this.owner.machine)throw new Error('Host policy identity mismatch.');
    await this.call('state',{revision:policy.revision,state,...(error?{error}:{})});
  }
}
