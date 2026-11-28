import {createHash} from 'node:crypto';

/** Shared deterministic provider namespaces. Never include raw customer identifiers. */
export class TenantNames {
  name(tenant:string){if(!/^usr_[A-Za-z0-9_-]{8,100}$/.test(tenant))throw new Error('Invalid tenant.');return `swarm-u-${createHash('sha256').update(tenant).digest('hex').slice(0,32)}`;}
  network(tenant:string){this.name(tenant);return `tenant-${createHash('sha256').update(tenant).digest('hex').slice(0,32)}`;}
  volumeName(tenant:string){this.name(tenant);return `tenant_${createHash('sha256').update(tenant).digest('hex').slice(0,16)}`;}
  deploymentVolumeName(tenant:string,operation:string){this.name(tenant);if(!/^[a-f0-9]{32}$/.test(operation))throw new Error('Invalid deployment operation.');return `v_${createHash('sha256').update(JSON.stringify([tenant,operation])).digest('hex').slice(0,26)}`;}
}
