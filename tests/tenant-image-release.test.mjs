import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {validateInputs,publicKey} from '../infra/tenant-host/release-inputs.mjs';
import {validatePipeline} from '../infra/tenant-host/release-images.mjs';
import {evaluateScan,validateExceptions,imageScope,MAX_EXCEPTION_DAYS} from '../infra/tenant-host/scan-gate.mjs';
import {assertChromeSandbox} from '../infra/tenant-host/sandbox-evidence.mjs';
import {assertBootableRelease} from '../infra/tenant-host/validate-release.mjs';
const source='a'.repeat(40),digest='b'.repeat(64),image=`registry.fly.io/test@sha256:${digest}`;
const profile=fs.readFileSync(new URL('../infra/tenant-host/chromium-seccomp.json',import.meta.url));
const lock=JSON.parse(fs.readFileSync(new URL('../infra/tenant-host/images.lock.json',import.meta.url)));
const pair=generateKeyPairSync('ed25519');
const pem=pair.publicKey.export({type:'spki',format:'pem'});
const inputs={RELEASE_BUILD_MODE:'verified',RELEASE_SOURCE_SHA:source,APP_IMAGE:image,RUNNER_IMAGE:image,MCP_IMAGE:image,DESKTOP_IMAGE:image,HOST_BASE:image,HOST_IMAGE_TAG:'registry.fly.io/test:host',IMAGE_VERIFICATION_KEY:'/key.pub'};
test('verified release rejects tags, missing trust keys and mutable source refs',()=>{
  validateInputs(inputs);
  for(const field of ['APP_IMAGE','RUNNER_IMAGE','MCP_IMAGE','DESKTOP_IMAGE','HOST_BASE'])assert.throws(()=>validateInputs({...inputs,[field]:'repo:latest'}),/registry digest/);
  assert.throws(()=>validateInputs({...inputs,IMAGE_VERIFICATION_KEY:''}),/required/);
  assert.throws(()=>validateInputs({...inputs,RELEASE_SOURCE_SHA:'main'}),/exact Git/);
  assert.throws(()=>validateInputs({...inputs,HOST_IMAGE_TAG:'repo:tag;command'}),/explicit image tag/);
});
test('platform signing private keys and wrong algorithms cannot enter release metadata',()=>{
  publicKey(pem);
  assert.throws(()=>publicKey(pair.privateKey.export({type:'pkcs8',format:'pem'})),/PUBLIC KEY/);
  assert.throws(()=>publicKey(generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({type:'spki',format:'pem'})),/Ed25519/);
});
test('publishing requires pinned upstream inputs and a bounded registry app',()=>{
  validatePipeline('publish',source,'approved-app',lock);
  for(const field of ['nodeImage','dockerImage'])assert.throws(()=>validatePipeline('publish',source,'approved-app',{...lock,[field]:'node:latest'}),/Unpinned/);
  assert.throws(()=>validatePipeline('publish',source,'x;echo bad',lock),/REGISTRY_APP/);
  assert.throws(()=>validatePipeline('publish',source,'approved-app',{...lock,npmIntegrity:'unverified'}),/checksums/);
  assert.throws(()=>validatePipeline('publish',source,'approved-app',{...lock,goImage:'golang:latest'}),/Unpinned goImage/);
  assert.throws(()=>validatePipeline('publish',source,'approved-app',{...lock,runtimeBuild:{...lock.runtimeBuild,runcCommit:'main'}}),/runtime source pins/);
  assert.throws(()=>validatePipeline('publish',source,'approved-app',{...lock,runtimeBuild:{...lock.runtimeBuild,goModuleUpgrades:['golang.org/x/net@latest']}}),/Go module upgrades/);
});
function manifest(){return {buildMode:'verified',sourceCommit:source,desktopSeccompSha256:createHash('sha256').update(profile).digest('hex'),appImage:image,runnerImage:image,mcpImage:image,desktopImage:image,imageIds:Object.fromEntries(['appImage','runnerImage','mcpImage','desktopImage'].map(k=>[k,`sha256:${digest}`]))};}
test('unverified hosts and a substituted desktop sandbox profile cannot boot',()=>{
  assertBootableRelease(manifest(),profile);
  for(const buildMode of ['dry-run','',undefined])assert.throws(()=>assertBootableRelease({...manifest(),buildMode},profile),/cannot start/);
  assert.throws(()=>assertBootableRelease(manifest(),Buffer.from('{}')),/seccomp profile/);
  assert.throws(()=>assertBootableRelease({...manifest(),appImage:'repo:latest'},profile),/binding/);
});
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tenant-images-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'infra'),{recursive:true});
  fs.cpSync(new URL('../infra/tenant-host',import.meta.url),path.join(root,'infra/tenant-host'),{recursive:true,filter:s=>!s.includes('/node_modules')});
  const bin=path.join(root,'.context/tenant-tools');fs.mkdirSync(bin,{recursive:true});
  const log=path.join(root,'calls.jsonl');
  const mock=`#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');const a=process.argv.slice(2),tool=path.basename(process.argv[1]);
fs.appendFileSync(process.env.MOCK_LOG,JSON.stringify({tool,args:a,secret:process.env.FLY_IMAGE_PUSH_TOKEN??null})+'\\n');
if(tool==='git'){if(a[0]==='rev-parse')console.log(process.env.MOCK_SOURCE);process.exit(0);}
if(tool==='cosign'){if(a[0]==='public-key')console.log(process.env.MOCK_PUBLIC_KEY);process.exit(process.env.MOCK_SIGNATURE_FAIL==='1'?1:0);}
if(tool==='trivy'){const p=a[a.indexOf('--output')+1];if(a.includes('--output'))fs.writeFileSync(p,process.env.MOCK_SCAN_REPORT?fs.readFileSync(process.env.MOCK_SCAN_REPORT):JSON.stringify({SchemaVersion:2,ArtifactName:'fixture',Results:[{Target:'fixture (debian 13)',Class:'os-pkgs'}]}));process.exit(process.env.MOCK_SCAN_FAIL==='1'?1:0);}
if(tool==='docker'){
 if(a[0]==='image'&&a[1]==='inspect'){
  if(process.env.MOCK_MISSING_BASE==='1'&&a[2].includes('host-base'))process.exit(1);
  const name=a[2],id='sha256:'+(name.includes('desktop')?'d':'c').repeat(64);
  console.log(JSON.stringify([{Id:id,Os:'linux',Architecture:'amd64',RepoDigests:['registry.fly.io/approved-app@'+id],Config:{Labels:{'org.opencontainers.image.revision':process.env.MOCK_BAD_REVISION==='1'?'0'.repeat(40):process.env.MOCK_SOURCE}}}]));
 }else if(a[0]==='create'){if(a.at(-2)!=='node'||a.at(-1)!=='--version'){console.error('no command specified');process.exit(1);}console.log('extract-fixture');}
 else if(a[0]==='cp'){
  const target=a[2];
  if(a[1].endsWith('/ffmpeg-build.json')){const c=JSON.parse(fs.readFileSync('infra/tenant-host/images.lock.json')).ffmpeg;fs.writeFileSync(target,JSON.stringify({...c,binaryVersion:'ffmpeg version '+c.version,binarySha256:require('node:crypto').createHash('sha256').update('binary-fixture').digest('hex')}));}
  else if(a[1].endsWith('/bin/ffmpeg'))fs.writeFileSync(target,'binary-fixture');
  else if(a[1].endsWith('/package.json'))fs.writeFileSync(target,'{}');
  else fs.mkdirSync(path.join(target,a[1].endsWith('node_modules')?'node_modules':'dist'),{recursive:true});
 }else if(a[0]==='save')fs.writeFileSync(a[a.indexOf('--output')+1],'archive-fixture');
 else if(a[0]==='run')console.log('<tr><td>Layer 1 Sandbox</td><td>Namespace</td></tr><tr><td>PID namespaces</td><td>Yes</td></tr><tr><td>Network namespaces</td><td>Yes</td></tr><tr><td>Seccomp-BPF sandbox</td><td>Yes</td></tr>');
}
`;
  for(const tool of ['docker','cosign','trivy','git'])fs.writeFileSync(path.join(bin,tool),mock,{mode:0o700});
  const key=path.join(root,'platform.pub');fs.writeFileSync(key,pem);
  const env={...process.env,PATH:bin+':'+process.env.PATH,MOCK_LOG:log,MOCK_SOURCE:source,MOCK_PUBLIC_KEY:pem,RELEASE_SOURCE_SHA:source,APP_IMAGE:'local:app',RUNNER_IMAGE:'local:app',MCP_IMAGE:'local:app',DESKTOP_IMAGE:'local:desktop',HOST_BASE:'local:host-base',HOST_IMAGE_TAG:'local:host',PLATFORM_PUBLIC_KEY_FILE:key};
  return {root,env,log,run:(script,args=[],extra={})=>spawnSync(script,args,{cwd:root,env:{...env,...extra},encoding:'utf8'}),calls:()=>fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l)):[]};
}
test('dry assembly uses local exact images, preserves MCP archive and never contacts registry/signing tools',t=>{
  const f=fixture(t);const result=f.run('bash',['infra/tenant-host/build-release.sh','--dry-run']);
  assert.equal(result.status,0,result.stderr);
  const calls=f.calls();assert.ok(!calls.some(c=>c.tool==='cosign'||c.tool==='trivy'||['pull','push','login'].includes(c.args[0])));
  assert.equal(calls.filter(c=>c.args[0]==='save').length,2,'shared app/runner/MCP is archived once');
  assert.ok(fs.existsSync(path.join(f.root,'.context/tenant-release/images/MCP_IMAGE.tar')));
  const release=JSON.parse(fs.readFileSync(path.join(f.root,'.context/tenant-release/release.json')));
  assert.equal(release.desktopSeccompSha256,createHash('sha256').update(profile).digest('hex'));
  assert.throws(()=>assertBootableRelease(release,profile),/cannot start/);
});
test('failed signature and mismatched component source prevent host assembly',t=>{
  const f=fixture(t);let result=f.run('bash',['infra/tenant-host/build-release.sh'],{...inputs,PLATFORM_PUBLIC_KEY_FILE:f.env.PLATFORM_PUBLIC_KEY_FILE,MOCK_SIGNATURE_FAIL:'1'});
  assert.notEqual(result.status,0);assert.ok(!f.calls().some(c=>['pull','create','build'].includes(c.args[0])));
  fs.writeFileSync(f.log,'');result=f.run('bash',['infra/tenant-host/build-release.sh','--dry-run'],{MOCK_BAD_REVISION:'1'});
  assert.notEqual(result.status,0);assert.match(result.stderr,/source commit mismatch/);assert.ok(!f.calls().some(c=>c.args[0]==='build'));
});
test('dry assembly refuses a missing host base before build can fetch it',t=>{
  const f=fixture(t),result=f.run('bash',['infra/tenant-host/build-release.sh','--dry-run'],{MOCK_MISSING_BASE:'1'});
  assert.notEqual(result.status,0);
  assert.ok(!f.calls().some(c=>['create','build','pull','push','login'].includes(c.args[0])));
});
test('complete dry pipeline strips inherited secrets, builds host, emits no registry digest and remains explicitly unqualified',t=>{
  const f=fixture(t),output=path.join(f.root,'output');const result=f.run(process.execPath,['infra/tenant-host/release-images.mjs','--dry-run'],{FLY_IMAGE_PUSH_TOKEN:'fixture-not-a-secret',GITHUB_OUTPUT:output});
  assert.equal(result.status,0,result.stderr);
  const calls=f.calls();assert.ok(calls.every(c=>c.secret===null));assert.ok(!calls.some(c=>c.tool==='cosign'||['push','login','pull'].includes(c.args[0])));
  assert.match(fs.readFileSync(output,'utf8'),/^host_image_digest=\nhost_image_id=sha256:/);
  const appBuild=calls.find(c=>c.tool==='docker'&&c.args[0]==='build'&&c.args.includes('Dockerfile'));
  assert.ok(appBuild.args.includes(`SWARM_BUILD_REVISION=${source}`),'app image is built with the exact source revision');
  const record=JSON.parse(fs.readFileSync(path.join(f.root,'.context/tenant-release/reports/images.json')));
  assert.equal(record.liveInfrastructureQualified,false);assert.equal(record.mode,'dry-run');
});
test('scan failures remain failures in dry mode and cannot produce a publication output',t=>{
  const f=fixture(t),output=path.join(f.root,'output');const result=f.run(process.execPath,['infra/tenant-host/release-images.mjs','--dry-run'],{MOCK_SCAN_FAIL:'1',GITHUB_OUTPUT:output});
  assert.notEqual(result.status,0);assert.match(result.stderr,/Image qualification failed/);assert.equal(fs.existsSync(output),false);
  assert.ok(!f.calls().some(c=>c.tool==='cosign'||['push','login'].includes(c.args[0])));
  const record=JSON.parse(fs.readFileSync(path.join(f.root,'.context/tenant-release/reports/images.json')));assert.equal(record.failedScans.length,5);
});
const publishEnv={REGISTRY_APP:'approved-app',GITHUB_ACTIONS:'true',GITHUB_REF:'refs/heads/main',FLY_IMAGE_PUSH_TOKEN:'fixture-registry-token',COSIGN_PRIVATE_KEY:'fixture-encrypted-key',COSIGN_PASSWORD:'fixture-key-password',TENANT_PLATFORM_PUBLIC_KEY:pem};
test('publishing refuses non-main workflows and scan failures before any image push',t=>{
  const f=fixture(t);
  let result=f.run(process.execPath,['infra/tenant-host/release-images.mjs','--publish'],{...publishEnv,GITHUB_REF:'refs/heads/unreviewed'});
  assert.notEqual(result.status,0);assert.match(result.stderr,/protected main/);
  assert.ok(!f.calls().some(c=>c.tool==='docker'));
  fs.writeFileSync(f.log,'');
  result=f.run(process.execPath,['infra/tenant-host/release-images.mjs','--publish'],{...publishEnv,MOCK_SCAN_FAIL:'1'});
  assert.notEqual(result.status,0);assert.ok(!f.calls().some(c=>['push','sign'].includes(c.args[0])));
  assert.equal(fs.readdirSync(path.join(f.root,'.context')).some(n=>n.startsWith('tenant-image-private-')),false);
});
test('publication binds scanned signed digests to source/profile and cleans credentials',t=>{
  const f=fixture(t),output=path.join(f.root,'output');
  const result=f.run(process.execPath,['infra/tenant-host/release-images.mjs','--publish'],{...publishEnv,GITHUB_OUTPUT:output});
  assert.equal(result.status,0,result.stderr);
  const calls=f.calls();assert.ok(calls.every(c=>c.secret===null));
  assert.equal(calls.filter(c=>c.tool==='cosign'&&c.args[0]==='sign').length,5);
  assert.ok(calls.some(c=>c.tool==='docker'&&c.args[0]==='run'),'required smoke executes');
  const record=JSON.parse(fs.readFileSync(path.join(f.root,'.context/tenant-release/reports/images.json')));
  assert.equal(record.mode,'publish');assert.equal(record.sourceCommit,source);assert.equal(record.liveInfrastructureQualified,false);
  assert.ok(Object.values(record.components).every(ref=>/@sha256:[a-f0-9]{64}$/.test(ref)));
  assert.equal(record.desktopSeccompSha256,createHash('sha256').update(profile).digest('hex'));
  assert.match(fs.readFileSync(output,'utf8'),/^host_image_digest=registry\.fly\.io\/approved-app@sha256:/);
  assert.equal(fs.readdirSync(path.join(f.root,'.context')).some(n=>n.startsWith('tenant-image-private-')),false);
});

