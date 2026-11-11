import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
export function assertBootableRelease(release,desktopProfile) {
  if(release?.buildMode!=='verified')throw Error('Unverified/dry-run host images cannot start tenant workloads');
  if(!/^[a-f0-9]{40}$/.test(release.sourceCommit??''))throw Error('Release source commit is missing');
  if(!desktopProfile||createHash('sha256').update(desktopProfile).digest('hex')!==release.desktopSeccompSha256)throw Error('Desktop seccomp profile does not match the release');
  for(const key of ['appImage','runnerImage','mcpImage','desktopImage']){
    if(!/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(release[key]??'')||!/^sha256:[a-f0-9]{64}$/.test(release.imageIds?.[key]??''))throw Error('Verified release image binding missing');
  }
}
if(process.argv[1]===fileURLToPath(import.meta.url))assertBootableRelease(JSON.parse(fs.readFileSync(process.argv[2],'utf8')),fs.readFileSync(process.argv[3]));
