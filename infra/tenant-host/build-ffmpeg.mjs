// Build-time only; called in an isolated image stage, never at tenant startup.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const config=JSON.parse(fs.readFileSync('/build/images.lock.json','utf8')).ffmpeg;
if(!/^\d+\.\d+\.\d+$/.test(config.version)||config.sourceUrl!==`https://ffmpeg.org/releases/ffmpeg-${config.version}.tar.xz`||!/^[a-f0-9]{64}$/.test(config.sourceSha256)||!/^[A-F0-9]{40}$/.test(config.signingKeyFingerprint))throw Error('Invalid pinned FFmpeg source');
const run=(file,args,options={})=>execFileSync(file,args,{stdio:'inherit',...options});
const read=(file,args)=>run(file,args,{encoding:'utf8',stdio:['ignore','pipe','inherit']});
const sha=data=>createHash('sha256').update(data).digest('hex');
async function download(url,file){
  for(let attempt=0;;attempt++){
    try{const r=await fetch(url,{signal:AbortSignal.timeout(60000),redirect:'error'});if(!r.ok)throw Error(`Source download failed: ${r.status}`);fs.writeFileSync(file,Buffer.from(await r.arrayBuffer()));break;}
    catch(error){if(attempt===2)throw error;}
  }
}
await download(config.sourceUrl,'/build/source.tar.xz');
if(sha(fs.readFileSync('/build/source.tar.xz'))!==config.sourceSha256)throw Error('FFmpeg tarball checksum mismatch');
await download(config.sourceUrl+'.asc','/build/source.asc');
fs.mkdirSync('/build/gnupg',{mode:0o700});
const key=read('gpg',['--homedir','/build/gnupg','--show-keys','--with-colons','/build/ffmpeg-release.asc']);
if(key.split('\n').filter(l=>l.startsWith('pub:')).length!==1||key.split('\n').find(l=>l.startsWith('fpr:'))?.split(':')[9]!==config.signingKeyFingerprint)throw Error('Unexpected upstream signing key');
run('gpg',['--homedir','/build/gnupg','--batch','--dearmor','--output','/build/keyring.gpg','/build/ffmpeg-release.asc']);
run('gpgv',['--homedir','/build/gnupg','--keyring','/build/keyring.gpg','/build/source.asc','/build/source.tar.xz']);
fs.mkdirSync('/build/source');run('tar',['-xJf','/build/source.tar.xz','--strip-components=1','-C','/build/source']);
process.chdir('/build/source');
run('./configure',config.configureFlags);run('make',['-j2','ffmpeg']);run('strip',['ffmpeg']);
fs.mkdirSync('/out');fs.copyFileSync('ffmpeg','/out/ffmpeg');fs.chmodSync('/out/ffmpeg',0o755);
const metadata={...config,signatureUrl:config.sourceUrl+'.asc',binarySha256:sha(fs.readFileSync('/out/ffmpeg')),binaryVersion:read('/out/ffmpeg',['-version']).split('\n')[0]};
if(!metadata.binaryVersion.startsWith(`ffmpeg version ${config.version}`))throw Error('FFmpeg binary/source version mismatch');
fs.writeFileSync('/out/ffmpeg-build.json',JSON.stringify(metadata,null,2)+'\n');
fs.copyFileSync('COPYING.LGPLv2.1','/out/COPYING.LGPLv2.1');
