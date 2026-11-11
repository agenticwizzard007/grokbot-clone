import fs from 'node:fs';
import {createPublicKey} from 'node:crypto';
import {fileURLToPath} from 'node:url';
export function publicKey(value) {
  if(!/^-----BEGIN PUBLIC KEY-----\r?\n/.test(value))throw Error('Platform key must be a PUBLIC KEY PEM, never a private key');
  const key=createPublicKey(value);
  if(key.asymmetricKeyType!=='ed25519')throw Error('Platform public key must be Ed25519');
  return key;
}
export function validateInputs(e) {
  if(!['verified','dry-run'].includes(e.RELEASE_BUILD_MODE))throw Error('Invalid build mode');
  if(!/^[a-f0-9]{40}$/.test(e.RELEASE_SOURCE_SHA??''))throw Error('RELEASE_SOURCE_SHA must name an exact Git commit');
  for(const name of ['APP_IMAGE','RUNNER_IMAGE','MCP_IMAGE','DESKTOP_IMAGE','HOST_BASE']) {
    const value=e[name]??'';
    const pinned=/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(value);
    const local=/^sha256:[a-f0-9]{64}$/.test(value)||/^[a-z0-9][a-z0-9./_-]*:[a-zA-Z0-9._-]+$/.test(value);
    if(!(pinned||e.RELEASE_BUILD_MODE==='dry-run'&&local))throw Error(`${name} must be ${e.RELEASE_BUILD_MODE==='verified'?'a registry digest':'a local image reference'}`);
  }
  if(!/^[a-z0-9][a-z0-9./_-]*:[a-zA-Z0-9._-]+$/.test(e.HOST_IMAGE_TAG??''))throw Error('HOST_IMAGE_TAG must be an explicit image tag');
  if(e.RELEASE_BUILD_MODE==='verified'&&!e.IMAGE_VERIFICATION_KEY)throw Error('IMAGE_VERIFICATION_KEY is required');
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  validateInputs(process.env);
  publicKey(fs.readFileSync(process.env.PLATFORM_PUBLIC_KEY_FILE,'utf8'));
}