test('Chrome sandbox evidence accepts the modern status table and refuses missing or disabled layers',()=>{
  const rows='<tr><td class="good">Layer 1 Sandbox</td><td>Namespace</td></tr><tr><td>PID namespaces</td><td>Yes</td></tr><tr><td>Network namespaces</td><td>Yes</td></tr><tr><td>Seccomp-BPF sandbox</td><td>Yes</td></tr>';
  assert.deepEqual(assertChromeSandbox(rows),{namespace:true,seccomp:true});
  assert.throws(()=>assertChromeSandbox(rows.replace('Namespace</td>','None</td>')),/namespace AND seccomp/);
  assert.throws(()=>assertChromeSandbox(rows.replace('Seccomp-BPF sandbox</td><td>Yes','Seccomp-BPF sandbox</td><td>No')),/namespace AND seccomp/);
  assert.throws(()=>assertChromeSandbox('<html>new tab</html>'),/namespace AND seccomp/);
  assert.throws(()=>assertChromeSandbox(rows+'<tr><td>PID namespaces</td><td>Yes</td></tr>'),/namespace AND seccomp/);
  assert.throws(()=>assertChromeSandbox(rows.replace('<tr><td>Network namespaces</td><td>Yes</td></tr>','')),/namespace AND seccomp/);
});

