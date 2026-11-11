import crypto from 'node:crypto';
import fs from 'node:fs';
import { assertTenant, isTenant } from '../deployment.js';
import {sealSecret,openSecret} from './secret-envelope.js';
function key(userId: string) {
  assertTenant(userId);
  if (isTenant) {
    const p = process.env.TENANT_DATA_KEY_FILE!;
    const stat = fs.lstatSync(p);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error('Insecure tenant key file.');
    const k = Buffer.from(fs.readFileSync(p, 'utf8').trim(), 'base64');
    if (k.length !== 32) throw new Error('Invalid tenant data key.');
    return k;
  }
  if (!process.env.SESSION_SECRET) throw new Error('Encryption key is missing.');
  return Buffer.from(crypto.hkdfSync('sha256', process.env.SESSION_SECRET, userId, 'swarm-private-secrets-v1', 32));
}
export function sealPrivate(userId: string, purpose: string, value: unknown): string {
  const secret=key(userId);try{return sealSecret(secret,userId,purpose,value);}finally{secret.fill(0);}
}
export function openPrivate<T>(userId: string, purpose: string, encrypted: string): T {
  if (!encrypted.startsWith('private1:')) throw new Error('Unencrypted credential requires migration.');
  const secret=key(userId);try{return openSecret<T>(secret,userId,purpose,encrypted);}finally{secret.fill(0);}
}
