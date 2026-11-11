// Builds one source revision. Only the explicit publish path receives registry/signing credentials.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {generateKeyPairSync} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {publicKey} from './release-inputs.mjs';
export function validatePipeline(mode,source,app,lock){
  if(!['dry-run','publish'].includes(mode)||!/^[a-f0-9]{40}$/.test(source))throw Error('Expected --dry-run or --publish and an exact RELEASE_SOURCE_SHA');
  if(mode==='publish'&&!/^[a-z][a-z0-9-]{2,60}$/.test(app??''))throw Error('REGISTRY_APP must name the approved Fly registry app');
  for(const name of ['nodeImage','dockerImage'])if(!/^docker\.io\/library\/[a-z]+@sha256:[a-f0-9]{64}$/.test(lock[name]??''))throw Error(`Unpinned ${name}`);
  if(lock.platform!=='linux/amd64'||!/^\d{8}T\d{6}Z$/.test(lock.debianSnapshot)||!/^\d+\.\d+\.\d+\.\d+-\d+$/.test(lock.chromeVersion)||!/^[a-f0-9]{64}$/.test(lock.chromeSha256))throw Error('Invalid locked platform/package inputs');
  if(!/^\d+\.\d+\.\d+$/.test(lock.dockerVersion)||!/^[a-f0-9]{64}$/.test(lock.dockerStaticSha256)||!/^\d+\.\d+\.\d+$/.test(lock.npmVersion)||!/^sha512-[A-Za-z0-9+/]{86}==$/.test(lock.npmIntegrity))throw Error('Invalid Docker/npm release checksums');
  if(!/^[0-9a-zA-Z:.+~-]+$/.test(lock.zlibVersion??''))throw Error('Invalid zlib package version');
}
export function main(args=process.argv.slice(2),environment=process.env){
  if(args.length!==1)throw Error('Usage: release-images.mjs --dry-run | --publish');
  const mode=args[0].replace(/^--/,''),source=environment.RELEASE_SOURCE_SHA,app=environment.REGISTRY_APP;
  const lock=JSON.parse(fs.readFileSync('infra/tenant-host/images.lock.json','utf8'));
  validatePipeline(mode,source,app,lock);
  const childEnv={...environment,PATH:`${path.resolve('.context/tenant-tools')}:${environment.PATH}`};
  for(const key of ['FLY_IMAGE_PUSH_TOKEN','COSIGN_PRIVATE_KEY','COSIGN_PASSWORD','TENANT_PLATFORM_PUBLIC_KEY'])delete childEnv[key];
  const run=(command,argv,options={})=>{
    const result=spawnSync(command,argv,{env:childEnv,encoding:'utf8',stdio:'inherit',...options});
    if(result.error)throw result.error;
    if(result.status!==0)throw Error(`${command} ${argv[0]} failed (${result.status??result.signal})`);
    return result.stdout?.trim();
  };
  const read=(command,argv,options={})=>run(command,argv,{stdio:['ignore','pipe','inherit'],...options});
  if(read('git',['rev-parse','HEAD'])!==source)throw Error('Checked-out source differs from RELEASE_SOURCE_SHA');
  if(mode==='publish'){
    if(environment.GITHUB_ACTIONS!=='true'||environment.GITHUB_REF!=='refs/heads/main')throw Error('Publishing runs only from the protected main workflow');
    run('git',['merge-base','--is-ancestor',source,'origin/main']);
    if(read('git',['status','--porcelain']))throw Error('Publishing requires clean reviewed source');
    for(const key of ['FLY_IMAGE_PUSH_TOKEN','COSIGN_PRIVATE_KEY','TENANT_PLATFORM_PUBLIC_KEY'])if(!environment[key])throw Error(`Missing ${key}`);
    publicKey(environment.TENANT_PLATFORM_PUBLIC_KEY);
  }
  const privateDir=fs.mkdtempSync(path.resolve('.context/tenant-image-private-'));
  fs.chmodSync(privateDir,0o700);
  childEnv.DOCKER_CONFIG=path.join(privateDir,'docker');fs.mkdirSync(childEnv.DOCKER_CONFIG,{mode:0o700});
  const reportDir='.context/tenant-release/reports';fs.rmSync(reportDir,{recursive:true,force:true});fs.mkdirSync(reportDir,{recursive:true});
  const keyFile=path.join(privateDir,'cosign.key'),verifyFile=path.join(privateDir,'cosign.pub'),platformKey=path.join(privateDir,'platform.pub');
  const signingEnv={...childEnv,COSIGN_PASSWORD:environment.COSIGN_PASSWORD??''};
  const suffix=`${source.slice(0,12)}-${environment.GITHUB_RUN_ID??'local'}-${environment.GITHUB_RUN_ATTEMPT??'1'}`;
  if(!/^[a-z0-9-]+$/.test(suffix))throw Error('Invalid release tag suffix');
  const tag=name=>mode==='publish'?`registry.fly.io/${app}:${name}-${suffix}`:`swarm-tenant-${name}:${suffix}`;
  const build=(name,file,buildArgs={})=>{
    const image=tag(name);run('docker',['build','--platform=linux/amd64','-f',file,'--label',`org.opencontainers.image.revision=${source}`,...Object.entries(buildArgs).flatMap(([key,value])=>['--build-arg',`${key}=${value}`]),'-t',image,'.']);return image;
  };
  const failedScans=[];
  const scan=(name,image)=>{
    try{run('trivy',['image','--image-src','docker','--scanners','vuln','--severity','HIGH,CRITICAL','--exit-code','1','--format','json','--output',`${reportDir}/${name}.json`,image]);}
    catch(error){if(mode==='publish')throw error;failedScans.push(name);console.error(`Dry-run scan failed for ${name}; collecting remaining evidence, final result will fail.`);}
  };
  const inspected=image=>JSON.parse(read('docker',['image','inspect',image]))[0];
  const publish=image=>{
    run('docker',['push',image]);
    const digest=inspected(image).RepoDigests?.find(value=>value.startsWith(`registry.fly.io/${app}@sha256:`));
    if(!digest||!/@sha256:[a-f0-9]{64}$/.test(digest))throw Error('Pushed image digest could not be resolved');
    run('cosign',['sign','--yes','--key',keyFile,digest],{env:signingEnv});
    run('cosign',['verify','--key',verifyFile,digest]);
    return digest;
  };
  try{
    if(mode==='publish'){
      fs.writeFileSync(keyFile,environment.COSIGN_PRIVATE_KEY,{mode:0o600});
      fs.writeFileSync(verifyFile,read('cosign',['public-key','--key',keyFile],{env:signingEnv}),{mode:0o600});
      fs.writeFileSync(platformKey,environment.TENANT_PLATFORM_PUBLIC_KEY,{mode:0o600});
      run('docker',['login','registry.fly.io','--username','x','--password-stdin'],{input:environment.FLY_IMAGE_PUSH_TOKEN+'\n',stdio:['pipe','inherit','inherit']});
    }else{
      fs.writeFileSync(platformKey,generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'}),{mode:0o600});
    }
    const common={NODE_IMAGE:lock.nodeImage,DEBIAN_SNAPSHOT:lock.debianSnapshot,ZLIB_VERSION:lock.zlibVersion};
    const images={
      app:build('app','Dockerfile',{...common,NPM_VERSION:lock.npmVersion,NPM_INTEGRITY:lock.npmIntegrity}),
      hostBase:build('host-base','infra/tenant-host/HostBase.Dockerfile',{...common,DOCKER_IMAGE:lock.dockerImage,DOCKER_VERSION:lock.dockerVersion,DOCKER_STATIC_SHA256:lock.dockerStaticSha256}),
    };
    for(const [name,image] of Object.entries(images))scan(name,image);
    // Both bases are scanned/signed before a publish build references their immutable registry digests.
    const refs=mode==='publish'?Object.fromEntries(Object.entries(images).map(([name,image])=>[name,publish(image)])):{...images};
    images.desktopBase=build('desktop-base','infra/tenant-host/DesktopBase.Dockerfile',{...common,CHROME_VERSION:lock.chromeVersion,CHROME_SHA256:lock.chromeSha256,ZLIB_VERSION:lock.zlibVersion});
    scan('desktopBase',images.desktopBase);
    refs.desktopBase=mode==='publish'?publish(images.desktopBase):images.desktopBase;
    images.desktop=build('desktop','infra/tenant-host/Desktop.Dockerfile',{DESKTOP_BASE:refs.desktopBase});
    scan('desktop',images.desktop);
    // Dry-run is build/scan only and needs no delegated runtime cgroups. Publication additionally requires image smoke.
    if(mode==='publish')run('bash',['infra/tenant-host/smoke-images.sh',images.app,images.hostBase,images.desktop]);
    refs.desktop=mode==='publish'?publish(images.desktop):images.desktop;
    const hostTag=tag('host');
    const releaseEnv={...childEnv,RELEASE_SOURCE_SHA:source,APP_IMAGE:refs.app,RUNNER_IMAGE:refs.app,MCP_IMAGE:refs.app,
      DESKTOP_IMAGE:refs.desktop,HOST_BASE:refs.hostBase,HOST_IMAGE_TAG:hostTag,PLATFORM_PUBLIC_KEY_FILE:platformKey,IMAGE_VERIFICATION_KEY:verifyFile};
    run('bash',['infra/tenant-host/build-release.sh',...(mode==='dry-run'?['--dry-run']:[])],{env:releaseEnv});
    scan('host',hostTag);
    const host=mode==='publish'?publish(hostTag):inspected(hostTag).Id;
    const release=JSON.parse(fs.readFileSync('.context/tenant-release/release.json','utf8'));
    const record={mode,sourceCommit:source,lockedInputs:lock,components:refs,runner:refs.app,mcp:refs.app,hostImage:host,
      desktopSeccompSha256:release.desktopSeccompSha256,ffmpeg:release.ffmpeg,failedScans,
      liveInfrastructureQualified:false};
    fs.writeFileSync(`${reportDir}/images.json`,JSON.stringify(record,null,2)+'\n');
    if(mode==='publish')fs.copyFileSync(verifyFile,`${reportDir}/cosign.pub`);
    if(!failedScans.length&&environment.GITHUB_OUTPUT)fs.appendFileSync(environment.GITHUB_OUTPUT,`host_image_digest=${mode==='publish'?host:''}\nhost_image_id=${inspected(hostTag).Id}\npublished=${mode==='publish'}\n`);
    console.log(JSON.stringify(record,null,2));
    if(failedScans.length)throw Error(`Image qualification failed: ${failedScans.join(', ')}. No images were published.`);
  }finally{
    // Registry configuration and key material never enter build contexts or uploaded artifacts.
    fs.rmSync(privateDir,{recursive:true,force:true});
  }
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  try{fs.mkdirSync('.context',{recursive:true});main();}catch(error){console.error(error.message);process.exitCode=1;}
}