const finding=(id,pkg,severity,fixed='')=>({VulnerabilityID:id,PkgName:pkg,Severity:severity,InstalledVersion:'1',FixedVersion:fixed});
const report=(...v)=>({SchemaVersion:2,ArtifactName:'fixture',Results:[{Target:'image',Vulnerabilities:v}]});
const exception=(over={})=>({id:'CVE-2026-6653',package:'libxml2',image:'desktop',severity:'CRITICAL',reachability:'Pulled in by GTK; not called by Swarm code; confined desktop container.',approvedBy:'agenticwizzard7',approved:'2026-11-19',expires:'2026-12-19',...over});
const now=Date.parse('2026-11-20T00:00:00Z');
test('scan gate blocks fixable findings even when an exception exists',()=>{
  const r=evaluateScan(report(finding('CVE-2026-6653','libxml2','CRITICAL','2.9.1')),{exceptions:[exception()]},now,'desktop');
  assert.equal(r.violations.length,1);assert.match(r.violations[0].reason,/fix available/);
});
test('scan gate accepts only unexpired exceptions for the exact CVE, package and severity',()=>{
  assert.equal(evaluateScan(report(finding('CVE-2026-6653','libxml2','CRITICAL')),{exceptions:[exception()]},now,'desktop').violations.length,0);
  assert.match(evaluateScan(report(finding('CVE-2026-6653','libxml2','CRITICAL')),{exceptions:[]},now,'desktop').violations[0].reason,/no exception/);
  assert.match(evaluateScan(report(finding('CVE-2026-6653','libxml2-utils','CRITICAL')),{exceptions:[exception()]},now,'desktop').violations[0].reason,/no exception/);
  assert.match(evaluateScan(report(finding('CVE-2026-6653','libxml2','CRITICAL')),{exceptions:[exception({severity:'HIGH'})]},now,'desktop').violations[0].reason,/HIGH only/);
  assert.match(evaluateScan(report(finding('CVE-2026-6653','libxml2','CRITICAL')),{exceptions:[exception()]},Date.parse('2026-12-19T00:00:00Z'),'desktop').violations[0].reason,/expired/);
  assert.equal(evaluateScan(report(finding('CVE-2026-1','x','MEDIUM')),{exceptions:[]},now,'desktop').total,0);
});
test('exceptions are bounded, explained and attributable',()=>{
  assert.equal(MAX_EXCEPTION_DAYS,30);
  assert.throws(()=>validateExceptions({exceptions:[exception({expires:'2026-12-20'})]}),/exceeds 30 days/);
  assert.throws(()=>validateExceptions({exceptions:[exception({reachability:'ok'})]}),/reachability/);
  assert.throws(()=>validateExceptions({exceptions:[exception({approvedBy:''})]}),/approvedBy/);
  assert.throws(()=>validateExceptions({exceptions:[exception(),exception()]}),/Duplicate/);
  assert.throws(()=>validateExceptions({exceptions:[exception({id:'*'})]}),/id/);
  validateExceptions(JSON.parse(fs.readFileSync(new URL('../infra/tenant-host/scan-exceptions.json',import.meta.url))));
});
test('a fixable finding fails the dry pipeline for every image without publishing',t=>{
  const f=fixture(t),output=path.join(f.root,'output'),scan=path.join(f.root,'scan.json');
  fs.writeFileSync(scan,JSON.stringify(report(finding('CVE-2026-78661','golang.org/x/net','HIGH','0.62.0'))));
  const result=f.run(process.execPath,['infra/tenant-host/release-images.mjs','--dry-run'],{MOCK_SCAN_REPORT:scan,GITHUB_OUTPUT:output});
  assert.notEqual(result.status,0);assert.match(result.stderr,/fix available/);assert.equal(fs.existsSync(output),false);
  const record=JSON.parse(fs.readFileSync(path.join(f.root,'.context/tenant-release/reports/images.json')));
  assert.equal(record.failedScans.length,5);assert.match(record.scanExceptionsSha256,/^[a-f0-9]{64}$/);
});

