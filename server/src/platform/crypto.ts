import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
/** Short-lived platform identity metadata; tenant content uses KMS tenant envelopes instead. */
export function platformSecrets(secret = process.env.SESSION_SECRET) {
  if (!secret || secret.length < 32) throw new Error('Strong platform SESSION_SECRET required.');
  const key=createHash('sha256').update(`swarm-platform-records:${secret}`).digest();
  return {
    seal(purpose:string,value:unknown){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from(purpose));const data=Buffer.concat([c.update(JSON.stringify(value)),c.final()]);return Buffer.concat([iv,c.getAuthTag(),data]).toString('base64url');},
    open<T=any>(purpose:string,value:string):T{const b=Buffer.from(value,'base64url'),d=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAAD(Buffer.from(purpose));d.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([d.update(b.subarray(28)),d.final()]).toString());},
  };
}
