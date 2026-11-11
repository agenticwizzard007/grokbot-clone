import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
/** Key selection/authorization belongs to the caller. This envelope authenticates
 * the immutable owner and purpose even when encrypted records are substituted. */
export function sealSecret(key:Buffer,owner:string,purpose:string,value:unknown){
  if(key.length!==32)throw new Error('Invalid secret key.');
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(JSON.stringify([owner,purpose,1])));
  const clear=Buffer.from(JSON.stringify(value));
  try{const ciphertext=Buffer.concat([cipher.update(clear),cipher.final()]);return `private1:${Buffer.concat([iv,cipher.getAuthTag(),ciphertext]).toString('base64url')}`;}
  finally{clear.fill(0);}
}
export function openSecret<T>(key:Buffer,owner:string,purpose:string,encrypted:string):T {
  if(key.length!==32||!encrypted.startsWith('private1:'))throw new Error('Credential ownership or integrity check failed.');
  try{
    const bytes=Buffer.from(encrypted.slice(9),'base64url'),cipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));
    cipher.setAuthTag(bytes.subarray(12,28));cipher.setAAD(Buffer.from(JSON.stringify([owner,purpose,1])));
    const clear=Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]);
    try{return JSON.parse(clear.toString());}finally{clear.fill(0);}
  }catch{throw new Error('Credential ownership or integrity check failed.');}
}
