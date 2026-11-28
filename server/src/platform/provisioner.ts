import { Directory } from './directory.js';
import { FlyTenants } from './fly-tenants.js';
import { DockerTenants } from './docker-tenants.js';
import { TenantEnvelopes } from './envelopes.js';
import { pinnedImage } from '../runtime/container-policy.js';
import { BackupCatalog } from './backups.js';
import { S3BackupStorage } from './backup-storage.js';
import {LifecycleWorker} from './lifecycle-worker.js';
import {EnvironmentWorker} from './environment-operations.js';
import {assertProvisioningImage,tenantDriver} from './release-policy.js';
import {pruneSignupMetadata} from './signup.js';
import {pruneSessionMetadata} from './tenant-sessions.js';
import {startOperationsMetrics,OperationsActivity} from './operations-metrics.js';
import {pruneHostUsage} from './host-usage.js';
import {usageCollectionEnabled} from '../runtime/host-usage.js';
export {infrastructureGates} from './release-policy.js';
export function createTenantDriver() {
  return tenantDriver()==='docker' ? new DockerTenants() : new FlyTenants();
}
export async function startProvisioner() {
  usageCollectionEnabled(process.env.TENANT_USAGE_COLLECTION);
  const fly=createTenantDriver(),directory=new Directory(),envelopes=new TenantEnvelopes(directory);
  const backups=new BackupCatalog(directory,new S3BackupStorage());
  const image=pinnedImage(process.env.TENANT_HOST_IMAGE??'');
  await assertProvisioningImage(directory.pool,image);
  const concurrency=Number(process.env.PROVISIONER_CONCURRENCY??8);
  if(!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>64)throw new Error('Invalid provisioner worker count.');
  const worker=new LifecycleWorker(directory,{fly,envelopes,backups,image,region:process.env.TENANT_REGION??''});
  const environments=new EnvironmentWorker(directory,fly);
  const running=new Set<Promise<unknown>>();let closing=false;
  let tickFailures=0,retentionFailures=0,retentionLastSuccess=0;
  const activity=new OperationsActivity();
  const metrics=await startOperationsMetrics(directory,'provisioner',{state:()=>({
    ready:!closing,tickFailures,retentionFailures,retentionLastSuccess,oldestTickSeconds:activity.oldestSeconds(),
  })}).catch(async error=>{await directory.pool.end();throw error;});
  const interval=setInterval(()=>{
    if(closing)return;
    for(let slot=running.size;slot<concurrency;slot++){
      const task=activity.run(()=>worker.tick().then(result=>result==='idle'?environments.tick():result)).catch(()=>{tickFailures++;}).finally(()=>running.delete(task));running.add(task);
    }
  },1000);
  let pruning:Promise<unknown>|undefined;
  const retention=setInterval(()=>{if(pruning||closing)return;pruning=Promise.allSettled([backups.prune(),environments.pruneRetiredVolumes(),pruneSignupMetadata(directory),pruneSessionMetadata(directory),pruneHostUsage(directory)])
    .then(results=>{const failures=results.filter(result=>result.status==='rejected').length;retentionFailures+=failures;if(!failures)retentionLastSuccess=Date.now()/1000;})
    .finally(()=>{pruning=undefined;});},60000);
  return {close:async()=>{closing=true;clearInterval(interval);clearInterval(retention);await Promise.allSettled([...running,...(pruning?[pruning]:[]),...(metrics?[metrics.close()]:[])]);},directory};
}