test('exceptions apply only from their approval date until expiry, with real calendar dates',()=>{
  const crit=report(finding('CVE-2026-6653','libxml2','CRITICAL'));
  assert.match(evaluateScan(crit,{exceptions:[exception({approved:'2027-01-01',expires:'2027-01-31'})]},now,'desktop').violations[0].reason,/not yet approved/);
  assert.equal(evaluateScan(crit,{exceptions:[exception({approved:'2026-11-20',expires:'2026-12-20'})]},now,'desktop').violations.length,0,'approval day is inclusive');
  assert.match(evaluateScan(crit,{exceptions:[exception({approved:'2026-10-21',expires:'2026-11-20'})]},now,'desktop').violations[0].reason,/expired/,'expiry day is exclusive');
  assert.throws(()=>validateExceptions({exceptions:[exception({approved:'2026-02-30',expires:'2026-03-15'})]}),/real approved/);
});
test('an exception for one image never clears another; app/runner/MCP share the app scope explicitly',()=>{
  const crit=report(finding('CVE-2026-6653','libxml2','CRITICAL')),appOnly={exceptions:[exception({image:'app'})]};
  assert.match(evaluateScan(crit,appOnly,now,'desktop').violations[0].reason,/no exception for image desktop/);
  assert.match(evaluateScan(crit,appOnly,now,'DESKTOP_IMAGE').violations[0].reason,/no exception for image desktop/);
  assert.match(evaluateScan(crit,appOnly,now,'desktopBase').violations[0].reason,/no exception/);
  for(const label of ['app','APP_IMAGE','RUNNER_IMAGE','MCP_IMAGE'])assert.equal(evaluateScan(crit,appOnly,now,label).violations.length,0,label);
  assert.equal(imageScope('HOST_BASE'),'hostBase');
  assert.throws(()=>imageScope('unknown'),/Unknown scan image/);assert.throws(()=>evaluateScan(crit,appOnly,now),/Unknown scan image/);
  assert.throws(()=>validateExceptions({exceptions:[exception({image:undefined})]}),/must name one image/);
});
test('missing or malformed scan reports fail closed; a valid empty report is clean',()=>{
  for(const bad of [{},null,[],{SchemaVersion:1,ArtifactName:'x',Results:[]},{SchemaVersion:2,Results:[]},{SchemaVersion:2,ArtifactName:'x'},
    {SchemaVersion:2,ArtifactName:'x',Results:[{}]},{SchemaVersion:2,ArtifactName:'x',Results:[{Target:'t',Vulnerabilities:{}}]},
    {SchemaVersion:2,ArtifactName:'x',Results:[{Target:'t',Vulnerabilities:[{PkgName:'p',Severity:'HIGH'}]}]},
    {SchemaVersion:2,ArtifactName:'x',Results:[{Target:'t',Vulnerabilities:[{VulnerabilityID:'CVE-2026-1',PkgName:'p',Severity:'SEVERE'}]}]}])
    assert.throws(()=>evaluateScan(bad,{exceptions:[]},now,'app'),/Scan report|Scan result|schema/,JSON.stringify(bad));
  assert.deepEqual(evaluateScan({SchemaVersion:2,ArtifactName:'x',Results:[]},{exceptions:[]},now,'app').violations,[]);
});
test('a malformed scan report blocks dry output and publication before any sign or push',t=>{
  const f=fixture(t),output=path.join(f.root,'output'),scan=path.join(f.root,'scan.json');fs.writeFileSync(scan,'{}');
  let result=f.run(process.execPath,['infra/tenant-host/release-images.mjs','--dry-run'],{MOCK_SCAN_REPORT:scan,GITHUB_OUTPUT:output});
  assert.notEqual(result.status,0);assert.match(result.stderr,/Unsupported scan report schema/);assert.equal(fs.existsSync(output),false);
  fs.writeFileSync(f.log,'');
  result=f.run(process.execPath,['infra/tenant-host/release-images.mjs','--publish'],{...publishEnv,MOCK_SCAN_REPORT:scan,GITHUB_OUTPUT:output});
  assert.notEqual(result.status,0);assert.ok(!f.calls().some(c=>['push','sign'].includes(c.args[0])));assert.equal(fs.existsSync(output),false);
});
test('verified component checks map component names to image scopes and refuse a malformed report',t=>{
  const f=fixture(t),scan=path.join(f.root,'scan.json');fs.writeFileSync(scan,'{}');
  const result=f.run('bash',['infra/tenant-host/build-release.sh'],{...inputs,PLATFORM_PUBLIC_KEY_FILE:f.env.PLATFORM_PUBLIC_KEY_FILE,IMAGE_VERIFICATION_KEY:f.env.PLATFORM_PUBLIC_KEY_FILE,MOCK_SCAN_REPORT:scan});
  assert.notEqual(result.status,0);assert.match(result.stderr,/APP_IMAGE: Unsupported scan report schema/);assert.ok(!f.calls().some(c=>['pull','create','build'].includes(c.args[0])));
});
